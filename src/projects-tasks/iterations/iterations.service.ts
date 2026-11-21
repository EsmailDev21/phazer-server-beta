import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Iteration, IterationState, Prisma, TaskStatus } from '@prisma/client';
import { PermissionResolver } from '../../access-control/access-control.service';
import { PrismaService } from '../../prisma/prisma.service';
import { leafProgress } from '../tasks/task-tree';
import { MetricNode, averageVelocity, measure, round2 } from './iteration-metrics';
import { normalizeName } from '../planning/normalize-name';
import {
  CloseIterationDto,
  CreateIterationDto,
  CurrentIterationsQueryDto,
  ListIterationsQueryDto,
  UpdateIterationDto,
  VELOCITY_DEFAULT_LIMIT,
  VelocityQueryDto,
} from './dto/iteration.dto';
import {
  ITERATION_CLOSED,
  MAX_ITERATIONS_PER_WORKSPACE,
  assertCanBeMoveTarget,
  assertDatesOrdered,
  assertTransition,
  formatDateOnly,
  parseDateOnly,
  planClose,
} from './iteration-rules';

export interface IterationDto {
  id: string;
  workspaceId: string;
  projectId: string | null;
  kind: string;
  name: string;
  goal: string | null;
  startDate: string | null;
  endDate: string | null;
  state: string;
  closedAt: Date | null;
  closeSummary: Prisma.JsonValue | null;
  taskCount: number;
}

const toDto = (i: Iteration, taskCount: number): IterationDto => ({
  id: i.id,
  workspaceId: i.workspaceId,
  projectId: i.projectId,
  kind: i.kind,
  name: i.name,
  goal: i.goal,
  startDate: formatDateOnly(i.startDate),
  endDate: formatDateOnly(i.endDate),
  state: i.state,
  closedAt: i.closedAt,
  closeSummary: i.closeSummary,
  taskCount,
});

/**
 * ADR-0007. Iterations (sprint / cycle / milestone). Writes are `manageWorkflow`
 * (admins and owners, route guard on the workspace id); reads need workspace access.
 *
 * LOCKING. Every state change takes the iteration's row lock FOR UPDATE first; every
 * task write that assigns an iteration takes it FOR SHARE (TaskPlanningService) before
 * writing the task row. So a task can never be assigned into an iteration that is being
 * closed, and the two cannot wait on each other's row locks. When close also locks a
 * move target, both rows are locked in id order.
 */
