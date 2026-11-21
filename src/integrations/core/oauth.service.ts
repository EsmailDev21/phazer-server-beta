import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AuditAction,
  IntegrationConnectionStatus,
  IntegrationProvider,
  Prisma,
} from '@prisma/client';
import { PermissionResolver } from '../../access-control/access-control.service';
import { PlanLimitsService } from '../../access-control/plan-limits.service';
import { PlanLimitExceededException } from '../../common/exceptions/plan-limit-exceeded.exception';
import { TokenVaultService } from '../../crypto/token-vault.service';
import { AuditLogService } from '../../events/audit-log.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ConnectorRegistry } from './connector.registry';
import { CredentialService } from './credential.service';
import { CallbackParams } from './integration.types';
import { OAuthStateService } from './oauth-state.service';

/** Connections that occupy a plan slot. REVOKED does not. */
export const LIVE_STATUSES: IntegrationConnectionStatus[] = [
  IntegrationConnectionStatus.ACTIVE,
  IntegrationConnectionStatus.NEEDS_REAUTH,
  IntegrationConnectionStatus.ERROR,
];

@Injectable()
export class OAuthService {
  private readonly logger = new Logger(OAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ConnectorRegistry,
    private readonly vault: TokenVaultService,
    private readonly resolver: PermissionResolver,
    private readonly planLimits: PlanLimitsService,
    private readonly credentials: CredentialService,
    private readonly audit: AuditLogService,
    private readonly config: ConfigService,
    private readonly states: OAuthStateService,
  ) {}

  /** Step 1 of diagram 03: create single-use state, return the provider URL. */
  async start(
    provider: IntegrationProvider,
    accountId: string,
    userId: string,
  ): Promise<{ authUrl: string }> {
    const adapter = this.registry.get(provider);
    if (!adapter.isConfigured() || !this.vault.configured) {
      throw new ServiceUnavailableException(
        `${provider} integration is not configured on this server`,
      );
    }
    // At the cap, a user may still START when the account already has a live connection of this provider:
    // it may be a repair of that very connection (NEEDS_REAUTH), which takes no new slot. Which guild /
    // team / installation it is is only known at the callback, which does the exact check.
    if (!(await this.hasLiveConnection(accountId, provider))) {
      await this.assertSlotAvailable(accountId);
    } else {
      try {
        await this.assertSlotAvailable(accountId);
      } catch (e) {
        if (!(e instanceof PlanLimitExceededException)) throw e;
      }
    }

    const { nonce, challenge } = await this.states.create({
      provider,
      purpose: 'CONNECT',
      userId,
      accountId,
      usePkce: adapter.usesPkce,
    });
    return {
      authUrl: adapter.authorizeUrl({
        state: nonce,
        redirectUri: this.redirectUri(provider),
        pkceChallenge: challenge,
      }),
    };
  }

  /**
   * Step 3 of diagram 03. Never throws to the browser: every outcome is a redirect to the SPA, with
   * `?connected=` or `?error=<code>`. The state row is consumed FIRST and atomically, so a replayed
   * callback (or two racing ones) fails with `invalid_state` whatever happens afterwards.
   */
  async handleCallback(
    provider: IntegrationProvider,
    query: CallbackParams,
  ): Promise<string> {
    const back = (k: 'connected' | 'error', v: string) =>
      `${this.frontendUrl()}/settings/integrations?${k}=${encodeURIComponent(v)}`;

    const nonce = query.state;
    if (!nonce) return back('error', 'invalid_state');
    const state = await this.states.consume(provider, 'CONNECT', nonce);
    if (!state) return back('error', 'invalid_state');
    if (query.error) return back('error', 'denied');

    try {
      const allowed = await this.resolver.resolve(
        state.user_id,
        'manageIntegrations',
        'ACCOUNT',
        state.account_id,
      );
      if (!allowed.allowed) return back('error', 'forbidden');

      const adapter = this.registry.get(provider);
      const { tokens, account } = await adapter.exchangeCode(query, {
        redirectUri: this.redirectUri(provider),
        pkceVerifier: this.states.decryptVerifier(state),
      });

      const existing = await this.prisma.integrationConnection.findUnique({
        where: {
          accountId_provider_externalAccountId: {
            accountId: state.account_id,
            provider,
            externalAccountId: account.id,
          },
        },
        select: { id: true, status: true },
      });
      const takesNewSlot = !existing || !LIVE_STATUSES.includes(existing.status);
      if (takesNewSlot) await this.assertSlotAvailable(state.account_id);

      const connection = await this.prisma.$transaction(async (tx) => {
        const row = await tx.integrationConnection.upsert({
          where: {
            accountId_provider_externalAccountId: {
              accountId: state.account_id,
              provider,
              externalAccountId: account.id,
            },
          },
          create: {
            accountId: state.account_id,
            provider,
            externalAccountId: account.id,
            externalAccountName: account.name,
            scopes: tokens.scopes,
            createdById: state.user_id,
          },
          update: {
            externalAccountName: account.name,
            scopes: tokens.scopes,
            status: IntegrationConnectionStatus.ACTIVE,
            lastError: null,
          },
        });
        await this.credentials.store(row.id, tokens, tx);
        if (existing?.status === IntegrationConnectionStatus.REVOKED) {
          // ADR-0009 d.3: reconnecting revives the paused links.
          await tx.channelLink.updateMany({
            where: { connectionId: row.id, pausedAt: { not: null } },
            data: { pausedAt: null },
          });
        }
        return row;
      });

      await this.audit.record({
        actorId: state.user_id,
        accountId: state.account_id,
        action: AuditAction.INTEGRATION_CONNECTED,
        metadata: { connectionId: connection.id, provider },
      });
      // Best effort and AFTER the commit: a provider hiccup must not undo a successful connection (ADR-0012 d.8).
      try {
        await adapter.afterConnect?.(account);
      } catch (e) {
        this.logger.warn(`afterConnect failed for ${provider}: ${(e as Error).message}`);
      }
      return back('connected', provider.toLowerCase());
    } catch (e) {
      if (e instanceof PlanLimitExceededException) return back('error', 'plan_limit');
      // uq_integration_connections_live_external: that provider account is live in ANOTHER account.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return back('error', 'already_connected');
      this.logger.warn(
        `OAuth callback failed for ${provider}: ${(e as Error).name}: ${(e as Error).message}`,
      );
      return back('error', 'provider_error');
    }
  }

  private async hasLiveConnection(accountId: string, provider: IntegrationProvider): Promise<boolean> {
    return (
      (await this.prisma.integrationConnection.count({
        where: { accountId, provider, status: { in: LIVE_STATUSES } },
      })) > 0
    );
  }

  private async assertSlotAvailable(accountId: string): Promise<void> {
    const ok = await this.planLimits.checkLimit(
      'integration',
      'manageIntegrations',
      { accountId },
    );
    if (!ok) {
      throw new PlanLimitExceededException(
        'Your plan has reached its integration limit',
      );
    }
  }

  redirectUri(provider: IntegrationProvider): string {
    const base =
      this.config.get<string>('API_PUBLIC_URL') ??
      `http://localhost:${this.config.get<string>('PORT') ?? '3000'}`;
    return `${base.replace(/\/$/, '')}/integrations/${provider.toLowerCase()}/callback`;
  }

  private frontendUrl(): string {
    return (this.config.get<string>('FRONTEND_URL') ?? '').replace(/\/$/, '');
  }
}

