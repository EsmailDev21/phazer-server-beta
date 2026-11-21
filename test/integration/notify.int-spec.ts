/**
 * Step 2.3 - notification router (ADR-0011) against a real DB: routing rules, echo guard, silent/bulk,
 * burst cap, delivery job outcomes, failure disabling + alert, admin API. A FakeAdapter stands in for providers.
 */
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { Activity, ActivityAction, IntegrationProvider, Role } from '@prisma/client';
import { randomBytes } from 'crypto';
import { PermissionResolver } from '../../src/access-control/access-control.service';
import { PlanLimitsService } from '../../src/access-control/plan-limits.service';
import { TokenVaultService } from '../../src/crypto/token-vault.service';
import { ActivityService } from '../../src/events/activity.service';
import { AuditLogService } from '../../src/events/audit-log.service';
import { FeatureFlagsService } from '../../src/feature-flags/feature-flags.service';
import { FanoutService } from '../../src/activity-notifications/fanout/fanout.service';
import { NotificationsService } from '../../src/activity-notifications/notifications/notifications.service';
import { ConnectorRegistry } from '../../src/integrations/core/connector.registry';
import { CredentialService } from '../../src/integrations/core/credential.service';
import {
  ConnectorAdapter,
  INTEGRATION_ADAPTERS,
  NotifyContext,
  NotifyPermanentError,
} from '../../src/integrations/core/integration.types';
import { RedisLockService } from '../../src/integrations/core/redis-lock.service';
import { ChannelAdminService } from '../../src/integrations/notify/channel-admin.service';
import { NotificationRouter } from '../../src/integrations/notify/notification-router.service';
import { DISABLE_AFTER_FAILURES, NotifyDeliverJob } from '../../src/integrations/notify/notify-deliver.job';
import { DEFAULT_EVENTS, RichMessageBuilder } from '../../src/integrations/notify/rich-message.builder';
import { PrismaService } from '../../src/prisma/prisma.service';
import { JobHandlerRegistry } from '../../src/queue/job-handler.registry';
import { QueueService } from '../../src/queue/queue.service';
import { RedisService } from '../../src/redis/redis.service';
import { createProject, createTask, createUser, createUserWithAccount, createWorkspace, addAccountMember } from './factories';
import { disconnectTestPrisma, getTestPrisma } from './support/prisma-test-client';
import { resetDb } from './support/reset-db';

class FakeAdapter implements ConnectorAdapter {
  readonly provider = IntegrationProvider.DISCORD;
  readonly capabilities = new Set<never>();
  readonly usesPkce = false;
  sent: NotifyContext[] = [];
  notifyImpl: (c: NotifyContext) => Promise<void> = async () => undefined;
  canNotify = true;
  isConfigured() { return true; }
  authorizeUrl() { return 'x'; }
  async exchangeCode(): Promise<never> { throw new Error('unused'); }
  async revoke() { /* noop */ }
  get notify() {
    return this.canNotify ? async (c: NotifyContext) => { this.sent.push(c); return this.notifyImpl(c); } : undefined;
  }
}

const KEY = randomBytes(32).toString('base64');
const settings: Record<string, string> = { FRONTEND_URL: 'http://fe.test' };
const config = { get: (k: string) => settings[k] };

