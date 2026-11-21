import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PermissionResolver } from '../access-control.service';
import { REQUIRE_ACCESS_KEY } from '../decorators/require-access.decorator';
import { AuthenticatedRequest } from '../../common/interfaces/authenticated-request.interface';
import { PlanLimitExceededException } from '../../common/exceptions/plan-limit-exceeded.exception';

interface RequireAccessMetadata {
  action: import('../interfaces/access-control.types').ActionName;
  targetType: import('../interfaces/access-control.types').TargetType;
  paramSource: 'param' | 'query' | 'body';
  paramName: string;
}

/**
 * Runs AFTER JwtAuthGuard (registration order in AppModule's APP_GUARD
 * providers matters — Jwt must populate request.user first). Routes with
 * no @RequireAccess metadata pass through untouched.
 */
@Injectable()
export class AccessControlGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permissionResolver: PermissionResolver,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const metadata = this.reflector.getAllAndOverride<
      RequireAccessMetadata | undefined
    >(REQUIRE_ACCESS_KEY, [context.getHandler(), context.getClass()]);

    if (!metadata) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.user?.userId) {
      throw new UnauthorizedException('Authentication required');
    }

    const targetId = this.extractTargetId(request, metadata);

    const result = await this.permissionResolver.resolve(
      request.user.userId,
      metadata.action,
      metadata.targetType,
      targetId,
    );

    if (!result.allowed) {
      if (result.planLimitExceeded) {
        throw new PlanLimitExceededException(
          result.reason ?? 'Plan limit exceeded',
        );
      }
      throw new ForbiddenException(result.reason ?? 'Forbidden');
    }

    return true;
  }

  private extractTargetId(
    request: AuthenticatedRequest,
    metadata: RequireAccessMetadata,
  ): string {
    const source =
      metadata.paramSource === 'query'
        ? request.query
        : metadata.paramSource === 'body'
          ? request.body
          : request.params;

    const value = (source as Record<string, unknown>)?.[metadata.paramName];

    if (typeof value !== 'string' || value.length === 0) {
      throw new ForbiddenException(
        `Missing "${metadata.paramName}" in request ${metadata.paramSource} for access check`,
      );
    }

    return value;
  }
}
