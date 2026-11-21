import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IntegrationConnectionStatus, IntegrationProvider } from '@prisma/client';
import { PermissionResolver } from '../../access-control/access-control.service';
import { TokenVaultService } from '../../crypto/token-vault.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ConnectorRegistry } from './connector.registry';

export type HealthIssueCode =
  | 'connection_revoked'
  | 'needs_reauth'
  | 'connection_error'
  | 'credential_missing'
  | 'credential_key_retired'
  | 'credential_expired'
  | 'credential_not_on_current_key'
  | 'provider_not_configured'
  | 'webhook_secret_missing'
  | 'bot_token_missing'
  | 'links_paused'
  | 'subscriptions_disabled'
  | 'delivery_failures'
  | 'delivery_backlog';

export interface HealthIssue {
  code: HealthIssueCode;
  severity: 'warning' | 'error';
  message: string;
}

export interface ConnectionHealthDto {
  /** healthy = no issues; degraded = warnings only; down = at least one error (the connection cannot do its job). */
  verdict: 'healthy' | 'degraded' | 'down';
  issues: HealthIssue[];
  connection: {
    id: string;
    provider: IntegrationProvider;
    status: IntegrationConnectionStatus;
    externalAccountName: string;
    lastError: string | null;
    lastUsedAt: Date | null;
    createdAt: Date;
  };
  credential: {
    present: boolean;
    /** The key id only; never any part of the token or ciphertext. */
    kid: string | null;
    onCurrentKey: boolean | null;
    expiresAt: Date | null;
    refreshable: boolean;
  };
  provider: { configured: boolean; webhookSecretConfigured: boolean; botTokenConfigured: boolean | null };
  channels: {
    links: number;
    pausedLinks: number;
    subscriptionsEnabled: number;
    subscriptionsDisabled: number;
    disabled: Array<{ subscriptionId: string; channelLinkId: string; reason: string | null }>;
  };
  deliveries: {
    last24h: { SENT: number; FAILED: number; SKIPPED: number; PENDING: number };
    lastSentAt: Date | null;
    lastFailure: { at: Date; error: string | null } | null;
    oldestPendingAgeSeconds: number;
  };
  identities: { linked: number };
  /** No call is made to the provider: a page refresh must not spend the connection's rate budget. */
  probedProvider: false;
  checkedAt: Date;
}

/** The env each provider needs before its inbound traffic is accepted (ADR-0012/0013/0014). */
const INBOUND_SECRET_ENV: Record<IntegrationProvider, string> = {
  DISCORD: 'DISCORD_PUBLIC_KEY',
  SLACK: 'SLACK_SIGNING_SECRET',
  GITHUB: 'GITHUB_WEBHOOK_SECRET',
} as Record<IntegrationProvider, string>;

const BACKLOG_SECONDS = 10 * 60;
const FAILURE_RATE_MIN_SAMPLE = 5;

/**
 * Step 2.7 (ADR-0015 d.4). `GET /integrations/connections/:id/health`, owner/admin of the connection's account only
 * (`manageIntegrations`, resolved here like revoke does). Answers "why is this integration not working" from OUR state: connection
 * status, credential key and expiry, provider configuration, link/subscription state and the recent delivery record.
 */
