import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { JobEnvelope } from '../../queue/job-envelope';
import {
  JobHandler,
  JobHandlerRegistry,
} from '../../queue/job-handler.registry';
import { QUEUES } from '../../queue/queue.definitions';
import { CycleService } from './cycle.service';

declare module '../../queue/queue.definitions' {
  interface JobPayloads {
    'system.cycle-rollover': Record<string, never>;
  }
}

/**
 * ADR-0045. Hourly: create the next cycle of every automated chain, close the ones that are over
 * (moving unfinished tasks on) and start the ones whose day has come. Hourly so a worker outage
 * delays a rollover by hours, not by a day; running it again changes nothing.
 */
@Injectable()
export class CycleRolloverJob
  implements JobHandler<'system.cycle-rollover'>, OnModuleInit
{
  private readonly logger = new Logger(CycleRolloverJob.name);
  readonly queue = QUEUES.SYSTEM.name;
  readonly jobName = 'system.cycle-rollover' as const;

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly cycles: CycleService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
    this.registry.registerSchedule({
      queue: this.queue,
      schedulerId: 'cycle-rollover-hourly',
      jobName: this.jobName,
      payload: {},
      cron: '17 * * * *',
    });
  }

  async handle(envelope: JobEnvelope) {
    const result = await this.cycles.sweep();
    this.logger.log(
      `Cycle sweep ${envelope.traceId}: ${result.created} created, ${result.rolled} rolled over, ` +
        `${result.started} started, ${result.failed} failed`,
    );
    return result;
  }
}
