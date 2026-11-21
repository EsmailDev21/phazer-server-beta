import { Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { RedisNotConfiguredError } from '../redis/redis.service';
import {
  EnqueueOptions,
  QueueService,
  QueueUnavailableError,
} from './queue.service';

const REAL = process.env.TEST_REDIS_URL;
const describeReal = REAL ? describe : describe.skip;
if (!REAL && process.env.CI) {
  throw new Error('TEST_REDIS_URL must be set in CI for queue.service.spec.ts');
}
if (!REAL) {
  // eslint-disable-next-line no-console
  console.warn(
    'queue.service.spec: TEST_REDIS_URL not set - skipping real-Redis tests.',
  );
}

const DEAD = 'redis://127.0.0.1:1';

describe('QueueService without a usable Redis', () => {
  it('configured is false when REDIS_URL is unset', () => {
    const svc = new QueueService({ url: undefined, prefix: 'test' });
    expect(svc.configured).toBe(false);
  });

  it('getQueue / enqueue throw RedisNotConfiguredError, not something opaque', async () => {
    const svc = new QueueService({ url: undefined, prefix: 'test' });
    expect(() => svc.getQueue('system')).toThrow(RedisNotConfiguredError);
    await expect(svc.enqueue('system', 'system.ping', {})).rejects.toThrow(
      RedisNotConfiguredError,
    );
  });

  it('enqueue against an unreachable Redis times out (bounded) with QueueUnavailableError', async () => {
    const svc = new QueueService({
      url: DEAD,
      prefix: 'test',
      enqueueTimeoutMs: 300,
    });
    const startedAt = Date.now();
    await expect(svc.enqueue('system', 'system.ping', {})).rejects.toThrow(
      QueueUnavailableError,
    );
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    await svc.onModuleDestroy();
  });

  it('onModuleDestroy on a never-used service is a no-op', async () => {
    const svc = new QueueService({ url: undefined, prefix: 'test' });
    await expect(svc.onModuleDestroy()).resolves.toBeUndefined();
  });
});

describeReal('QueueService against a real Redis', () => {
  const prefix = () => `test-${process.pid}-${Date.now()}`;
  const services: QueueService[] = [];
  const make = (
    opts: Partial<{ prefix: string; enqueueTimeoutMs: number }> = {},
  ) => {
    const svc = new QueueService({
      url: REAL,
      prefix: opts.prefix ?? prefix(),
      enqueueTimeoutMs: opts.enqueueTimeoutMs,
    });
    services.push(svc);
    return svc;
  };

  beforeEach(() => jest.spyOn(Logger.prototype, 'error').mockImplementation());
  afterEach(async () => {
    await Promise.all(services.splice(0).map((s) => s.onModuleDestroy()));
    jest.restoreAllMocks();
  });

  async function drain(queue: Queue) {
    await queue.obliterate({ force: true }).catch(() => undefined);
  }

  it('configured is true with a valid URL', () => {
    expect(make().configured).toBe(true);
  });

  it('enqueue adds a job whose data is a valid, buildEnvelope-shaped envelope', async () => {
    const svc = make();
    const { id } = await svc.enqueue(
      'system',
      'system.ping',
      { note: 'hi' },
      { ctx: { accountId: 'acc_1', actorId: 'user_1' } },
    );
    expect(typeof id).toBe('string');
    const job = await svc.getQueue('system').getJob(id);
    expect(job?.data).toEqual({
      v: 1,
      traceId: expect.any(String),
      accountId: 'acc_1',
      actorId: 'user_1',
      payload: { note: 'hi' },
    });
    await drain(svc.getQueue('system'));
  });

  it('jobId makes a duplicate enqueue a no-op: same job id, still one job', async () => {
    const svc = make();
    const queue = svc.getQueue('system');
    const opts: EnqueueOptions = { jobId: 'idempotent-1' };
    const a = await svc.enqueue('system', 'system.ping', {}, opts);
    const b = await svc.enqueue('system', 'system.ping', {}, opts);
    expect(a.id).toBe('idempotent-1');
    expect(b.id).toBe('idempotent-1');
    // NOTE: BullMQ 6's getJobCountByTypes treats 'wait' and 'waiting' as
    // separate (aliased) buckets that both count the same job - passing both
    // double-counts. Listing the actual jobs avoids that trap.
    const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
    expect(jobs).toHaveLength(1);
    await drain(queue);
  });

  it('default job options apply: attempts and backoff are set on the queued job', async () => {
    const svc = make();
    const { id } = await svc.enqueue('system', 'system.ping', {});
    const job = await svc.getQueue('system').getJob(id);
    expect(job?.opts.attempts).toBe(5);
    expect(job?.opts.backoff).toEqual({ type: 'exponential', delay: 1_000 });
    await drain(svc.getQueue('system'));
  });

  it('two different prefixes on the same Redis do not see each others jobs', async () => {
    const a = make({ prefix: `iso-a-${Date.now()}` });
    const b = make({ prefix: `iso-b-${Date.now()}` });
    const jobId = `shared-id-${Date.now()}`;
    await a.enqueue('system', 'system.ping', { note: 'a' }, { jobId });
    expect(await b.getQueue('system').getJob(jobId)).toBeUndefined();
    await drain(a.getQueue('system'));
    await drain(b.getQueue('system'));
  });

  it('onModuleDestroy closes the queue: getQueue after destroy opens a fresh one (proves it does not throw on reuse)', async () => {
    const svc = make();
    svc.getQueue('system');
    await svc.onModuleDestroy();
    expect(() => svc.getQueue('system')).not.toThrow();
    await drain(svc.getQueue('system'));
  });
});
