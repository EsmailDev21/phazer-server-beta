import { hostname } from 'os';
import {
  BeforeApplicationShutdown,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { Job, UnrecoverableError, Worker } from 'bullmq';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { JobHandlerRegistry } from '../queue/job-handler.registry';
import { buildEnvelope, parseEnvelope } from '../queue/job-envelope';
import { QUEUE_DEFINITIONS, QueueDefinition } from '../queue/queue.definitions';
import { QueueService } from '../queue/queue.service';
import { RedisService } from '../redis/redis.service';

export interface WorkerHostOptions {
  shutdownGraceMs: number;
  /** Defaults to the real registry; injectable so tests can use a flag-gated queue. */
  definitions?: readonly QueueDefinition[];
  heartbeatEveryMs?: number;
  heartbeatTtlSeconds?: number;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms).unref());

/**
 * The consumer side (ADR-0001). Lives ONLY in the worker process: the API never
 * imports this, so it can never consume a job.
 *
 * Lifecycle:
 *  bootstrap  1. reconcile schedules  2. start one Worker per enabled queue
 *             3. start the heartbeat
 *  shutdown   stop taking jobs, let running ones finish (bounded by the grace
 *             period), then force-close. Registered on beforeApplicationShutdown
 *             so it completes BEFORE the Redis/Queue services are torn down.
 *
 * Not @Injectable: QueueWorkerModule builds it from a factory.
 */
