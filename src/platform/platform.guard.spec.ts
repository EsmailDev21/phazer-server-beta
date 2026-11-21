import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PlatformRole } from '@prisma/client';
import { PlatformGuard } from './platform.guard';
import { PrismaService } from '../prisma/prisma.service';

function buildContext(userId: string | undefined): ExecutionContext {
  const request = userId ? { user: { userId } } : { user: undefined };
  return {
    getHandler: () => ({}) as any,
    getClass: () => ({}) as any,
    switchToHttp: () => ({ getRequest: () => request }) as any,
  } as unknown as ExecutionContext;
}

function buildGuard(
  required: PlatformRole | undefined,
  dbRole: PlatformRole | null,
) {
  const reflector = {
    getAllAndOverride: jest.fn().mockReturnValue(required),
  } as unknown as Reflector;
  const prisma = {
    user: {
      findUnique: jest
        .fn()
        .mockResolvedValue(dbRole === null ? null : { platformRole: dbRole }),
    },
  } as unknown as PrismaService;
  return { guard: new PlatformGuard(reflector, prisma), prisma };
}

describe('PlatformGuard', () => {
  it('a route with no @RequirePlatformRole metadata passes through untouched (no DB call)', async () => {
    const { guard, prisma } = buildGuard(undefined, null);
    const allowed = await guard.canActivate(buildContext('u1'));
    expect(allowed).toBe(true);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('no request.user at all throws UnauthorizedException, not a DB lookup with undefined', async () => {
    const { guard, prisma } = buildGuard(PlatformRole.MODERATOR, null);
    await expect(guard.canActivate(buildContext(undefined))).rejects.toThrow(
      UnauthorizedException,
    );
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('a user missing from the DB (deleted, stale JWT) is treated as NONE, not a crash', async () => {
    const { guard } = buildGuard(PlatformRole.MODERATOR, null);
    await expect(guard.canActivate(buildContext('ghost'))).rejects.toThrow(
      ForbiddenException,
    );
  });

  // The guard matrix IMPLEMENTATION.md 0.6 asks for: every (required x
  // actual) combination, proving the ordinal >= comparison (diagram 18:
  // "platformRole >= MODERATOR"), not a set-membership check.
  const ROLES: PlatformRole[] = [
    PlatformRole.NONE,
    PlatformRole.MODERATOR,
    PlatformRole.ADMIN,
  ];
  const RANK: Record<PlatformRole, number> = {
    NONE: 0,
    MODERATOR: 1,
    ADMIN: 2,
  };

  for (const required of ROLES) {
    for (const actual of ROLES) {
      const shouldAllow = RANK[actual] >= RANK[required];
      it(`required=${required}, actual=${actual} -> ${shouldAllow ? 'ALLOW' : 'DENY'}`, async () => {
        const { guard } = buildGuard(required, actual);
        const call = guard.canActivate(buildContext('u1'));
        if (shouldAllow) {
          await expect(call).resolves.toBe(true);
        } else {
          await expect(call).rejects.toThrow(ForbiddenException);
        }
      });
    }
  }

  it('looks the role up fresh from the DB every call - never trusts a cached/JWT-carried role', async () => {
    const { guard, prisma } = buildGuard(
      PlatformRole.ADMIN,
      PlatformRole.ADMIN,
    );
    await guard.canActivate(buildContext('u1'));
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'u1' },
      select: { platformRole: true },
    });
  });
});
