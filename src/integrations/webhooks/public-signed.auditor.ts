import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { PUBLIC_SIGNED_KEY } from '../../auth/decorators/public-signed.decorator';

/**
 * Fails the boot (API process) if a @PublicSigned route takes its body as a
 * DTO class, i.e. `@Body() dto: SomeDto`.
 *
 * Why this exists: the global ValidationPipe is `whitelist + forbidNonWhitelisted`
 * and Nest runs global pipes before route-level ones, so a DTO-typed body on a
 * provider webhook rejects every real payload (they carry fields we never
 * declare) with a 400. Nothing local can relax that, and tests with a
 * hand-written minimal payload would pass - the failure would only appear on
 * real provider traffic. A boot error is the cheapest place to catch it.
 *
 * Allowed: no body at all, `@SignedPayload()`, `@SignedRawBody()`, or a plain
 * `@Body()` typed as `Record<string, unknown>` / `unknown` / `any` (those
 * compile to `Object`, which ValidationPipe never validates).
 */
@Injectable()
export class PublicSignedAuditor implements OnApplicationBootstrap {
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector,
  ) {}

  onApplicationBootstrap(): void {
    const problems = this.findProblems();
    if (problems.length > 0) {
      throw new Error(
        `@PublicSigned route(s) with a DTO-typed @Body():\n  - ${problems.join('\n  - ')}\n` +
          'The global ValidationPipe would reject real provider payloads (unknown fields). ' +
          'Take the payload with @SignedPayload() and/or @SignedRawBody() instead.',
      );
    }
  }

  /** Public for tests. Returns one line per offending handler parameter. */
  findProblems(): string[] {
    const problems: string[] = [];
    for (const wrapper of this.discovery.getControllers()) {
      const { instance, metatype } = wrapper;
      if (!instance || !metatype) continue;
      const proto = Object.getPrototypeOf(instance) as object;

      for (const methodName of this.scanner.getAllMethodNames(proto)) {
        const handler = (proto as Record<string, unknown>)[methodName] as
          (() => unknown) | undefined;
        if (typeof handler !== 'function') continue;
        const signed = this.reflector.get<boolean>(PUBLIC_SIGNED_KEY, handler);
        if (!signed) continue;

        const args = (Reflect.getMetadata(
          ROUTE_ARGS_METADATA,
          metatype,
          methodName,
        ) ?? {}) as Record<string, { index: number }>;
        const paramTypes = (Reflect.getMetadata(
          'design:paramtypes',
          proto,
          methodName,
        ) ?? []) as Array<unknown>;

        for (const [key, { index }] of Object.entries(args)) {
          // Keys look like "<paramtype>:<index>"; custom decorators use a
          // uuid-ish type string and are never RouteParamtypes.BODY.
          if (Number(key.split(':')[0]) !== RouteParamtypes.BODY) continue;
          const type = paramTypes[index];
          if (type && type !== Object) {
            problems.push(
              `${metatype.name}.${methodName}() parameter #${index} is typed ${
                (type as { name?: string }).name ?? String(type)
              }`,
            );
          }
        }
      }
    }
    return problems;
  }
}
