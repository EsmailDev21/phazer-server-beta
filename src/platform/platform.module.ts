import { Global, Module } from '@nestjs/common';
import { PlatformGuard } from './platform.guard';

/**
 * @Global, same shape as AccessControlModule - PlatformGuard's own deps
 * (PrismaService, Reflector) are already globally resolvable, so this
 * module exists mainly so AppModule's `{ provide: APP_GUARD, useClass:
 * PlatformGuard }` has a documented home to point at, matching
 * FeatureGuard/AccessControlGuard's pattern rather than a bare class with
 * no module at all.
 */
@Global()
@Module({
  providers: [PlatformGuard],
  exports: [PlatformGuard],
})
export class PlatformModule {}
