/**
 * Runs against a REAL Redis (TEST_REDIS_URL), same convention as
 * redis.real.spec.ts. Proves the generic primitive works end to end:
 * two INDEPENDENT RedisPubSubService instances (each with its own
 * RedisService/connection, exactly as two separate processes would have)
 * sharing one real Redis - a subscribe on one and a publish on the other
 * must cross.
 */
import { Logger } from '@nestjs/common';
import { RedisPubSubService } from './redis-pubsub.service';
import { RedisService } from './redis.service';

const REAL = process.env.TEST_REDIS_URL;
const describeReal = REAL ? describe : describe.skip;
if (!REAL && process.env.CI) {
  throw new Error(
    'TEST_REDIS_URL must be set in CI for redis-pubsub.real.spec.ts',
  );
}
if (!REAL) {
  // eslint-disable-next-line no-console
  console.warn('redis-pubsub.real.spec: TEST_REDIS_URL not set - skipping.');
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

describeReal('RedisPubSubService against a real Redis', () => {
  const cleanups: Array<() => Promise<unknown>> = [];

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });
  afterEach(async () => {
    for (const fn of cleanups.splice(0).reverse())
      await fn().catch(() => undefined);
    jest.restoreAllMocks();
  });

  function build() {
    const redis = new RedisService(REAL);
    redis.onModuleInit();
    const pubsub = new RedisPubSubService(redis);
    cleanups.push(
      () => pubsub.onModuleDestroy(),
      () => redis.onModuleDestroy(),
    );
    return pubsub;
  }

  it('a message published on one connection is delivered to a handler subscribed on a different one', async () => {
    const publisherSide = build();
    const subscriberSide = build();
    const channel = `test:pubsub:${process.pid}:${Date.now()}`;
    const received: string[] = [];

    await subscriberSide.subscribe(channel, (msg) => received.push(msg));
    await sleep(100); // SUBSCRIBE is async over the wire; give it a moment to land

    await publisherSide.publish(channel, 'hello-across-connections');

    await waitFor(() => received.length > 0, 3_000, 'the message to arrive');
    expect(received).toEqual(['hello-across-connections']);
  });

  it('after unsubscribe, a further publish is not delivered', async () => {
    const publisherSide = build();
    const subscriberSide = build();
    const channel = `test:pubsub:${process.pid}:${Date.now()}:unsub`;
    const received: string[] = [];

    await subscriberSide.subscribe(channel, (msg) => received.push(msg));
    await sleep(100);
    await subscriberSide.unsubscribe(channel);
    await sleep(100);

    await publisherSide.publish(channel, 'should-not-arrive');
    await sleep(300);

    expect(received).toEqual([]);
  });

  it('one subscriber connection correctly routes two different channels to two different handlers', async () => {
    const publisherSide = build();
    const subscriberSide = build();
    const prefix = `test:pubsub:${process.pid}:${Date.now()}`;
    const receivedA: string[] = [];
    const receivedB: string[] = [];

    await subscriberSide.subscribe(`${prefix}:a`, (msg) => receivedA.push(msg));
    await subscriberSide.subscribe(`${prefix}:b`, (msg) => receivedB.push(msg));
    await sleep(100);

    await publisherSide.publish(`${prefix}:b`, 'for-b');
    await waitFor(() => receivedB.length > 0, 3_000, 'message for channel b');

    expect(receivedA).toEqual([]);
    expect(receivedB).toEqual(['for-b']);
  });
});
