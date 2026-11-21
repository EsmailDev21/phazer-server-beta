import { Injectable, Logger } from '@nestjs/common';
import { Subject } from 'rxjs';
import { RedisPubSubService } from '../../redis/redis-pubsub.service';

export interface NotificationPushPayload {
  id: string;
  type: string;
  sourceType: string;
  sourceId: string;
  createdAt: Date;
}

export function channelFor(userId: string): string {
  return `sse:user:${userId}`;
}

/**
 * Map<userId, Set<Subject>> per process (multiple tabs/devices per user
 * supported) - step 0.4 adds Redis pub/sub on top so this works across
 * more than one instance (ADR-0001 / IMPLEMENTATION.md 0.4):
 *
 *  - `connect()`: on the FIRST local Subject for a userId, SUBSCRIBEs to
 *    `sse:user:{id}`; every message received on it is delivered to every
 *    locally-connected Subject for that user (there can be more than one -
 *    multiple tabs/devices).
 *  - `disconnect()`: on the LAST local Subject for a userId going away,
 *    UNSUBSCRIBEs - no channel is held open for a user with nobody
 *    connected on this instance.
 *  - `publish()` (was called `push` before 0.4): ALWAYS goes through
 *    Redis, unconditionally - see `RedisPubSubService`'s class doc for
 *    why there is no same-instance fast path (it would double-deliver).
 *    Whichever instance currently holds that user's connection (if any)
 *    is the one whose `subscribe` handler fires and delivers it.
 *
 * RESILIENCE, unchanged from before 0.4: this is an optimization for
 * immediacy, NEVER the source of truth - the `Notification` table via
 * normal REST fetch is always authoritative. Clients do a catch-up REST
 * fetch on reconnect. `RedisPubSubService` degrades to "no live push"
 * (not a crash) when Redis is unset or unreachable, so this is safe to
 * use in every environment.
 */
@Injectable()
export class NotificationSseRegistry {
  private readonly logger = new Logger(NotificationSseRegistry.name);
  private readonly connections = new Map<
    string,
    Set<Subject<NotificationPushPayload>>
  >();

  constructor(private readonly pubsub: RedisPubSubService) {}

  connect(userId: string): Subject<NotificationPushPayload> {
    const subject = new Subject<NotificationPushPayload>();
    const existing = this.connections.get(userId);
    if (existing) {
      existing.add(subject);
    } else {
      this.connections.set(userId, new Set([subject]));
      // Fire-and-forget: the SSE stream itself must not wait on this -
      // RedisPubSubService.subscribe already never throws.
      void this.pubsub.subscribe(channelFor(userId), (message) =>
        this.deliverLocal(userId, message),
      );
    }
    return subject;
  }

  disconnect(userId: string, subject: Subject<NotificationPushPayload>): void {
    const set = this.connections.get(userId);
    if (!set) return;
    set.delete(subject);
    if (set.size === 0) {
      this.connections.delete(userId);
      void this.pubsub.unsubscribe(channelFor(userId));
    }
  }

  /** Publishes to every instance - see the class doc for why this never delivers locally directly. */
  async publish(
    userId: string,
    payload: NotificationPushPayload,
  ): Promise<void> {
    await this.pubsub.publish(channelFor(userId), JSON.stringify(payload));
  }

  private deliverLocal(userId: string, message: string): void {
    const set = this.connections.get(userId);
    if (!set) return; // can race a just-completed disconnect; harmless drop
    let payload: NotificationPushPayload;
    try {
      payload = JSON.parse(message) as NotificationPushPayload;
      payload.createdAt = new Date(payload.createdAt);
    } catch (error) {
      this.logger.warn(
        `Dropped malformed SSE push payload for ${userId}: ${(error as Error).message}`,
      );
      return;
    }
    for (const subject of set) subject.next(payload);
  }
}
