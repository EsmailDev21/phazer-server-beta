import { Injectable, Logger } from '@nestjs/common';
import { channelFor } from '../../activity-notifications/sse/notification-sse-registry.service';
import { RedisPubSubService } from '../../redis/redis-pubsub.service';
import { ImportProgress } from '../imports.types';

export type Outcome = 'created' | 'updated' | 'skipped' | 'failed';

/**
 * Step 4.4. The running counters of one import (ImportJob.progress). The DATABASE is the source of truth: the executor
 * persists a snapshot inside every chunk's own transaction, and after any failed write it reloads the tracker from the row, so
 * a retried or bisected chunk can never double-count.
 */
export class ProgressTracker {
  phase: string | null;
  private counts: ImportProgress['counts'];
  private charged: Record<string, number>;

  constructor(prev?: unknown) {
    const p = (prev && typeof prev === 'object' ? prev : {}) as Partial<ImportProgress>;
    this.phase = typeof p.phase === 'string' ? p.phase : null;
    this.counts = {};
    for (const [type, row] of Object.entries(p.counts ?? {})) {
      if (!row || typeof row !== 'object') continue;
      this.counts[type] = {};
      for (const o of ['created', 'updated', 'skipped', 'failed'] as const) {
        const n = (row as Record<string, unknown>)[o];
        if (typeof n === 'number' && Number.isFinite(n) && n > 0) this.counts[type][o] = Math.floor(n);
      }
    }
    this.charged = {};
    for (const [period, n] of Object.entries(p.chargedByPeriod ?? {})) {
      if (typeof n === 'number' && Number.isFinite(n) && n > 0) this.charged[period] = Math.floor(n);
    }
  }

  add(type: string, outcome: Outcome, n = 1): void {
    if (n <= 0) return;
    const row = (this.counts[type] ??= {});
    row[outcome] = (row[outcome] ?? 0) + n;
  }

  /** Overwrites one counter. For counts DERIVED from rows (the file copy phase), so a replay can never double them. */
  set(type: string, outcome: Outcome, n: number): void {
    const row = (this.counts[type] ??= {});
    if (n > 0) row[outcome] = Math.floor(n);
    else delete row[outcome];
  }

  charge(period: string, items: number): void {
    if (items > 0) this.charged[period] = (this.charged[period] ?? 0) + items;
  }

  get(type: string, outcome: Outcome): number {
    return this.counts[type]?.[outcome] ?? 0;
  }

  totals(): Record<Outcome, number> {
    const t: Record<Outcome, number> = { created: 0, updated: 0, skipped: 0, failed: 0 };
    for (const row of Object.values(this.counts)) for (const o of Object.keys(t) as Outcome[]) t[o] += row[o] ?? 0;
    return t;
  }

  /** Items already charged to the monthly meter, by period (a rollback refunds exactly these). */
  chargedByPeriod(): Record<string, number> {
    return { ...this.charged };
  }

  snapshot(now: Date = new Date()): ImportProgress {
    return {
      phase: this.phase,
      counts: JSON.parse(JSON.stringify(this.counts)),
      chargedByPeriod: { ...this.charged },
      updatedAt: now.toISOString(),
    };
  }
}

export interface ProgressMessage {
  importJobId: string;
  status: string;
  progress: ImportProgress | null;
  pauseReason: string | null;
}

/**
 * Step 4.4 / diagram 05: progress to the person's browser over the EXISTING per-user SSE stream (`sse:user:<id>`, Redis
 * pub/sub so it crosses the worker -> API process boundary). Best effort and never the source of truth: the job row is.
 * A dropped message costs a UI refresh, never data; a failure here must never fail an import.
 */
@Injectable()
export class ImportProgressPublisher {
  private readonly logger = new Logger(ImportProgressPublisher.name);
  constructor(private readonly pubsub: RedisPubSubService) {}

  async publish(userId: string, msg: ProgressMessage): Promise<void> {
    try {
      await this.pubsub.publish(
        channelFor(userId),
        JSON.stringify({ id: `import:${msg.importJobId}`, type: 'IMPORT_PROGRESS', sourceType: 'IMPORT', sourceId: msg.importJobId, createdAt: new Date().toISOString(), data: msg }),
      );
    } catch (e) {
      this.logger.warn(`Import progress push failed: ${(e as Error).message}`);
    }
  }
}
