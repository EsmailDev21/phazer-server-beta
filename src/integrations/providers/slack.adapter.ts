import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IntegrationProvider } from '@prisma/client';
import { ProviderHttpClient } from '../core/provider-http.client';
import { ChatResult } from '../chat/chat.types';
import { SLACK_RESPONSE_URL, renderResult, toSlackMessage } from '../chat/slack/slack.protocol';
import {
  AuthorizeContext,
  CallbackParams,
  Capability,
  ConnectorAdapter,
  ExchangeContext,
  IdentityCapability,
  ProviderAuthRejectedError,
  TokenSet,
  NotifyContext,
  NotifyPermanentError,
} from '../core/integration.types';

const SCOPES = [
  'commands',
  'chat:write',
  'chat:write.public', // post to public channels without being invited first; private channels still need /invite
  'links:read',
  'links:write',
  'channels:read',
  'users:read',
  'users:read.email',
];

interface SlackAccessResponse {
  ok: boolean;
  error?: string;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  team?: { id: string; name: string };
  bot_user_id?: string;
}

/**
 * Slack OAuth v2 (bot token). 2.1 covers connect / refresh (only when token rotation is on in the app
 * settings) / revoke. Slack has no PKCE, so the single-use state is the CSRF defence.
 */
@Injectable()
export class SlackAdapter implements ConnectorAdapter {
  readonly provider = IntegrationProvider.SLACK;
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>(['NOTIFY', 'COMMANDS', 'LINKS', 'WEBHOOKS']);
  readonly usesPkce = false;

  constructor(
    private readonly config: ConfigService,
    private readonly http: ProviderHttpClient,
  ) {}

  isConfigured(): boolean {
    return !!this.config.get('SLACK_CLIENT_ID') && !!this.config.get('SLACK_CLIENT_SECRET');
  }

  authorizeUrl(ctx: AuthorizeContext): string {
    const u = new URL('https://slack.com/oauth/v2/authorize');
    u.searchParams.set('client_id', this.config.get<string>('SLACK_CLIENT_ID')!);
    u.searchParams.set('scope', SCOPES.join(','));
    u.searchParams.set('redirect_uri', ctx.redirectUri);
    u.searchParams.set('state', ctx.state);
    return u.toString();
  }

