import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PlatformRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedRequest } from '../common/interfaces/authenticated-request.interface';
import { REQUIRE_PLATFORM_ROLE_KEY } from './require-platform-role.decorator';

/** Ordinal, matches diagram 18's "platformRole >= MODERATOR" phrasing - not just a set-membership check. */
const RANK: Record<PlatformRole, number> = {
  [PlatformRole.NONE]: 0,
  [PlatformRole.MODERATOR]: 1,
  [PlatformRole.ADMIN]: 2,
};

/**
 * Runs AFTER JwtAuthGuard, same ordering requirement as AccessControlGuard
 * (needs `request.user` populated first). Routes with no
 * `@RequirePlatformRole` metadata pass through untouched - same opt-in
 * shape as FeatureGuard/AccessControlGuard, so this adds zero behavior to
 * every route that isn't a platform-staff one.
 *
 * Looks `platformRole` up fresh from the DB every call, never off the JWT
 * - same reasoning as AccessControlGuard/PermissionResolver: a role
 * change must take effect on the very next request, not wait for a token
 * to expire. `jwt.strategy.ts`'s own doc already establishes this as the
 * project's convention (request.user carries only userId/email, nothing
 * downstream is preloaded).
 */
@Injectable()
export class PlatformGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<PlatformRole | undefined>(
      REQUIRE_PLATFORM_ROLE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.user?.userId) {
      throw new UnauthorizedException('Authentication required');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: request.user.userId },
      select: { platformRole: true },
    });
    // A deleted/missing user with a still-valid JWT is NONE, not a crash -
    // the RANK comparison below then correctly denies unless required is
    // also NONE (which no route would ever set - NONE is "no restriction",
    // not a role you'd gate on).
    const actual = user?.platformRole ?? PlatformRole.NONE;

    if (RANK[actual] >= RANK[required]) return true;
    throw new ForbiddenException(
      `Requires platform role >= ${required}, actor has ${actual}`,
    );
  }
}
