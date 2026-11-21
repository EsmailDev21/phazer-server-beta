import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { RedisService } from './redis.service';

/**
 * Dedicated PUBLISH/SUBSCRIBE layer on top of `RedisService` (ADR-0001,
 * step 0.4). ioredis rule, confirmed against its docs: once a connection
 * issues SUBSCRIBE it enters subscriber mode and can no longer run
 * ordinary commands on that SAME connection - so this owns one extra,
 * lazily-created connection (`RedisService`'s client `.duplicate()`,
 * which copies its connection options - including `lazyConnect`, so it
 * connects itself on first use, no manual `.connect()` needed) purely
 * for subscribing. PUBLISH reuses `RedisService`'s existing shared
 * client instead, since publishing never needs subscriber mode.
 *
 * One subscriber connection total, for every channel - ioredis supports
 * subscribing/unsubscribing to many channels over time on one connection;
 * there is no need for "one connection per channel". A single `message`
 * listener dispatches by channel name to whichever handler is currently
 * registered for it.
 *
 * Soft-fails exactly like `RedisService`: Redis being unset or
 * unreachable degrades a caller (no live push gets through), it never
 * throws and never crashes the process. This is intentional and uniform
 * - there is deliberately NO "same process, skip Redis" fast path in any
 * caller of this class. Reasoning: a fast path would only fire when the
 * publisher and the matching subscriber happen to live in the same
 * process, which is exactly the case where going through Redis would
 * ALSO deliver the message via the `message` event - taking the fast
 * path too would double-deliver. Uniform routing through Redis, always,
 * is simpler and avoids that failure mode entirely. The cost is that a
 * caller needs Redis configured to get ANY live delivery, even within
 * one process - acceptable here because every current caller (SSE, see
 * `NotificationSseRegistry`) already treats live delivery as a
 * best-effort optimization with a REST/DB source of truth behind it.
 */
@Injectable()
export class RedisPubSubService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisPubSubService.name);
  private subscriber: Redis | null = null;
  private readonly handlers = new Map<string, (message: string) => void>();

  constructor(private readonly redis: RedisService) {}

  /** No-op (not an error) when Redis isn't configured or a command fails - see class doc. */
  async publish(channel: string, message: string): Promise<void> {
    if (!this.redis.configured) return;
    try {
      await this.redis.getClient().publish(channel, message);
    } catch (error) {
      this.logger.warn(
        `publish to "${channel}" failed: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Registers `handler` for `channel` and issues SUBSCRIBE. Calling this
   * again for a channel that already has a handler replaces it (no
   * duplicate SUBSCRIBE sent - ioredis dedupes those itself anyway).
   */
  async subscribe(
    channel: string,
    handler: (message: string) => void,
  ): Promise<void> {
    if (!this.redis.configured) return;
    this.handlers.set(channel, handler);
    try {
      await this.ensureSubscriber().subscribe(channel);
    } catch (error) {
      this.logger.warn(
        `subscribe to "${channel}" failed: ${(error as Error).message}`,
      );
    }
  }

  async unsubscribe(channel: string): Promise<void> {
    this.handlers.delete(channel);
    if (!this.subscriber) return;
    try {
      await this.subscriber.unsubscribe(channel);
    } catch (error) {
      this.logger.warn(
        `unsubscribe from "${channel}" failed: ${(error as Error).message}`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    const sub = this.subscriber;
    this.subscriber = null;
    this.handlers.clear();
    if (sub) sub.disconnect();
  }

  private ensureSubscriber(): Redis {
    if (this.subscriber) return this.subscriber;
    const sub = this.redis.getClient().duplicate();
    // Same reasoning as RedisService.onError: an 'error' event with no
    // listener is an uncaught exception in Node, and ioredis emits one
    // per failed reconnect attempt while Redis is down.
    sub.on('error', (err: Error) =>
      this.logger.warn(`subscriber connection error: ${err.message}`),
    );
    sub.on('message', (channel: string, message: string) => {
      this.handlers.get(channel)?.(message);
    });
    this.subscriber = sub;
    return sub;
  }
}
