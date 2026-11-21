import {
  BadRequestException,
  ExecutionContext,
  HttpCode,
  HttpStatus,
  SetMetadata,
  applyDecorators,
  createParamDecorator,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Request } from 'express';
import { Public } from './public.decorator';

export const PUBLIC_SIGNED_KEY = 'publicSigned';

/**
 * A route called by an external provider (GitHub, Slack, Discord, ...) that
 * authenticates by SIGNATURE, not by a user JWT. Step 0.9.
 *
 * What it does:
 *  - `@Public()`: JwtAuthGuard lets it through. The handler is then entirely
 *    responsible for verifying the signature against the RAW body before it
 *    does anything else, and in particular before it writes to the database
 *    (an unauthenticated caller must not be able to fill the dedupe table).
 *  - skips the DEFAULT throttle (100 req/min/IP): providers deliver bursts from
 *    a handful of IPs, and 429s make them disable the webhook. Abuse
 *    protection on these routes is the signature check, not a request counter.
 *  - answers 200 instead of Nest's POST default of 201 (providers expect 200).
 *    A route can still override with its own @HttpCode.
 *  - marks the route so PublicSignedAuditor can check, at boot, that it takes
 *    its payload with @SignedPayload()/@SignedRawBody() (see below).
 *
 * What it deliberately does NOT do: swap in a permissive ValidationPipe. That
 * cannot work - the strict pipe is registered globally (main.ts) and Nest runs
 * global pipes BEFORE route/param pipes, so a route-level pipe never gets the
 * chance to relax anything (proved in public-signed.spec.ts). The mechanism is
 * the two param decorators below, which the global ValidationPipe never
 * validates; the auditor enforces that nobody bypasses them.
 *
 * METHOD decorator only (it includes @HttpCode, which cannot decorate a class).
 *
 * Pair with `@RequireFeature('INTEGRATIONS')` (ADR-0002) so a disabled
 * integration answers 404 before anything else.
 */
export const PublicSigned = () =>
  applyDecorators(
    Public(),
    SkipThrottle({ default: true }),
    HttpCode(HttpStatus.OK),
    SetMetadata(PUBLIC_SIGNED_KEY, true),
  );

type RawBodyRequest = Request & { rawBody?: Buffer };

/**
 * The EXACT bytes the provider signed (`rawBody: true` is enabled globally in
 * main.ts). 400 if absent - never fall back to re-serialising the parsed body,
 * which is not guaranteed byte-identical and would make verification
 * unreliable in a way that only shows up on real traffic.
 */
export const SignedRawBody = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Buffer => {
    const req = ctx.switchToHttp().getRequest<RawBodyRequest>();
    if (!Buffer.isBuffer(req.rawBody)) {
      throw new BadRequestException('Missing raw request body');
    }
    return req.rawBody;
  },
);

/**
 * The parsed payload, untouched: no whitelist, no forbidNonWhitelisted, no
 * transform. A custom param decorator is skipped by the global ValidationPipe
 * (it only validates custom decorators when `validateCustomDecorators` is set),
 * which is exactly what a provider payload needs - it carries fields we do not
 * and should not declare. Treat everything in it as untrusted input until the
 * adapter has parsed the pieces it needs.
 */
export const SignedPayload = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): unknown =>
    ctx.switchToHttp().getRequest<Request>().body ?? {},
);
