import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { JobEnvelope } from '../../queue/job-envelope';
import {
  JobHandler,
  JobHandlerRegistry,
} from '../../queue/job-handler.registry';
import { QUEUES } from '../../queue/queue.definitions';
import { SprintService } from './sprint.service';

declare module '../../queue/queue.definitions' {
  interface JobPayloads {
    'system.sprint-snapshots': Record<string, never>;
  }
}

/**
 * ADR-0044. Hourly: refresh today's snapshot of every ACTIVE sprint. Hourly rather than nightly
 * so a worker that was down at midnight loses an hour, not a day; the last run of a day is what
 * the burndown shows for it.
 */
@Injectable()
export class SprintSnapshotJob
  implements JobHandler<'system.sprint-snapshots'>, OnModuleInit
{
  private readonly logger = new Logger(SprintSnapshotJob.name);
  readonly queue = QUEUES.SYSTEM.name;
  readonly jobName = 'system.sprint-snapshots' as const;

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly sprints: SprintService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
    this.registry.registerSchedule({
      queue: this.queue,
      schedulerId: 'sprint-snapshots-hourly',
      jobName: this.jobName,
      payload: {},
      cron: '7 * * * *',
    });
  }

  async handle(envelope: JobEnvelope) {
    const result = await this.sprints.recordDaily();
    this.logger.log(
      `Sprint snapshot job ${envelope.traceId}: ${result.sprints} sprint(s), ${result.failed} failed`,
    );
    return result;
  }
}
