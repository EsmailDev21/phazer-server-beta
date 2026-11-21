import { Logger } from '@nestjs/common';
import {
  FEATURE_FLAGS,
  FeatureFlag,
  FlagState,
  parseFeatureFlags,
} from './feature-flags';

/**
 * The single place the rest of the code asks "is this feature on?".
 *
 * Flags are read ONCE from the environment when the process starts (ADR-0002:
 * changing one needs a restart). Deliberately not decorated with @Injectable():
 * it is built by a factory in FeatureFlagsModule so tests can hand it an
 * explicit env instead of mutating process.env.
 */
export class FeatureFlagsService {
  private readonly logger = new Logger(FeatureFlagsService.name);
  private readonly flags: FlagState;

  constructor(env: NodeJS.ProcessEnv) {
    const parsed = parseFeatureFlags(env);
    this.flags = parsed.flags;
    // Boot validation (assertFeatureFlagEnv) already reported these loudly; the
    // service only logs so the information also lands in the app's own logs.
    for (const name of parsed.unknown) {
      this.logger.warn(`${name} is not a known feature flag; ignored`);
    }
  }

  /**
   * `scope.accountId` is accepted and ignored today. It is reserved so
   * per-account rollout can be added later without touching any call site
   * (ADR-0002 "Revisit if").
   */
  isEnabled(flag: FeatureFlag, _scope?: { accountId?: string }): boolean {
    return this.flags[flag];
  }

  enabledFlags(): FeatureFlag[] {
    return FEATURE_FLAGS.filter((flag) => this.flags[flag]);
  }
}
