import * as net from 'net';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { RedisModule } from './redis.module';
import {
  RedisNotConfiguredError,
  RedisService,
  RedisServiceOptions,
} from './redis.service';

// Nothing listens on port 1: connection is refused immediately, like a Redis
// that is down. No server needed for any test in this file.
const DEAD = 'redis://127.0.0.1:1';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('RedisService without a usable Redis', () => {
  let errorSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  const unhandled = jest.fn();

  // Every service is destroyed in afterEach even if an assertion throws, so a
  // failing test can never leak a client that reconnects forever and hangs Jest.
  const created: RedisService[] = [];
  const make = (url: string | undefined, opts?: RedisServiceOptions) => {
    const svc = new RedisService(url, opts);
    created.push(svc);
    return svc;
  };

  beforeEach(() => {
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    process.on('unhandledRejection', unhandled);
  });
  afterEach(async () => {
    await Promise.all(created.map((svc) => svc.onModuleDestroy()));
    created.length = 0;
    process.off('unhandledRejection', unhandled);
    unhandled.mockClear();
    jest.restoreAllMocks();
  });

  describe('not configured', () => {
    it.each([undefined, '', '   '])(
      'REDIS_URL=%j: off, silent, init/destroy are no-ops',
      async (url) => {
        const svc = make(url);
        expect(svc.configured).toBe(false);
        await svc.onModuleInit();
        expect(svc.isReady()).toBe(false);
        expect(() => svc.getClient()).toThrow(RedisNotConfiguredError);
        await svc.onModuleDestroy();
        expect(warnSpy).not.toHaveBeenCalled(); // unset is normal
      },
    );

    it('a set-but-invalid REDIS_URL disables Redis with ONE warning, and does not throw', async () => {
      const svc = make('http://nope');
      expect(svc.configured).toBe(false);
      await svc.onModuleInit();
      await svc.onModuleDestroy();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain('redis:// or rediss://');
    });
  });

  describe('configured but Redis is down', () => {
    it('onModuleInit returns immediately and does not throw', async () => {
      const svc = make(DEAD);
      const startedAt = Date.now();
      expect(() => svc.onModuleInit()).not.toThrow();
      expect(Date.now() - startedAt).toBeLessThan(200);
      expect(svc.configured).toBe(true);
      expect(svc.isReady()).toBe(false);
      await svc.onModuleDestroy();
    });

    it('never produces an unhandled rejection or uncaught error event', async () => {
      const svc = make(DEAD);
      await svc.onModuleInit();
      await sleep(900); // several failed attempts + the rejected connect()
      await svc.onModuleDestroy();
      expect(unhandled).not.toHaveBeenCalled();
    });

    it('logs the first error, then suppresses repeats within the interval', async () => {
      const svc = make(DEAD, { errorLogIntervalMs: 60_000 });
      await svc.onModuleInit();
      await sleep(1_300); // ~4 attempts at 200/400/600ms backoff
      await svc.onModuleDestroy();
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0][0]).toContain('Redis connection error');
    });

    it('with a 0ms interval every failure is logged (proves suppression is what limited the count above)', async () => {
      const svc = make(DEAD, { errorLogIntervalMs: 0 });
      await svc.onModuleInit();
      await sleep(1_300);
      await svc.onModuleDestroy();
      expect(errorSpy.mock.calls.length).toBeGreaterThanOrEqual(3);
    });

    it('commands fail fast instead of queueing while Redis is away', async () => {
      const svc = make(DEAD);
      await svc.onModuleInit();
      const startedAt = Date.now();
      await expect(svc.getClient().ping()).rejects.toThrow();
      expect(Date.now() - startedAt).toBeLessThan(3_000);
      await svc.onModuleDestroy();
    });

    it('shutdown stops the reconnect loop', async () => {
      const svc = make(DEAD, { errorLogIntervalMs: 0 });
      await svc.onModuleInit();
      await sleep(500);
      await svc.onModuleDestroy();
      const atShutdown = errorSpy.mock.calls.length;
      await sleep(1_500); // longer than several backoff steps
      expect(errorSpy.mock.calls.length).toBe(atShutdown);
    });

    it('onModuleInit is idempotent: a second call keeps the same client instead of orphaning it', async () => {
      const svc = make(DEAD);
      svc.onModuleInit();
      const first = svc.getClient();
      svc.onModuleInit();
      expect(svc.getClient()).toBe(first);
    });

    it('shutdown while between reconnect attempts is prompt (no needless wait: there is no socket)', async () => {
      const svc = make(DEAD);
      svc.onModuleInit();
      await sleep(300); // refused once, now waiting to retry
      const startedAt = Date.now();
      await svc.onModuleDestroy();
      expect(Date.now() - startedAt).toBeLessThan(300);
    });

    it('shutdown with a socket open but a server that never answers still ends the connection', async () => {
      // Accepts TCP, never speaks Redis: the client sits in 'connect', socket open.
      const sockets: net.Socket[] = [];
      const server = net.createServer((sock) => sockets.push(sock));
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const { port } = server.address() as net.AddressInfo;
      try {
        const svc = make(`redis://127.0.0.1:${port}`);
        svc.onModuleInit();
        const client = svc.getClient();
        await sleep(300);
        expect(client.status).toBe('connect');

        const startedAt = Date.now();
        await svc.onModuleDestroy();
        expect(client.status).toBe('end');
        // ioredis destroys a peer that never closes after 2s; we must not hang
        // past that.
        expect(Date.now() - startedAt).toBeLessThan(3_000);
      } finally {
        sockets.forEach((s) => s.destroy());
        await new Promise((r) => server.close(r));
      }
    });

    it('onModuleDestroy is safe to call twice', async () => {
      const svc = make(DEAD);
      await svc.onModuleInit();
      await svc.onModuleDestroy();
      await expect(svc.onModuleDestroy()).resolves.toBeUndefined();
    });
  });

  describe('inside a Nest application', () => {
    const saved = process.env.REDIS_URL;
    afterEach(() => {
      if (saved === undefined) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = saved;
    });

    it('app.init() succeeds quickly and the process survives with Redis down', async () => {
      process.env.REDIS_URL = DEAD;
      const startedAt = Date.now();
      const moduleRef = await Test.createTestingModule({
        // FeatureFlagsModule is @Global in the real app; RedisModule's health
        // indicator needs it.
        imports: [
          (await import('../feature-flags/feature-flags.module'))
            .FeatureFlagsModule,
          RedisModule,
        ],
      }).compile();
      const app = moduleRef.createNestApplication();
      await app.init();
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(app.get(RedisService).configured).toBe(true);
      expect(app.get(RedisService).isReady()).toBe(false);
      await app.close();
      expect(unhandled).not.toHaveBeenCalled();
    });
  });
});
