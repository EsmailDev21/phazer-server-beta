import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  Iteration,
  IterationKind,
  IterationState,
  Prisma,
} from '@prisma/client';
import { PermissionResolver } from '../../access-control/access-control.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CycleView,
  completionPct,
  nextCycleDates,
  nextCycleName,
  orderCycles,
  ringWindow,
  shouldAutoStart,
  shouldCreateNext,
  shouldRollover,
} from './cycle-rules';
import {
  CycleConfig,
  KIND_NOT_SUPPORTED,
  KIND_PROFILE,
  kindsWith,
} from './iteration-kinds';
import { measure } from './iteration-metrics';
import {
  MAX_ITERATIONS_PER_WORKSPACE,
  formatDateOnly,
  parseDateOnly,
} from './iteration-rules';
import { toMetricNodes, todayUtc } from './iteration-snapshots';
import { IterationsService } from './iterations.service';

/** Most automated cycles looked at in one sweep run (the next run takes the rest). */
const SWEEP_BATCH = 500;

export interface CycleSweepResult {
  created: number;
  rolled: number;
  started: number;
  failed: number;
}

interface CloseSummaryShape {
  unfinished?: number;
  movedToId?: string | null;
  velocity?: {
    totalCount?: number;
    totalPoints?: number;
    completedCount?: number;
    completedPoints?: number;
  };
}

const asConfig = (raw: Prisma.JsonValue | null): CycleConfig | null =>
  raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as CycleConfig)
    : null;

const viewOf = (c: Iteration): CycleView => ({
  state: c.state,
  startDate: formatDateOnly(c.startDate),
  endDate: formatDateOnly(c.endDate),
  config: asConfig(c.config),
});

/**
 * ADR-0045. Cycles that repeat: the hourly sweep that creates the next cycle, closes a finished one
 * (moving its unfinished tasks on) and starts the next, and the ring of neighbouring cycles. The
 * decisions are the pure functions in cycle-rules.ts; this class only reads and writes rows.
 * Closing and starting go through IterationsService, so every rule and lock of a manual close or
 * start applies to an automatic one.
 */
@Injectable()
export class CycleService {
  private readonly logger = new Logger(CycleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly permissionResolver: PermissionResolver,
    private readonly iterations: IterationsService,
  ) {}

  // ------------------------------------------------------------------- ring

  async ring(workspaceId: string, iterationId: string, userId: string) {
    await this.assertCanRead(workspaceId, userId);
    const it = await this.prisma.iteration.findFirst({
      where: { id: iterationId, workspaceId },
    });
    if (!it) throw new NotFoundException('Iteration not found');
    if (!KIND_PROFILE[it.kind].cadence) {
      throw new BadRequestException({
        message: `A ${it.kind.toLowerCase()} has no cadence`,
        code: KIND_NOT_SUPPORTED,
      });
    }

    const siblings = await this.prisma.iteration.findMany({
      where: { workspaceId, projectId: it.projectId, kind: it.kind },
    });
    const ordered = orderCycles(
      siblings.map((s) => ({ ...s, startDate: formatDateOnly(s.startDate) })),
    );
    const window = ringWindow(ordered, iterationId);

    // Closed cycles keep the numbers saved when they closed; the others are measured now.
    const open = window
      .filter((c) => c.state !== IterationState.CLOSED)
      .map((c) => c.id);
    const live = new Map<string, ReturnType<typeof measure>>();
    if (open.length > 0) {
      const rows = await this.prisma.task.findMany({
        where: { iterationId: { in: open }, isArchived: false },
        select: {
          id: true,
          iterationId: true,
          parentId: true,
          status: true,
          isArchived: true,
          estimate: true,
          workflowStatus: { select: { excludeFromProgress: true } },
        },
      });
      for (const id of open) {
        live.set(
          id,
          measure(toMetricNodes(rows.filter((r) => r.iterationId === id))),
        );
      }
    }

    const items = window.map((c) => {
      const summary = (c.closeSummary as CloseSummaryShape | null) ?? null;
      const m =
        c.state === IterationState.CLOSED ? summary?.velocity : undefined;
      const liveM = live.get(c.id);
      const totalCount = m?.totalCount ?? liveM?.totalCount ?? 0;
      const completedCount = m?.completedCount ?? liveM?.completedCount ?? 0;

      // Tasks the cycle before this one handed over when it closed.
      const idx = ordered.findIndex((x) => x.id === c.id);
      const prev = idx > 0 ? ordered[idx - 1] : undefined;
      const prevSummary =
        (prev?.closeSummary as CloseSummaryShape | null) ?? null;
      const rolledIn =
        prev &&
        prev.state === IterationState.CLOSED &&
        prevSummary?.movedToId === c.id
          ? (prevSummary.unfinished ?? 0)
          : 0;

      return {
        id: c.id,
        name: c.name,
        state: c.state,
        startDate: c.startDate,
        endDate: formatDateOnly(c.endDate),
        totalCount,
        completedCount,
        totalPoints: m?.totalPoints ?? liveM?.totalPoints ?? 0,
        completedPoints: m?.completedPoints ?? liveM?.completedPoints ?? 0,
        completionPct: completionPct(completedCount, totalCount),
        rolledIn,
      };
    });
    return { currentId: iterationId, today: todayUtc(), items };
  }

  // ------------------------------------------------------------------ sweep

