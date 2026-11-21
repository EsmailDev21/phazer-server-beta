import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Request } from 'express';
import {
  AuthenticatedUser,
  JwtPayload,
} from '../interfaces/jwt-payload.interface';

/**
 * JwtStrategy.validate(payload) returns MINIMAL identity ONLY:
 * { userId, email }. NO nested fetch of preferences/organizations/teams/
 * members — that eager fetch is deleted entirely (was: real per-request
 * perf cost, confirmed in audit). Downstream context (account/workspace/
 * role) is resolved per-request by PermissionResolver, not pre-loaded here.
 *
 * Token extraction checks the Authorization header FIRST, then falls back
 * to the `accessToken` httpOnly cookie (set by the Google OAuth callback).
 * ADDED for the Activity/Notifications module's SSE endpoint
 * (GET /notifications/stream): browser EventSource cannot set custom
 * request headers, so cookie-based auth is the only way an SSE connection
 * can authenticate — "the same httpOnly cookie already used for normal
 * auth," per that graph. Bearer-header clients are unaffected.
 */
const cookieExtractor = (req: Request): string | null => {
  return req?.cookies?.accessToken ?? null;
};

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(configService: ConfigService) {
    // JWT_SECRET presence is already enforced at bootstrap (main.ts fails
    // fast before app.listen() if unset) — safe to read directly here.
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        ExtractJwt.fromAuthHeaderAsBearerToken(),
        cookieExtractor,
      ]),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('JWT_SECRET') as string,
    });
  }

  validate(payload: JwtPayload): AuthenticatedUser {
    return { userId: payload.sub, email: payload.email };
  }
}
