import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { RedisHealthIndicator } from './redis-health.indicator';
import { RedisService } from './redis.service';
import { Logger } from '@nestjs/common';

const DEAD = 'redis://127.0.0.1:1';

const created: RedisService[] = [];

describe('RedisHealthIndicator (no Redis server needed)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });
  afterEach(async () => {
    await Promise.all(created.map((r) => r.onModuleDestroy()));
    created.length = 0;
    jest.restoreAllMocks();
  });

  const indicator = (url: string | undefined, env: NodeJS.ProcessEnv = {}) =>
    new RedisHealthIndicator(
      new RedisService(url),
      new FeatureFlagsService(env),
    );

  it('not configured: reports not_configured, not down', async () => {
    expect(await indicator(undefined).probe()).toEqual({
      status: 'not_configured',
      required: false,
    });
  });

  it('down is reported immediately (no PING queued behind a dead connection) and carries no error text', async () => {
    const redis = new RedisService(DEAD);
    created.push(redis);
    const ind = new RedisHealthIndicator(redis, new FeatureFlagsService({}));
    await redis.onModuleInit();

    const startedAt = Date.now();
    const result = await ind.probe();
    expect(Date.now() - startedAt).toBeLessThan(100);
    expect(result).toEqual({ status: 'down', required: false });
    // /health is public: nothing about hosts, ports or errors may leak.
    expect(JSON.stringify(result)).not.toMatch(/127\.0\.0\.1|ECONN|refused|:1/);
  });

  it('required is true exactly when a Redis-backed flag is on', async () => {
    for (const flag of ['INTEGRATIONS', 'IMPORTS']) {
      const r = await indicator(undefined, {
        [`FEATURE_${flag}`]: 'true',
      }).probe();
      expect(r.required).toBe(true);
    }
    for (const flag of ['WORKFLOW', 'TEMPLATES', 'MARKETPLACE']) {
      const r = await indicator(undefined, {
        [`FEATURE_${flag}`]: 'true',
      }).probe();
      expect(r.required).toBe(false);
    }
  });
});
