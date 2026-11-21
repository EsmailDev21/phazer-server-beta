/**
 * Runs against a REAL Redis (TEST_REDIS_URL). Outage and recovery are produced
 * by a small TCP proxy in front of it, so the same tests work against a CI
 * service container we cannot stop and restart.
 *
 * Locally without TEST_REDIS_URL the suite is skipped (with a note). In CI it
 * FAILS instead of skipping: an unrun test must never look like a passing one.
 */
import * as net from 'net';
import { Logger } from '@nestjs/common';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { RedisHealthIndicator } from './redis-health.indicator';
import { RedisService } from './redis.service';

const TARGET = process.env.TEST_REDIS_URL;
if (!TARGET && process.env.CI) {
  throw new Error(
    'TEST_REDIS_URL must be set in CI (e.g. redis://localhost:6379); refusing to skip the real-Redis tests.',
  );
}
const describeReal = TARGET ? describe : describe.skip;
if (!TARGET) {
  // eslint-disable-next-line no-console
  console.warn(
    'redis.real.spec: TEST_REDIS_URL not set - skipping real-Redis tests.',
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, timeoutMs: number, what: string) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for: ${what}`);
    }
    await sleep(25);
  }
}

/** Forwards to the real Redis; can be stopped, restarted on the same port, or paused (black-holed). */
class TcpProxy {
  private server: net.Server | null = null;
  private sockets = new Set<net.Socket>();
  paused = false;
  port = 0;

  constructor(
    private readonly targetHost: string,
    private readonly targetPort: number,
  ) {}

  async start(): Promise<void> {
    this.server = net.createServer((client) => {
      const upstream = net.connect(this.targetPort, this.targetHost);
      this.sockets.add(client).add(upstream);
      client.on('data', (d) => {
        if (!this.paused) upstream.write(d); // paused: swallow, never answer
      });
      upstream.on('data', (d) => client.write(d));
      const closeBoth = () => {
        client.destroy();
        upstream.destroy();
      };
      client.on('error', closeBoth).on('close', closeBoth);
      upstream.on('error', closeBoth).on('close', closeBoth);
    });
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, '127.0.0.1', () => resolve());
    });
    this.port = (this.server.address() as net.AddressInfo).port; // reused on restart
  }

  /** Simulates Redis going away: drops every connection and refuses new ones. */
  async stop(): Promise<void> {
    this.sockets.forEach((s) => s.destroy());
    this.sockets.clear();
    const server = this.server;
    this.server = null;
    if (server) await new Promise((r) => server.close(r));
  }
}

describeReal('RedisService against a real Redis', () => {
  const parsed = new URL(TARGET ?? 'redis://localhost:6379');
  const targetHost = parsed.hostname;
  const targetPort = Number(parsed.port || 6379);
  const cleanups: Array<() => Promise<unknown>> = [];
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
  });
  afterEach(async () => {
    for (const fn of cleanups.splice(0).reverse()) await fn();
    jest.restoreAllMocks();
  });

  function connect(url: string) {
    const redis = new RedisService(url, { errorLogIntervalMs: 0 });
    const indicator = new RedisHealthIndicator(
      redis,
      new FeatureFlagsService({}),
    );
    redis.onModuleInit();
    cleanups.push(() => redis.onModuleDestroy());
    return { redis, indicator };
  }

  it('connects, reports up with a latency, and round-trips a value', async () => {
    const { redis, indicator } = connect(TARGET);
    await waitFor(() => redis.isReady(), 3_000, 'Redis to become ready');

    const probe = await indicator.probe();
    expect(probe.status).toBe('up');
    expect(typeof probe.latencyMs).toBe('number');
    expect(probe.latencyMs).toBeLessThan(500);

    const key = `test:redis-spec:${process.pid}:${Date.now()}`;
    const client = redis.getClient();
    await client.set(key, 'hello', 'EX', 30);
    expect(await client.get(key)).toBe('hello');
    await client.del(key);
  });

  describe('through a proxy we can break', () => {
    let proxy: TcpProxy;
    beforeEach(async () => {
      proxy = new TcpProxy(targetHost, targetPort);
      await proxy.start();
      cleanups.push(() => proxy.stop());
    });
    const proxyUrl = () => `redis://127.0.0.1:${proxy.port}`;

    it('outage: reported down at once, commands fail fast; recovery: reconnects by itself', async () => {
      const { redis, indicator } = connect(proxyUrl());
      await waitFor(() => redis.isReady(), 3_000, 'initial connection');
      expect((await indicator.probe()).status).toBe('up');

      await proxy.stop(); // Redis goes away
      await waitFor(
        () => !redis.isReady(),
        3_000,
        'client to notice the outage',
      );

      const startedAt = Date.now();
      expect(await indicator.probe()).toEqual({
        status: 'down',
        required: false,
      });
      expect(Date.now() - startedAt).toBeLessThan(100);
      await expect(redis.getClient().ping()).rejects.toThrow();

      await proxy.start(); // Redis comes back on the same port
      await waitFor(() => redis.isReady(), 10_000, 'automatic reconnection');

      const after = await indicator.probe();
      expect(after.status).toBe('up');
      expect(await redis.getClient().ping()).toBe('PONG');
      expect(logSpy).toHaveBeenCalledWith('Redis connection re-established');
    }, 30_000);

    it('a hung Redis (connected but not answering): probe gives up at its timeout instead of hanging /health', async () => {
      const { redis, indicator } = connect(proxyUrl());
      await waitFor(() => redis.isReady(), 3_000, 'initial connection');

      proxy.paused = true; // still connected, never replies
      const startedAt = Date.now();
      const probe = await indicator.probe(250);
      const took = Date.now() - startedAt;

      expect(probe).toEqual({ status: 'down', required: false });
      expect(took).toBeGreaterThanOrEqual(240);
      expect(took).toBeLessThan(1_000);
    });
  });
});
