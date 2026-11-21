import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IntegrationProvider } from '@prisma/client';
import { createSign } from 'crypto';
import { ProviderHttpClient } from '../core/provider-http.client';
import {
  AuthorizeContext,
  CallbackParams,
  Capability,
  ConnectorAdapter,
  ExchangeContext,
  ExternalAccount,
  ProviderAuthRejectedError,
  TokenSet,
} from '../core/integration.types';

const API = 'https://api.github.com';
const GH_HEADERS = {
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'task-manager-integrations',
};

export interface GithubRepoInfo {
  id: number;
  fullName: string;
  private: boolean;
  archived: boolean;
  defaultBranch: string;
}

const toRepo = (r: { id: number; full_name: string; private?: boolean; archived?: boolean; default_branch?: string }): GithubRepoInfo => ({
  id: r.id,
  fullName: r.full_name,
  private: r.private === true,
  archived: r.archived === true,
  defaultBranch: r.default_branch ?? 'main',
});

/**
 * GitHub App. The "connection" is an INSTALLATION; there is no refresh token: access is a short-lived
 * installation token minted from an app JWT, so `refresh()` simply mints another one.
 *
 * Security (ADR-0009 d.4): the installation_id in the callback query is attacker-controlled, so it is
 * NOT trusted on its own. The App must have "Request user authorization (OAuth) during installation"
 * on; we exchange the `code`, list /user/installations with that user token, and require the id to be
 * in the list - i.e. the person completing the flow really has access to that installation. The user
 * token is discarded immediately and never stored.
 */
@Injectable()
export class GithubAdapter implements ConnectorAdapter {
  readonly provider = IntegrationProvider.GITHUB;
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>(['IMPORT', 'LINKS', 'WEBHOOKS', 'NOTIFY']);
  readonly usesPkce = false;

  constructor(
    private readonly config: ConfigService,
    private readonly http: ProviderHttpClient,
  ) {}

  isConfigured(): boolean {
    return (
      !!this.config.get('GITHUB_APP_ID') &&
      !!this.config.get('GITHUB_APP_SLUG') &&
      !!this.config.get('GITHUB_APP_PRIVATE_KEY') &&
      !!this.config.get('GITHUB_APP_CLIENT_ID') &&
      !!this.config.get('GITHUB_APP_CLIENT_SECRET')
    );
  }

  authorizeUrl(ctx: AuthorizeContext): string {
    const slug = encodeURIComponent(this.config.get<string>('GITHUB_APP_SLUG')!);
    const u = new URL(`https://github.com/apps/${slug}/installations/new`);
    u.searchParams.set('state', ctx.state);
    return u.toString();
  }

  async exchangeCode(params: CallbackParams, ctx: ExchangeContext) {
    const installationId = params.installation_id;
    if (!installationId || !/^\d+$/.test(installationId)) throw new Error('GitHub callback without installation_id');
    if (!params.code) throw new Error('GitHub callback without code: enable user authorization during installation');

    const userToken = await this.userToken(params.code, ctx.redirectUri);
    await this.assertUserHasInstallation(userToken, installationId);

    const jwt = this.appJwt();
    const inst = await this.http.requestJson<{ account?: { login?: string } }>({
      rateKey: 'oauth:GITHUB',
      url: `${API}/app/installations/${installationId}`,
      headers: { ...GH_HEADERS, authorization: `Bearer ${jwt}` },
    });
    const account: ExternalAccount = { id: installationId, name: inst.account?.login ?? `installation ${installationId}` };
    const tokens = await this.mint(installationId);
    return { tokens, account };
  }

  async refresh(tokens: TokenSet): Promise<TokenSet> {
    const installationId = tokens.extra?.installationId;
    if (!installationId) throw new ProviderAuthRejectedError('Stored GitHub credential has no installation id');
    return this.mint(installationId);
  }

  async revoke(tokens: TokenSet): Promise<void> {
    // Revokes the token only; uninstalling the App is the GitHub owner's decision, not ours.
    await this.http.request({
      rateKey: 'oauth:GITHUB',
      url: `${API}/installation/token`,
      method: 'DELETE',
      headers: { ...GH_HEADERS, authorization: `Bearer ${tokens.accessToken}` },
    });
  }

  // ---- step 2.6: repositories visible to the installation (admin repo picker + link validation)