@Injectable()
export class IterationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissionResolver: PermissionResolver,
  ) {}

  // ------------------------------------------------------------------ reads

  async list(
    workspaceId: string,
    userId: string,
    query: ListIterationsQueryDto,
  ): Promise<IterationDto[]> {
    await this.assertCanRead(workspaceId, userId);
    const rows = await this.prisma.iteration.findMany({
      where: {
        workspaceId,
        ...(query.projectId ? { projectId: query.projectId } : {}),
        ...(query.state ? { state: query.state } : {}),
        ...(query.kind ? { kind: query.kind } : {}),
      },
      orderBy: [{ startDate: 'desc' }, { createdAt: 'desc' }],
    });
    const counts = await this.prisma.task.groupBy({
      by: ['iterationId'],
      where: { iterationId: { in: rows.map((r) => r.id) }, isArchived: false },
      _count: true,
    });
    const countBy = new Map(counts.map((c) => [c.iterationId, c._count]));
    return rows.map((r) => toDto(r, countBy.get(r.id) ?? 0));
  }

  async get(workspaceId: string, iterationId: string, userId: string) {
    await this.assertCanRead(workspaceId, userId);
    const it = await this.getOrThrow(this.prisma, workspaceId, iterationId);
    return this.describe(this.prisma, it);
  }

  /** Counts by category + leaf-only progress (ADR-0005 d.6, ADR-0006 d.10) over the tasks IN the iteration. */
  private async describe(db: Prisma.TransactionClient | PrismaService, it: Iteration) {
    const rows = await db.task.findMany({
      where: { iterationId: it.id, isArchived: false },
      select: {
        id: true,
        parentId: true,
        status: true,
        isArchived: true,
        estimate: true,
        workflowStatus: { select: { excludeFromProgress: true } },
      },
    });
    const counts: Record<TaskStatus, number> = {
      TODO: 0,
      IN_PROGRESS: 0,
      BLOCKED: 0,
      DONE: 0,
    };
    for (const r of rows) counts[r.status] += 1;
    const nodes = toMetricNodes(rows);
    const progress = leafProgress(nodes);
    const m = measure(nodes);
    return {
      ...toDto(it, rows.length),
      counts,
      progress,
      // ADR-0008: leaf-only story points; unestimated tasks are reported, not guessed.
      points: {
        total: m.totalPoints,
        done: m.completedPoints,
        unestimated: m.unestimatedTotal,
      },
    };
  }

  /**
   * ADR-0008: "the current iteration" is simply every ACTIVE one - possibly several,
   * possibly none. With `projectId`: that project's iterations plus workspace-wide ones.
   */
  async current(
    workspaceId: string,
    userId: string,
    query: CurrentIterationsQueryDto,
  ) {
    await this.assertCanRead(workspaceId, userId);
    const scope = await this.projectScope(workspaceId, query.projectId);
    const rows = await this.prisma.iteration.findMany({
      where: { workspaceId, state: IterationState.ACTIVE, ...scope },
      orderBy: [
        { startDate: { sort: 'asc', nulls: 'last' } },
        { createdAt: 'asc' },
      ],
    });
    return Promise.all(rows.map((r) => this.describe(this.prisma, r)));
  }

  /**
   * ADR-0008. The last N iterations (default: 6 closed sprints) with completed points and
   * task count, oldest first so it can be charted as is. A CLOSED iteration reports the
   * snapshot taken when it closed (later edits to its tasks do not rewrite history; one
   * closed before snapshots existed falls back to a live measurement); any other state is
   * live. Completed = Done LEAF tasks; unestimated tasks add 0 points and are counted apart.
   */
  async velocity(workspaceId: string, userId: string, query: VelocityQueryDto) {
    await this.assertCanRead(workspaceId, userId);
    const kind = query.kind ?? 'SPRINT';
    const state = query.state ?? IterationState.CLOSED;
    const limit = query.limit ?? VELOCITY_DEFAULT_LIMIT;
    const scope = await this.projectScope(workspaceId, query.projectId);

    const newestFirst = await this.prisma.iteration.findMany({
      where: {
        workspaceId,
        state,
        ...(kind === 'ALL' ? {} : { kind }),
        ...scope,
      },
      orderBy: [
        { closedAt: { sort: 'desc', nulls: 'last' } },
        { endDate: { sort: 'desc', nulls: 'last' } },
        { createdAt: 'desc' },
      ],
      take: limit,
    });

    const needLive = newestFirst.filter((i) => !snapshotOf(i));
    const liveRows = needLive.length
      ? await this.prisma.task.findMany({
          where: { iterationId: { in: needLive.map((i) => i.id) }, isArchived: false },
          select: {
            id: true,
            parentId: true,
            status: true,
            isArchived: true,
            estimate: true,
            iterationId: true,
            workflowStatus: { select: { excludeFromProgress: true } },
          },
        })
      : [];
    const byIteration = new Map<string, typeof liveRows>();
    for (const r of liveRows) {
      byIteration.set(r.iterationId!, [...(byIteration.get(r.iterationId!) ?? []), r]);
    }

    const iterations = [...newestFirst].reverse().map((it) => {
      const snap = snapshotOf(it);
      const m = snap ?? measure(toMetricNodes(byIteration.get(it.id) ?? []));
      return {
        id: it.id,
        name: it.name,
        kind: it.kind,
        state: it.state,
        projectId: it.projectId,
        startDate: formatDateOnly(it.startDate),
        endDate: formatDateOnly(it.endDate),
        closedAt: it.closedAt,
        source: snap ? ('SNAPSHOT' as const) : ('LIVE' as const),
        completedCount: m.completedCount,
        completedPoints: m.completedPoints,
        totalCount: m.totalCount,
        totalPoints: m.totalPoints,
        unestimatedCompleted: m.unestimatedCompleted,
      };
    });
    return {
      filter: { projectId: query.projectId ?? null, kind, state, limit },
      iterations,
      average: averageVelocity(iterations),
    };
  }

  private async projectScope(
    workspaceId: string,
    projectId: string | undefined,
  ): Promise<Prisma.IterationWhereInput> {
    if (!projectId) return {};
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, workspaceId },
      select: { id: true },
    });
    if (!project) {
      throw new BadRequestException('projectId does not belong to this workspace');
    }
    return { OR: [{ projectId }, { projectId: null }] };
  }

  // ----------------------------------------------------------------- writes

  async create(workspaceId: string, dto: CreateIterationDto) {
    const { name } = normalizeName(dto.name, 'Iteration name', 200);
    const start = dto.startDate ? parseDateOnly(dto.startDate, 'startDate') : null;
    const end = dto.endDate ? parseDateOnly(dto.endDate, 'endDate') : null;
    assertDatesOrdered(start, end);

    const ws = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true },
    });
    if (!ws) throw new NotFoundException('Workspace not found');
    if (dto.projectId) {
      const project = await this.prisma.project.findFirst({
        where: { id: dto.projectId, workspaceId },
        select: { id: true },
      });
      if (!project) {
        throw new BadRequestException('projectId does not belong to this workspace');
      }
    }
    const count = await this.prisma.iteration.count({ where: { workspaceId } });
    if (count >= MAX_ITERATIONS_PER_WORKSPACE) {
      throw new ConflictException(
        `A workspace can have at most ${MAX_ITERATIONS_PER_WORKSPACE} iterations`,
      );
    }
    const created = await this.prisma.iteration.create({
      data: {
        workspaceId,
        projectId: dto.projectId ?? null,
        kind: dto.kind,
        name,
        goal: dto.goal,
        startDate: start,
        endDate: end,
      },
    });
    return toDto(created, 0);
  }

  async update(workspaceId: string, iterationId: string, dto: UpdateIterationDto) {
    return this.prisma.$transaction(async (tx) => {
      await this.lockRows(tx, [{ id: iterationId, mode: 'UPDATE' }]);
      const it = await this.getOrThrow(tx, workspaceId, iterationId);
      this.assertEditable(it);
      const start =
        dto.startDate === undefined
          ? it.startDate
          : dto.startDate === null
            ? null
            : parseDateOnly(dto.startDate, 'startDate');
      const end =
        dto.endDate === undefined
          ? it.endDate
          : dto.endDate === null
            ? null
            : parseDateOnly(dto.endDate, 'endDate');
      assertDatesOrdered(start, end);
      const updated = await tx.iteration.update({
        where: { id: iterationId },
        data: {
          ...(dto.kind !== undefined ? { kind: dto.kind } : {}),
          ...(dto.name !== undefined
            ? { name: normalizeName(dto.name, 'Iteration name', 200).name }
            : {}),
          ...(dto.goal !== undefined ? { goal: dto.goal } : {}),
          startDate: start,
          endDate: end,
        },
      });
      return this.describe(tx, updated);
    });
  }

  async delete(workspaceId: string, iterationId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.lockRows(tx, [{ id: iterationId, mode: 'UPDATE' }]);
      const it = await this.getOrThrow(tx, workspaceId, iterationId);
      if (it.state === IterationState.CLOSED) {
        throw new ConflictException({
          message: 'A closed iteration is history: reopen it before deleting it',
          code: ITERATION_CLOSED,
        });
      }
      // tasks.iteration_id is ON DELETE SET NULL: its tasks go back to the backlog.
      await tx.iteration.delete({ where: { id: iterationId } });
    });
  }

  async start(workspaceId: string, iterationId: string) {
    return this.transition(workspaceId, iterationId, IterationState.ACTIVE);
  }

  /** CLOSED -> ACTIVE. Tasks that were moved or sent to the backlog on close stay where they went. */
  async reopen(workspaceId: string, iterationId: string) {
    return this.transition(workspaceId, iterationId, IterationState.ACTIVE, true);
  }

  private async transition(
    workspaceId: string,
    iterationId: string,
    to: IterationState,
    clearClose = false,
  ) {
    return this.prisma.$transaction(async (tx) => {
      await this.lockRows(tx, [{ id: iterationId, mode: 'UPDATE' }]);
      const it = await this.getOrThrow(tx, workspaceId, iterationId);
      assertTransition(it.state, to);
      const updated = await tx.iteration.update({
        where: { id: iterationId },
        data: {
          state: to,
          ...(clearClose ? { closedAt: null, closeSummary: Prisma.DbNull } : {}),
        },
      });
      return this.describe(tx, updated);
    });
  }

  /**
   * Decision 1: with unfinished (not Done, not archived) tasks the caller must choose
   * LEAVE / MOVE / BACKLOG - there is no default. Done and archived tasks always stay.
   * No per-task activity (same stance as status edits); the outcome is stored on the
   * iteration as `closeSummary`.
   */
  async close(workspaceId: string, iterationId: string, dto: CloseIterationDto) {
    return this.prisma.$transaction(async (tx) => {
      const lockIds = [
        { id: iterationId, mode: 'UPDATE' as const },
        ...(dto.moveToIterationId && dto.moveToIterationId !== iterationId
          ? [{ id: dto.moveToIterationId, mode: 'SHARE' as const }]
          : []),
      ];
      await this.lockRows(tx, lockIds);
      const it = await this.getOrThrow(tx, workspaceId, iterationId);
      assertTransition(it.state, IterationState.CLOSED);

      const unfinishedWhere: Prisma.TaskWhereInput = {
        iterationId,
        isArchived: false,
        status: { not: TaskStatus.DONE },
      };
      const unfinished = await tx.task.count({ where: unfinishedWhere });
      const plan = planClose({
        unfinishedCount: unfinished,
        action: dto.action,
        moveToIterationId: dto.moveToIterationId,
        sourceId: iterationId,
      });

      // ADR-0008: measure BEFORE any unfinished task is moved away, so the snapshot
      // says what the iteration held and completed when it closed.
      const snapshotRows = await tx.task.findMany({
        where: { iterationId, isArchived: false },
        select: {
          id: true,
          parentId: true,
          status: true,
          isArchived: true,
          estimate: true,
          workflowStatus: { select: { excludeFromProgress: true } },
        },
      });
      const velocity = measure(toMetricNodes(snapshotRows));

      let movedToId: string | null = null;
      if (plan.kind === 'MOVE') {
        const target = await tx.iteration.findFirst({
          where: { id: plan.targetId, workspaceId },
        });
        if (!target) {
          throw new BadRequestException(
            'moveToIterationId does not belong to this workspace',
          );
        }
        assertCanBeMoveTarget(target.state);
        if (target.projectId) {
          const foreign = await tx.task.count({
            where: {
              ...unfinishedWhere,
              OR: [{ projectId: null }, { projectId: { not: target.projectId } }],
            },
          });
          if (foreign > 0) {
            throw new ConflictException(
              `${foreign} unfinished task(s) are not in the project of the target iteration`,
            );
          }
        }
        await tx.task.updateMany({
          where: unfinishedWhere,
          data: { iterationId: target.id },
        });
        movedToId = target.id;
      } else if (plan.kind === 'BACKLOG') {
        await tx.task.updateMany({
          where: unfinishedWhere,
          data: { iterationId: null },
        });
      }

      const completed = await tx.task.count({
        where: { iterationId, isArchived: false, status: TaskStatus.DONE },
      });
      const closed = await tx.iteration.update({
        where: { id: iterationId },
        data: {
          state: IterationState.CLOSED,
          closedAt: new Date(),
          closeSummary: {
            unfinished,
            action: plan.kind === 'NONE' ? null : plan.kind,
            movedToId,
            completed,
            velocity: { ...velocity },
          },
        },
      });
      return this.describe(tx, closed);
    });
  }

  // -------------------------------------------------------------- internals

  private assertEditable(it: Iteration) {
    if (it.state === IterationState.CLOSED) {
      throw new ConflictException({
        message: 'A closed iteration cannot be edited: reopen it first',
        code: ITERATION_CLOSED,
      });
    }
  }

  private async getOrThrow(
    db: Prisma.TransactionClient | PrismaService,
    workspaceId: string,
    iterationId: string,
  ) {
    const it = await db.iteration.findFirst({
      where: { id: iterationId, workspaceId },
    });
    if (!it) throw new NotFoundException('Iteration not found');
    return it;
  }

  /** Row locks in id order (two closers moving into each other cannot deadlock). */
  private async lockRows(
    tx: Prisma.TransactionClient,
    rows: Array<{ id: string; mode: 'UPDATE' | 'SHARE' }>,
  ) {
    for (const r of [...rows].sort((a, b) => a.id.localeCompare(b.id))) {
      if (r.mode === 'UPDATE') {
        await tx.$queryRaw`SELECT id FROM iterations WHERE id = ${r.id} FOR UPDATE`;
      } else {
        await tx.$queryRaw`SELECT id FROM iterations WHERE id = ${r.id} FOR SHARE`;
      }
    }
  }

  private async assertCanRead(workspaceId: string, userId: string) {
    if (
      !(await this.permissionResolver.hasWorkspaceLevelAccess(
        userId,
        workspaceId,
      ))
    ) {
      throw new ForbiddenException('You do not have access to this workspace');
    }
  }
}

