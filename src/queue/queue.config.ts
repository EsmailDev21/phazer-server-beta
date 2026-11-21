import type { DefaultJobOptions } from 'bullmq';

/**
 * Defaults for every job (ADR-0001: at-least-once, so jobs must be idempotent).
 *
 * Dead-letter policy: BullMQ's own *failed* set IS the dead-letter store. A job
 * that exhausts its attempts (or throws UnrecoverableError) stays there for 14
 * days for inspection and manual retry, and the worker logs it once at ERROR
 * with its trace id. No second queue: it would add a moving part without adding
 * any capability the failed set does not already have.
 */
export const DEFAULT_JOB_OPTIONS: DefaultJobOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 1_000 }, // 1s, 2s, 4s, 8s
  removeOnComplete: { age: 60 * 60, count: 1_000 },
  removeOnFail: { age: 14 * 24 * 60 * 60 },
};

/** Keys in a shared Redis must not collide across environments. */
export function resolveQueuePrefix(env: NodeJS.ProcessEnv): string {
  const explicit = env.QUEUE_PREFIX?.trim();
  return explicit || `bull-${env.NODE_ENV || 'development'}`;
}

export const DEFAULT_ENQUEUE_TIMEOUT_MS = 3_000;
export const DEFAULT_SHUTDOWN_GRACE_MS = 25_000;

export function resolveShutdownGraceMs(env: NodeJS.ProcessEnv): number {
  const raw = Number(env.WORKER_SHUTDOWN_GRACE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SHUTDOWN_GRACE_MS;
}
