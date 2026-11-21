import { SetMetadata } from '@nestjs/common';
import { PlatformRole } from '@prisma/client';

export const REQUIRE_PLATFORM_ROLE_KEY = 'requirePlatformRole';

/**
 * Gates a route on `User.platformRole`, a SEPARATE axis from account RBAC
 * (PLAN.md: "No platform-staff concept -> User.platformRole for
 * moderation... outside account RBAC"). A platform MODERATOR reviewing a
 * marketplace listing is not necessarily a member of the publisher's
 * account at all, so this is deliberately independent of
 * `@RequireAccess`/`AccessControlGuard` - a route uses one or the other,
 * not both. No route uses this yet (Phase 6's moderation queue is the
 * first); `PlatformGuard` and this decorator exist starting step 0.6
 * regardless, ahead of that first caller.
 */
export const RequirePlatformRole = (minimum: PlatformRole) =>
  SetMetadata(REQUIRE_PLATFORM_ROLE_KEY, minimum);
