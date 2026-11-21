import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Marks a route as not requiring a valid JWT. JwtAuthGuard is applied
 * globally (APP_GUARD) per the Foundations stateless-auth design, so any
 * route that should be reachable without a token (register, login, health,
 * OAuth callback, etc.) must be explicitly opted out with this decorator.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
