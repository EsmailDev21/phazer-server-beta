import { FeatureFlag } from '../feature-flags/feature-flags';

/**
 * The one registry of queues (ADR-0001). A queue's `flag`, when set, means:
 * the worker does not consume it and removes its schedules while that flag is
 * off (ADR-0002). `flag: null` = always on.
 */
export interface QueueDefinition {
  readonly name: string;
  readonly flag: FeatureFlag | null;
  /** Jobs processed in parallel by ONE worker process for this queue. */
  readonly concurrency: number;
  /**
   * BullMQ's stalled-job check interval (ms), default 30000. Left unset
   * everywhere except test queue definitions.
   *
   * Found by testing, not documented: BullMQ 6.3.8's Worker.close() calls
   * `this.stalledCheckStopper?.()` to cancel the pending stalled-check
   * setTimeout, but `stalledChecker()` (worker.js) only ASSIGNS
   * `stalledCheckStopper` after its first async iteration (a Redis round
   * trip) completes. A worker closed before that iteration finishes has
   * nothing to cancel: BullMQ's own 30s timer then keeps the process alive
   * for up to `stalledInterval` ms past close() - confirmed by measuring the
   * process's actual exit time, which lands within a few ms of exactly that
   * value. Bounded, not a leak, and irrelevant to a real long-running worker;
   * but our own tests DO close workers within milliseconds of creating them
   * (by design, for speed), so test queue definitions set this low.
   */
  readonly stalledIntervalMs?: number;
}

export const QUEUES = {
  /** Housekeeping and platform jobs (step 0.3 moves the deferred sweeps here). */
  SYSTEM: { name: 'system', flag: null, concurrency: 5 },
  /** Step 2.3: outbound chat notifications (ADR-0011). Off with FEATURE_INTEGRATIONS. */
  NOTIFY: { name: 'notify', flag: 'INTEGRATIONS', concurrency: 5 },
  /** Step 2.4: deferred chat commands (Discord interaction follow-ups; Slack in 2.5). */
  CHAT: { name: 'chat', flag: 'INTEGRATIONS', concurrency: 5 },
  /** Step 2.6: verified provider webhooks, processed after the 200 (GitHub events; ADR-0014). */
  WEBHOOK: { name: 'webhooks', flag: 'INTEGRATIONS', concurrency: 5 },
  /**
   * Step 4.1 / 4.4. Import runs and rollbacks. Low concurrency on purpose: one import already saturates a provider's
   * rate limit and a Postgres transaction per chunk; two parallel jobs per worker is the most that helps.
   * Attachment copy gets its own queue in step 4.6 so a slow download never blocks task chunks.
   */
  IMPORTS: { name: 'imports', flag: 'IMPORTS', concurrency: 2 },
  /** Step 4.6 (diagram 05, lane "Attachment copy"): file downloads, one at a time per worker, so a slow provider never holds a task-chunk slot. */
  IMPORT_FILES: { name: 'import-files', flag: 'IMPORTS', concurrency: 1 },
} as const satisfies Record<string, QueueDefinition>;

export type QueueKey = keyof typeof QUEUES;
export type QueueName = (typeof QUEUES)[QueueKey]['name'];

export const QUEUE_DEFINITIONS: readonly QueueDefinition[] =
  Object.values(QUEUES);

export function definitionOf(name: string): QueueDefinition {
  const def = QUEUE_DEFINITIONS.find((d) => d.name === name);
  if (!def) throw new Error(`Unknown queue "${name}"`);
  return def;
}

/**
 * Job name -> payload type. An INTERFACE on purpose: each later step adds its
 * own jobs next to the code that handles them, by declaration merging:
 *
 *   declare module '../queue/queue.definitions' {
 *     interface JobPayloads { 'imports.run-chunk': { importJobId: string } }
 *   }
 */
export interface JobPayloads {
  'system.ping': { note?: string };
}
export type JobName = keyof JobPayloads;
