/**
 * These tests close BullMQ workers within milliseconds of creating them (by
 * design, for speed), which can race BullMQ 6.3.8's Worker.close(): its
 * stalled-checker only arms a cancel handle after its first async iteration,
 * so a worker closed before that can leave BullMQ's own 30s stalledInterval
 * timer running uncancelled. Confirmed by measurement (a standalone repro
 * exited at +30040ms, not open-ended) - not a leak in our code, but real
 * enough that the whole suite could hang. Two mitigations, both real:
 *  - QueueDefinition.stalledIntervalMs lets test queues use a short interval
 *    instead of BullMQ's 30s default (see ALWAYS/GATED below).
 *  - package.json's jest config sets forceExit:true as a backstop, because
 *    that mitigation narrows the window without provably closing it for
 *    every internal BullMQ timer. Every OTHER spec file in this repo passes
 *    --detectOpenHandles clean without forceExit; only this file needs it.
 */
import { Logger } from '@nestjs/common';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { JobHandlerRegistry } from '../queue/job-handler.registry';
import { QueueDefinition } from '../queue/queue.definitions';
import { QueueService } from '../queue/queue.service';
import { RedisService } from '../redis/redis.service';
import { WorkerHostService } from './worker-host.service';

const REAL = process.env.TEST_REDIS_URL;
const describeReal = REAL ? describe : describe.skip;
if (!REAL && process.env.CI) {
  throw new Error(
    'TEST_REDIS_URL must be set in CI for worker-host.service.spec.ts',
  );
}
if (!REAL) {
  // eslint-disable-next-line no-console
  console.warn('worker-host.service.spec: TEST_REDIS_URL not set - skipping.');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(
  cond: () => boolean | Promise<boolean>,
  timeoutMs: number,
  what: string,
) {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs)
      throw new Error(`timed out waiting for: ${what}`);
    await sleep(20);
  }
}

