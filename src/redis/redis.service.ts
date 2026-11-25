import { Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import {
  checkRedisUrl,
  describeRedisTarget,
  redisErrorHint,
  type RedisTarget,
} from './redis-url';

export class RedisNotConfiguredError extends Error {
  constructor() {
    super(
      'Redis is not configured (REDIS_URL is unset or invalid). Check RedisService.configured before using it, or turn on a feature flag that requires it.',
    );
    this.name = 'RedisNotConfiguredError';
  }
}

export interface RedisServiceOptions {
  /** Minimum gap between logged connection errors while Redis stays down. */
  errorLogIntervalMs?: number;
}

/**
 * Owns the process's general-purpose Redis connection (ADR-0001).
 *
 * The one rule: **Redis being down must never stop the app from booting or
 * crash it.** Verified against ioredis 5, each of these is a real way to get
 * that wrong, and each is handled here:
 *
 *  - `connect()` REJECTS on the first failed attempt yet ioredis keeps
 *    reconnecting. An unhandled rejection kills a Node 22 process, so the
 *    promise is always caught and never awaited by boot.
 *  - ioredis emits an `error` event per failed attempt. With no listener that
 *    is an uncaught exception; with a naive listener it floods the log. The
 *    listener logs at most once per `errorLogIntervalMs` and logs recovery.
 *  - Commands issued while down fail fast (`maxRetriesPerRequest: 1`) instead
 *    of queueing for as long as Redis is away.
 *
 * Deliberately NOT @Injectable(): RedisModule builds it from a factory so tests
 * can pass an explicit URL instead of mutating process.env.
 */
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly errorLogIntervalMs: number;
  private client: Redis | null = null;
  private lastErrorLoggedAt = 0;
  private suppressedErrors = 0;
  private inFailure = false;

  /** True when REDIS_URL is set and valid. Says nothing about reachability. */
  readonly configured: boolean;

  /** Host, port and TLS of the configured URL (never the password); for logs. */
  private readonly target: RedisTarget | null;

  constructor(
    private readonly url: string | undefined,
    options: RedisServiceOptions = {},
  ) {
    this.errorLogIntervalMs = options.errorLogIntervalMs ?? 30_000;
    const check = checkRedisUrl(url);
    this.configured = check.ok;
    this.target = describeRedisTarget(url);

    // An unset URL is normal (Redis is optional until a flag needs it) and is
    // not logged. A URL that is set but wrong deserves a warning, but only a
    // warning: boot-time enforcement lives in assertFeatureFlagEnv and applies
    // only when a Redis-backed flag is on.
    if (!check.ok && url !== undefined && url.trim() !== '') {
      this.logger.warn(
        `REDIS_URL ${check.reason}; Redis is disabled for this process.`,
      );
    }
  }

  onModuleInit(): void {
    // Idempotent: a second call must not overwrite (and so orphan) a live client.
    if (!this.configured || this.client) return;

    if (this.target) {
      this.logger.log(
        `Connecting to Redis at ${this.target.host}:${this.target.port} (${this.target.tls ? 'TLS' : 'no TLS'}, ${this.target.hasPassword ? 'password set' : 'no password'})`,
      );
    }
    this.client = new Redis(this.url.trim(), {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 5_000,
      retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
    });

    this.client.on('error', (err: Error) => this.onError(err));
    this.client.on('ready', () => this.onReady());

    // Not awaited, always caught: see the class comment.
    this.client.connect().catch(() => {
      /* already reported by the 'error' listener; ioredis keeps retrying */
    });
  }

  async onModuleDestroy(): Promise<void> {
    const client = this.client;
    if (!client) return;
    this.client = null;
    try {
      if (client.status === 'ready') {
        await Promise.race([
          client.quit(),
          new Promise((resolve) => setTimeout(resolve, 2_000).unref()),
        ]);
      }
    } catch {
      /* fall through to a hard disconnect */
    } finally {
      // disconnect() (reconnect=false) is what stops the retry loop.
      // Only wait when a socket may be open. Between reconnect attempts
      // ('reconnecting'/'wait') there is none, ioredis emits no 'end' and its
      // status stays 'reconnecting' even though the retry loop has stopped.
      const socketMayBeOpen = ['connecting', 'connect', 'ready'].includes(
        client.status,
      );
      // Known ioredis behaviour: disconnect() arms a 2s destroy-timer that only
      // clears when the socket closes. Between attempts there is no live socket,
      // so the timer simply runs out: the process can take up to 2s longer to
      // exit. Harmless; measured, not a leak.
      client.disconnect();
      if (socketMayBeOpen) await this.waitForEnd(client);
    }
  }

  /**
   * disconnect() returns before an open socket has finished closing (ioredis
   * keeps a 2s destroy-timer alive until it does). Wait, bounded, for the 'end'
   * event so shutdown really releases the connection. ioredis force-destroys a
   * peer that never closes after 2s, so 2.5s bounds the worst case (a hung
   * Redis); a healthy one closes immediately.
   */
  private waitForEnd(client: Redis, timeoutMs = 2_500): Promise<void> {
    if (client.status === 'end') return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      timer.unref();
      client.once('end', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** The shared client. Throws RedisNotConfiguredError when Redis is off. */
  getClient(): Redis {
    if (!this.configured || !this.client) throw new RedisNotConfiguredError();
    return this.client;
  }

  /** True only when the connection is established right now. */
  isReady(): boolean {
    return this.client?.status === 'ready';
  }

  private onError(err: Error): void {
    this.inFailure = true;
    const now = Date.now();
    if (now - this.lastErrorLoggedAt >= this.errorLogIntervalMs) {
      const extra =
        this.suppressedErrors > 0
          ? ` (${this.suppressedErrors} similar error(s) suppressed)`
          : '';
      this.logger.error(
        `Redis connection error: ${err.message}${redisErrorHint(err.message, this.target)}${extra}`,
      );
      this.lastErrorLoggedAt = now;
      this.suppressedErrors = 0;
    } else {
      this.suppressedErrors += 1;
    }
  }

  private onReady(): void {
    if (this.inFailure) {
      this.logger.log('Redis connection re-established');
    }
    this.inFailure = false;
    this.suppressedErrors = 0;
    this.lastErrorLoggedAt = 0;
  }
}
