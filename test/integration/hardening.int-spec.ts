/**
 * Step 2.7 against a real DB: the connection health endpoint, the delivery retention sweep, credential re-encryption and the
 * shared-state metrics. (Slack uninstall + signing-secret rotation live in slack.int-spec; the prompt throttle in identity.int-spec.)
 */
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { IntegrationProvider, Role } from '@prisma/client';
import { randomBytes } from 'crypto';
import { PermissionResolver } from '../../src/access-control/access-control.service';
import { PlanLimitsService } from '../../src/access-control/plan-limits.service';
import { TokenVaultService } from '../../src/crypto/token-vault.service';
import { AuditLogService } from '../../src/events/audit-log.service';
import { ConnectorRegistry } from '../../src/integrations/core/connector.registry';
import { CredentialRotationService } from '../../src/integrations/core/credential-rotation.service';
import { CredentialService } from '../../src/integrations/core/credential.service';
import { IntegrationHealthService } from '../../src/integrations/core/integration-health.service';
import { ConnectorAdapter, INTEGRATION_ADAPTERS } from '../../src/integrations/core/integration.types';
import { RedisLockService } from '../../src/integrations/core/redis-lock.service';
import { ChannelDeliverySweepJob } from '../../src/integrations/notify/channel-delivery-sweep.job';
import { MetricsService } from '../../src/metrics/metrics.service';
import { SharedStateCollector } from '../../src/metrics/shared-state.collector';
import { PrismaService } from '../../src/prisma/prisma.service';
import { JobHandlerRegistry } from '../../src/queue/job-handler.registry';
import { QueueService } from '../../src/queue/queue.service';
import { RedisService } from '../../src/redis/redis.service';
import { addAccountMember, createProject, createTask, createUser, createUserWithAccount, createWorkspace } from './factories';
import { disconnectTestPrisma, getTestPrisma } from './support/prisma-test-client';
import { resetDb } from './support/reset-db';

const K1 = randomBytes(32).toString('base64');
const K2 = randomBytes(32).toString('base64');
const settings: Record<string, string> = { DISCORD_PUBLIC_KEY: 'a'.repeat(64), DISCORD_BOT_TOKEN: 'bot' };

class FakeDiscord implements ConnectorAdapter {
  readonly provider = IntegrationProvider.DISCORD;
  readonly capabilities = new Set<never>();
  readonly usesPkce = false;
  configured = true;
  refreshable = false;
  isConfigured() { return this.configured; }
  authorizeUrl() { return 'x'; }
  async exchangeCode(): Promise<never> { throw new Error('unused'); }
  async revoke() { /* noop */ }
  get refresh() { return this.refreshable ? async (t: never) => t : undefined; }
}

