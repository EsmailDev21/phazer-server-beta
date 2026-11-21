import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FeatureFlag } from './feature-flags';
import { FeatureFlagsService } from './feature-flags.service';
import { REQUIRE_FEATURE_KEY } from './require-feature.decorator';

/**
 * MUST be the FIRST global guard (see AppModule). If it ran after
 * JwtAuthGuard a disabled route would answer 401 to anonymous callers, which
 * reveals that the route exists. Running first, a disabled route answers
 * exactly what a route that does not exist answers: 404 `Cannot <METHOD> <url>`
 * (the message Nest itself uses), passing through the same global exception
 * filter.
 */
@Injectable()
export class FeatureGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly flags: FeatureFlagsService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;

    const required = this.reflector.getAllAndMerge<FeatureFlag[]>(
      REQUIRE_FEATURE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required || required.length === 0) return true;
    if (required.every((flag) => this.flags.isEnabled(flag))) return true;

    const req = context.switchToHttp().getRequest<{
      method: string;
      url: string;
    }>();
    throw new NotFoundException(`Cannot ${req.method} ${req.url}`);
  }
}