/** Prisma rows -> the pure metric nodes. */
function toMetricNodes(
  rows: Array<{
    id: string;
    parentId: string | null;
    status: TaskStatus;
    isArchived: boolean;
    estimate: number | null;
    workflowStatus: { excludeFromProgress: boolean } | null;
  }>,
): MetricNode[] {
  return rows.map((r) => ({
    id: r.id,
    parentId: r.parentId,
    status: r.status,
    isArchived: r.isArchived,
    estimate: r.estimate,
    excludeFromProgress: r.workflowStatus?.excludeFromProgress ?? false,
  }));
}

/** The numbers stored when the iteration was closed, if this one has them. */
function snapshotOf(it: Iteration) {
  if (it.state !== IterationState.CLOSED) return null;
  const v = (it.closeSummary as { velocity?: Record<string, unknown> } | null)
    ?.velocity;
  if (!v || typeof v.completedCount !== 'number') return null;
  return {
    totalCount: Number(v.totalCount),
    totalPoints: round2(Number(v.totalPoints)),
    completedCount: Number(v.completedCount),
    completedPoints: round2(Number(v.completedPoints)),
    unestimatedTotal: Number(v.unestimatedTotal ?? 0),
    unestimatedCompleted: Number(v.unestimatedCompleted ?? 0),
  };
}
