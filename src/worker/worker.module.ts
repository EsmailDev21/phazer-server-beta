import { Module } from '@nestjs/common';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { JobHandlerRegistry } from '../queue/job-handler.registry';
import { resolveShutdownGraceMs } from '../queue/queue.config';
import { QueueService } from '../queue/queue.service';
import { RedisService } from '../redis/redis.service';
import { WorkerHostService } from './worker-host.service';

/** Consumer side. Imported ONLY by WorkerAppModule, never by the API. */
@Module({
  providers: [
    {
      provide: WorkerHostService,
      inject: [
        JobHandlerRegistry,
        QueueService,
        FeatureFlagsService,
        RedisService,
      ],
      useFactory: (
        registry: JobHandlerRegistry,
        queues: QueueService,
        flags: FeatureFlagsService,
        redis: RedisService,
      ) =>
        new WorkerHostService(registry, queues, flags, redis, {
          shutdownGraceMs: resolveShutdownGraceMs(process.env),
        }),
    },
  ],
  exports: [WorkerHostService],
})
export class WorkerModule {}