describe('notification router (step 2.3)', () => {
  let prisma: PrismaService;
  let adapter: FakeAdapter;
  let router: NotificationRouter;
  let job: NotifyDeliverJob;
  let admin: ChannelAdminService;
  let activities: ActivityService;
  let creds: CredentialService;
  let fanout: FanoutService;
  let emitter: EventEmitter2;
  const enqueued: Array<{ queue: string; name: string; payload: { deliveryId: string }; jobId?: string }> = [];
  let enqueueFails = false;
  let flagOn = true;
  const created: unknown[] = [];
  let worldSeq = 0; // every world gets its own guild: one live connection per provider tenant (step 2.4)

  beforeAll(async () => {
    prisma = getTestPrisma();
    adapter = new FakeAdapter();
    emitter = new EventEmitter2();
    const vault = new TokenVaultService({ TOKEN_VAULT_KEYS: `k1:${KEY}`, TOKEN_VAULT_CURRENT_KID: 'k1' } as never);
    const m = await Test.createTestingModule({
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: emitter },
        { provide: TokenVaultService, useValue: vault },
        { provide: RedisService, useValue: { configured: false, isReady: () => false } },
        { provide: ConfigService, useValue: config },
        { provide: INTEGRATION_ADAPTERS, useValue: [adapter] },
        { provide: FeatureFlagsService, useValue: { isEnabled: () => flagOn } },
        {
          provide: QueueService,
          useValue: {
            enqueue: async (queue: string, name: string, payload: { deliveryId: string }, o?: { jobId?: string }) => {
              if (enqueueFails) throw new Error('redis down');
              enqueued.push({ queue, name, payload, jobId: o?.jobId });
              return { id: o?.jobId ?? 'x' };
            },
          },
        },
        { provide: JobHandlerRegistry, useValue: { register: () => undefined, registerSchedule: () => undefined } },
        { provide: NotificationsService, useValue: { createNotification: async (n: unknown) => { created.push(n); } } },
        ActivityService, AuditLogService, PermissionResolver, PlanLimitsService, ConnectorRegistry, RedisLockService, CredentialService,
        RichMessageBuilder, NotificationRouter, NotifyDeliverJob, ChannelAdminService, FanoutService,
      ],
    }).compile();
    await m.init();
    router = m.get(NotificationRouter); job = m.get(NotifyDeliverJob); admin = m.get(ChannelAdminService);
    activities = m.get(ActivityService); creds = m.get(CredentialService); fanout = m.get(FanoutService);
    // what @OnEvent does in the real app
    emitter.on('activity.created', (a: Activity) => router.onActivity(a));
  });
  beforeEach(async () => {
    await resetDb(prisma);
    adapter.sent = []; adapter.notifyImpl = async () => undefined; adapter.canNotify = true;
    enqueued.length = 0; created.length = 0; enqueueFails = false; flagOn = true;
    delete settings.NOTIFY_MAX_PER_MINUTE;
  });
  afterAll(() => disconnectTestPrisma());

  /** Org account: OWNER + MEMBER, workspace, project + task, ACTIVE connection with a token, a channel link + default subscription. */
  async function world() {
    const { user: owner, account } = await createUserWithAccount(prisma, { role: Role.OWNER });
    await prisma.account.update({ where: { id: account.id }, data: { planType: 'ENTERPRISE_ORG' as never } });
    const member = await createUser(prisma);
    await addAccountMember(prisma, { accountId: account.id, userId: member.id, role: Role.MEMBER });
    const ws = await createWorkspace(prisma, { accountId: account.id });
    const project = await createProject(prisma, { workspaceId: ws.id, createdById: owner.id });
    const task = await createTask(prisma, { workspaceId: ws.id, createdById: owner.id, projectId: project.id, title: 'Fix login' });
    const conn = await prisma.integrationConnection.create({
      data: { accountId: account.id, provider: 'DISCORD', externalAccountId: `g-${++worldSeq}`, externalAccountName: 'Guild', createdById: owner.id },
    });
    await creds.store(conn.id, { accessToken: 'tok', scopes: [] });
    const link = await prisma.channelLink.create({ data: { connectionId: conn.id, kind: 'CHANNEL', externalId: 'chan-1', workspaceId: ws.id, configuredById: owner.id } });
    const sub = await prisma.channelSubscription.create({ data: { channelLinkId: link.id, events: [...DEFAULT_EVENTS] } });
    return { owner, member, account, ws, project, task, conn, link, sub };
  }
  type W = Awaited<ReturnType<typeof world>>;

  const act = (w: W, action: ActivityAction = 'STATUS_CHANGED', extra: Partial<Parameters<ActivityService['record']>[0]> = {}) =>
    prisma.activity.create({ data: { actorId: w.owner.id, action, targetType: 'TASK', targetId: w.task.id, workspaceId: w.ws.id, ...extra } as never });
  const deliveries = () => prisma.channelDelivery.findMany({ orderBy: { createdAt: 'asc' } });

  describe('routing', () => {
    it('matching event -> one PENDING delivery and one notify.deliver job with a deterministic id', async () => {
      const w = await world(); const a = await act(w);
      const r = await router.route(a);
      expect(r).toEqual([{ subscriptionId: w.sub.id, outcome: 'queued' }]);
      const [d] = await deliveries();
      expect(d).toMatchObject({ subscriptionId: w.sub.id, activityId: a.id, status: 'PENDING' });
      expect(enqueued).toEqual([{ queue: 'notify', name: 'notify.deliver', payload: { deliveryId: d.id }, jobId: `notify-${d.id}` }]);
    });

    it('event not subscribed, or an action no channel can subscribe to: nothing', async () => {
      const w = await world();
      expect(await router.route(await act(w, 'PRIORITY_CHANGED'))).toEqual([]);
      expect(await router.route(await act(w, 'REACTED'))).toEqual([]);
      expect(await router.route(await act(w, 'TAG_ADDED'))).toEqual([]);
      expect(await deliveries()).toHaveLength(0);
    });

    it('project scope: a project-bound link hears its project only; a workspace link hears both', async () => {
      const w = await world();
      const other = await createProject(prisma, { workspaceId: w.ws.id, createdById: w.owner.id });
      const otherTask = await createTask(prisma, { workspaceId: w.ws.id, createdById: w.owner.id, projectId: other.id });
      const l2 = await prisma.channelLink.create({ data: { connectionId: w.conn.id, kind: 'CHANNEL', externalId: 'chan-p', workspaceId: w.ws.id, projectId: w.project.id, configuredById: w.owner.id } });
      const s2 = await prisma.channelSubscription.create({ data: { channelLinkId: l2.id, events: ['STATUS_CHANGED'] } });
      const a1 = await act(w); // in w.project
      const a2 = await act(w, 'STATUS_CHANGED', { targetId: otherTask.id });
      expect((await router.route(a1)).map((x) => x.subscriptionId).sort()).toEqual([w.sub.id, s2.id].sort());
      expect((await router.route(a2)).map((x) => x.subscriptionId)).toEqual([w.sub.id]);
    });

    it.each([
      ['another workspace', async (w: W) => { const ws2 = await createWorkspace(prisma, { accountId: w.account.id }); await prisma.channelLink.update({ where: { id: w.link.id }, data: { workspaceId: ws2.id } }); }],
      ['link paused', async (w: W) => { await prisma.channelLink.update({ where: { id: w.link.id }, data: { pausedAt: new Date() } }); }],
      ['connection REVOKED', async (w: W) => { await prisma.integrationConnection.update({ where: { id: w.conn.id }, data: { status: 'REVOKED' } }); }],
      ['connection NEEDS_REAUTH', async (w: W) => { await prisma.integrationConnection.update({ where: { id: w.conn.id }, data: { status: 'NEEDS_REAUTH' } }); }],
      ['subscription disabled', async (w: W) => { await prisma.channelSubscription.update({ where: { id: w.sub.id }, data: { enabled: false } }); }],
      ['not a CHANNEL link', async (w: W) => { await prisma.channelLink.update({ where: { id: w.link.id }, data: { kind: 'GUILD' } }); }],
      ['connection of a DIFFERENT account (corrupt data, defence in depth)', async (w: W) => { const o = await createUserWithAccount(prisma, { role: Role.OWNER }); await prisma.integrationConnection.update({ where: { id: w.conn.id }, data: { accountId: o.account.id } }); }],
    ])('%s -> nothing is routed', async (_n, mutate) => {
      const w = await world(); await mutate(w);
      expect(await router.route(await act(w))).toEqual([]);
      expect(await deliveries()).toHaveLength(0); expect(enqueued).toHaveLength(0);
    });

    it('visibility: a SILENT activity needs a subscription that opted into SILENT', async () => {
      const w = await world();
      await prisma.channelSubscription.update({ where: { id: w.sub.id }, data: { events: ['DUE_DATE_APPROACHING'] } });
      const silent = await act(w, 'DUE_DATE_APPROACHING', { visibility: 'SILENT' });
      expect(await router.route(silent)).toEqual([]);
      await prisma.channelSubscription.update({ where: { id: w.sub.id }, data: { minVisibility: 'SILENT' } });
      expect(await router.route(silent)).toEqual([{ subscriptionId: w.sub.id, outcome: 'queued' }]);
    });

    it('feature flag off -> the router does nothing', async () => {
      const w = await world(); flagOn = false;
      expect(await router.route(await act(w))).toEqual([]);
      expect(await deliveries()).toHaveLength(0);
    });

    it('idempotent: routing the same activity twice creates one delivery and one job', async () => {
      const w = await world(); const a = await act(w);
      await router.route(a);
      expect(await router.route(a)).toEqual([{ subscriptionId: w.sub.id, outcome: 'duplicate' }]);
      expect(await deliveries()).toHaveLength(1); expect(enqueued).toHaveLength(1);
    });

    it('enqueue failure: delivery FAILED(enqueue_failed), no streak counted, the emitter never sees an exception', async () => {
      const w = await world(); enqueueFails = true; const a = await act(w);
      await expect(router.onActivity(a)).resolves.toBeUndefined();
      expect((await deliveries())[0]).toMatchObject({ status: 'FAILED', error: 'enqueue_failed' });
      expect((await prisma.channelSubscription.findUniqueOrThrow({ where: { id: w.sub.id } })).failureCount).toBe(0);
    });
  });

  describe('silent / bulk writes never notify (through the real ActivityService)', () => {
    const rec = (w: W, ctx?: Parameters<ActivityService['record']>[1]) =>
      activities.record({ actorId: w.owner.id, action: 'STATUS_CHANGED', targetType: 'TASK', targetId: w.task.id, workspaceId: w.ws.id }, ctx);
    const settle = () => new Promise((r) => setTimeout(r, 150));

    it('a normal write notifies; silent and bulk contexts leave history but notify nobody', async () => {
      const w = await world();
      await rec(w, { origin: 'MANUAL', actorId: w.owner.id });
      await settle(); expect(await deliveries()).toHaveLength(1);
      await rec(w, { origin: 'IMPORT', actorId: w.owner.id, silent: true });
      await rec(w, { origin: 'TEMPLATE', actorId: w.owner.id, bulk: true });
      await settle();
      expect(await prisma.activity.count()).toBe(3); // history kept
      expect(await deliveries()).toHaveLength(1); // ...but only the first notified
    });
  });

  describe('echo guard', () => {
    it('an INTEGRATION write from chan-1 is not posted back to chan-1 (SKIPPED echo) but IS posted to chan-2 - through the real emit path', async () => {
      const w = await world();
      const l2 = await prisma.channelLink.create({ data: { connectionId: w.conn.id, kind: 'CHANNEL', externalId: 'chan-2', workspaceId: w.ws.id, configuredById: w.owner.id } });
      const s2 = await prisma.channelSubscription.create({ data: { channelLinkId: l2.id, events: [...DEFAULT_EVENTS] } });
      const a = await activities.record(
        { actorId: w.owner.id, action: 'STATUS_CHANGED', targetType: 'TASK', targetId: w.task.id, workspaceId: w.ws.id },
        { origin: 'INTEGRATION', actorId: w.owner.id, integrationSource: { connectionId: w.conn.id, channelId: 'chan-1' } },
      );
      expect(a.metadata).toMatchObject({ origin: 'INTEGRATION', integration: { connectionId: w.conn.id, channelId: 'chan-1' } });
      await new Promise((r) => setTimeout(r, 200)); // the wired listener routes it asynchronously
      expect(await prisma.channelDelivery.findFirstOrThrow({ where: { subscriptionId: w.sub.id } })).toMatchObject({ status: 'SKIPPED', error: 'echo' });
      expect(await prisma.channelDelivery.findFirstOrThrow({ where: { subscriptionId: s2.id } })).toMatchObject({ status: 'PENDING' });
      expect(enqueued).toHaveLength(1);
      // routing it again changes nothing (idempotent)
      expect((await router.route(a)).map((x) => x.outcome)).toEqual(['duplicate', 'duplicate']);
    });

    it('same channel id on a DIFFERENT connection is not an echo', async () => {
      const w = await world();
      const a = await act(w, 'STATUS_CHANGED', { metadata: { integration: { connectionId: 'someone-else', channelId: 'chan-1' } } });
      expect((await router.route(a))[0].outcome).toBe('queued');
    });

    it('a write with no integration source (web UI) is never an echo', async () => {
      const w = await world();
      expect((await router.route(await act(w, 'STATUS_CHANGED', { metadata: { origin: 'MANUAL' } })))[0].outcome).toBe('queued');
    });
  });

  describe('burst cap', () => {
    it('beyond NOTIFY_MAX_PER_MINUTE: SKIPPED rate_capped, counted PER SUBSCRIPTION (a second channel has its own budget)', async () => {
      const w = await world(); settings.NOTIFY_MAX_PER_MINUTE = '3';
      const l2 = await prisma.channelLink.create({ data: { connectionId: w.conn.id, kind: 'CHANNEL', externalId: 'chan-2', workspaceId: w.ws.id, configuredById: w.owner.id } });
      const s2 = await prisma.channelSubscription.create({ data: { channelLinkId: l2.id, events: [...DEFAULT_EVENTS] } });
      for (let i = 0; i < 5; i++) await router.route(await act(w));
      for (const id of [w.sub.id, s2.id]) {
        expect(await prisma.channelDelivery.count({ where: { subscriptionId: id, status: 'PENDING' } })).toBe(3);
        expect(await prisma.channelDelivery.count({ where: { subscriptionId: id, status: 'SKIPPED', error: 'rate_capped' } })).toBe(2);
      }
      expect(enqueued).toHaveLength(6); // capped ones never reach the queue
    });

    it('the cap window slides: rows older than a minute do not count', async () => {
      const w = await world(); settings.NOTIFY_MAX_PER_MINUTE = '2';
      for (let i = 0; i < 2; i++) await router.route(await act(w));
      await prisma.channelDelivery.updateMany({ data: { createdAt: new Date(Date.now() - 61_000) } });
      expect((await router.route(await act(w)))[0].outcome).toBe('queued');
    });
  });

  describe('notify.deliver', () => {
    const run = async (deliveryId: string, jobInfo?: { attemptsMade: number; attempts: number }) =>
      job.handle({ v: 1, traceId: 't', accountId: null, actorId: null, payload: { deliveryId } }, jobInfo ? ({ attemptsMade: jobInfo.attemptsMade, opts: { attempts: jobInfo.attempts } } as never) : undefined);
    const pending = async (w: W, action: ActivityAction = 'STATUS_CHANGED', extra: Partial<Parameters<ActivityService['record']>[0]> = {}) => {
      await router.route(await act(w, action, extra)); return (await prisma.channelDelivery.findFirstOrThrow({ orderBy: { createdAt: 'desc' } })).id;
    };
    const delivery = (id: string) => prisma.channelDelivery.findUniqueOrThrow({ where: { id } });
    const sub = (id: string) => prisma.channelSubscription.findUniqueOrThrow({ where: { id } });

    it('sends a provider-neutral message with names, link and actor; marks SENT and resets the failure streak', async () => {
      const w = await world();
      const [from, to] = await prisma.workflowStatus.findMany({ where: { projectId: w.project.id }, orderBy: { position: 'asc' }, take: 2 });
      await prisma.channelSubscription.update({ where: { id: w.sub.id }, data: { failureCount: 2 } });
      const id = await pending(w, 'STATUS_CHANGED', { metadata: { fromStatusId: from.id, toStatusId: to.id, fromCategory: 'TODO', toCategory: 'IN_PROGRESS' } });
      await run(id);
      expect(adapter.sent).toHaveLength(1);
      const c = adapter.sent[0];
      expect(c).toMatchObject({ accessToken: 'tok', connection: { id: w.conn.id, externalAccountId: w.conn.externalAccountId }, channel: { kind: 'CHANNEL', externalId: 'chan-1' }, rateKey: `connection:${w.conn.id}` });
      expect(c.message.title).toBe(`${w.ws.key}-${w.task.number} Fix login`);
      expect(c.message.url).toBe(`http://fe.test/tasks/${w.ws.key}-${w.task.number}`);
      expect(c.message.summary).toBe(`Status: ${from.name} \u2192 ${to.name}`);
      expect(c.message.actor).toBeDefined(); expect(c.message.fields.some((f) => f.label === 'Project')).toBe(true);
      expect(await delivery(id)).toMatchObject({ status: 'SENT', attempts: 1, error: null });
      expect((await sub(w.sub.id)).failureCount).toBe(0);
    });

    it('free text is cut: a 500-char title cannot blow a provider limit', async () => {
      const w = await world(); await prisma.task.update({ where: { id: w.task.id }, data: { title: 'x'.repeat(500) } });
      await run(await pending(w));
      expect(adapter.sent[0].message.title.length).toBeLessThanOrEqual(200);
    });

    it('TASK_URL_TEMPLATE wins over the default link', async () => {
      const w = await world(); settings.TASK_URL_TEMPLATE = 'https://app.test/t/{id}?k={key}';
      try { await run(await pending(w)); } finally { delete settings.TASK_URL_TEMPLATE; }
      expect(adapter.sent[0].message.url).toBe(`https://app.test/t/${w.task.id}?k=${w.ws.key}-${w.task.number}`);
    });

    it('a delivery already processed is a no-op (retry / duplicate job)', async () => {
      const w = await world(); const id = await pending(w);
      await run(id); await run(id);
      expect(adapter.sent).toHaveLength(1);
    });

    it.each([
      ['subscription_disabled', async (w: W) => { await prisma.channelSubscription.update({ where: { id: w.sub.id }, data: { enabled: false } }); }],
      ['link_paused', async (w: W) => { await prisma.channelLink.update({ where: { id: w.link.id }, data: { pausedAt: new Date() } }); }],
      ['connection_inactive', async (w: W) => { await prisma.integrationConnection.update({ where: { id: w.conn.id }, data: { status: 'REVOKED' } }); }],
      ['adapter_cannot_notify', async () => { adapter.canNotify = false; }],
      ['target_gone', async (w: W) => { await prisma.task.delete({ where: { id: w.task.id } }); }],
      ['connection_needs_reauth', async (w: W) => { await creds.remove(w.conn.id); }],
    ])('state changed while queued (%s): SKIPPED, nothing sent, and it does not count as a failure', async (reason, mutate) => {
      const w = await world(); const id = await pending(w); await mutate(w);
      await run(id);
      expect(await delivery(id)).toMatchObject({ status: 'SKIPPED', error: reason });
      expect(adapter.sent).toHaveLength(0);
      expect((await sub(w.sub.id)).failureCount).toBe(0);
    });

    it('permanent errors: FAILED with the code; 3 CONSECUTIVE failures disable the subscription and raise ONE system audit alert', async () => {
      const w = await world(); adapter.notifyImpl = async () => { throw new NotifyPermanentError('channel_not_found'); };
      for (let i = 1; i <= DISABLE_AFTER_FAILURES; i++) {
        const id = await pending(w); await run(id);
        expect(await delivery(id)).toMatchObject({ status: 'FAILED', error: 'channel_not_found' });
        expect((await sub(w.sub.id)).enabled).toBe(i < DISABLE_AFTER_FAILURES);
      }
      const s = await sub(w.sub.id);
      expect(s).toMatchObject({ enabled: false, failureCount: DISABLE_AFTER_FAILURES });
      expect(s.disabledReason).toContain('channel_not_found');
      const alerts = await prisma.auditLog.findMany({ where: { action: 'INTEGRATION_SUBSCRIPTION_DISABLED' } });
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({ accountId: w.account.id, metadata: expect.objectContaining({ system: true, subscriptionId: w.sub.id, reason: 'channel_not_found' }) });
      // and a disabled subscription routes nothing further
      expect(await router.route(await act(w))).toEqual([]);
    });

    it('a success in between resets the streak: 2 failures, success, 1 failure -> still enabled', async () => {
      const w = await world();
      adapter.notifyImpl = async () => { throw new NotifyPermanentError('x'); };
      await run(await pending(w)); await run(await pending(w));
      adapter.notifyImpl = async () => undefined; await run(await pending(w));
      adapter.notifyImpl = async () => { throw new NotifyPermanentError('x'); }; await run(await pending(w));
      expect(await sub(w.sub.id)).toMatchObject({ enabled: true, failureCount: 1 });
    });

    it('failing together: many failing jobs at once still raise exactly one alert', async () => {
      const w = await world(); adapter.notifyImpl = async () => { throw new NotifyPermanentError('gone'); };
      await prisma.channelSubscription.update({ where: { id: w.sub.id }, data: { failureCount: 2 } });
      const ids: string[] = []; for (let i = 0; i < 4; i++) ids.push(await pending(w));
      await Promise.all(ids.map((id) => run(id)));
      expect(await prisma.auditLog.count({ where: { action: 'INTEGRATION_SUBSCRIPTION_DISABLED' } })).toBe(1);
    });

    it('transient error with attempts left: throws for the queue to retry, stays PENDING, no failure counted; on the last attempt it fails for real', async () => {
      const w = await world(); adapter.notifyImpl = async () => { throw new Error('ECONNRESET'); };
      const id = await pending(w);
      await expect(run(id, { attemptsMade: 0, attempts: 5 })).rejects.toThrow('ECONNRESET');
      expect(await delivery(id)).toMatchObject({ status: 'PENDING', attempts: 1 });
      expect((await sub(w.sub.id)).failureCount).toBe(0);
      await run(id, { attemptsMade: 4, attempts: 5 });
      expect(await delivery(id)).toMatchObject({ status: 'FAILED', error: 'retries_exhausted' });
      expect((await sub(w.sub.id)).failureCount).toBe(1);
    });

    it('a PENDING-skipped echo / rate_capped row is never sent', async () => {
      const w = await world();
      const a = await act(w, 'STATUS_CHANGED', { metadata: { integration: { connectionId: w.conn.id, channelId: 'chan-1' } } });
      await router.route(a);
      const d = await prisma.channelDelivery.findFirstOrThrow();
      await run(d.id);
      expect(adapter.sent).toHaveLength(0);
    });
  });

  describe('admin API', () => {
    it('create link -> subscribe (default events) -> list -> deliveries -> delete cascades', async () => {
      const w = await world();
      const link = await admin.createLink(w.conn.id, w.owner.id, { externalId: ' chan-9 ', workspaceId: w.ws.id, projectId: w.project.id });
      expect(link).toMatchObject({ kind: 'CHANNEL', externalId: 'chan-9', projectId: w.project.id, subscriptions: [] });
      const s = await admin.createSubscription(link.id, w.owner.id, {});
      expect(s.events.sort()).toEqual([...DEFAULT_EVENTS].sort());
      expect(s).toMatchObject({ minVisibility: 'TIMELINE', enabled: true, failureCount: 0 });
      expect((await admin.listLinks(w.conn.id, w.owner.id)).find((l) => l.id === link.id)?.subscriptions).toHaveLength(1);
      await router.route(await act(w)); // lands in the workspace-wide link and the new project link
      const log = await admin.deliveries(link.id, w.owner.id);
      expect(log).toHaveLength(1); expect(log[0]).toMatchObject({ status: 'PENDING' });
      await admin.deleteLink(link.id, w.owner.id);
      expect(await prisma.channelSubscription.count({ where: { channelLinkId: link.id } })).toBe(0);
      expect(await prisma.channelDelivery.count({ where: { subscriptionId: s.id } })).toBe(0);
    });

    it('validation: workspace/project of another tenant 400, duplicate channel 409, unknown connection 404, inactive 400', async () => {
      const w = await world(); const other = await world();
      await expect(admin.createLink(w.conn.id, w.owner.id, { externalId: 'c', workspaceId: other.ws.id })).rejects.toMatchObject({ status: 400 });
      await expect(admin.createLink(w.conn.id, w.owner.id, { externalId: 'c', workspaceId: w.ws.id, projectId: other.project.id })).rejects.toMatchObject({ status: 400 });
      await expect(admin.createLink(w.conn.id, w.owner.id, { externalId: 'chan-1', workspaceId: w.ws.id })).rejects.toMatchObject({ status: 409 });
      await expect(admin.createLink('nope', w.owner.id, { externalId: 'c', workspaceId: w.ws.id })).rejects.toMatchObject({ status: 404 });
      await prisma.integrationConnection.update({ where: { id: w.conn.id }, data: { status: 'REVOKED' } });
      await expect(admin.createLink(w.conn.id, w.owner.id, { externalId: 'c2', workspaceId: w.ws.id })).rejects.toMatchObject({ status: 400 });
    });

    it('events: unsubscribable actions rejected (400), duplicates collapsed; GUILD links cannot have subscriptions', async () => {
      const w = await world();
      await expect(admin.createSubscription(w.link.id, w.owner.id, { events: ['MENTIONED'] })).rejects.toMatchObject({ status: 400 });
      await expect(admin.createSubscription(w.link.id, w.owner.id, { events: ['REACTED', 'CREATED'] })).rejects.toMatchObject({ status: 400 });
      const s = await admin.createSubscription(w.link.id, w.owner.id, { events: ['CREATED', 'CREATED', 'ARCHIVED'] });
      expect(s.events.sort()).toEqual(['ARCHIVED', 'CREATED']);
      const g = await prisma.channelLink.create({ data: { connectionId: w.conn.id, kind: 'GUILD', externalId: 'guild', workspaceId: w.ws.id, configuredById: w.owner.id } });
      await expect(admin.createSubscription(g.id, w.owner.id, {})).rejects.toMatchObject({ status: 400 });
    });

    it('re-enabling a disabled subscription gives it a fresh start (failure count and reason cleared)', async () => {
      const w = await world();
      await prisma.channelSubscription.update({ where: { id: w.sub.id }, data: { enabled: false, failureCount: 3, disabledReason: 'x' } });
      expect(await admin.updateSubscription(w.sub.id, w.owner.id, { enabled: true })).toMatchObject({ enabled: true, failureCount: 0, disabledReason: null });
      expect(await admin.updateSubscription(w.sub.id, w.owner.id, { events: ['CREATED'], minVisibility: 'SILENT', enabled: false })).toMatchObject({ events: ['CREATED'], minVisibility: 'SILENT', enabled: false });
    });

    it('deliveries: newest first, limit clamped to 1..100', async () => {
      const w = await world();
      for (let i = 0; i < 3; i++) await router.route(await act(w));
      const log = await admin.deliveries(w.link.id, w.owner.id, 2);
      expect(log).toHaveLength(2);
      expect(log[0].createdAt.getTime()).toBeGreaterThanOrEqual(log[1].createdAt.getTime());
      expect(await admin.deliveries(w.link.id, w.owner.id, 0)).toHaveLength(1);
      expect(await admin.deliveries(w.link.id, w.owner.id, 10_000)).toHaveLength(3);
    });

    it('a plain MEMBER (no manageIntegrations) is refused on every route (403); another account sees 403 too', async () => {
      const w = await world(); const stranger = await createUser(prisma);
      for (const who of [w.member, stranger]) {
        await expect(admin.listLinks(w.conn.id, who.id)).rejects.toMatchObject({ status: 403 });
        await expect(admin.createLink(w.conn.id, who.id, { externalId: 'z', workspaceId: w.ws.id })).rejects.toMatchObject({ status: 403 });
        await expect(admin.deleteLink(w.link.id, who.id)).rejects.toMatchObject({ status: 403 });
        await expect(admin.createSubscription(w.link.id, who.id, {})).rejects.toMatchObject({ status: 403 });
        await expect(admin.updateSubscription(w.sub.id, who.id, { enabled: false })).rejects.toMatchObject({ status: 403 });
        await expect(admin.deleteSubscription(w.sub.id, who.id)).rejects.toMatchObject({ status: 403 });
        await expect(admin.deliveries(w.link.id, who.id)).rejects.toMatchObject({ status: 403 });
      }
      expect(await prisma.channelLink.count()).toBe(1);
    });
  });

  describe('alert reaches the admins (FanoutService, step 2.3 change)', () => {
    const audit = (w: W, system: boolean) => ({ id: 'a1', actorId: w.owner.id, accountId: w.account.id, metadata: system ? { system: true } : {} }) as never;

    it('a normal audit event still EXCLUDES the actor; a system event alerts every owner/admin INCLUDING the borrowed actor', async () => {
      const w = await world();
      await fanout.handleAuditLogCreated(audit(w, false));
      expect(created.map((c) => (c as { userId: string }).userId)).toEqual([]); // the only owner is the actor
      await fanout.handleAuditLogCreated(audit(w, true));
      expect(created.map((c) => (c as { userId: string; type: string }))).toEqual([expect.objectContaining({ userId: w.owner.id, type: 'ACCOUNT_ALERT' })]);
    });
  });
});