describe('step 2.7 hardening', () => {
  let prisma: PrismaService;
  let health: IntegrationHealthService;
  let creds: CredentialService;
  let adapter: FakeDiscord;
  let vault1: TokenVaultService;
  let vault12: TokenVaultService;
  let sweep: ChannelDeliverySweepJob;

  beforeAll(async () => {
    prisma = getTestPrisma();
    adapter = new FakeDiscord();
    vault1 = new TokenVaultService({ TOKEN_VAULT_KEYS: `k1:${K1}`, TOKEN_VAULT_CURRENT_KID: 'k1' } as never);
    vault12 = new TokenVaultService({ TOKEN_VAULT_KEYS: `k1:${K1},k2:${K2}`, TOKEN_VAULT_CURRENT_KID: 'k2' } as never);
    const m = await Test.createTestingModule({
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: new EventEmitter2() },
        { provide: TokenVaultService, useValue: vault1 },
        { provide: RedisService, useValue: { configured: false, isReady: () => false } },
        { provide: ConfigService, useValue: { get: (k: string) => settings[k] } },
        { provide: INTEGRATION_ADAPTERS, useValue: [adapter] },
        { provide: JobHandlerRegistry, useValue: { register: () => undefined, registerSchedule: () => undefined } },
        AuditLogService, PermissionResolver, PlanLimitsService, ConnectorRegistry, RedisLockService, CredentialService,
        IntegrationHealthService, ChannelDeliverySweepJob,
      ],
    }).compile();
    await m.init();
    health = m.get(IntegrationHealthService); creds = m.get(CredentialService); sweep = m.get(ChannelDeliverySweepJob);
  });
  beforeEach(async () => {
    await resetDb(prisma);
    adapter.configured = true; adapter.refreshable = false;
    Object.assign(settings, { DISCORD_PUBLIC_KEY: 'a'.repeat(64), DISCORD_BOT_TOKEN: 'bot' });
  });
  afterAll(() => disconnectTestPrisma());

  let seq = 0;
  async function world() {
    const { user: owner, account } = await createUserWithAccount(prisma, { role: Role.OWNER });
    await prisma.account.update({ where: { id: account.id }, data: { planType: 'ENTERPRISE_ORG' as never } });
    const admin = await createUser(prisma); await addAccountMember(prisma, { accountId: account.id, userId: admin.id, role: Role.ADMIN });
    const member = await createUser(prisma); await addAccountMember(prisma, { accountId: account.id, userId: member.id, role: Role.MEMBER });
    const ws = await createWorkspace(prisma, { accountId: account.id });
    const project = await createProject(prisma, { workspaceId: ws.id, createdById: owner.id, name: 'P' } as never);
    const conn = await prisma.integrationConnection.create({ data: { accountId: account.id, provider: 'DISCORD', externalAccountId: `g${++seq}`, externalAccountName: 'Guild', createdById: owner.id } });
    await creds.store(conn.id, { accessToken: 'secret-access-token', refreshToken: 'secret-refresh-token', scopes: [] });
    const link = await prisma.channelLink.create({ data: { connectionId: conn.id, kind: 'CHANNEL', externalId: 'c1', workspaceId: ws.id, projectId: project.id, configuredById: owner.id } });
    const sub = await prisma.channelSubscription.create({ data: { channelLinkId: link.id, events: [] } });
    return { owner, admin, member, account, ws, project, conn, link, sub };
  }
  type W = Awaited<ReturnType<typeof world>>;

  async function delivery(w: W, status: 'SENT' | 'FAILED' | 'SKIPPED' | 'PENDING', ageMs = 0, error: string | null = null) {
    const task = await createTask(prisma, { workspaceId: w.ws.id, createdById: w.owner.id, projectId: w.project.id, title: `t${++seq}` });
    const activity = await prisma.activity.create({ data: { actorId: w.owner.id, action: 'STATUS_CHANGED', targetType: 'TASK', targetId: task.id, workspaceId: w.ws.id } as never });
    const at = new Date(Date.now() - ageMs);
    return prisma.channelDelivery.create({ data: { subscriptionId: w.sub.id, activityId: activity.id, status, error, createdAt: at, updatedAt: at } });
  }

  // ------------------------------------------------------------------ health

  describe('GET /integrations/connections/:id/health', () => {
    it('a working connection is healthy; the report never contains token material', async () => {
      const w = await world();
      const h = await health.check(w.conn.id, w.owner.id);
      expect(h.verdict).toBe('healthy');
      expect(h.issues).toEqual([]);
      expect(h).toMatchObject({
        connection: { id: w.conn.id, provider: 'DISCORD', status: 'ACTIVE' },
        credential: { present: true, kid: 'k1', onCurrentKey: true, refreshable: false },
        provider: { configured: true, webhookSecretConfigured: true, botTokenConfigured: true },
        channels: { links: 1, pausedLinks: 0, subscriptionsEnabled: 1, subscriptionsDisabled: 0 },
        probedProvider: false,
      });
      expect(JSON.stringify(h)).not.toMatch(/secret-access-token|secret-refresh-token|v1:k1:/);
    });

    it('OWNER and ADMIN may look; a MEMBER, a stranger from another account and a non-existent id may not', async () => {
      const w = await world();
      await expect(health.check(w.conn.id, w.owner.id)).resolves.toBeDefined();
      await expect(health.check(w.conn.id, w.admin.id)).resolves.toBeDefined();
      await expect(health.check(w.conn.id, w.member.id)).rejects.toBeInstanceOf(ForbiddenException);
      const other = await createUserWithAccount(prisma, { role: Role.OWNER });
      await expect(health.check(w.conn.id, other.user.id)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(health.check('nope', w.owner.id)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('NEEDS_REAUTH, REVOKED and ERROR are "down" with their own code', async () => {
      const w = await world();
      const codes = async (status: 'NEEDS_REAUTH' | 'REVOKED' | 'ERROR') => {
        await prisma.integrationConnection.update({ where: { id: w.conn.id }, data: { status, lastError: status === 'ERROR' ? 'suspended' : null } });
        const h = await health.check(w.conn.id, w.owner.id);
        return { verdict: h.verdict, codes: h.issues.map((i) => i.code) };
      };
      expect(await codes('NEEDS_REAUTH')).toEqual({ verdict: 'down', codes: ['needs_reauth'] });
      expect(await codes('REVOKED')).toEqual({ verdict: 'down', codes: ['connection_revoked'] });
      expect(await codes('ERROR')).toEqual({ verdict: 'down', codes: ['connection_error'] });
    });

    it('credential problems: missing; encrypted with a key no longer in the ring (error); on an old key still in the ring (warning only)', async () => {
      const w = await world();
      // old key still in the ring: warning
      await prisma.integrationCredential.update({ where: { connectionId: w.conn.id }, data: { kid: 'k0', ciphertext: 'v1:k0:x:y:z' } });
      let h = await health.check(w.conn.id, w.owner.id);
      expect(h.verdict).toBe('down');
      expect(h.issues.map((i) => i.code)).toEqual(['credential_key_retired']);
      expect(h.credential).toMatchObject({ kid: 'k0', onCurrentKey: false });

      await prisma.integrationCredential.deleteMany({ where: { connectionId: w.conn.id } });
      h = await health.check(w.conn.id, w.owner.id);
      expect(h.issues.map((i) => i.code)).toEqual(['credential_missing']);
      expect(h.credential).toMatchObject({ present: false, kid: null, onCurrentKey: null });
    });

    it('a credential on a retained-but-not-current key is only a warning (degraded) until it is re-encrypted', async () => {
      const w = await world();
      const only = new TokenVaultService({ TOKEN_VAULT_KEYS: `k1:${K1},k2:${K2}`, TOKEN_VAULT_CURRENT_KID: 'k2' } as never);
      const svc = Object.create(health) as IntegrationHealthService;
      (svc as unknown as { vault: TokenVaultService }).vault = only;
      const h = await svc.check(w.conn.id, w.owner.id);
      expect(h.verdict).toBe('degraded');
      expect(h.issues).toEqual([expect.objectContaining({ code: 'credential_not_on_current_key', severity: 'warning' })]);
      await new CredentialRotationService(prisma, only).reencryptAll();
      expect((await svc.check(w.conn.id, w.owner.id)).verdict).toBe('healthy');
    });

    it('an expired token on a provider that cannot refresh is an error; one that CAN refresh is fine (refreshed on next use)', async () => {
      const w = await world();
      await prisma.integrationCredential.update({ where: { connectionId: w.conn.id }, data: { expiresAt: new Date(Date.now() - 60_000) } });
      expect((await health.check(w.conn.id, w.owner.id)).issues.map((i) => i.code)).toEqual(['credential_expired']);
      adapter.refreshable = true;
      expect((await health.check(w.conn.id, w.owner.id)).verdict).toBe('healthy');
    });

    it('server configuration: an unconfigured provider, a missing inbound secret and a missing Discord bot token each say so', async () => {
      const w = await world();
      adapter.configured = false;
      settings.DISCORD_PUBLIC_KEY = ''; settings.DISCORD_BOT_TOKEN = '';
      const h = await health.check(w.conn.id, w.owner.id);
      expect(h.verdict).toBe('down');
      expect(h.issues.map((i) => i.code).sort()).toEqual(['bot_token_missing', 'provider_not_configured', 'webhook_secret_missing']);
      expect(h.issues.find((i) => i.code === 'webhook_secret_missing')!.message).toContain('DISCORD_PUBLIC_KEY');
    });

    it('delivery picture: disabled subscriptions (with their reason), paused links, 24 h counts, last failure, and a stuck backlog', async () => {
      const w = await world();
      await delivery(w, 'SENT'); await delivery(w, 'SENT'); await delivery(w, 'SKIPPED');
      await delivery(w, 'FAILED', 0, 'retries_exhausted'); await delivery(w, 'FAILED', 0, 'forbidden'); await delivery(w, 'FAILED', 0, 'forbidden');
      await delivery(w, 'FAILED', 3 * 24 * 3600_000, 'old'); // outside the 24 h window
      await delivery(w, 'PENDING', 20 * 60_000);
      await prisma.channelSubscription.update({ where: { id: w.sub.id }, data: { enabled: false, disabledReason: '3 consecutive failures: forbidden' } });
      await prisma.channelLink.update({ where: { id: w.link.id }, data: { pausedAt: new Date() } });
      const h = await health.check(w.conn.id, w.owner.id);
      expect(h.deliveries.last24h).toEqual({ SENT: 2, FAILED: 3, SKIPPED: 1, PENDING: 1 });
      expect(h.deliveries.lastFailure?.error).toBeTruthy();
      expect(h.deliveries.oldestPendingAgeSeconds).toBeGreaterThanOrEqual(1190);
      expect(h.channels.disabled).toEqual([{ subscriptionId: w.sub.id, channelLinkId: w.link.id, reason: '3 consecutive failures: forbidden' }]);
      expect(h.verdict).toBe('degraded');
      expect(h.issues.map((i) => i.code).sort()).toEqual(['delivery_backlog', 'delivery_failures', 'links_paused', 'subscriptions_disabled']);
    });

    it('only THIS connection\u2019s deliveries count (another connection of the same account does not leak in)', async () => {
      const w = await world();
      await delivery(w, 'FAILED'); await delivery(w, 'FAILED');
      const conn2 = await prisma.integrationConnection.create({ data: { accountId: w.account.id, provider: 'DISCORD', externalAccountId: 'g-other', externalAccountName: 'Other', createdById: w.owner.id } });
      await creds.store(conn2.id, { accessToken: 'x', scopes: [] });
      const h = await health.check(conn2.id, w.owner.id);
      expect(h.deliveries.last24h).toEqual({ SENT: 0, FAILED: 0, SKIPPED: 0, PENDING: 0 });
      expect(h.deliveries.lastFailure).toBeNull();
    });
  });

  // ------------------------------------------------------------------ delivery retention

  describe('channel_deliveries retention sweep', () => {
    it('deletes rows past the retention in every status, keeps newer ones, and is idempotent', async () => {
      const w = await world();
      const DAY = 24 * 3600_000;
      const keep1 = await delivery(w, 'SENT', 2 * DAY);
      const keep2 = await delivery(w, 'FAILED', 29 * DAY);
      const keep3 = await delivery(w, 'PENDING', 1000);
      await delivery(w, 'SENT', 31 * DAY); await delivery(w, 'FAILED', 40 * DAY); await delivery(w, 'SKIPPED', 90 * DAY); await delivery(w, 'PENDING', 35 * DAY);
      expect(await sweep.sweep()).toEqual({ deleted: 4, hasMore: false, retentionDays: 30 });
      expect((await prisma.channelDelivery.findMany({ select: { id: true } })).map((r) => r.id).sort()).toEqual([keep1.id, keep2.id, keep3.id].sort());
      expect((await sweep.sweep()).deleted).toBe(0);
      // the subscription and the failure streak it carries are untouched
      expect(await prisma.channelSubscription.count({ where: { id: w.sub.id } })).toBe(1);
    });

    it('honours CHANNEL_DELIVERY_RETENTION_DAYS (and ignores a value below the 7-day floor)', async () => {
      const w = await world();
      const DAY = 24 * 3600_000;
      await delivery(w, 'SENT', 10 * DAY);
      settings.CHANNEL_DELIVERY_RETENTION_DAYS = '3'; // below the floor: 30 applies, the 10-day-old row stays
      expect((await sweep.sweep()).deleted).toBe(0);
      settings.CHANNEL_DELIVERY_RETENTION_DAYS = '7';
      expect(await sweep.sweep()).toMatchObject({ deleted: 1, retentionDays: 7 });
      delete settings.CHANNEL_DELIVERY_RETENTION_DAYS;
    });

    it('the created_at index exists (the sweep and the last-hour gauge filter on it alone)', async () => {
      const rows = await prisma.$queryRaw<Array<{ indexname: string }>>`SELECT indexname FROM pg_indexes WHERE tablename = 'channel_deliveries'`;
      expect(rows.map((r) => r.indexname)).toContain('idx_channel_deliveries_created_at');
    });
  });

  // ------------------------------------------------------------------ re-encryption

  describe('credential re-encryption (key rotation)', () => {
    it('k1 -> k2: every credential moves, tokens survive, the connection still works with the k2-only ring, and k1 can be retired', async () => {
      const a = await world(); const b = await world();
      const r = await new CredentialRotationService(prisma, vault12).reencryptAll();
      expect(r).toMatchObject({ currentKid: 'k2', scanned: 2, rotated: 2, failed: [] });
      expect((await prisma.integrationCredential.findMany({ select: { kid: true } })).map((x) => x.kid)).toEqual(['k2', 'k2']);

      // retire k1: a service whose ring holds ONLY k2 reads both credentials
      const k2only = new TokenVaultService({ TOKEN_VAULT_KEYS: `k2:${K2}`, TOKEN_VAULT_CURRENT_KID: 'k2' } as never);
      const m = await Test.createTestingModule({
        providers: [
          { provide: PrismaService, useValue: prisma }, { provide: TokenVaultService, useValue: k2only },
          { provide: ConnectorRegistry, useValue: {} }, { provide: RedisLockService, useValue: {} }, { provide: AuditLogService, useValue: {} }, CredentialService,
        ],
      }).compile();
      const c2 = m.get(CredentialService);
      expect(await c2.getAccessToken(a.conn.id)).toBe('secret-access-token');
      expect((await c2.load(b.conn.id))!.refreshToken).toBe('secret-refresh-token');
    });

    it('a retired key is detectable beforehand: a credential still on a key missing from the ring is reported, not destroyed', async () => {
      const w = await world();
      const k3 = randomBytes(32).toString('base64');
      const v3 = new TokenVaultService({ TOKEN_VAULT_KEYS: `k3:${k3}`, TOKEN_VAULT_CURRENT_KID: 'k3' } as never);
      const stuck = v3.encrypt('{"accessToken":"t","scopes":[]}');
      await prisma.integrationCredential.update({ where: { connectionId: w.conn.id }, data: { kid: 'k3', ciphertext: stuck } });
      const r = await new CredentialRotationService(prisma, vault12).reencryptAll();
      expect(r.failed).toEqual([{ connectionId: w.conn.id, error: 'TokenVaultUnknownKeyError' }]);
      expect((await prisma.integrationCredential.findUniqueOrThrow({ where: { connectionId: w.conn.id } })).ciphertext).toBe(stuck);
    });
  });

  // ------------------------------------------------------------------ metrics from shared state

  describe('shared-state metrics', () => {
    it('reflect the real tables: connections, last-hour deliveries, oldest pending, disabled subscriptions, credentials by key id', async () => {
      const w = await world(); await world();
      await delivery(w, 'SENT'); await delivery(w, 'FAILED'); await delivery(w, 'FAILED', 3 * 3600_000); // third is outside the hour
      await delivery(w, 'PENDING', 5 * 60_000);
      await prisma.channelSubscription.update({ where: { id: w.sub.id }, data: { enabled: false } });
      await prisma.integrationConnection.update({ where: { id: w.conn.id }, data: { status: 'NEEDS_REAUTH' } });
      const m = new MetricsService();
      const col = new SharedStateCollector(m, prisma, { configured: false } as unknown as QueueService);
      col.onModuleInit();
      const text = await m.render();
      expect(text).toContain('integration_connections{provider="DISCORD",status="ACTIVE"} 1');
      expect(text).toContain('integration_connections{provider="DISCORD",status="NEEDS_REAUTH"} 1');
      expect(text).toContain('integration_channel_deliveries_last_hour{provider="DISCORD",status="SENT"} 1');
      expect(text).toContain('integration_channel_deliveries_last_hour{provider="DISCORD",status="FAILED"} 1');
      expect(text).toContain('integration_channel_deliveries_last_hour{provider="DISCORD",status="PENDING"} 1');
      expect(text).toMatch(/integration_channel_delivery_oldest_pending_age_seconds (29\d|30\d)(\.\d+)?/);
      expect(text).toContain('integration_subscriptions_disabled 1');
      expect(text).toContain('integration_credentials_by_kid{kid="k1"} 2');
      expect(text).not.toMatch(/secret-access-token|v1:k1:/);
    });
  });
});
