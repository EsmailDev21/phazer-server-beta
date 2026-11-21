import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard } from '@nestjs/throttler';
import { AccessControlGuard } from './access-control/guards/access-control.guard';
import { PlatformGuard } from './platform/platform.guard';
import { AppModule } from './app.module';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { FeatureGuard } from './feature-flags/feature.guard';

/**
 * Pins the REAL global guard order without booting the app (no database
 * needed). Order is load-bearing:
 *   FeatureGuard   - a disabled feature must 404 before auth can 401 (ADR-0002)
 *   ThrottlerGuard
 *   JwtAuthGuard   - sets request.user
 *   AccessControlGuard - reads request.user
 *   PlatformGuard  - reads request.user; order vs AccessControlGuard is
 *                     otherwise arbitrary (disjoint metadata keys, step 0.6)
 */
describe('AppModule global guard order', () => {
  it('is FeatureGuard, Throttler, Jwt, AccessControl, Platform', () => {
    const providers: Array<{ provide?: unknown; useClass?: unknown }> =
      Reflect.getMetadata('providers', AppModule);
    const guards = providers
      .filter((p) => p && p.provide === APP_GUARD)
      .map((p) => p.useClass);

    expect(guards).toEqual([
      FeatureGuard,
      ThrottlerGuard,
      JwtAuthGuard,
      AccessControlGuard,
      PlatformGuard,
    ]);
  });
});
