import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { JobEnvelope } from '../../queue/job-envelope';
import {
  JobHandler,
  JobHandlerRegistry,
} from '../../queue/job-handler.registry';
import { QUEUES } from '../../queue/queue.definitions';
import { WebhookDedupeService } from './webhook-dedupe.service';

declare module '../../queue/queue.definitions' {
  interface JobPayloads {
    'system.integration-webhook-events-sweep': Record<string, never>;
  }
}

/**
 * Step 0.9: 7-day retention for IntegrationWebhookEvent (IMPLEMENTATION.md,
 * "Retention sweeps"). On the always-on `system` queue rather than a future
 * integrations queue: it must keep running even if INTEGRATIONS is turned off
 * again, or the table would stop being trimmed. Hourly, because a busy GitHub
 * installation can produce tens of thousands of deliveries a day and each run
 * is capped (see WebhookDedupeService.sweep). Idempotent: an already-deleted
 * row no longer matches.
 */
@Injectable()
export class IntegrationWebhookSweepJob
  implements JobHandler<'system.integration-webhook-events-sweep'>, OnModuleInit
{
  private readonly logger = new Logger(IntegrationWebhookSweepJob.name);
  readonly queue = QUEUES.SYSTEM.name;
  readonly jobName = 'system.integration-webhook-events-sweep' as const;

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly dedupe: WebhookDedupeService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
    this.registry.registerSchedule({
      queue: this.queue,
      schedulerId: 'integration-webhook-events-sweep-hourly',
      jobName: this.jobName,
      payload: {},
      everyMs: 60 * 60 * 1000,
    });
  }

  async handle(envelope: JobEnvelope) {
    const result = await this.dedupe.sweep();
    this.logger.log(
      `Webhook event sweep ${envelope.traceId}: ${result.deleted} deleted${result.hasMore ? ' (more remain, next run continues)' : ''}`,
    );
    return result;
  }
}