export class WorkerHostService
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(WorkerHostService.name);
  private readonly workers: Worker[] = [];
  private readonly workerId = `${hostname()}-${process.pid}`;
  private heartbeat: NodeJS.Timeout | null = null;
  private lastErrorLoggedAt = 0;

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly queues: QueueService,
    private readonly flags: FeatureFlagsService,
    private readonly redis: RedisService,
    private readonly options: WorkerHostOptions,
  ) {}

  /** Redis key that proves this worker is alive (TTL'd, so a dead one disappears). */
  private get definitions(): readonly QueueDefinition[] {
    return this.options.definitions ?? QUEUE_DEFINITIONS;
  }

  get heartbeatKey(): string {
    return `${this.queues.prefix}:worker:${this.workerId}:heartbeat`;
  }

  get activeQueueNames(): string[] {
    return this.workers.map((w) => w.name);
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.queues.configured) {
      throw new Error('The worker requires a valid REDIS_URL.');
    }
    await this.reconcileSchedules();
    for (const def of this.definitions) {
      if (this.isDisabled(def)) {
        this.logger.log(
          `Queue "${def.name}" is not consumed: FEATURE_${def.flag} is off`,
        );
        continue;
      }
      this.startWorker(def);
    }
    this.startHeartbeat();
    this.logger.log(
      `Worker ${this.workerId} consuming: ${this.activeQueueNames.join(', ') || '(none)'}`,
    );
  }

  async beforeApplicationShutdown(signal?: string): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    const workers = this.workers.splice(0);
    if (workers.length === 0) return;

    this.logger.log(
      `Shutting down${signal ? ` on ${signal}` : ''}: waiting up to ${this.options.shutdownGraceMs}ms for running jobs`,
    );
    // BullMQ quirk, confirmed by reading Worker.close(): once a close() is in
    // flight, a LATER close(true) on the same worker is a no-op that returns
    // the SAME promise - force does not retroactively abandon a graceful close
    // already waiting on the current job. So "wait, then force" cannot be two
    // calls on one worker; instead we stop AWAITING at the deadline and let
    // the still-running close() finish on its own. It is caught so it can
    // never surface as an unhandled rejection after we have moved on.
    const drained = Promise.all(workers.map((w) => w.close())).then(() => true);
    drained.catch((err: Error) =>
      this.logger.warn(
        `Worker close() failed after shutdown moved on: ${err.message}`,
      ),
    );

    const finished = await Promise.race([
      drained,
      sleep(this.options.shutdownGraceMs).then(() => false),
    ]);

    if (!finished) {
      // A job still running past the grace period is abandoned here. BullMQ
      // will see its lock expire and mark it stalled, which - given
      // at-least-once delivery and idempotent handlers (ADR-0001) - is safe:
      // it is retried, not lost.
      this.logger.warn(
        `Grace period of ${this.options.shutdownGraceMs}ms exceeded; moving on without waiting further (the in-flight job will be retried once its lock expires)`,
      );
    }
    await this.removeHeartbeat();
  }

  // -- schedules ------------------------------------------------------------

  /**
   * Idempotent and safe with N workers: upserting a scheduler by its stable id
   * is a no-op when it already exists, so a fleet schedules each job once.
   * Queues whose flag is off get their schedules REMOVED (ADR-0002), otherwise
   * they would keep firing into a queue nobody consumes and pile up.
   */
  private async reconcileSchedules(): Promise<void> {
    for (const def of this.definitions) {
      const queue = this.queues.getQueue(def.name);
      if (this.isDisabled(def)) {
        for (const existing of await queue.getJobSchedulers()) {
          await queue.removeJobScheduler(existing.key);
          this.logger.log(
            `Removed schedule "${existing.key}" (FEATURE_${def.flag} is off)`,
          );
        }
        continue;
      }
      for (const s of this.registry.schedulesFor(def.name)) {
        await queue.upsertJobScheduler(
          s.schedulerId,
          s.everyMs ? { every: s.everyMs } : { pattern: s.cron },
          {
            name: s.jobName,
            // BullMQ stores one static template per scheduler, so every run of
            // a schedule shares this trace id.
            data: buildEnvelope(s.payload, {
              traceId: `schedule:${s.schedulerId}`,
            }),
          },
        );
      }
    }
  }

  // -- consuming ------------------------------------------------------------

  private isDisabled(def: QueueDefinition): boolean {
    return def.flag !== null && !this.flags.isEnabled(def.flag);
  }

  private startWorker(def: QueueDefinition): void {
    const worker = new Worker(def.name, (job) => this.process(def.name, job), {
      ...this.queues.connectionOptions(),
      concurrency: def.concurrency,
      // See QueueDefinition.stalledIntervalMs for why this is per-queue.
      ...(def.stalledIntervalMs !== undefined && {
        stalledInterval: def.stalledIntervalMs,
      }),
    });
    worker.on('failed', (job, err) => this.onFailed(def.name, job, err));
    worker.on('error', (err) => this.onWorkerError(def.name, err));
    this.workers.push(worker);
  }

  private async process(queue: string, job: Job): Promise<unknown> {
    let envelope;
    try {
      envelope = parseEnvelope(job.data);
    } catch (err) {
      // Malformed data cannot become valid on retry: fail it straight away.
      throw new UnrecoverableError((err as Error).message);
    }
    const handler = this.registry.get(queue, job.name);
    if (!handler) {
      // Deliberately retryable, not Unrecoverable: the usual cause is deploy
      // skew (a newer API enqueued a job this older worker does not know yet).
      throw new Error(`No handler registered for ${queue}/${job.name}`);
    }
    return handler.handle(envelope, job);
  }

  private onFailed(queue: string, job: Job | undefined, err: Error): void {
    if (!job) return;
    const attempts = job.opts.attempts ?? 1;
    const final =
      err instanceof UnrecoverableError || job.attemptsMade >= attempts;
    const trace = (job.data as { traceId?: string } | undefined)?.traceId;
    const where = `${queue}/${job.name} id=${job.id} trace=${trace ?? '-'}`;
    if (final) {
      // The dead-letter event: BullMQ keeps the job in its failed set.
      this.logger.error(
        `Job DEAD ${where} after ${job.attemptsMade}/${attempts} attempts: ${err.message}`,
      );
    } else {
      this.logger.warn(
        `Job failed ${where} (attempt ${job.attemptsMade}/${attempts}, will retry): ${err.message}`,
      );
    }
  }

  private onWorkerError(queue: string, err: Error): void {
    const now = Date.now();
    if (now - this.lastErrorLoggedAt < 30_000) return;
    this.lastErrorLoggedAt = now;
    this.logger.error(`Worker "${queue}" error: ${err.message}`);
  }

  // -- heartbeat ------------------------------------------------------------

  private startHeartbeat(): void {
    const beat = () => {
      if (!this.redis.isReady()) return;
      this.redis
        .getClient()
        .set(
          this.heartbeatKey,
          String(Date.now()),
          'EX',
          this.options.heartbeatTtlSeconds ?? 30,
        )
        .catch(() => undefined);
    };
    beat();
    this.heartbeat = setInterval(beat, this.options.heartbeatEveryMs ?? 10_000);
    this.heartbeat.unref();
  }

  private async removeHeartbeat(): Promise<void> {
    if (!this.redis.isReady()) return;
    await this.redis
      .getClient()
      .del(this.heartbeatKey)
      .catch(() => undefined);
  }
}
