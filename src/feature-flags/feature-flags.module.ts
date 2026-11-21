import { Global, Module } from '@nestjs/common';
import { FeatureFlagsService } from './feature-flags.service';
import { FeatureGuard } from './feature.guard';

/**
 * @Global so any module can inject FeatureFlagsService. The guard is NOT
 * registered here as APP_GUARD: global guard order follows registration order
 * and it has to come first, so AppModule registers it explicitly.
 */
@Global()
@Module({
  providers: [
    {
      provide: FeatureFlagsService,
      useFactory: () => new FeatureFlagsService(process.env),
    },
    FeatureGuard,
  ],
  exports: [FeatureFlagsService, FeatureGuard],
})
export class FeatureFlagsModule {}
