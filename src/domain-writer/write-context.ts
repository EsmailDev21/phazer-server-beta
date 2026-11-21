import { BadRequestException } from '@nestjs/common';
import { CreationMode, Prisma } from '@prisma/client';

/**
 * ADR-0003. Describes HOW a write happens (who/what originated it, whether it
 * may notify anyone, which transaction it belongs to) - never WHAT is written.
 *
 * Never built from request input: no DTO has any of these fields, and the
 * global ValidationPipe (`forbidNonWhitelisted`) rejects unknown properties,
 * so the public API cannot set `origin`, `keepOriginalDates` or `importJobId`.
 * Only server-side code (DomainWriter callers: chat handlers, importers,
 * template applier, automations) constructs one.
 */
export interface WriteContext {
  /** Replaces the hard-coded `createdVia: 'MANUAL'` of the controller path. */
  origin: CreationMode;
  /** null = system. Becomes the Activity actor. */
  actorId: string | null;
  /** Write history rows (visibility SILENT) but emit nothing. */
  silent?: boolean;
  /** Chunked high-volume write. Implies `silent`. */
  bulk?: boolean;
  /** Honour caller-supplied createdAt/updatedAt. Throws unless origin is IMPORT. */
  keepOriginalDates?: boolean;
  /** Recorded in activity metadata (Task has no column for it). */
  importJobId?: string;
  /**
   * Step 2.3 echo guard: the chat channel an INTEGRATION write came from. The notification router
   * never posts the resulting activity back into that same channel (the command reply already did).
   */
  integrationSource?: { connectionId: string; channelId: string };
  /**
   * Step 5.2. Set only by the automation runner: which rule made this write and how many rule-made
   * hops deep it is (1 = a person's change caused the rule). Recorded in activity metadata, which is
   * how the runner recognises its own writes and stops loops. Never built from request input.
   */
  automation?: { id: string; depth: number };
  /** Explicit transaction (ADR-0003 decision 4: no ambient transactions). */
  tx?: Prisma.TransactionClient;
  /**
   * Callbacks to run once the transaction commits. OWNED BY THE WRITER
   * (`DomainWriter.run` creates and flushes it); callers never populate it.
   */
  afterCommit?: Array<() => void>;
}

/** `bulk` implies `silent` (ADR-0003 decision 8). */
export function isSilent(ctx: WriteContext | undefined): boolean {
  return !!ctx && (ctx.silent === true || ctx.bulk === true);
}

/**
 * Enforced on every service entry point that accepts a context.
 * Plain `Error`s on programmer mistakes would surface as a 500 if one ever
 * escaped to HTTP; these are all server-side misuse, so that is intended
 * - except keepOriginalDates, which is the one rule that protects the public
 * API from backdating, so it is a loud 400-class failure as well.
 */
export function assertWriteContext(ctx: WriteContext): void {
  if (ctx.keepOriginalDates && ctx.origin !== CreationMode.IMPORT) {
    throw new BadRequestException(
      'keepOriginalDates is only valid for origin IMPORT',
    );
  }
  if (ctx.afterCommit && !ctx.tx) {
    throw new Error('WriteContext.afterCommit without a tx is meaningless');
  }
}

/** Metadata every context-bearing activity row carries (ADR-0003 decision 6). */
export function contextMetadata(
  base: Prisma.InputJsonValue | undefined,
  ctx: WriteContext,
): Prisma.InputJsonValue {
  const extra: Record<string, string> = { origin: ctx.origin };
  if (ctx.importJobId) extra.importJobId = ctx.importJobId;
  const withSource: Record<string, unknown> = { ...extra };
  if (ctx.integrationSource) withSource.integration = ctx.integrationSource;
  // step 5.2: which rule (and how deep) made this write; the runner reads it back to stop loops
  if (ctx.automation) withSource.automation = { id: ctx.automation.id, depth: ctx.automation.depth };

  if (base === undefined || base === null) return withSource as Prisma.InputJsonObject;
  if (typeof base === 'object' && !Array.isArray(base)) {
    // Caller's own keys win over ours only if they chose the same name on
    // purpose; 'origin'/'importJobId' are reserved, so ours go last.
    return { ...(base as Prisma.InputJsonObject), ...(withSource as Prisma.InputJsonObject) };
  }
  return { value: base, ...(withSource as Prisma.InputJsonObject) };
}