  /**
   * One pass over every automated cycle. Safe to repeat and to run on several workers: each step is
   * decided from what is in the database now, creating the successor is serialised per cycle, and
   * one cycle failing never stops the others.
   */
  async sweep(today: string = todayUtc()): Promise<CycleSweepResult> {
    const result: CycleSweepResult = {
      created: 0,
      rolled: 0,
      started: 0,
      failed: 0,
    };

    // 1. Running cycles: create what comes next, close what is over.
    const running = await this.prisma.iteration.findMany({
      where: {
        kind: { in: kindsWith('cadence') },
        state: IterationState.ACTIVE,
        OR: [
          { config: { path: ['autoCreateNext'], equals: true } },
          { config: { path: ['autoRollover'], equals: true } },
        ],
      },
      orderBy: { endDate: 'asc' },
      take: SWEEP_BATCH,
    });
    for (const cycle of running) {
      try {
        await this.stepRunning(cycle, today, result);
      } catch (err) {
        result.failed += 1;
        this.logger.error(
          `Cycle ${cycle.id} could not be advanced: ${(err as Error).message}`,
        );
      }
    }

    // 2. Planned cycles of an automated chain whose first day has come. After step 1, so a cycle that
    //    just closed has already made room for its successor.
    const todayDate = parseDateOnly(today, 'today');
    const waiting = await this.prisma.iteration.findMany({
      where: {
        kind: { in: kindsWith('cadence') },
        state: IterationState.PLANNED,
        startDate: { lte: todayDate },
        endDate: { gte: todayDate },
        config: { path: ['autoCreateNext'], equals: true },
      },
      orderBy: { startDate: 'asc' },
      take: SWEEP_BATCH,
    });
    for (const cycle of waiting) {
      try {
        const activeInScope = await this.prisma.iteration.count({
          where: {
            workspaceId: cycle.workspaceId,
            projectId: cycle.projectId,
            kind: cycle.kind,
            state: IterationState.ACTIVE,
          },
        });
        if (!shouldAutoStart(viewOf(cycle), today, activeInScope > 0)) continue;
        await this.iterations.start(cycle.workspaceId, cycle.id);
        result.started += 1;
      } catch (err) {
        result.failed += 1;
        this.logger.error(
          `Cycle ${cycle.id} could not be started: ${(err as Error).message}`,
        );
      }
    }
    return result;
  }

  private async stepRunning(
    cycle: Iteration,
    today: string,
    result: CycleSweepResult,
  ) {
    const view = viewOf(cycle);
    let successor = await this.findSuccessor(this.prisma, cycle);

    if (shouldCreateNext(view, successor !== null)) {
      const made = await this.createNext(cycle);
      if (made.created) result.created += 1;
      successor = made.cycle;
    }

    if (successor && shouldRollover(view, today, successor)) {
      await this.iterations.close(cycle.workspaceId, cycle.id, {
        action: 'MOVE',
        moveToIterationId: successor.id,
      });
      result.rolled += 1;
    }
  }

  /** The nearest cycle that starts after this one ends and is not closed, in the same scope. */
  private async findSuccessor(
    db: Prisma.TransactionClient | PrismaService,
    cycle: Iteration,
  ) {
    if (!cycle.endDate) return null;
    return db.iteration.findFirst({
      where: {
        workspaceId: cycle.workspaceId,
        projectId: cycle.projectId,
        kind: cycle.kind,
        id: { not: cycle.id },
        state: { not: IterationState.CLOSED },
        startDate: { gt: cycle.endDate },
      },
      orderBy: { startDate: 'asc' },
    });
  }

  /**
   * Names are not unique in the database, so two workers could both see "no successor" and both
   * create one. The lock makes them take turns; the second finds the first one's cycle and stops.
   */
  private async createNext(
    cycle: Iteration,
  ): Promise<{ cycle: Iteration | null; created: boolean }> {
    const config = asConfig(cycle.config);
    const prevEnd = formatDateOnly(cycle.endDate);
    if (!config || config.cadenceWeeks === undefined || !prevEnd) {
      return { cycle: null, created: false };
    }
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`cycle-next:${cycle.id}`}))`;
      const existing = await this.findSuccessor(tx, cycle);
      if (existing) return { cycle: existing, created: false };

      const count = await tx.iteration.count({
        where: { workspaceId: cycle.workspaceId },
      });
      if (count >= MAX_ITERATIONS_PER_WORKSPACE) {
        this.logger.warn(
          `Workspace ${cycle.workspaceId} is full: no next cycle for ${cycle.id}`,
        );
        return { cycle: null, created: false };
      }
      const siblings = await tx.iteration.findMany({
        where: {
          workspaceId: cycle.workspaceId,
          projectId: cycle.projectId,
          kind: cycle.kind,
        },
        select: { name: true },
      });
      const dates = nextCycleDates(
        prevEnd,
        config.cadenceWeeks!,
        config.cooldownDays ?? 0,
      );
      const created = await tx.iteration.create({
        data: {
          workspaceId: cycle.workspaceId,
          projectId: cycle.projectId,
          kind: IterationKind.CYCLE,
          name: nextCycleName(
            cycle.name,
            siblings.map((s) => s.name),
          ),
          startDate: parseDateOnly(dates.startDate, 'startDate'),
          endDate: parseDateOnly(dates.endDate, 'endDate'),
          config: config as Prisma.InputJsonObject,
        },
      });
      return { cycle: created, created: true };
    });
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