  /** One page (100) of the repositories this installation can access. `hasMore` = ask for the next page. */
  async repositories(accessToken: string, page: number, rateKey: string): Promise<{ repos: GithubRepoInfo[]; hasMore: boolean }> {
    const p = Number.isInteger(page) && page >= 1 && page <= 50 ? page : 1;
    const body = await this.http.requestJson<{ total_count?: number; repositories: Array<Parameters<typeof toRepo>[0]> }>({
      rateKey,
      url: `${API}/installation/repositories?per_page=100&page=${p}`,
      headers: { ...GH_HEADERS, authorization: `Bearer ${accessToken}` },
    });
    const repos = (body.repositories ?? []).map(toRepo);
    return { repos, hasMore: repos.length === 100 && (body.total_count ?? 0) > p * 100 };
  }

  /** One repository by its numeric id, or null when this installation cannot see it (404/403): that is how a link request is validated. */
  async repository(accessToken: string, repoId: number, rateKey: string): Promise<GithubRepoInfo | null> {
    if (!Number.isSafeInteger(repoId) || repoId < 1) return null;
    const res = await this.http.request({
      rateKey,
      url: `${API}/repositories/${repoId}`,
      headers: { ...GH_HEADERS, authorization: `Bearer ${accessToken}` },
    });
    if (res.status === 404 || res.status === 403) return null;
    if (!res.ok) throw new Error(`GitHub repository lookup HTTP ${res.status}`);
    return toRepo(res.json<Parameters<typeof toRepo>[0]>());
  }

  // ---- internals

  private async mint(installationId: string): Promise<TokenSet> {
    const res = await this.http.request({
      rateKey: 'oauth:GITHUB',
      url: `${API}/app/installations/${installationId}/access_tokens`,
      method: 'POST',
      headers: { ...GH_HEADERS, authorization: `Bearer ${this.appJwt()}` },
    });
    if (res.status === 404 || res.status === 401 || res.status === 403) {
      throw new ProviderAuthRejectedError(`GitHub installation ${installationId} not accessible (HTTP ${res.status})`);
    }
    if (!res.ok) throw new Error(`GitHub access_tokens HTTP ${res.status}`);
    const body = res.json<{ token: string; expires_at: string }>();
    return {
      accessToken: body.token,
      expiresAt: new Date(body.expires_at),
      scopes: ['app'],
      tokenType: 'installation',
      extra: { installationId },
    };
  }

  private async userToken(code: string, redirectUri: string): Promise<string> {
    const res = await this.http.request({
      rateKey: 'oauth:GITHUB',
      url: 'https://github.com/login/oauth/access_token',
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.config.get<string>('GITHUB_APP_CLIENT_ID')!,
        client_secret: this.config.get<string>('GITHUB_APP_CLIENT_SECRET')!,
        code,
        redirect_uri: redirectUri,
      }),
    });
    const body = res.ok ? res.json<{ access_token?: string; error?: string }>() : {};
    if (!body.access_token) throw new Error(`GitHub code exchange failed: ${(body as { error?: string }).error ?? res.status}`);
    return body.access_token;
  }

  private async assertUserHasInstallation(userToken: string, installationId: string): Promise<void> {
    // First page of 100 is enough for a person who administers a handful of installations; if the id is
    // not found there we refuse rather than paginate unboundedly on a callback path.
    const body = await this.http.requestJson<{ installations: Array<{ id: number }> }>({
      rateKey: 'oauth:GITHUB',
      url: `${API}/user/installations?per_page=100`,
      headers: { ...GH_HEADERS, authorization: `Bearer ${userToken}` },
    });
    if (!body.installations.some((i) => String(i.id) === installationId)) {
      throw new Error('The authorising GitHub user has no access to that installation');
    }
  }

  /** RS256 app JWT, valid 9 minutes (GitHub's maximum is 10), backdated 60 s for clock skew. */
  appJwt(nowSec = Math.floor(Date.now() / 1000)): string {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
      iat: nowSec - 60,
      exp: nowSec + 9 * 60,
      iss: this.config.get<string>('GITHUB_APP_ID'),
    })}`;
    const pem = this.config.get<string>('GITHUB_APP_PRIVATE_KEY')!.replace(/\\n/g, '\n');
    const sig = createSign('RSA-SHA256').update(unsigned).sign(pem).toString('base64url');
    return `${unsigned}.${sig}`;
  }
}
