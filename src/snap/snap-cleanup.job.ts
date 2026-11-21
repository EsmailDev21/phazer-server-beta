import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { JobEnvelope } from '../queue/job-envelope';
import { JobHandler, JobHandlerRegistry } from '../queue/job-handler.registry';
import { QUEUES } from '../queue/queue.definitions';
import { SnapSessionsService } from './snap-sessions.service';

declare module '../queue/queue.definitions' {
  interface JobPayloads {
    'system.snap-expire-stale-sessions': Record<string, never>;
  }
}

/**
 * Step 0.3: wires `SnapSessionsService.expireStaleSessions` (SNAP__CLEANUP__EXPIRY,
 * previously a complete but uncallable implementation) onto the `system`
 * queue. Scheduled every 15 minutes — the review timeout it enforces
 * (`SESSION_REVIEW_TIMEOUT_HOURS` = 24h) is coarse, but a stale session sitting
 * a few extra minutes in REVIEWING is harmless, so this favors a light
 * schedule over tight precision. Naturally idempotent: a session already
 * marked EXPIRED no longer matches the REVIEWING filter, so at-least-once
 * redelivery never double-expires anything.
 */
@Injectable()
export class SnapCleanupJob
  implements JobHandler<'system.snap-expire-stale-sessions'>, OnModuleInit
{
  private readonly logger = new Logger(SnapCleanupJob.name);
  readonly queue = QUEUES.SYSTEM.name;
  readonly jobName = 'system.snap-expire-stale-sessions' as const;

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly snapSessionsService: SnapSessionsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
    this.registry.registerSchedule({
      queue: this.queue,
      schedulerId: 'snap-expire-stale-sessions-every-15m',
      jobName: this.jobName,
      payload: {},
      everyMs: 15 * 60 * 1000,
    });
  }

  async handle(envelope: JobEnvelope) {
    const result = await this.snapSessionsService.expireStaleSessions();
    this.logger.log(
      `Snap cleanup job ${envelope.traceId}: ${result.expiredCount} session(s) expired`,
    );
    return result;
  }
}
