import { SetMetadata } from '@nestjs/common';
import { FeatureFlag } from './feature-flags';

export const REQUIRE_FEATURE_KEY = 'requireFeature';

/**
 * Marks a controller or route as belonging to one or more feature flags. When
 * any listed flag is off the route answers 404 (FeatureGuard, ADR-0002).
 * Class-level and method-level flags are merged: ALL of them must be on.
 */
export const RequireFeature = (...flags: FeatureFlag[]) =>
  SetMetadata(REQUIRE_FEATURE_KEY, flags);
