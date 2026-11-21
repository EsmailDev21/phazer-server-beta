import { Injectable } from '@nestjs/common';
import { Job } from 'bullmq';
import { JobEnvelope } from './job-envelope';
import { JobName, QueueName } from './queue.definitions';

export interface JobHandler<N extends JobName = JobName> {
  readonly queue: QueueName;
  readonly jobName: N;
  /** Must be idempotent: delivery is at-least-once (ADR-0001). */
  handle(envelope: JobEnvelope, job: Job): Promise<unknown>;
}

/** A recurring job. `schedulerId` is the stable key that makes registration idempotent. */
export interface JobSchedule {
  readonly queue: QueueName;
  readonly schedulerId: string;
  readonly jobName: JobName;
  readonly payload: unknown;
  /** Exactly one of these. */
  readonly everyMs?: number;
  readonly cron?: string;
}

/**
 * Where feature modules announce "this job name is handled by this code" and
 * "this job recurs". Populated in onModuleInit; the worker host reads it in
 * onApplicationBootstrap, after every module has registered.
 */
@Injectable()
export class JobHandlerRegistry {
  private readonly handlers = new Map<string, JobHandler>();
  private readonly schedules: JobSchedule[] = [];

  register(handler: JobHandler): void {
    const key = `${handler.queue}/${handler.jobName}`;
    if (this.handlers.has(key)) {
      throw new Error(`Duplicate job handler for ${key}`);
    }
    this.handlers.set(key, handler);
  }

  registerSchedule(schedule: JobSchedule): void {
    if (Boolean(schedule.everyMs) === Boolean(schedule.cron)) {
      throw new Error(
        `Schedule ${schedule.schedulerId}: set exactly one of everyMs / cron`,
      );
    }
    if (this.schedules.some((s) => s.schedulerId === schedule.schedulerId)) {
      throw new Error(`Duplicate schedulerId ${schedule.schedulerId}`);
    }
    this.schedules.push(schedule);
  }

  get(queue: string, jobName: string): JobHandler | undefined {
    return this.handlers.get(`${queue}/${jobName}`);
  }

  schedulesFor(queue: string): JobSchedule[] {
    return this.schedules.filter((s) => s.queue === queue);
  }
}
