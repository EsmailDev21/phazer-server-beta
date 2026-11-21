import { Injectable, Module, OnModuleInit } from '@nestjs/common';
import { JobEnvelope } from '../queue/job-envelope';
import { JobHandler, JobHandlerRegistry } from '../queue/job-handler.registry';
import { QUEUES } from '../queue/queue.definitions';

/**
 * `system.ping`: does nothing except prove the whole path (enqueue -> Redis ->
 * worker -> handler -> result) works. Used by the CI smoke test and by
 * operators (`enqueue system.ping`, see the result in the queue).
 */
@Injectable()
export class SystemPingHandler
  implements JobHandler<'system.ping'>, OnModuleInit
{
  readonly queue = QUEUES.SYSTEM.name;
  readonly jobName = 'system.ping' as const;

  constructor(private readonly registry: JobHandlerRegistry) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(envelope: JobEnvelope) {
    return { pong: true, traceId: envelope.traceId };
  }
}

@Module({ providers: [SystemPingHandler] })
export class SystemJobsModule {}
