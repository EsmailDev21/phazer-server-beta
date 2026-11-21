import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { JobEnvelope } from '../../queue/job-envelope';
import {
  JobHandler,
  JobHandlerRegistry,
} from '../../queue/job-handler.registry';
import { QUEUES } from '../../queue/queue.definitions';
import { DueDateReminderService } from './due-date-reminder.service';

declare module '../../queue/queue.definitions' {
  interface JobPayloads {
    'system.due-date-reminders': { withinHours?: number };
  }
}

/**
 * Step 0.3: wires `DueDateReminderService.scanAndNotify` (previously a
 * complete but uncallable implementation, per its own class doc) onto the
 * `system` queue as a daily repeatable job.
 *
 * KNOWN GAP, carried forward unfixed: `scanAndNotify` has no
 * dedup/last-reminded-at check, so a task within the 24h window gets
 * notified again on every run that still sees it in range — the class doc
 * on `DueDateReminderService` already flags this. Scheduling this DAILY
 * (rather than hourly) bounds the practical duplicate count to at most one
 * extra reminder per task, not several; a real fix needs a schema change
 * (a `Task.lastDueDateReminderAt` column) and is out of scope for a
 * wiring-only step.
 */
@Injectable()
export class DueDateReminderJob
  implements JobHandler<'system.due-date-reminders'>, OnModuleInit
{
  private readonly logger = new Logger(DueDateReminderJob.name);
  readonly queue = QUEUES.SYSTEM.name;
  readonly jobName = 'system.due-date-reminders' as const;

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly dueDateReminderService: DueDateReminderService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
    this.registry.registerSchedule({
      queue: this.queue,
      schedulerId: 'due-date-reminders-daily',
      jobName: this.jobName,
      payload: {},
      cron: '0 8 * * *', // once daily, 08:00 server time
    });
  }

  async handle(envelope: JobEnvelope<{ withinHours?: number }>) {
    const result = await this.dueDateReminderService.scanAndNotify(
      envelope.payload.withinHours,
    );
    this.logger.log(
      `Due-date reminder job ${envelope.traceId}: ${result.scanned} task(s) scanned`,
    );
    return result;
  }
}
