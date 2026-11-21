import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { AuditAction, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../events/audit-log.service';
import { PlanLimitsService } from '../access-control/plan-limits.service';
import { PlanLimitExceededException } from '../common/exceptions/plan-limit-exceeded.exception';
import { TasksService } from '../projects-tasks/tasks/tasks.service';
import { ProjectCreateExtras, ProjectsService } from '../projects-tasks/projects/projects.service';
import { CustomFieldsService } from '../projects-tasks/custom-fields/custom-fields.service';
import { CreateTaskDto } from '../projects-tasks/tasks/dto/create-task.dto';
import { CreateProjectDto } from '../projects-tasks/projects/dto/create-project.dto';
import { CreateCustomFieldDto } from '../projects-tasks/custom-fields/dto/create-custom-field.dto';
import {
  BulkTaskItem,
  TaskWriteExtras,
} from '../projects-tasks/tasks/task-write.types';
import { WriteContext, assertWriteContext } from './write-context';

/** ADR-0003 decision 8. Tuned later against the ADR-0004 lock-time measurement (1.7). */
export const DEFAULT_BULK_CHUNK_SIZE = 100;
/** Prisma's interactive-transaction default (5 s) is far too short for a chunk. */
export const DEFAULT_TX_TIMEOUT_MS = 30_000;
export const DEFAULT_TX_MAX_WAIT_MS = 10_000;

export interface RunOptions {
  timeoutMs?: number;
  maxWaitMs?: number;
}

export interface BulkTaskOptions extends RunOptions {
  chunkSize?: number;
  /**
   * Retry-safety hook (ADR-0003 decision 10). Runs INSIDE each chunk's
   * transaction, so an importer can look up its ExternalRef rows and drop the
   * items it already imported - atomically with the inserts that follow. A
   * chunk may run twice (at-least-once delivery); this is how it stays a no-op.
   */
  filterChunk?: (
    tx: Prisma.TransactionClient,
    chunk: BulkTaskItem[],
  ) => Promise<BulkTaskItem[]>;
  /**
   * Companion of `filterChunk` (step 4.4). Runs INSIDE the same transaction, right after the chunk's tasks are inserted, with
   * the items that were kept and the created rows in the same order (`created[n]` belongs to `kept[n]`). An importer records
   * its ExternalRef rows, tags, custom values and pending links here, so a crash can never leave a task without its ref (a
   * re-run would then create it twice) or a ref without its task. If it throws, the whole chunk rolls back.
   */
  afterChunk?: (
    tx: Prisma.TransactionClient,
    kept: BulkTaskItem[],
    created: Array<{ id: string }>,
  ) => Promise<void>;
}

export interface BulkTaskResult {
  createdIds: string[];
  /** Items dropped by `filterChunk` as already present. */
  skipped: number;
  chunks: number;
}

/**
 * Thrown when a chunk fails. Earlier chunks are committed and stay committed;
 * the failing chunk wrote nothing. `chunkIndex` + `createdIds` are what a
 * resumable importer persists to continue from its gate.
 */
export class BulkWriteError extends Error {
  readonly code: 'PLAN_LIMIT_EXCEEDED' | 'CHUNK_FAILED';
  constructor(
    readonly chunkIndex: number,
    readonly createdIds: string[],
    readonly causeError: unknown,
  ) {
    super(
      `Bulk write failed at chunk ${chunkIndex} (${createdIds.length} task(s) committed before it): ${
        causeError instanceof Error ? causeError.message : String(causeError)
      }`,
    );
    this.name = 'BulkWriteError';
    this.code =
      causeError instanceof PlanLimitExceededException
        ? 'PLAN_LIMIT_EXCEEDED'
        : 'CHUNK_FAILED';
  }
}

/**
 * ADR-0003. The one door for server-side writers (chat commands, importers,
 * template applier, automations) into tasks, projects and custom fields. It
 * wraps the existing services - validation and the activity row stay where
 * they are - and adds what those services cannot: a transaction, deferred
 * events, chunking, and the plan-limit check a worker never gets from a guard.
 *
 * It does NOT authorise. Callers do that before calling (decision 9).
 */
@Injectable()
export class DomainWriter {
  private readonly logger = new Logger(DomainWriter.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tasks: TasksService,
    private readonly projects: ProjectsService,
    private readonly customFields: CustomFieldsService,
    private readonly planLimits: PlanLimitsService,
    private readonly auditLog: AuditLogService,
  ) {}

  /**
   * Run `fn` in ONE transaction and fire the events it queued only after it
   * commits (decision 5). A rollback emits nothing. If `ctx` already carries
   * a transaction, `fn` joins it and the outer owner flushes.
   */
  async run<T>(
    ctx: WriteContext,
    fn: (ctx: WriteContext) => Promise<T>,
    opts: RunOptions = {},
  ): Promise<T> {
    assertWriteContext(ctx);

    if (ctx.tx) {
      if (!ctx.afterCommit) {
        throw new Error(
          'DomainWriter.run: a ctx with tx must come from an outer run() (afterCommit missing)',
        );
      }
      return fn(ctx);
    }

    const afterCommit: Array<() => void> = [];
    const result = await this.prisma.$transaction(
      (tx) => fn({ ...ctx, tx, afterCommit }),
      {
        timeout: opts.timeoutMs ?? DEFAULT_TX_TIMEOUT_MS,
        maxWait: opts.maxWaitMs ?? DEFAULT_TX_MAX_WAIT_MS,
      },
    );

    // Committed. A throwing listener must not turn a committed write into a
    // failed call (the caller would retry and duplicate it).
    for (const cb of afterCommit) {
      try {
        cb();
      } catch (err) {
        this.logger.error(
          `afterCommit callback failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    return result;
  }

  createTask(
    dto: CreateTaskDto,
    createdById: string,
    ctx: WriteContext,
    extras?: TaskWriteExtras,
    opts?: RunOptions,
  ) {
    return this.run(
      ctx,
      (c) => this.tasks.create(dto, createdById, c, extras),
      opts,
    );
  }

  createProject(
    dto: CreateProjectDto,
    createdById: string,
    ctx: WriteContext,
    opts?: RunOptions,
    extras?: ProjectCreateExtras,
  ) {
    return this.run(
      ctx,
      (c) => this.projects.create(dto, createdById, c, extras),
      opts,
    );
  }

  createCustomField(
    workspaceId: string,
    dto: CreateCustomFieldDto,
    ctx: WriteContext,
    opts?: RunOptions,
  ) {
    return this.run(
      ctx,
      (c) => this.customFields.create(workspaceId, dto, c),
      opts,
    );
  }

  setCustomValue(
    taskId: string,
    fieldId: string,
    value: unknown,
    ctx: WriteContext,
    opts?: RunOptions,
  ) {
    return this.run(
      ctx,
      (c) => this.customFields.setValue(taskId, fieldId, value, c),
      opts,
    );
  }

  /**
   * Bulk task create into one workspace: one transaction per chunk, the task
   * cap checked per project before each chunk, never silently truncating
   * (decisions 8, 9). Always runs as a silent bulk write regardless of the
   * `silent`/`bulk` flags passed in.
   */
  async createTasksBulk(
    workspaceId: string,
    items: BulkTaskItem[],
    createdById: string,
    ctx: WriteContext,
    opts: BulkTaskOptions = {},
  ): Promise<BulkTaskResult> {
    const bulkCtx: WriteContext = { ...ctx, bulk: true, silent: true };
    assertWriteContext(bulkCtx);
    if (bulkCtx.tx) {
      throw new Error(
        'createTasksBulk owns its transactions (one per chunk); do not pass ctx.tx',
      );
    }
    const chunkSize = opts.chunkSize ?? DEFAULT_BULK_CHUNK_SIZE;
    if (!Number.isInteger(chunkSize) || chunkSize < 1) {
      throw new Error(`createTasksBulk: invalid chunkSize ${chunkSize}`);
    }

    const result: BulkTaskResult = { createdIds: [], skipped: 0, chunks: 0 };

    // ADR-0005 decision 12. `parentIndex` is an index into THE ARRAY PASSED HERE,
    // not into whichever chunk the item lands in. Validated up front (a parent
    // must come earlier), then remapped per chunk below.
    const globalIndex = new Map<BulkTaskItem, number>();
    items.forEach((item, idx) => {
      globalIndex.set(item, idx);
      if (item.parentIndex !== undefined) {
        if (
          !Number.isInteger(item.parentIndex) ||
          item.parentIndex < 0 ||
          item.parentIndex >= idx
        ) {
          throw new BadRequestException(
            `item ${idx}: parentIndex must refer to an EARLIER item of the list`,
          );
        }
        if (item.parentId) {
          throw new BadRequestException(
            `item ${idx}: give parentId OR parentIndex, not both`,
          );
        }
      }
    });
    /** Ids of everything created so far, by global index (input order). */
    const idsByIndex = new Map<number, string>();

    for (let i = 0; i < items.length; i += chunkSize) {
      const chunkIndex = result.chunks;
      const chunk = items.slice(i, i + chunkSize);
      try {
        const out = await this.run(
          bulkCtx,
          async (c) => {
            const tx = c.tx as Prisma.TransactionClient;
            const kept = opts.filterChunk
              ? await opts.filterChunk(tx, chunk)
              : chunk;
            if (kept.length === 0)
              return { ids: [] as string[], keptIdx: [] as number[], kept: 0 };

            // Remap each parentIndex to what createChunk understands: an index into
            // THIS chunk's kept items, or - when the parent was created by an
            // earlier chunk - its real id.
            const keptPos = new Map(kept.map((item, pos) => [item, pos]));
            const resolved = kept.map((item, pos) => {
              if (item.parentIndex === undefined) return item;
              const parentItem = items[item.parentIndex];
              const local = keptPos.get(parentItem);
              if (local !== undefined) return { ...item, parentIndex: local };
              const existingId = idsByIndex.get(item.parentIndex);
              if (existingId) {
                return {
                  ...item,
                  parentIndex: undefined,
                  parentId: existingId,
                };
              }
              throw new BadRequestException(
                `item ${globalIndex.get(kept[pos])}: its parent (item ${item.parentIndex}) was skipped or not created; pass parentId for a parent that already exists`,
              );
            });

            await this.assertTaskCap(tx, workspaceId, resolved);
            const created = await this.tasks.createChunk(
              workspaceId,
              resolved,
              createdById,
              c,
            );
            // createChunk returns input order, so created[n] belongs to kept[n].
            if (opts.afterChunk) await opts.afterChunk(tx, kept, created);
            return {
              ids: created.map((t) => t.id),
              keptIdx: kept.map((item) => globalIndex.get(item) as number),
              kept: kept.length,
            };
          },
          opts,
        );
        out.ids.forEach((id, n) => idsByIndex.set(out.keptIdx[n], id));
        result.createdIds.push(...out.ids);
        result.skipped += chunk.length - out.kept;
        result.chunks += 1;
      } catch (err) {
        throw new BulkWriteError(chunkIndex, result.createdIds, err);
      }
    }
    return result;
  }

  /**
   * Step 4.4: attach an imported task to a parent that was created later (see TasksService.attachImportedChild). Joins the
   * caller's transaction (`ctx.tx` required).
   */
  attachImportedChild(
    workspaceId: string,
    taskId: string,
    parentId: string,
    ctx: WriteContext,
    opts?: RunOptions,
  ) {
    return this.run(
      ctx,
      (c) => this.tasks.attachImportedChild(workspaceId, taskId, parentId, c),
      opts,
    );
  }

  /** Step 4.7b: re-point a link in an imported task's description (see TasksService.rewriteImportedText). Joins `ctx.tx`. */
  rewriteImportedText(workspaceId: string, taskId: string, from: string, to: string, ctx: WriteContext, opts?: RunOptions) {
    return this.run(ctx, (c) => this.tasks.rewriteImportedText(workspaceId, taskId, from, to, c), opts);
  }

  /**
   * ONE summary per job, emitted normally so the existing auditlog.created
   * fan-out turns it into an ACCOUNT_ALERT for OWNER/ADMIN (decision 7).
   */
  recordJobSummary(params: {
    actorId: string;
    accountId: string;
    action: Extract<
      AuditAction,
      'IMPORT_COMPLETED' | 'IMPORT_ROLLED_BACK' | 'TEMPLATE_APPLIED'
    >;
    metadata?: Prisma.InputJsonValue;
  }) {
    return this.auditLog.record(params);
  }

  // ---- internals ----

  /**
   * The cap lives in the @RequireAccess guard on the HTTP path, which a
   * worker never passes through (decision 9). Counted inside the chunk's own
   * transaction. Same race as the guard has today (two concurrent chunks can
   * both pass) - closing it needs a lock and belongs with the 1.1 counter row.
   */
  private async assertTaskCap(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    items: BulkTaskItem[],
  ): Promise<void> {
    const perProject = new Map<string, number>();
    for (const item of items) {
      if (!item.projectId) continue; // Inbox tasks are never capped
      perProject.set(item.projectId, (perProject.get(item.projectId) ?? 0) + 1);
    }
    if (perProject.size === 0) return;

    const workspace = await tx.workspace.findUnique({
      where: { id: workspaceId },
      select: { accountId: true },
    });
    if (!workspace) return; // createChunk raises the proper NotFound

    for (const [projectId, additional] of perProject) {
      const ok = await this.planLimits.checkLimit(
        'task',
        'createTask',
        { accountId: workspace.accountId, workspaceId, projectId },
        { additional, db: tx },
      );
      if (!ok) {
        throw new PlanLimitExceededException(
          `Task limit reached for project ${projectId}: cannot add ${additional} more`,
        );
      }
    }
  }
}
