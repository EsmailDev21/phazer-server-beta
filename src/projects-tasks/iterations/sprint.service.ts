import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  ActivityAction,
  ActivityTargetType,
  IterationState,
  Prisma,
} from '@prisma/client';
import { PermissionResolver } from '../../access-control/access-control.service';
import { PrismaService } from '../../prisma/prisma.service';
import { measure } from './iteration-metrics';
import {
  KIND_NOT_SUPPORTED,
  KIND_PROFILE,
  SprintConfig,
  kindsWith,
  parseConfig,
} from './iteration-kinds';
import {
  loadLoadNodes,
  loadMetricNodes,
  loadSnapshots,
  todayUtc,
  upsertSnapshot,
} from './iteration-snapshots';
import {
  Commitment,
  RawChange,
  buildBurndown,
  capacityLoad,
  classifyScopeChanges,
  snapshotValues,
} from './sprint-rules';

/** Most ITERATION_CHANGED rows read for one sprint's scope-change list. */
const MAX_SCOPE_CHANGE_ROWS = 500;

/**
 * ADR-0044. The read side of a sprint (burndown, per-person load, scope changes), the retro
 * note, and the daily snapshot sweep. Reads need workspace-level access, like the iteration
 * reads in IterationsService, so every task of the sprint is visible to the reader.
 */
@Injectable()
export class SprintService {
  private readonly logger = new Logger(SprintService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly permissionResolver: PermissionResolver,
  ) {}

  async burndown(workspaceId: string, iterationId: string, userId: string) {
    await this.assertCanRead(workspaceId, userId);
    const it = await this.getOrThrow(workspaceId, iterationId);
    this.assertSupports(it.kind, 'burndown');

    const commitment =
      (it.startSummary as unknown as Commitment | null) ?? null;
    const snapshots = await loadSnapshots(this.prisma, iterationId);
    const live =
      it.state === IterationState.ACTIVE
        ? {
            day: todayUtc(),
            ...snapshotValues(
              measure(await loadMetricNodes(this.prisma, iterationId)),
            ),
          }
        : null;
    const series = buildBurndown({
      startDate: dateOnly(it.startDate),
      endDate: dateOnly(it.endDate),
      commitment,
      snapshots,
      live,
    });
    return {
      iterationId,
      state: it.state,
      startDate: dateOnly(it.startDate),
      endDate: dateOnly(it.endDate),
      today: todayUtc(),
      commitment,
      ...series,
    };
  }

  async load(workspaceId: string, iterationId: string, userId: string) {
    await this.assertCanRead(workspaceId, userId);
    const it = await this.getOrThrow(workspaceId, iterationId);
    this.assertSupports(it.kind, 'capacity');
    const config = (it.config as SprintConfig | null) ?? {};
    return capacityLoad(
      config.capacity,
      await loadLoadNodes(this.prisma, iterationId),
    );
  }

