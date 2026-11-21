import { Logger } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { HealthCheckError, TerminusModule } from '@nestjs/terminus';
import request from 'supertest';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { RedisHealthIndicator } from '../redis/redis-health.indicator';
import { RedisService } from '../redis/redis.service';
import { HealthController } from './health.controller';
import { PrismaHealthIndicator } from './prisma.health';

const DEAD = 'redis://127.0.0.1:1';

const cleanups: Array<() => Promise<unknown>> = [];

async function buildApp(opts: {
  dbUp: boolean;
  redisUrl?: string;
  env?: NodeJS.ProcessEnv;
}) {
  const redis = new RedisService(opts.redisUrl);
  const dbStub = {
    isHealthy: async (key: string) => {
      if (opts.dbUp) return { [key]: { status: 'up' } };
      throw new HealthCheckError('down', { [key]: { status: 'down' } });
    },
  };
  const moduleRef = await Test.createTestingModule({
    imports: [TerminusModule],
    controllers: [HealthController],
    providers: [
      { provide: PrismaHealthIndicator, useValue: dbStub },
      { provide: RedisService, useValue: redis },
      {
        provide: FeatureFlagsService,
        useValue: new FeatureFlagsService(opts.env ?? {}),
      },
      RedisHealthIndicator,
    ],
  }).compile();
  moduleRef.useLogger(false);
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  await app.init(); // runs redis.onModuleInit() as a provider lifecycle hook
  // Always torn down in afterEach, even when an assertion throws first.
  cleanups.push(
    () => redis.onModuleDestroy(),
    () => app.close(),
  );
  return { app, redis };
}

describe('GET /health', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });
  afterEach(async () => {
    await Promise.all(cleanups.map((fn) => fn()));
    cleanups.length = 0;
    jest.restoreAllMocks();
  });

  it('database up, Redis not configured: 200 ok, redis reported as not_configured, not degraded', async () => {
    const { app } = await buildApp({ dbUp: true });
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.details.redis).toEqual({
      status: 'not_configured',
      required: false,
    });
    expect(res.body.degraded).toEqual([]);
  });

  it('database up, Redis DOWN: still 200 "ok" - degraded, not failed', async () => {
    const { app } = await buildApp({ dbUp: true, redisUrl: DEAD });
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.details.redis).toEqual({ status: 'down', required: false });
    expect(res.body.degraded).toEqual(['redis']);
  });

  it('a Redis outage stays 200 even when a Redis-backed flag is on; `required` tells monitors it matters', async () => {
    const { app } = await buildApp({
      dbUp: true,
      redisUrl: DEAD,
      env: { FEATURE_IMPORTS: 'true' },
    });
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.body.details.redis).toEqual({ status: 'down', required: true });
    expect(res.body.degraded).toEqual(['redis']);
  });

  it('database DOWN: 503 regardless of Redis - the database still decides the status code', async () => {
    const { app } = await buildApp({ dbUp: false });
    const res = await request(app.getHttpServer()).get('/health').expect(503);
    expect(res.body.status).toBe('error');
  });

  it('keeps the pre-existing response fields (additive change only)', async () => {
    const { app } = await buildApp({ dbUp: true });
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(Object.keys(res.body).sort()).toEqual(
      ['degraded', 'details', 'error', 'info', 'status'].sort(),
    );
    expect(res.body.info.database).toEqual({ status: 'up' });
    expect(res.body.details.database).toEqual({ status: 'up' });
  });

  it('does not leak connection errors, hosts or ports into the public response', async () => {
    const { app } = await buildApp({ dbUp: true, redisUrl: DEAD });
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(JSON.stringify(res.body)).not.toMatch(/127\.0\.0\.1|ECONN|refused/);
  });
});
