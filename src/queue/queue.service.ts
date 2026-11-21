import { Logger, OnModuleDestroy } from '@nestjs/common';
import { DefaultJobOptions, Queue } from 'bullmq';
import { RedisNotConfiguredError } from '../redis/redis.service';
import { checkRedisUrl } from '../redis/redis-url';
import { JobContext, buildEnvelope } from './job-envelope';
import {
  DEFAULT_ENQUEUE_TIMEOUT_MS,
  DEFAULT_JOB_OPTIONS,
} from './queue.config';
import { JobName, JobPayloads, QueueName } from './queue.definitions';

export class QueueUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'QueueUnavailableError';
  }
}

export interface QueueServiceOptions {
  url: string | undefined;
  prefix: string;
  defaultJobOptions?: DefaultJobOptions;
  enqueueTimeoutMs?: number;
}

export interface EnqueueOptions {
  ctx?: JobContext;
  /**
   * Deterministic id = idempotent enqueue: while a job with this id exists,
   * enqueueing it again is a no-op. Use it whenever a caller might retry.
   */
  jobId?: string;
  delayMs?: number;
}

/**
 * Producer side of the queue layer, used by BOTH processes (the API to enqueue,
 * the worker to manage schedules). Not @Injectable: QueueModule builds it from a
 * factory so tests can pass an explicit URL/prefix.
 *
 * BullMQ forces `maxRetriesPerRequest: null` on its own connections, so during a
 * Redis outage `queue.add()` would wait indefinitely. enqueue() therefore has a
 * deadline and throws QueueUnavailableError. **A timeout means the outcome is
 * unknown, not that the job was not queued** - which is exactly why callers who
 * may retry pass a deterministic `jobId`.
 */
export class QueueService implements OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  private readonly queues = new Map<string, Queue>();
  private lastErrorLoggedAt = 0;

  constructor(private readonly options: QueueServiceOptions) {}

  get configured(): boolean {
    return checkRedisUrl(this.options.url).ok;
  }

  get prefix(): string {
    return this.options.prefix;
  }

  /** Connection settings for a BullMQ Worker in this process (same Redis, same key prefix). */
  connectionOptions(): { connection: { url: string }; prefix: string } {
    if (!this.configured) throw new RedisNotConfiguredError();
    return {
      connection: { url: this.options.url.trim() },
      prefix: this.options.prefix,
    };
  }

  /** The (lazily created, cached) BullMQ queue. */
  getQueue(name: QueueName | string): Queue {
    if (!this.configured) throw new RedisNotConfiguredError();
    let queue = this.queues.get(name);
    if (!queue) {
      queue = new Queue(name, {
        ...this.connectionOptions(),
        defaultJobOptions: {
          ...DEFAULT_JOB_OPTIONS,
          ...this.options.defaultJobOptions,
        },
      });
      // An 'error' event with no listener is an uncaught exception. ioredis
      // emits one per failed reconnect attempt, so also rate-limit the log.
      queue.on('error', (err) => this.onError(name, err));
      this.queues.set(name, queue);
    }
    return queue;
  }

  async enqueue<N extends JobName>(
    queue: QueueName,
    jobName: N,
    payload: JobPayloads[N],
    options: EnqueueOptions = {},
  ): Promise<{ id: string }> {
    const q = this.getQueue(queue);
    const timeoutMs =
      this.options.enqueueTimeoutMs ?? DEFAULT_ENQUEUE_TIMEOUT_MS;

    let timer: NodeJS.Timeout;
    try {
      const job = await Promise.race([
        q.add(jobName, buildEnvelope(payload, options.ctx), {
          jobId: options.jobId,
          delay: options.delayMs,
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new QueueUnavailableError(
                  `Timed out after ${timeoutMs}ms enqueueing "${jobName}" on "${queue}". The outcome is unknown; retry with a jobId to be safe.`,
                ),
              ),
            timeoutMs,
          );
        }),
      ]);
      return { id: job.id };
    } finally {
      clearTimeout(timer);
    }
  }

  async onModuleDestroy(): Promise<void> {
    const queues = [...this.queues.values()];
    this.queues.clear();
    // close() can itself wait on a connection that never came up, so bound it.
    await Promise.all(
      queues.map((q) =>
        Promise.race([
          q.close().catch(() => undefined),
          new Promise((resolve) => setTimeout(resolve, 2_000).unref()),
        ]),
      ),
    );
  }

  private onError(queue: string, err: Error): void {
    const now = Date.now();
    if (now - this.lastErrorLoggedAt < 30_000) return;
    this.lastErrorLoggedAt = now;
    this.logger.error(`Queue "${queue}" connection error: ${err.message}`);
  }
}
