import { assertFeatureFlagEnv } from '../feature-flags/assert-feature-env';
import { checkRedisUrl } from '../redis/redis-url';

/**
 * Boot check for the worker process. Unlike the API (where Redis is optional
 * until a flag needs it), a worker with no Redis has nothing to do, so a valid
 * REDIS_URL is ALWAYS required. `exit`/`log` are injectable for tests.
 */
export function assertWorkerEnv(
  env: NodeJS.ProcessEnv = process.env,
  exit: (code: number) => never = process.exit,
  log: Pick<Console, 'error' | 'warn'> = console,
): void {
  const redis = checkRedisUrl(env.REDIS_URL);
  if (!redis.ok) {
    log.error(
      `FATAL: REDIS_URL ${redis.reason}. The worker process needs Redis to run. Refusing to start.`,
    );
    exit(1);
  }
  assertFeatureFlagEnv(env, exit, log);
}
