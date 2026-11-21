import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  Activity,
  ActivityAction,
  ActivityTargetType,
  ActivityVisibility,
  CreationMode,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  WriteContext,
  assertWriteContext,
  contextMetadata,
  isSilent,
} from '../domain-writer/write-context';

export interface RecordActivityParams {
  actorId: string | null; // null = system-generated (e.g. scheduled due-date reminder)
  action: ActivityAction;
  targetType: ActivityTargetType;
  targetId: string;
  workspaceId: string;
  metadata?: Prisma.InputJsonValue;
  visibility?: ActivityVisibility; // defaults per action below if omitted
  /**
   * Step 4.6: the moment the change happened in the SOURCE system. Honoured only with a context that has
   * `keepOriginalDates` (which assertWriteContext already restricts to origin IMPORT); ignored everywhere else, so the
   * public API can never backdate history.
   */
  createdAt?: Date;
}

/** Actions that are SILENT by default (drive notifications only, never rendered in the visible feed). */
const SILENT_ACTIONS: ReadonlySet<ActivityAction> = new Set([
  ActivityAction.DUE_DATE_APPROACHING,
]);

/**
 * Shared writer used by Tasks/Projects/Collaboration services. The ONLY
 * place Activity rows get created — every caller goes through here so the
 * async fan-out trigger (EventEmitter2) fires uniformly, per
 * AN__FANOUT__TRIGGER: "triggered asynchronously, AFTER the source
 * transaction commits... NOT inline in the same request."
 *
 * record() awaits the INSERT (the fast, synchronous part — the row must
 * exist before the HTTP response returns) but does NOT await the emitted
 * event's listener (FanoutService) — emit() invokes the listener
 * synchronously up to its first `await`, then returns control here
 * immediately, so the actual recipient-resolution/notification-creation
 * work continues in the background without blocking the request. No job
 * queue (BullMQ/etc.) exists in this codebase — this is the same
 * "no job scheduler" constraint already established in Foundations.
 */
@Injectable()
export class ActivityService {
  private readonly logger = new Logger(ActivityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * No `ctx` = the original behaviour, exactly (ADR-0003 decision 1): insert
   * on the shared client, then emit immediately.
   *
   * With a `ctx` (ADR-0003 decisions 4-6):
   *  - inserts on `ctx.tx` when there is one;
   *  - `silent`/`bulk`: the row is still written (history is kept) but with
   *    visibility SILENT, and `activity.created` is NOT emitted, so no
   *    fan-out runs;
   *  - otherwise, inside a transaction the emit is deferred onto
   *    `ctx.afterCommit` so a rollback emits nothing.
   * `origin`/`importJobId` are recorded in metadata.
   */
  async record(
    params: RecordActivityParams,
    ctx?: WriteContext,
  ): Promise<Activity> {
    if (!ctx) {
      const activity = await this.prisma.activity.create({
        data: this.buildRow(params, undefined),
      });
      this.eventEmitter.emit('activity.created', activity);
      return activity;
    }

    assertWriteContext(ctx);
    const db = ctx.tx ?? this.prisma;
    const activity = await db.activity.create({
      data: this.buildRow(params, ctx),
    });

    if (isSilent(ctx)) return activity; // history kept, nothing emitted

    if (ctx.tx) {
      if (!ctx.afterCommit) {
        // Emitting inside an open transaction would let a listener observe
        // rows that are later rolled back. Refuse rather than guess.
        throw new Error(
          'ActivityService.record: ctx.tx requires ctx.afterCommit - run the write through DomainWriter.run()',
        );
      }
      ctx.afterCommit.push(() =>
        this.eventEmitter.emit('activity.created', activity),
      );
      return activity;
    }

    this.eventEmitter.emit('activity.created', activity);
    return activity;
  }

  /**
   * Bulk history rows for a silent/bulk write: one INSERT, no per-row return,
   * never emits. Refuses a non-silent context outright - a caller that wants
   * fan-out must use record() so the emit rule above applies.
   */
  async recordMany(
    rows: RecordActivityParams[],
    ctx: WriteContext,
  ): Promise<number> {
    assertWriteContext(ctx);
    if (!isSilent(ctx)) {
      throw new Error('ActivityService.recordMany requires a silent/bulk ctx');
    }
    if (rows.length === 0) return 0;
    const db = ctx.tx ?? this.prisma;
    const result = await db.activity.createMany({
      data: rows.map((r) => this.buildRow(r, ctx)),
    });
    return result.count;
  }

  private buildRow(
    params: RecordActivityParams,
    ctx: WriteContext | undefined,
  ): Prisma.ActivityUncheckedCreateInput {
    const defaultVisibility = SILENT_ACTIONS.has(params.action)
      ? ActivityVisibility.SILENT
      : ActivityVisibility.TIMELINE;
    // Step 4.6: a silent IMPORT write may ask for IMPORTED (history copied from another system: kept, but shown only on the
    // task's own history). Every other silent write is still forced to SILENT.
    const importedHistory =
      !!ctx &&
      ctx.origin === CreationMode.IMPORT &&
      params.visibility === ActivityVisibility.IMPORTED;
    return {
      actorId: params.actorId,
      action: params.action,
      targetType: params.targetType,
      targetId: params.targetId,
      workspaceId: params.workspaceId,
      visibility: importedHistory
        ? ActivityVisibility.IMPORTED
        : isSilent(ctx)
          ? ActivityVisibility.SILENT
          : (params.visibility ?? defaultVisibility),
      metadata: ctx ? contextMetadata(params.metadata, ctx) : params.metadata,
      ...(ctx?.keepOriginalDates && params.createdAt
        ? { createdAt: params.createdAt }
        : {}),
    };
  }
}