describeReal('WorkerHostService against a real Redis', () => {
  // stalledIntervalMs kept low: see QueueDefinition.stalledIntervalMs. These
  // tests close workers within milliseconds of creating them, which can race
  // BullMQ's own stalled-checker arming and otherwise leave the default 30s
  // timer running past the test (confirmed by measurement, not assumed).
  const ALWAYS: QueueDefinition = {
    name: 'wh-always',
    flag: null,
    concurrency: 2,
    stalledIntervalMs: 250,
  };
  const GATED: QueueDefinition = {
    name: 'wh-gated',
    flag: 'IMPORTS',
    concurrency: 1,
    stalledIntervalMs: 250,
  };
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

  function build(
    definitions: QueueDefinition[],
    env: NodeJS.ProcessEnv = {},
    hostOpts: Partial<{ shutdownGraceMs: number }> = {},
  ) {
    const prefix = `wh-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const registry = new JobHandlerRegistry();
    const queues = new QueueService({ url: REAL, prefix });
    const flags = new FeatureFlagsService(env);
    const redis = new RedisService(REAL);
    redis.onModuleInit();
    const host = new WorkerHostService(registry, queues, flags, redis, {
      shutdownGraceMs: hostOpts.shutdownGraceMs ?? 5_000,
      heartbeatEveryMs: 200,
      heartbeatTtlSeconds: 5,
      definitions,
    });
    cleanups.push(
      () => host.beforeApplicationShutdown('test-cleanup'),
      async () => {
        for (const def of definitions) {
          await queues
            .getQueue(def.name)
            .obliterate({ force: true })
            .catch(() => undefined);
        }
        await queues.onModuleDestroy();
      },
      () => redis.onModuleDestroy(),
    );
    return { host, registry, queues, redis };
  }

  it('starts a worker only for queues with no flag or an enabled flag', async () => {
    const { host } = build([ALWAYS, GATED], {});
    await host.onApplicationBootstrap();
    expect(host.activeQueueNames.sort()).toEqual([ALWAYS.name]);
  });

  it('a queue whose flag turns on gets a consumer', async () => {
    const { host } = build([ALWAYS, GATED], { FEATURE_IMPORTS: 'true' });
    await host.onApplicationBootstrap();
    expect(host.activeQueueNames.sort()).toEqual(
      [ALWAYS.name, GATED.name].sort(),
    );
  });

  it('bootstrap throws if REDIS_URL is not usable (the worker must not run with nothing to consume)', async () => {
    const registry = new JobHandlerRegistry();
    const queues = new QueueService({ url: undefined, prefix: 'x' });
    const host = new WorkerHostService(
      registry,
      queues,
      new FeatureFlagsService({}),
      new RedisService(undefined),
      { shutdownGraceMs: 1000, definitions: [ALWAYS] },
    );
    await expect(host.onApplicationBootstrap()).rejects.toThrow('REDIS_URL');
  });

  it('a registered handler actually processes an enqueued job (end-to-end)', async () => {
    const { host, registry, queues } = build([ALWAYS]);
    const seen: unknown[] = [];
    registry.register({
      queue: ALWAYS.name as never,
      jobName: 'system.ping',
      handle: async (envelope) => {
        seen.push(envelope);
        return 'ok';
      },
    });
    await host.onApplicationBootstrap();
    await queues.enqueue(ALWAYS.name as never, 'system.ping', { note: 'e2e' });
    await waitFor(() => seen.length === 1, 3_000, 'the job to be processed');
    expect((seen[0] as { payload: unknown }).payload).toEqual({ note: 'e2e' });
  });

  it('a job with no registered handler retries rather than vanishing (deploy-skew case)', async () => {
    const { host, queues } = build([ALWAYS]);
    await host.onApplicationBootstrap(); // no handler registered at all
    const { id } = await queues.enqueue(
      ALWAYS.name as never,
      'system.ping',
      {},
    );
    const queue = queues.getQueue(ALWAYS.name);
    // Not isFailed(): with attempts:5 and backoff, one failed attempt leaves
    // the job "delayed" awaiting retry, not in its terminal failed state.
    // attemptsMade going up is proof enough that it was retried, not dropped.
    await waitFor(
      async () => ((await queue.getJob(id))?.attemptsMade ?? 0) >= 1,
      3_000,
      'the unhandled job to record a failed attempt',
    );
    const job = await queue.getJob(id);
    expect(job?.attemptsMade).toBeGreaterThanOrEqual(1);
  });

  it('reconcileSchedules upserts a schedule idempotently: registering twice does not duplicate it', async () => {
    const { host, registry, queues } = build([ALWAYS]);
    registry.registerSchedule({
      queue: ALWAYS.name as never,
      schedulerId: 'sched-1',
      jobName: 'system.ping',
      payload: {},
      everyMs: 60_000,
    });
    await host.onApplicationBootstrap();
    const first = await queues.getQueue(ALWAYS.name).getJobSchedulers();
    await (
      host as unknown as { reconcileSchedules(): Promise<void> }
    ).reconcileSchedules();
    const second = await queues.getQueue(ALWAYS.name).getJobSchedulers();
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(second[0].key).toBe(first[0].key);
  });

  it("turning a flag off removes that queue's schedules (they would otherwise pile up unconsumed)", async () => {
    const registry = new JobHandlerRegistry();
    registry.registerSchedule({
      queue: GATED.name as never,
      schedulerId: 'sched-gated',
      jobName: 'system.ping',
      payload: {},
      everyMs: 60_000,
    });
    const prefix = `wh-flagoff-${Date.now()}`;
    const queues = new QueueService({ url: REAL, prefix });
    const redis = new RedisService(REAL);
    redis.onModuleInit();
    cleanups.push(
      () =>
        queues
          .getQueue(GATED.name)
          .obliterate({ force: true })
          .catch(() => undefined),
      () => queues.onModuleDestroy(),
      () => redis.onModuleDestroy(),
    );

    // 1. bring the schedule up while the flag is ON
    const on = new WorkerHostService(
      registry,
      queues,
      new FeatureFlagsService({ FEATURE_IMPORTS: 'true' }),
      redis,
      {
        shutdownGraceMs: 1000,
        definitions: [GATED],
      },
    );
    await on.onApplicationBootstrap();
    expect(await queues.getQueue(GATED.name).getJobSchedulers()).toHaveLength(
      1,
    );
    await on.beforeApplicationShutdown();

    // 2. same schedule registration, flag now OFF: must be swept
    const off = new WorkerHostService(
      registry,
      queues,
      new FeatureFlagsService({}),
      redis,
      {
        shutdownGraceMs: 1000,
        definitions: [GATED],
      },
    );
    await off.onApplicationBootstrap();
    expect(await queues.getQueue(GATED.name).getJobSchedulers()).toHaveLength(
      0,
    );
    expect(off.activeQueueNames).toEqual([]);
    await off.beforeApplicationShutdown();
  });

  it('close() shortly after start does not leave the process open (BullMQ stalledChecker race, see QueueDefinition.stalledIntervalMs)', async () => {
    // Reproduces the exact shape that was found to leak: a queue whose
    // schedule fires an immediate job with no registered handler (so it
    // fails right away), closed within milliseconds of the worker starting.
    // Regression coverage for the fix is the low stalledIntervalMs on ALWAYS/
    // GATED above; this test's own assertion is that shutdown is fast, i.e.
    // it is NOT quietly waiting out a 30s (or even 250ms-per-loop) timer.
    const { host, registry, queues } = build([GATED], {
      FEATURE_IMPORTS: 'true',
    });
    registry.registerSchedule({
      queue: GATED.name as never,
      schedulerId: 'race-sched',
      jobName: 'system.ping',
      payload: {},
      everyMs: 60_000,
    });
    await host.onApplicationBootstrap(); // no handler registered: the immediate occurrence fails fast
    const startedAt = Date.now();
    await host.beforeApplicationShutdown();
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    await queues
      .getQueue(GATED.name)
      .obliterate({ force: true })
      .catch(() => undefined);
  });

  it('sets a heartbeat key with a TTL, and removes it on shutdown', async () => {
    const { host, redis, queues } = build([ALWAYS]);
    await host.onApplicationBootstrap();
    await waitFor(
      async () => (await redis.getClient().exists(host.heartbeatKey)) === 1,
      1_000,
      'heartbeat to be set',
    );
    const ttl = await redis.getClient().ttl(host.heartbeatKey);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(5);
    await host.beforeApplicationShutdown();
    expect(await redis.getClient().exists(host.heartbeatKey)).toBe(0);
    await queues
      .getQueue(ALWAYS.name)
      .obliterate({ force: true })
      .catch(() => undefined);
  });

  it('shutdown lets an in-flight job finish within the grace period', async () => {
    const { host, registry, queues } = build(
      [ALWAYS],
      {},
      { shutdownGraceMs: 3_000 },
    );
    let started = false;
    let finished = false;
    registry.register({
      queue: ALWAYS.name as never,
      jobName: 'system.ping',
      handle: async () => {
        started = true;
        await sleep(300);
        finished = true;
        return 'ok';
      },
    });
    await host.onApplicationBootstrap();
    await queues.enqueue(ALWAYS.name as never, 'system.ping', {});
    await waitFor(() => started, 2_000, 'the job to start');

    await host.beforeApplicationShutdown('SIGTERM');
    expect(finished).toBe(true);
  });

  it('shutdown returns at the grace period, not when a slow job finally finishes', async () => {
    // A handler that never resolves at all cannot be tested safely here: per
    // BullMQ's Worker.close() (read in node_modules), once close() is called
    // a LATER close(true) is a no-op returning the same promise, so a worker
    // whose job truly never resolves cannot be force-closed by any public API
    // - it would leak a live Redis connection across test runs. A slow-but-
    // finite handler exercises the same code path (our wait is bounded) without
    // that risk, and additionally proves we really "moved on" rather than
    // having cancelled the job.
    const { host, registry, queues } = build(
      [ALWAYS],
      {},
      { shutdownGraceMs: 300 },
    );
    let finishedAt = 0;
    registry.register({
      queue: ALWAYS.name as never,
      jobName: 'system.ping',
      handle: async () => {
        await sleep(1_000);
        finishedAt = Date.now();
        return 'ok';
      },
    });
    await host.onApplicationBootstrap();
    await queues.enqueue(ALWAYS.name as never, 'system.ping', {});
    await sleep(100); // let it start

    const startedAt = Date.now();
    await host.beforeApplicationShutdown('SIGTERM');
    const shutdownTook = Date.now() - startedAt;
    expect(shutdownTook).toBeGreaterThanOrEqual(280);
    expect(shutdownTook).toBeLessThan(700); // bounded by the 300ms grace, not the 1000ms job

    expect(finishedAt).toBe(0); // moved on before the job was done...
    await waitFor(
      () => finishedAt > 0,
      2_000,
      'the job to finish in the background',
    );
    expect(finishedAt).toBeGreaterThan(0); // ...but it really did complete, not get cancelled

    // Test hygiene, not a production concern: the job finishing lets the
    // dangling worker.close() (started above, never awaited by production
    // code either - see the comment on beforeApplicationShutdown) actually
    // complete and release its own Redis connection, separate from anything
    // RedisService/QueueService own. Wait for that so this test does not leak
    // a live socket into the next one / the process exit check.
    await waitFor(
      async () =>
        (await queues.getQueue(ALWAYS.name).getWorkers()).length === 0,
      2_000,
      "the abandoned worker's own connection to finish closing",
    );
  });
});
