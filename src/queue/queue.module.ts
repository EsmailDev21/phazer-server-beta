import { Global, Module } from '@nestjs/common';
import { JobHandlerRegistry } from './job-handler.registry';
import { resolveQueuePrefix } from './queue.config';
import { QueueService } from './queue.service';

/** Producer side. Imported by the API and by the worker. */
@Global()
@Module({
  providers: [
    {
      provide: QueueService,
      useFactory: () =>
        new QueueService({
          url: process.env.REDIS_URL,
          prefix: resolveQueuePrefix(process.env),
        }),
    },
    JobHandlerRegistry,
  ],
  exports: [QueueService, JobHandlerRegistry],
})
export class QueueModule {}
