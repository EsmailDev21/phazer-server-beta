import { Injectable, OnModuleInit } from '@nestjs/common';
import { JobEnvelope } from '../queue/job-envelope';
import { JobHandler, JobHandlerRegistry } from '../queue/job-handler.registry';
import { QUEUES } from '../queue/queue.definitions';
import { AutomationWaitService } from './automation-wait.service';

declare module '../queue/queue.definitions' {
  interface JobPayloads {
    'system.automation-wait-resume': Record<string, never>;
  }
}

/**
 * Step 5.15. Every minute: carry on the waits whose time is up. Safe to run on several workers (a wait is
 * claimed before it runs, so at most one does it).
 */
@Injectable()
export class AutomationWaitJob
  implements JobHandler<'system.automation-wait-resume'>, OnModuleInit
{
  readonly queue = QUEUES.SYSTEM.name;
  readonly jobName = 'system.automation-wait-resume' as const;

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly waits: AutomationWaitService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
    this.registry.registerSchedule({
      queue: this.queue,
      schedulerId: 'automation-wait-resume',
      jobName: this.jobName,
      payload: {},
      cron: '* * * * *',
    });
  }

  async handle(_envelope: JobEnvelope) {
    return this.waits.resumeDue();
  }
}
