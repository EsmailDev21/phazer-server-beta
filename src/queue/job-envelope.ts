import { randomUUID } from 'crypto';

/**
 * Every job carries this (ADR-0001), so any worker log line can be tied back to
 * the request/actor/tenant that caused it. `v` lets the shape evolve while old
 * jobs still sit in Redis.
 */
export interface JobEnvelope<T = unknown> {
  v: 1;
  traceId: string;
  accountId: string | null;
  actorId: string | null;
  payload: T;
}

export interface JobContext {
  traceId?: string;
  accountId?: string | null;
  actorId?: string | null;
}

export class InvalidEnvelopeError extends Error {
  constructor(reason: string) {
    super(`Invalid job envelope: ${reason}`);
    this.name = 'InvalidEnvelopeError';
  }
}

export function buildEnvelope<T>(
  payload: T,
  ctx: JobContext = {},
): JobEnvelope<T> {
  return {
    v: 1,
    traceId: ctx.traceId ?? randomUUID(),
    accountId: ctx.accountId ?? null,
    actorId: ctx.actorId ?? null,
    payload,
  };
}

// accountId/actorId are optional in the wire format (older enqueuers may omit
// them); missing is treated the same as explicit null.
const isNullableString = (x: unknown) =>
  x === undefined || x === null || typeof x === 'string';

/** Validates untrusted data read back from Redis. Throws InvalidEnvelopeError. */
export function parseEnvelope(data: unknown): JobEnvelope {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new InvalidEnvelopeError('not an object');
  }
  const d = data as Record<string, unknown>;
  if (d.v !== 1)
    throw new InvalidEnvelopeError(`unsupported version ${String(d.v)}`);
  if (typeof d.traceId !== 'string' || d.traceId === '') {
    throw new InvalidEnvelopeError('traceId missing');
  }
  if (!isNullableString(d.accountId))
    throw new InvalidEnvelopeError('accountId must be string or null');
  if (!isNullableString(d.actorId))
    throw new InvalidEnvelopeError('actorId must be string or null');
  if (!('payload' in d)) throw new InvalidEnvelopeError('payload missing');
  return d as unknown as JobEnvelope;
}