  async scopeChanges(workspaceId: string, iterationId: string, userId: string) {
    await this.assertCanRead(workspaceId, userId);
    const it = await this.getOrThrow(workspaceId, iterationId);
    this.assertSupports(it.kind, 'burndown');

    const commitment =
      (it.startSummary as unknown as Commitment | null) ?? null;
    if (!commitment) return emptyScopeChanges(null);

    // Estimates have no history, so a task's points are its estimate NOW (ADR-0044 d.5).
    const rows = await this.prisma.activity.findMany({
      where: {
        workspaceId,
        action: ActivityAction.ITERATION_CHANGED,
        targetType: ActivityTargetType.TASK,
        createdAt: { gte: new Date(commitment.at) },
        OR: [
          { metadata: { path: ['to'], equals: iterationId } },
          { metadata: { path: ['from'], equals: iterationId } },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: MAX_SCOPE_CHANGE_ROWS,
      select: {
        targetId: true,
        createdAt: true,
        actorId: true,
        metadata: true,
      },
    });
    const raw: RawChange[] = rows.map((r) => {
      const m = (r.metadata ?? {}) as {
        from?: string | null;
        to?: string | null;
      };
      return {
        taskId: r.targetId,
        at: r.createdAt,
        from: m.from ?? null,
        to: m.to ?? null,
        actorId: r.actorId,
      };
    });
    const changes = classifyScopeChanges(iterationId, raw, commitment.at);
    if (changes.length === 0) return emptyScopeChanges(commitment.at);

    const tasks = await this.prisma.task.findMany({
      where: {
        id: { in: [...new Set(changes.map((c) => c.taskId))] },
        workspaceId,
      },
      select: { id: true, title: true, number: true, estimate: true },
    });
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const items = changes.map((c) => {
      const t = byId.get(c.taskId);
      return {
        ...c,
        title: t?.title ?? null,
        number: t?.number ?? null,
        points: t?.estimate ?? 0,
      };
    });
    const sum = (kind: 'ADDED' | 'REMOVED') =>
      Math.round(
        items.filter((i) => i.kind === kind).reduce((n, i) => n + i.points, 0) *
          100,
      ) / 100;
    return {
      since: commitment.at,
      addedCount: items.filter((i) => i.kind === 'ADDED').length,
      removedCount: items.filter((i) => i.kind === 'REMOVED').length,
      addedPoints: sum('ADDED'),
      removedPoints: sum('REMOVED'),
      items,
    };
  }

  /**
   * The retro is the one setting that stays editable after the sprint is closed: it is written
   * AFTER the work is over (ADR-0044 d.6). It lives in `config.retro`, so it is validated like
   * the rest of the config; empty or null clears it.
   */
  async setRetro(
    workspaceId: string,
    iterationId: string,
    retro: string | null,
  ) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM iterations WHERE id = ${iterationId} FOR UPDATE`;
      const it = await tx.iteration.findFirst({
        where: { id: iterationId, workspaceId },
      });
      if (!it) throw new NotFoundException('Iteration not found');
      this.assertSupports(it.kind, 'retro');
      const rest = { ...((it.config as SprintConfig | null) ?? {}) } as Record<
        string,
        unknown
      >;
      delete rest.retro;
      const next = parseConfig(
        it.kind,
        retro === null ? rest : { ...rest, retro },
      );
      const updated = await tx.iteration.update({
        where: { id: iterationId },
        data: {
          config: next ? (next as Prisma.InputJsonObject) : Prisma.DbNull,
        },
      });
      return {
        iterationId: updated.id,
        retro: (updated.config as SprintConfig | null)?.retro ?? null,
      };
    });
  }

  /**
   * Hourly sweep (system.sprint-snapshots): refresh today's row of every ACTIVE sprint. The last
   * run of the day is the end-of-day state. Safe to repeat and to run on several workers
   * (an upsert on (iteration, day)); one bad iteration never stops the others.
   */
  async recordDaily(
    day: string = todayUtc(),
  ): Promise<{ sprints: number; failed: number }> {
    const sprints = await this.prisma.iteration.findMany({
      where: {
        state: IterationState.ACTIVE,
        kind: { in: kindsWith('burndown') },
      },
      select: { id: true },
    });
    let failed = 0;
    for (const s of sprints) {
      try {
        await upsertSnapshot(
          this.prisma,
          s.id,
          day,
          measure(await loadMetricNodes(this.prisma, s.id)),
        );
      } catch (err) {
        failed += 1;
        this.logger.error(
          `Snapshot of iteration ${s.id} failed: ${(err as Error).message}`,
        );
      }
    }
    return { sprints: sprints.length, failed };
  }

  private assertSupports(
    kind: keyof typeof KIND_PROFILE,
    capability: 'burndown' | 'capacity' | 'retro',
  ) {
    if (!KIND_PROFILE[kind][capability]) {
      throw new BadRequestException({
        message: `A ${kind.toLowerCase()} has no ${capability}`,
        code: KIND_NOT_SUPPORTED,
      });
    }
  }

  private async getOrThrow(workspaceId: string, iterationId: string) {
    const it = await this.prisma.iteration.findFirst({
      where: { id: iterationId, workspaceId },
    });
    if (!it) throw new NotFoundException('Iteration not found');
    return it;
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

const dateOnly = (d: Date | null): string | null =>
  d ? d.toISOString().slice(0, 10) : null;

const emptyScopeChanges = (since: string | null) => ({
  since,
  addedCount: 0,
  removedCount: 0,
  addedPoints: 0,
  removedPoints: 0,
  items: [] as Array<never>,
});
