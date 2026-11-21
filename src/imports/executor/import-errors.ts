import { HttpException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { BulkWriteError } from '../../domain-writer/domain-writer.service';
import { PlanLimitExceededException } from '../../common/exceptions/plan-limit-exceeded.exception';
import { ConnectionNeedsReauthError } from '../../integrations/core/credential.service';
import {
  ProviderAuthRejectedError,
  ProviderCircuitOpenError,
  ProviderHttpError,
  ProviderRateLimitedError,
} from '../../integrations/core/integration.types';

/**
 * Step 4.4. What an error means for a RUNNING import (diagram 04: "429 / reauth / quota -> PAUSED; invalid -> issue, continue;
 * anything else -> FAILED"). Pure, so every branch is a table row.
 *
 *  AUTH        the provider no longer accepts the token -> PAUSED until the person reconnects and resumes
 *  PLAN_LIMIT  a plan cap stopped the write                 -> PAUSED until the person frees room / upgrades and resumes
 *  RATE_LIMIT  the provider asked us to wait               -> PAUSED, retried by itself after `delayMs`
 *  TRANSIENT   network / 5xx / deadlock / pool             -> PAUSED, retried by itself after `delayMs` (backing off)
 *  ITEM        THIS data was refused (a 4xx from our own writers) -> isolate the offending item(s), report, continue
 *  FATAL       anything else: a bug, a 4xx from the provider (the selection vanished), a malformed page -> FAILED (resumable)
 */
export type ImportErrorKind = 'AUTH' | 'PLAN_LIMIT' | 'RATE_LIMIT' | 'TRANSIENT' | 'ITEM' | 'FATAL';

export interface ClassifiedImportError {
  kind: ImportErrorKind;
  /** Wait before the automatic retry (RATE_LIMIT / TRANSIENT). */
  delayMs?: number;
  /** For the person: shown as the job's pause / failure reason. Never a stack trace, never a provider body. */
  message: string;
}

/** A deliberate stop with a message written for the person (e.g. "preview the import again"). Always FATAL, never retried. */
export class ImportFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportFailure';
  }
}

export const BACKOFF = { baseMs: 15_000, maxMs: 10 * 60_000, maxRateLimitMs: 30 * 60_000, circuitMs: 60_000 } as const;
/** After this many consecutive automatic retries without progress the job stops retrying and FAILS (resumable). */
export const MAX_AUTO_RETRIES = 8;

/** 15s, 30s, 60s ... capped at 10 min. `n` is the number of automatic retries already made (0-based). */
export function backoffMs(n: number): number {
  return Math.min(BACKOFF.baseMs * 2 ** Math.max(n, 0), BACKOFF.maxMs);
}

const TRANSIENT_PRISMA = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2028', 'P2034']);
const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT']);

/** The error a bulk write wraps. */
export function unwrap(e: unknown): unknown {
  return e instanceof BulkWriteError ? e.causeError : e;
}

export function classifyImportError(raw: unknown, retries = 0): ClassifiedImportError {
  const e = unwrap(raw);

  if (e instanceof ImportFailure) return { kind: 'FATAL', message: e.message };
  if (e instanceof ConnectionNeedsReauthError || e instanceof ProviderAuthRejectedError) {
    return { kind: 'AUTH', message: 'The connection needs to be reconnected. Reconnect it, then resume the import.' };
  }
  if (e instanceof PlanLimitExceededException) {
    return { kind: 'PLAN_LIMIT', message: `Your plan's limit was reached: ${e.message}. Free some room or upgrade, then resume the import.` };
  }
  if (e instanceof ProviderRateLimitedError) {
    const delay = Math.min(Math.max(e.retryAfterMs, BACKOFF.baseMs), BACKOFF.maxRateLimitMs);
    return { kind: 'RATE_LIMIT', delayMs: delay, message: `The provider asked us to slow down; continuing in ${Math.ceil(delay / 1000)}s.` };
  }
  if (e instanceof ProviderCircuitOpenError) {
    return { kind: 'TRANSIENT', delayMs: BACKOFF.circuitMs, message: 'The provider is not answering; trying again shortly.' };
  }
  if (e instanceof ProviderHttpError) {
    if (e.status >= 500 || e.status === 0 || e.status === 408 || e.status === 425) {
      return { kind: 'TRANSIENT', delayMs: backoffMs(retries), message: `The provider had a problem (HTTP ${e.status}); trying again shortly.` };
    }
    // 401 / 403 are handled by CredentialService as auth; a 404 / 410 / 422 here means the source itself changed
    return { kind: 'FATAL', message: `The provider refused the request (HTTP ${e.status}); the selected source may have been removed or renamed.` };
  }
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    if (TRANSIENT_PRISMA.has(e.code)) return { kind: 'TRANSIENT', delayMs: backoffMs(retries), message: 'The database was busy; trying again shortly.' };
    // unique / foreign key / not found: THIS data conflicts with something that exists now
    if (['P2002', 'P2003', 'P2025', 'P2014', 'P2011', 'P2000'].includes(e.code)) return { kind: 'ITEM', message: 'An item conflicted with existing data.' };
  }
  if (e instanceof Prisma.PrismaClientInitializationError || e instanceof Prisma.PrismaClientRustPanicError) {
    return { kind: 'TRANSIENT', delayMs: backoffMs(retries), message: 'The database is not reachable; trying again shortly.' };
  }
  if (e instanceof HttpException) {
    // our own writers refusing this data (depth, parent in another project, date order, cap of types ...). 5xx = a bug.
    return e.getStatus() < 500 ? { kind: 'ITEM', message: e.message } : { kind: 'FATAL', message: 'The import hit an internal error.' };
  }
  // the storage SDK (step 4.6): a 5xx / throttle from the object store is a hiccup, not a bug
  const httpStatus = (e as { $metadata?: { httpStatusCode?: unknown } } | null)?.$metadata?.httpStatusCode;
  if (typeof httpStatus === 'number' && (httpStatus >= 500 || httpStatus === 429)) {
    return { kind: 'TRANSIENT', delayMs: backoffMs(retries), message: 'The file storage had a problem; trying again shortly.' };
  }
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && NETWORK_CODES.has(code)) {
    return { kind: 'TRANSIENT', delayMs: backoffMs(retries), message: 'A network problem interrupted the import; trying again shortly.' };
  }
  return { kind: 'FATAL', message: 'The import hit an unexpected internal error.' };
}
