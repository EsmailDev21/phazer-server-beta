import { Injectable, OnModuleInit } from '@nestjs/common';
import { JobEnvelope } from '../queue/job-envelope';
import { JobHandler, JobHandlerRegistry } from '../queue/job-handler.registry';
import { QUEUES } from '../queue/queue.definitions';
import { DueSweepService } from './due-sweep.service';

declare module '../queue/queue.definitions' {
  interface JobPayloads {
    'system.automation-due-sweep': Record<string, never>;
  }
}

/** Step 5.2. Every 5 minutes: fire the DUE_APPROACHING rules whose window has opened. Safe to run on several workers (the run rows make it idempotent). */
@Injectable()
export class AutomationDueSweepJob
  implements JobHandler<'system.automation-due-sweep'>, OnModuleInit
{
  readonly queue = QUEUES.SYSTEM.name;
  readonly jobName = 'system.automation-due-sweep' as const;

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly sweep: DueSweepService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
    this.registry.registerSchedule({
      queue: this.queue,
      schedulerId: 'automation-due-sweep',
      jobName: this.jobName,
      payload: {},
      cron: '*/5 * * * *',
    });
  }

  async handle(_envelope: JobEnvelope) {
    return this.sweep.sweep();
  }
}