  /**
   * Step 2.2: "Sign in with Slack" (OpenID Connect) for the user, and `users.info` with the bot token for
   * silent verified-email matching. Both report the Slack team id so a user from another workspace is refused.
   */
  readonly identity: IdentityCapability = {
    authorizeUrl: (ctx) => {
      const u = new URL('https://slack.com/openid/connect/authorize');
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('scope', 'openid email profile');
      u.searchParams.set('client_id', this.config.get<string>('SLACK_CLIENT_ID')!);
      u.searchParams.set('redirect_uri', ctx.redirectUri);
      u.searchParams.set('state', ctx.state);
      return u.toString();
    },
    exchange: async (params, ctx) => {
      if (!params.code) throw new Error('Slack identity callback without code');
      const tokRes = await this.http.request({
        rateKey: 'oauth:SLACK',
        url: 'https://slack.com/api/openid.connect.token',
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: this.config.get<string>('SLACK_CLIENT_ID')!,
          client_secret: this.config.get<string>('SLACK_CLIENT_SECRET')!,
          code: params.code,
          redirect_uri: ctx.redirectUri,
          grant_type: 'authorization_code',
        }),
      });
      const tok = tokRes.ok ? tokRes.json<{ ok: boolean; access_token?: string; error?: string }>() : { ok: false, error: `http_${tokRes.status}` };
      if (!tok.ok || !tok.access_token) throw new Error(`Slack openid token: ${tok.error ?? 'unknown_error'}`);
      const info = await this.http.requestJson<{
        ok: boolean; error?: string; sub?: string; name?: string; email?: string; email_verified?: boolean;
        'https://slack.com/team_id'?: string;
      }>({
        rateKey: 'oauth:SLACK',
        url: 'https://slack.com/api/openid.connect.userInfo',
        headers: { authorization: `Bearer ${tok.access_token}` },
      });
      if (!info.ok || !info.sub) throw new Error(`Slack userInfo: ${info.error ?? 'unknown_error'}`);
      return {
        id: info.sub,
        name: info.name ?? info.sub,
        email: info.email,
        emailConfirmed: info.email_verified === true,
        tenantId: info['https://slack.com/team_id'],
      };
    },
    lookup: async (accessToken, externalUserId, rateKey) => {
      const r = await this.http.requestJson<{
        ok: boolean; error?: string;
        user?: { id: string; team_id?: string; deleted?: boolean; is_bot?: boolean; real_name?: string; is_email_confirmed?: boolean; profile?: { email?: string } };
      }>({
        rateKey,
        url: `https://slack.com/api/users.info?user=${encodeURIComponent(externalUserId)}`,
        headers: { authorization: `Bearer ${accessToken}` },
      });
      if (!r.ok) {
        if (r.error === 'user_not_found') return null;
        throw new Error(`Slack users.info: ${r.error ?? 'unknown_error'}`);
      }
      const u = r.user!;
      return {
        id: u.id,
        name: u.real_name ?? u.id,
        email: u.profile?.email,
        emailConfirmed: u.is_email_confirmed === true && !u.deleted,
        isBot: u.is_bot === true || u.deleted === true,
        tenantId: u.team_id,
      };
    },
  };

  async exchangeCode(params: CallbackParams, ctx: ExchangeContext) {
    if (!params.code) throw new Error('Slack callback without code');
    const r = await this.access({ code: params.code, redirect_uri: ctx.redirectUri });
    if (!r.team?.id || !r.access_token) throw new Error('Slack response missing team or token');
    return {
      tokens: this.toTokens(r, { botUserId: r.bot_user_id }),
      account: { id: r.team.id, name: r.team.name },
    };
  }

  async refresh(tokens: TokenSet): Promise<TokenSet> {
    if (!tokens.refreshToken) throw new ProviderAuthRejectedError('No refresh token stored');
    const r = await this.access({ grant_type: 'refresh_token', refresh_token: tokens.refreshToken }, true);
    return this.toTokens(r, tokens.extra);
  }

  async revoke(tokens: TokenSet): Promise<void> {
    await this.http.request({
      rateKey: 'oauth:SLACK',
      url: 'https://slack.com/api/auth.revoke',
      method: 'POST',
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });
  }

  // ------------------------------------------------------------------ step 2.5 (ADR-0013)

  /** One Slack Web API call. Slack answers HTTP 200 with `ok:false` for logical failures; HTTP errors (429, 5xx) are the client's/ours. */
  private async api(method: string, token: string, body: Record<string, unknown>, rateKey: string): Promise<{ ok: boolean; error?: string; [k: string]: unknown }> {
    const res = await this.http.request({
      rateKey,
      url: `https://slack.com/api/${method}`,
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Slack ${method} HTTP ${res.status}`);
    return res.json();
  }

  /** Slack workspace admin / owner? Needed for `/task link` (the Manage Server equivalent). users:read is already a requested scope. */
  async isWorkspaceAdmin(token: string, userId: string, rateKey: string): Promise<boolean> {
    const r = await this.api('users.info', token, { user: userId }, rateKey).catch(() => null);
    const u = (r as { user?: { is_admin?: boolean; is_owner?: boolean; is_primary_owner?: boolean } } | null)?.user;
    return !!(u?.is_admin || u?.is_owner || u?.is_primary_owner);
  }

  /** views.open: the trigger_id is only valid for 3 seconds, so callers invoke this synchronously. */
  async openView(token: string, triggerId: string, view: unknown, rateKey: string): Promise<void> {
    const r = await this.api('views.open', token, { trigger_id: triggerId, view }, rateKey);
    if (!r.ok) throw new Error(`Slack views.open: ${r.error ?? 'unknown_error'}`);
  }

  async unfurl(token: string, a: { channel: string; ts: string; unfurls: Record<string, unknown> }, rateKey: string): Promise<void> {
    const r = await this.api('chat.unfurl', token, { channel: a.channel, ts: a.ts, unfurls: a.unfurls }, rateKey);
    if (!r.ok) throw new Error(`Slack chat.unfurl: ${r.error ?? 'unknown_error'}`);
  }

  /**
   * Deliver a deferred command's result. Slash commands and buttons carry a `response_url` (a credential in itself, and
   * validated against Slack's hosts because we POST to it); modal submissions carry none, so the result is POSTED to the
   * channel (public, in the message's thread) or shown only to the user (ephemeral). Throws on failure so the job retries.
   */
  async chatReply(
    target: { applicationId: string; interactionToken: string; reply?: { channelId?: string; threadTs?: string; userId?: string }; accessToken?: string },
    result: ChatResult,
  ): Promise<void> {
    const msg = renderResult(result);
    if (target.reply?.channelId) {
      if (!target.accessToken) throw new Error('Slack reply needs the connection token');
      const common = { channel: target.reply.channelId, text: msg.text, blocks: msg.blocks, ...(target.reply.threadTs ? { thread_ts: target.reply.threadTs } : {}) };
      const r = result.visibility === 'public'
        ? await this.api('chat.postMessage', target.accessToken, { ...common, unfurl_links: false }, `chat:${target.applicationId}`)
        : await this.api('chat.postEphemeral', target.accessToken, { ...common, user: target.reply.userId }, `chat:${target.applicationId}`);
      if (!r.ok) throw new Error(`Slack reply: ${r.error ?? 'unknown_error'}`);
      return;
    }
    if (!SLACK_RESPONSE_URL.test(target.interactionToken)) throw new Error('Invalid response_url');
    const res = await this.http.request({
      rateKey: `chat:${target.applicationId}`,
      url: target.interactionToken,
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ response_type: msg.response_type, text: msg.text, blocks: msg.blocks, replace_original: false }),
    });
    if (!res.ok) throw new Error(`Slack response_url HTTP ${res.status}`);
  }

  async notify(ctx: NotifyContext): Promise<void> {
    if (ctx.channel.kind !== 'CHANNEL' || !/^[CG][A-Z0-9]{2,20}$/.test(ctx.channel.externalId)) throw new NotifyPermanentError('invalid_channel');
    const r = await this.api('chat.postMessage', ctx.accessToken, { channel: ctx.channel.externalId, ...toSlackMessage(ctx.message) }, ctx.rateKey);
    if (r.ok) return;
    // The destination is gone, archived, or we may not post there (bot not invited, scope missing, token dead): retrying cannot help.
    const permanent = ['channel_not_found', 'not_in_channel', 'is_archived', 'account_inactive', 'invalid_auth', 'token_revoked', 'token_expired', 'missing_scope', 'restricted_action', 'access_denied', 'no_permission', 'team_access_not_granted', 'invalid_arguments', 'msg_too_long', 'channel_is_archived'];
    if (permanent.includes(r.error ?? '')) throw new NotifyPermanentError(`slack_${r.error}`);
    throw new Error(`Slack chat.postMessage: ${r.error ?? 'unknown_error'}`);
  }

  private async access(form: Record<string, string>, isRefresh = false): Promise<SlackAccessResponse> {
    const res = await this.http.request({
      rateKey: 'oauth:SLACK',
      url: 'https://slack.com/api/oauth.v2.access',
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.config.get<string>('SLACK_CLIENT_ID')!,
        client_secret: this.config.get<string>('SLACK_CLIENT_SECRET')!,
        ...form,
      }),
    });
    // Slack answers HTTP 200 with ok:false for logical failures.
    if (!res.ok) throw new Error(`Slack oauth.v2.access HTTP ${res.status}`);
    const body = res.json<SlackAccessResponse>();
    if (!body.ok) {
      const dead = ['invalid_refresh_token', 'token_revoked', 'invalid_auth', 'account_inactive'];
      if (isRefresh && dead.includes(body.error ?? '')) {
        throw new ProviderAuthRejectedError(`Slack: ${body.error}`);
      }
      throw new Error(`Slack oauth.v2.access: ${body.error ?? 'unknown_error'}`);
    }
    return body;
  }

  private toTokens(r: SlackAccessResponse, extra?: Record<string, string | undefined>): TokenSet {
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(extra ?? {})) if (v) clean[k] = v;
    return {
      accessToken: r.access_token!,
      refreshToken: r.refresh_token,
      expiresAt: r.expires_in ? new Date(Date.now() + r.expires_in * 1000) : undefined,
      scopes: (r.scope ?? '').split(',').filter(Boolean),
      tokenType: r.token_type,
      extra: Object.keys(clean).length ? clean : undefined,
    };
  }
}
