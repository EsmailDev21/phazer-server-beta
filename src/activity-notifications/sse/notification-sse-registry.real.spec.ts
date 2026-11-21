/**
 * Runs against a REAL Redis (TEST_REDIS_URL), same convention as
 * redis.real.spec.ts / worker-host.service.spec.ts. Proves the exact
 * claim IMPLEMENTATION.md asks step 0.4 to prove: "two app instances:
 * user connected to A receives event triggered on B".
 *
 * Two INDEPENDENT `NotificationSseRegistry` instances, each with its own
 * `RedisPubSubService`/`RedisService` (exactly as two separate API
 * processes would have), sharing one real Redis:
 *   - instance A: the user's browser is connected (holds the Subject)
 *   - instance B: a write happens here (e.g. a request an LB routed to
 *     B, or a worker-process notification per ADR-0001) and calls
 *     `publish()`
 * The event must reach the Subject held by A, not B.
 */
import { Logger } from '@nestjs/common';
import { NotificationSseRegistry } from './notification-sse-registry.service';
import { RedisPubSubService } from '../../redis/redis-pubsub.service';
import { RedisService } from '../../redis/redis.service';

const REAL = process.env.TEST_REDIS_URL;
const describeReal = REAL ? describe : describe.skip;
if (!REAL && process.env.CI) {
  throw new Error(
    'TEST_REDIS_URL must be set in CI for notification-sse-registry.real.spec.ts',
  );
}
if (!REAL) {
  // eslint-disable-next-line no-console
  console.warn(
    'notification-sse-registry.real.spec: TEST_REDIS_URL not set - skipping.',
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, timeoutMs: number, what: string) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs)
      throw new Error(`timed out waiting for: ${what}`);
    await sleep(20);
  }
}

describeReal('SSE fan-out across two app instances (real Redis)', () => {
  const cleanups: Array<() => Promise<unknown>> = [];

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });
  afterEach(async () => {
    for (const fn of cleanups.splice(0).reverse())
      await fn().catch(() => undefined);
    jest.restoreAllMocks();
  });

  function buildInstance() {
    const redis = new RedisService(REAL);
    redis.onModuleInit();
    const pubsub = new RedisPubSubService(redis);
    const registry = new NotificationSseRegistry(pubsub);
    cleanups.push(
      () => pubsub.onModuleDestroy(),
      () => redis.onModuleDestroy(),
    );
    return registry;
  }

  const payload = {
    id: `notif-${Date.now()}`,
    type: 'TASK_ASSIGNED',
    sourceType: 'ACTIVITY',
    sourceId: 'a1',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  };

  it('user connected to instance A receives an event published on instance B', async () => {
    const instanceA = buildInstance();
    const instanceB = buildInstance();
    const userId = `u-${process.pid}-${Date.now()}`;

    const received: unknown[] = [];
    const subject = instanceA.connect(userId);
    subject.subscribe((v) => received.push(v));
    await sleep(150); // let the real SUBSCRIBE land before B publishes

    await instanceB.publish(userId, payload);

    await waitFor(() => received.length > 0, 3_000, 'the event to arrive on A');
    expect(received).toEqual([payload]);

    // And instance B, which never connected this user, never received it.
    instanceA.disconnect(userId, subject);
  });

  it('after the user disconnects from A, a further publish on B is not delivered anywhere (no leak, no crash)', async () => {
    const instanceA = buildInstance();
    const instanceB = buildInstance();
    const userId = `u-${process.pid}-${Date.now()}-gone`;

    const received: unknown[] = [];
    const subject = instanceA.connect(userId);
    subject.subscribe((v) => received.push(v));
    await sleep(150);
    instanceA.disconnect(userId, subject);
    await sleep(150);

    await instanceB.publish(userId, payload);
    await sleep(300);

    expect(received).toEqual([]);
  });

  it('two users connected to two different instances each only receive their own event', async () => {
    const instanceA = buildInstance();
    const instanceB = buildInstance();
    const base = `u-${process.pid}-${Date.now()}`;
    const userOnA = `${base}-a`;
    const userOnB = `${base}-b`;

    const receivedOnA: unknown[] = [];
    const receivedOnB: unknown[] = [];
    instanceA.connect(userOnA).subscribe((v) => receivedOnA.push(v));
    instanceB.connect(userOnB).subscribe((v) => receivedOnB.push(v));
    await sleep(150);

    // Both published from instance A, as if both writes happened to land there.
    await instanceA.publish(userOnA, { ...payload, id: 'for-a' });
    await instanceA.publish(userOnB, { ...payload, id: 'for-b' });

    await waitFor(
      () => receivedOnA.length > 0 && receivedOnB.length > 0,
      3_000,
      'both events to arrive',
    );
    expect(receivedOnA).toEqual([{ ...payload, id: 'for-a' }]);
    expect(receivedOnB).toEqual([{ ...payload, id: 'for-b' }]);
  });
});
