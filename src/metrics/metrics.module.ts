import { Global, Module } from '@nestjs/common';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';
import { SharedStateCollector } from './shared-state.collector';

/**
 * API process only (the worker has no HTTP listener). @Global so provider plumbing that runs in BOTH processes
 * (ProviderHttpClient, the signature checkers' callers) can inject MetricsService as @Optional(): present in the API, absent in the worker.
 */
@Global()
@Module({
  controllers: [MetricsController],
  providers: [MetricsService, SharedStateCollector],
  exports: [MetricsService],
})
export class MetricsModule {}
