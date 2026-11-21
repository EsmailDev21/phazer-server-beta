import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { RedisService } from '../../redis/redis.service';

export class LockTimeoutError extends Error {
  constructor(key: string) {
    super(`Could not acquire lock "${key}" in time`);
    this.name = 'LockTimeoutError';
  }
}

// Delete only if we still own it (a slow holder must not release someone else's lock).
const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

/**
 * Mutual exclusion across processes via Redis `SET NX PX`. Without Redis (tests, single-process dev) it
 * falls back to an in-process queue, which is correct for one process and nothing more - production
 * with FEATURE_INTEGRATIONS on is required to have Redis (ADR-0002), so the fallback never serves it.
 */
@Injectable()
export class RedisLockService {
  private readonly logger = new Logger(RedisLockService.name);
  private readonly local = new Map<string, Promise<void>>();

  constructor(private readonly redis: RedisService) {}

  async withLock<T>(
    key: string,
    ttlMs: number,
    fn: () => Promise<T>,
    opts: { waitMs?: number; retryMs?: number } = {},
  ): Promise<T> {
    if (!this.redis.configured || !this.redis.isReady()) {
      return this.withLocalLock(key, fn);
    }
    const client = this.redis.getClient();
    const token = randomBytes(16).toString('hex');
    const redisKey = `lock:${key}`;
    const waitMs = opts.waitMs ?? 10_000;
    const retryMs = opts.retryMs ?? 50;
    const deadline = Date.now() + waitMs;

    for (;;) {
      const ok = await client.set(redisKey, token, 'PX', ttlMs, 'NX');
      if (ok === 'OK') break;
      if (Date.now() >= deadline) throw new LockTimeoutError(key);
      await new Promise((r) => setTimeout(r, retryMs));
    }
    try {
      return await fn();
    } finally {
      try {
        await client.eval(RELEASE, 1, redisKey, token);
      } catch (e) {
        this.logger.warn(`Lock release failed for ${key}: ${(e as Error).message}`);
      }
    }
  }

  private async withLocalLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.local.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const chain = prev.then(() => mine);
    this.local.set(key, chain);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.local.get(key) === chain) this.local.delete(key);
    }
  }
}
