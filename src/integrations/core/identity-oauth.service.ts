import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IntegrationConnectionStatus, IntegrationProvider } from '@prisma/client';
import { TokenVaultService } from '../../crypto/token-vault.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ConnectorRegistry } from './connector.registry';
import { IdentityService } from './identity.service';
import { CallbackParams } from './integration.types';
import { OAuthStateService } from './oauth-state.service';

/**
 * "Link my account" (diagram 09, step 2): a LOGGED-IN user proves, through the provider's own OAuth, which
 * provider user they are. The state binds the app user; the provider answers for the other side. Neither a
 * link in chat nor a forged callback can pair two people.
 */
@Injectable()
export class IdentityOAuthService {
  private readonly logger = new Logger(IdentityOAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ConnectorRegistry,
    private readonly states: OAuthStateService,
    private readonly identities: IdentityService,
    private readonly vault: TokenVaultService,
    private readonly config: ConfigService,
  ) {}

  async start(provider: IntegrationProvider, connectionId: string, userId: string): Promise<{ authUrl: string }> {
    const conn = await this.prisma.integrationConnection.findUnique({
      where: { id: connectionId },
      select: { id: true, accountId: true, provider: true, status: true },
    });
    // 404 for "not yours" as well as "not there": no probing of other accounts' connection ids.
    if (!conn || conn.provider !== provider) throw new NotFoundException('Connection not found');
    if (!(await this.identities.isParticipant(userId, conn.accountId))) {
      throw new NotFoundException('Connection not found');
    }
    if (conn.status !== IntegrationConnectionStatus.ACTIVE) {
      throw new BadRequestException('This integration is not connected right now');
    }
    const adapter = this.registry.get(provider);
    if (!adapter.identity) throw new NotFoundException('This provider does not support account linking');
    if (!adapter.isConfigured() || !this.vault.configured) {
      throw new ServiceUnavailableException(`${provider} integration is not configured on this server`);
    }
    const { nonce, challenge } = await this.states.create({
      provider,
      purpose: 'IDENTITY',
      userId,
      accountId: conn.accountId,
      connectionId,
      usePkce: adapter.usesPkce,
    });
    return {
      authUrl: adapter.identity.authorizeUrl({
        state: nonce,
        redirectUri: this.redirectUri(provider),
        pkceChallenge: challenge,
      }),
    };
  }

  /** Always a redirect to the SPA: `?identity_linked=<provider>` or `?identity_error=<code>`. */
  async handleCallback(provider: IntegrationProvider, query: CallbackParams): Promise<string> {
    const back = (k: 'identity_linked' | 'identity_error', v: string) =>
      `${(this.config.get<string>('FRONTEND_URL') ?? '').replace(/\/$/, '')}/settings/integrations?${k}=${encodeURIComponent(v)}`;
    if (!query.state) return back('identity_error', 'invalid_state');
    const state = await this.states.consume(provider, 'IDENTITY', query.state);
    if (!state || !state.connection_id) return back('identity_error', 'invalid_state');
    if (query.error) return back('identity_error', 'denied');

    try {
      const conn = await this.prisma.integrationConnection.findUnique({
        where: { id: state.connection_id },
        select: { id: true, accountId: true, provider: true, status: true, externalAccountId: true },
      });
      if (!conn || conn.status !== IntegrationConnectionStatus.ACTIVE) return back('identity_error', 'connection_inactive');
      // Membership may have changed since the user clicked.
      if (!(await this.identities.isParticipant(state.user_id, conn.accountId))) {
        return back('identity_error', 'forbidden');
      }
      const adapter = this.registry.get(provider);
      if (!adapter.identity) return back('identity_error', 'provider_error');

      const ext = await adapter.identity.exchange(query, {
        redirectUri: this.redirectUri(provider),
        pkceVerifier: this.states.decryptVerifier(state),
      });
      if (ext.isBot) return back('identity_error', 'not_a_person');
      if (ext.tenantId && ext.tenantId !== conn.externalAccountId) return back('identity_error', 'wrong_workspace');

      const outcome = await this.identities.linkViaOAuth(conn, ext, state.user_id);
      return outcome === 'LINKED'
        ? back('identity_linked', provider.toLowerCase())
        : back('identity_error', 'already_linked');
    } catch (e) {
      this.logger.warn(`Identity callback failed for ${provider}: ${(e as Error).name}: ${(e as Error).message}`);
      return back('identity_error', 'provider_error');
    }
  }

  redirectUri(provider: IntegrationProvider): string {
    const base =
      this.config.get<string>('API_PUBLIC_URL') ??
      `http://localhost:${this.config.get<string>('PORT') ?? '3000'}`;
    return `${base.replace(/\/$/, '')}/integrations/${provider.toLowerCase()}/identity/callback`;
  }
}