@Injectable()
export class IntegrationHealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ConnectorRegistry,
    private readonly vault: TokenVaultService,
    private readonly config: ConfigService,
    private readonly resolver: PermissionResolver,
  ) {}

  async check(connectionId: string, userId: string): Promise<ConnectionHealthDto> {
    const conn = await this.prisma.integrationConnection.findUnique({
      where: { id: connectionId },
      select: {
        id: true, accountId: true, provider: true, status: true, externalAccountName: true, lastError: true, lastUsedAt: true, createdAt: true,
        credential: { select: { kid: true, expiresAt: true } },
      },
    });
    if (!conn) throw new NotFoundException('Connection not found');
    const allowed = await this.resolver.resolve(userId, 'manageIntegrations', 'ACCOUNT', conn.accountId);
    if (!allowed.allowed) throw new ForbiddenException(allowed.reason ?? 'Not allowed');

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [links, pausedLinks, subsEnabled, disabledSubs, grouped, lastSent, lastFailed, oldestPending, linked] = await Promise.all([
      this.prisma.channelLink.count({ where: { connectionId } }),
      this.prisma.channelLink.count({ where: { connectionId, pausedAt: { not: null } } }),
      this.prisma.channelSubscription.count({ where: { enabled: true, channelLink: { connectionId } } }),
      this.prisma.channelSubscription.findMany({
        where: { enabled: false, channelLink: { connectionId } },
        select: { id: true, channelLinkId: true, disabledReason: true },
        orderBy: { updatedAt: 'desc' },
        take: 10,
      }),
      this.prisma.channelDelivery.groupBy({ by: ['status'], where: { createdAt: { gt: since }, subscription: { channelLink: { connectionId } } }, _count: { _all: true } }),
      this.prisma.channelDelivery.findFirst({ where: { status: 'SENT', subscription: { channelLink: { connectionId } } }, orderBy: { updatedAt: 'desc' }, select: { updatedAt: true } }),
      this.prisma.channelDelivery.findFirst({ where: { status: 'FAILED', subscription: { channelLink: { connectionId } } }, orderBy: { updatedAt: 'desc' }, select: { updatedAt: true, error: true } }),
      this.prisma.channelDelivery.findFirst({ where: { status: 'PENDING', subscription: { channelLink: { connectionId } } }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
      this.prisma.identityLink.count({ where: { connectionId, userId: { not: null } } }),
    ]);
    const subsDisabledTotal = await this.prisma.channelSubscription.count({ where: { enabled: false, channelLink: { connectionId } } });

    const adapter = this.registry.has(conn.provider) ? this.registry.get(conn.provider) : undefined;
    const providerConfigured = adapter?.isConfigured() ?? false;
    const secretEnv = INBOUND_SECRET_ENV[conn.provider];
    const webhookSecretConfigured = secretEnv ? ((this.config.get<string>(secretEnv) ?? '').trim() !== '') : true;
    const botTokenConfigured = conn.provider === 'DISCORD' ? (this.config.get<string>('DISCORD_BOT_TOKEN') ?? '').trim() !== '' : null;

    const counts = { SENT: 0, FAILED: 0, SKIPPED: 0, PENDING: 0 };
    for (const g of grouped) counts[g.status as keyof typeof counts] = g._count._all;
    const oldestPendingAgeSeconds = oldestPending ? Math.max(0, Math.round((Date.now() - oldestPending.createdAt.getTime()) / 1000)) : 0;

    const cred = conn.credential;
    const onCurrentKey = cred && this.vault.configured ? cred.kid === this.vault.currentKid : null;
    const issues: HealthIssue[] = [];
    const add = (code: HealthIssueCode, severity: HealthIssue['severity'], message: string) => issues.push({ code, severity, message });

    if (conn.status === 'REVOKED') add('connection_revoked', 'error', 'This connection was disconnected (by a person or at the provider). Reconnect to resume; links and subscriptions are kept.');
    if (conn.status === 'NEEDS_REAUTH') add('needs_reauth', 'error', 'The provider rejected the stored credential. An owner or admin must reconnect.');
    if (conn.status === 'ERROR') add('connection_error', 'error', conn.lastError ?? 'The connection is in an error state.');
    if (conn.status === 'ACTIVE' || conn.status === 'NEEDS_REAUTH') {
      if (!cred) add('credential_missing', 'error', 'No credential is stored for this connection. Reconnect.');
    }
    if (cred) {
      if (!this.vault.configured || !this.vault.hasKey(cred.kid)) add('credential_key_retired', 'error', `The credential is encrypted with key "${cred.kid}", which is no longer in the key ring. It cannot be read; reconnect (see the key-rotation runbook).`);
      else if (onCurrentKey === false) add('credential_not_on_current_key', 'warning', `The credential is on key "${cred.kid}", not the current key. Run the re-encryption step of the key-rotation runbook before retiring that key.`);
      if (cred.expiresAt && cred.expiresAt.getTime() <= Date.now() && !adapter?.refresh) add('credential_expired', 'error', 'The access token has expired and this provider cannot refresh it. Reconnect.');
    }
    if (!providerConfigured) add('provider_not_configured', 'error', 'This provider is not configured on the server (missing client credentials).');
    if (!webhookSecretConfigured) add('webhook_secret_missing', 'error', `${secretEnv} is not set, so every request from ${conn.provider.toLowerCase()} is rejected.`);
    if (botTokenConfigured === false) add('bot_token_missing', 'warning', 'DISCORD_BOT_TOKEN is not set: slash commands are not registered and no notifications can be sent.');
    if (conn.status === 'ACTIVE' && links > 0 && pausedLinks > 0) add('links_paused', 'warning', `${pausedLinks} of ${links} channel link(s) are paused.`);
    if (subsDisabledTotal > 0) add('subscriptions_disabled', 'warning', `${subsDisabledTotal} subscription(s) are disabled (repeated delivery failures or manual).`);
    if (counts.FAILED + counts.SENT >= FAILURE_RATE_MIN_SAMPLE && counts.FAILED * 2 >= counts.FAILED + counts.SENT) add('delivery_failures', 'warning', `${counts.FAILED} of the last ${counts.FAILED + counts.SENT} deliveries (24 h) failed.`);
    if (oldestPendingAgeSeconds > BACKLOG_SECONDS) add('delivery_backlog', 'warning', `The oldest delivery has been waiting ${Math.round(oldestPendingAgeSeconds / 60)} minutes: is the worker running?`);

    const verdict: ConnectionHealthDto['verdict'] = issues.some((i) => i.severity === 'error') ? 'down' : issues.length ? 'degraded' : 'healthy';
    return {
      verdict,
      issues,
      connection: { id: conn.id, provider: conn.provider, status: conn.status, externalAccountName: conn.externalAccountName, lastError: conn.lastError, lastUsedAt: conn.lastUsedAt, createdAt: conn.createdAt },
      credential: { present: !!cred, kid: cred?.kid ?? null, onCurrentKey, expiresAt: cred?.expiresAt ?? null, refreshable: !!adapter?.refresh },
      provider: { configured: providerConfigured, webhookSecretConfigured, botTokenConfigured },
      channels: {
        links, pausedLinks, subscriptionsEnabled: subsEnabled, subscriptionsDisabled: subsDisabledTotal,
        disabled: disabledSubs.map((s) => ({ subscriptionId: s.id, channelLinkId: s.channelLinkId, reason: s.disabledReason })),
      },
      deliveries: {
        last24h: counts,
        lastSentAt: lastSent?.updatedAt ?? null,
        lastFailure: lastFailed ? { at: lastFailed.updatedAt, error: lastFailed.error } : null,
        oldestPendingAgeSeconds,
      },
      identities: { linked },
      probedProvider: false,
      checkedAt: new Date(),
    };
  }
}
