/**
 * Proves the specific claim IMPLEMENTATION.md asks step 0.3 to prove:
 * "jobs run once across two workers". `reconcileSchedules` dedup itself is
 * already covered generically in worker-host.service.spec.ts (registering
 * the same schedule twice via one host is a no-op); this test goes one
 * step further and simulates two actually-separate worker PROCESSES for
 * the five real step-0.3 jobs — two independent `JobHandlerRegistry`
 * instances (as NestJS would build fresh per process), each populated by
 * running each job's real `onModuleInit()` with only its underlying
 * service mocked, then two independent `WorkerHostService` instances
 * pointed at the same real Redis/queue. Only one of the five schedulers
 * should exist afterwards for each job, not two.
 *
 * Same BullMQ stalled-checker timing note as worker-host.service.spec.ts
 * applies (see that file's header) — hence stalledIntervalMs kept low and
 * this file's own forceExit reliance via the shared jest config.
 */
import { Logger } from '@nestjs/common';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { JobHandlerRegistry } from '../queue/job-handler.registry';
import { QUEUES } from '../queue/queue.definitions';
import { QueueService } from '../queue/queue.service';
import { RedisService } from '../redis/redis.service';
import { WorkerHostService } from './worker-host.service';
import { DueDateReminderJob } from '../activity-notifications/activity/due-date-reminder.job';
import { DueDateReminderService } from '../activity-notifications/activity/due-date-reminder.service';
import { SnapCleanupJob } from '../snap/snap-cleanup.job';
import { SnapSessionsService } from '../snap/snap-sessions.service';
import { AttachmentCleanupJob } from '../attachments/attachment-cleanup.job';
import { AttachmentsService } from '../attachments/attachments.service';
import { BillingReconcileJob } from '../billing/billing-reconcile.job';
import { BillingService } from '../billing/billing.service';
import { AccountPurgeJob } from '../tenancy/accounts/account-purge.job';
import { AccountsService } from '../tenancy/accounts/accounts.service';

const REAL = process.env.TEST_REDIS_URL;
const describeReal = REAL ? describe : describe.skip;
if (!REAL && process.env.CI) {
  throw new Error(
    'TEST_REDIS_URL must be set in CI for system-sweeps.schedules.spec.ts',
  );
}
if (!REAL) {
  // eslint-disable-next-line no-console
  console.warn(
    'system-sweeps.schedules.spec: TEST_REDIS_URL not set - skipping.',
  );
}

const EXPECTED_SCHEDULER_IDS = [
  'due-date-reminders-daily',
  'snap-expire-stale-sessions-every-15m',
  'attachments-cleanup-abandoned-hourly',
  'billing-reconcile-overages-monthly',
  'account-purge-daily',
].sort();

/** Builds one "process worth" of the five real jobs, only their underlying
 * domain services mocked, wired into a fresh registry — mirrors exactly
 * what NestJS module bootstrap does for WorkerAppModule. */
function registerAllFiveJobs(registry: JobHandlerRegistry): void {
  new DueDateReminderJob(registry, {
    scanAndNotify: jest.fn(),
  } as unknown as DueDateReminderService).onModuleInit();
  new SnapCleanupJob(registry, {
    expireStaleSessions: jest.fn(),
  } as unknown as SnapSessionsService).onModuleInit();
  new AttachmentCleanupJob(registry, {
    cleanupAbandoned: jest.fn(),
  } as unknown as AttachmentsService).onModuleInit();
  new BillingReconcileJob(registry, {
    reconcileSeatOverages: jest.fn(),
  } as unknown as BillingService).onModuleInit();
  new AccountPurgeJob(
    registry,
    { listExpiredSoftDeletes: jest.fn() } as unknown as AccountsService,
    {} as BillingService,
    {} as AttachmentsService,
  ).onModuleInit();
}

describeReal('Step 0.3 sweep schedules across two independent workers', () => {
  const cleanups: Array<() => Promise<unknown>> = [];

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
  });
  afterEach(async () => {
    for (const fn of cleanups.splice(0).reverse())
      await fn().catch(() => undefined);
    jest.restoreAllMocks();
  });

  function buildWorker(prefix: string) {
    const registry = new JobHandlerRegistry();
    registerAllFiveJobs(registry);
    const queues = new QueueService({ url: REAL, prefix });
    const flags = new FeatureFlagsService({});
    const redis = new RedisService(REAL);
    redis.onModuleInit();
    const systemQueueDef = {
      ...QUEUES.SYSTEM,
      stalledIntervalMs: 250, // see file header note
    };
    const host = new WorkerHostService(registry, queues, flags, redis, {
      shutdownGraceMs: 1_000,
      heartbeatEveryMs: 200,
      heartbeatTtlSeconds: 5,
      definitions: [systemQueueDef],
    });
    cleanups.push(
      () => host.beforeApplicationShutdown('test-cleanup'),
      () => redis.onModuleDestroy(),
    );
    return { host, queues };
  }

  it('two independent workers reconciling the same five schedules leaves exactly five, not ten', async () => {
    const prefix = `sweeps-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const workerA = buildWorker(prefix);
    const workerB = buildWorker(prefix);
    cleanups.push(() =>
      workerA.queues
        .getQueue(QUEUES.SYSTEM.name)
        .obliterate({ force: true })
        .then(() => workerA.queues.onModuleDestroy()),
    );

    // Simulates two separate worker processes booting against the same
    // Redis/queue prefix, each running its own startup reconciliation.
    await (
      workerA.host as unknown as { reconcileSchedules(): Promise<void> }
    ).reconcileSchedules();
    await (
      workerB.host as unknown as { reconcileSchedules(): Promise<void> }
    ).reconcileSchedules();

    const schedulers = await workerA.queues
      .getQueue(QUEUES.SYSTEM.name)
      .getJobSchedulers();

    expect(schedulers).toHaveLength(5);
    expect(schedulers.map((s) => s.key).sort()).toEqual(EXPECTED_SCHEDULER_IDS);
  });
});
