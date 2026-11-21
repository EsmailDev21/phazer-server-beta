import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { JobEnvelope } from '../queue/job-envelope';
import { JobHandler, JobHandlerRegistry } from '../queue/job-handler.registry';
import { QUEUES } from '../queue/queue.definitions';
import { AttachmentsService } from './attachments.service';

declare module '../queue/queue.definitions' {
  interface JobPayloads {
    'system.attachments-cleanup-abandoned': Record<string, never>;
  }
}

/**
 * Step 0.3: wires `AttachmentsService.cleanupAbandoned`
 * (FILES__UPLOAD__ABANDONED_CLEANUP, previously a complete but uncallable
 * implementation) onto the `system` queue. Scheduled hourly — the PENDING
 * expiry window it enforces is 24h, so hourly is frequent enough that a
 * reservation is freed well before it could meaningfully affect a storage
 * cap check. Naturally idempotent: a row already deleted no longer matches
 * the PENDING+expired filter.
 */
@Injectable()
export class AttachmentCleanupJob
  implements JobHandler<'system.attachments-cleanup-abandoned'>, OnModuleInit
{
  private readonly logger = new Logger(AttachmentCleanupJob.name);
  readonly queue = QUEUES.SYSTEM.name;
  readonly jobName = 'system.attachments-cleanup-abandoned' as const;

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly attachmentsService: AttachmentsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
    this.registry.registerSchedule({
      queue: this.queue,
      schedulerId: 'attachments-cleanup-abandoned-hourly',
      jobName: this.jobName,
      payload: {},
      everyMs: 60 * 60 * 1000,
    });
  }

  async handle(envelope: JobEnvelope) {
    const result = await this.attachmentsService.cleanupAbandoned();
    this.logger.log(
      `Attachment cleanup job ${envelope.traceId}: ${result.deletedCount} deleted`,
    );
    return result;
  }
}
