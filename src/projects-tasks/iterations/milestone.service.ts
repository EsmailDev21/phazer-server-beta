import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { IterationState, Prisma, TaskStatus } from '@prisma/client';
import { PermissionResolver } from '../../access-control/access-control.service';
import { PrismaService } from '../../prisma/prisma.service';
import { countedLeaves } from '../tasks/task-tree';
import { CreateCriterionDto, UpdateCriterionDto } from './dto/iteration.dto';
import {
  KIND_NOT_SUPPORTED,
  KIND_PROFILE,
  MilestoneConfig,
} from './iteration-kinds';
import { measure } from './iteration-metrics';
import { ITERATION_CLOSED, formatDateOnly } from './iteration-rules';
import { CriterionRow, loadCriteria, stateOf } from './iteration-milestones';
import { loadMetricNodes, todayUtc } from './iteration-snapshots';
import {
  MAX_CRITERIA_PER_MILESTONE,
  MAX_CRITERION_TITLE,
  TargetChange,
  buildReleaseNotes,
  criterionMet,
  milestoneHealth,
  slipSummary,
  summarizeCriteria,
} from './milestone-rules';

/** Most blocking links listed on a road (the count is exact, the list is for showing). */
const MAX_BLOCKERS_LISTED = 50;
const MAX_RELEASE_PRS = 200;

const asConfig = (raw: Prisma.JsonValue | null): MilestoneConfig =>
  raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as MilestoneConfig)
    : {};

const criterionDto = (c: CriterionRow) => ({
  id: c.id,
  title: c.title,
  position: c.position,
  taskId: c.task?.id ?? null,
  taskNumber: c.task?.number ?? null,
  taskTitle: c.task?.title ?? null,
  /** MANUAL: a person checks it. TASK: met while its task is done. */
  source: c.task ? ('TASK' as const) : ('MANUAL' as const),
  met: criterionMetOf(c),
  doneAt: c.task ? null : c.doneAt,
});
const criterionMetOf = (c: CriterionRow) => criterionMet(stateOf(c));

/**
 * ADR-0046. The read side of a milestone (road, release notes) and the editing of its exit
 * criteria. The decisions are the pure functions in milestone-rules.ts. Reads need workspace-level
 * access like the other iteration reads; writes are manageWorkflow (the controller decorator).
 */
@Injectable()
export class MilestoneService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissionResolver: PermissionResolver,
  ) {}

  // ------------------------------------------------------------------- road

  async road(workspaceId: string, iterationId: string, userId: string) {
    await this.assertCanRead(workspaceId, userId);
    const it = await this.getOrThrow(this.prisma, workspaceId, iterationId);
    this.assertSupports(it.kind, 'road');

    const today = todayUtc();
    const [criteriaRows, nodes, blockerRows, changeRows] = await Promise.all([
      loadCriteria(this.prisma, iterationId),
      loadMetricNodes(this.prisma, iterationId),
      this.prisma.taskDependency.findMany({
        where: {
          blockedTask: {
            iterationId,
            isArchived: false,
            status: { not: TaskStatus.DONE },
          },
          blockingTask: { isArchived: false, status: { not: TaskStatus.DONE } },
        },
        take: MAX_BLOCKERS_LISTED,
        select: {
          blockedTask: { select: { id: true, number: true, title: true } },
          blockingTask: { select: { id: true, number: true, title: true } },
        },
      }),
      this.prisma.iterationTargetChange.findMany({
        where: { iterationId },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    const blockerCount = await this.prisma.taskDependency.count({
      where: {
        blockedTask: {
          iterationId,
          isArchived: false,
          status: { not: TaskStatus.DONE },
        },
        blockingTask: { isArchived: false, status: { not: TaskStatus.DONE } },
      },
    });

    const criteria = criteriaRows.map(criterionDto);
    const crit = summarizeCriteria(criteriaRows.map(stateOf));
    const work = measure(nodes);

    // The road's progress is the milestone's tasks; a milestone defined only by criteria uses those.
    const basis =
      work.totalCount > 0 ? 'TASKS' : crit.total > 0 ? 'CRITERIA' : 'NONE';
    const done = basis === 'TASKS' ? work.completedCount : crit.met;
    const total = basis === 'TASKS' ? work.totalCount : crit.total;

    const startDate = formatDateOnly(it.startDate);
    const endDate = formatDateOnly(it.endDate);
    const changes: TargetChange[] = changeRows.map((c) => ({
      previous: formatDateOnly(c.previousDate),
      next: formatDateOnly(c.newDate),
      at: c.createdAt.toISOString(),
      byId: c.changedById,
    }));

    return {
      iterationId,
      state: it.state,
      startDate,
      endDate,
      today,
      requireExitCriteria: asConfig(it.config).requireExitCriteria !== false,
      health: milestoneHealth({
        state: it.state,
        startDate,
        endDate,
        today,
        done,
        total,
        blockers: blockerCount,
      }),
      progress: {
        basis,
        done,
        total,
        pct: total > 0 ? Math.round((done / total) * 100) : 0,
      },
      criteria,
      criteriaSummary: crit,
      blockers: {
        count: blockerCount,
        items: blockerRows.map((b) => ({
          blocked: b.blockedTask,
          blocker: b.blockingTask,
        })),
      },
      slips: { ...slipSummary(changes, endDate), changes },
    };
  }

  // ---------------------------------------------------------- release notes

  async releaseNotes(workspaceId: string, iterationId: string, userId: string) {
    await this.assertCanRead(workspaceId, userId);
    const it = await this.getOrThrow(this.prisma, workspaceId, iterationId);
    this.assertSupports(it.kind, 'road');

    const rows = await this.prisma.task.findMany({
      where: { iterationId, isArchived: false },
      select: {
        id: true,
        number: true,
        title: true,
        parentId: true,
        status: true,
        isArchived: true,
        estimate: true,
        workflowStatus: { select: { excludeFromProgress: true } },
      },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    // Leaves only, like every number of an iteration (ADR-0008): a parent is its subtasks.
    const nodes = rows.map((r) => ({
      id: r.id,
      parentId: r.parentId,
      status: r.status,
      isArchived: r.isArchived,
      estimate: r.estimate,
      excludeFromProgress: r.workflowStatus?.excludeFromProgress ?? false,
    }));
    const doneTasks = countedLeaves(nodes)
      .filter((n) => n.status === TaskStatus.DONE)
      .map((n) => byId.get(n.id))
      .filter((t): t is NonNullable<typeof t> => t !== undefined)
      .map((t) => ({ id: t.id, number: t.number, title: t.title }));

    const links = await this.prisma.externalLink.findMany({
      where: {
        taskId: { in: rows.map((r) => r.id) },
        kind: 'PR',
        state: 'merged',
      },
      orderBy: { createdAt: 'asc' },
      take: MAX_RELEASE_PRS,
      select: { title: true, url: true },
    });
    const seen = new Set<string>();
    const prs = links.filter((l) =>
      seen.has(l.url) ? false : (seen.add(l.url), true),
    );

    return {
      tasks: doneTasks,
      prs,
      markdown: buildReleaseNotes({
        name: it.name,
        targetDate: formatDateOnly(it.endDate),
        tasks: doneTasks,
        prs,
      }),
    };
  }

  // --------------------------------------------------------------- criteria

  async addCriterion(
    workspaceId: string,
    iterationId: string,
    dto: CreateCriterionDto,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const it = await this.lockedMilestone(tx, workspaceId, iterationId);

      const existing = await tx.milestoneCriterion.count({
        where: { iterationId },
      });
      if (existing >= MAX_CRITERIA_PER_MILESTONE) {
        throw new BadRequestException({
          message: `A milestone can have at most ${MAX_CRITERIA_PER_MILESTONE} exit criteria`,
          code: 'TOO_MANY_CRITERIA',
        });
      }

      let taskTitle: string | null = null;
      if (dto.taskId) {
        const task = await tx.task.findFirst({
          where: { id: dto.taskId, workspaceId },
          select: { title: true },
        });
        if (!task) throw new NotFoundException('Task not found');
        taskTitle = task.title;
        const dup = await tx.milestoneCriterion.findFirst({
          where: { iterationId, taskId: dto.taskId },
          select: { id: true },
        });
        if (dup) {
          throw new ConflictException({
            message:
              'That task already backs an exit criterion of this milestone',
            code: 'CRITERION_EXISTS',
          });
        }
      }
      const title = (dto.title ?? taskTitle ?? '')
        .trim()
        .slice(0, MAX_CRITERION_TITLE);
      if (title === '') {
        throw new BadRequestException('A criterion needs a title or a task');
      }
      const last = await tx.milestoneCriterion.aggregate({
        where: { iterationId },
        _max: { position: true },
      });
      const created = await tx.milestoneCriterion.create({
        data: {
          iterationId: it.id,
          title,
          taskId: dto.taskId ?? null,
          position: (last._max.position ?? -1) + 1,
        },
      });
      return this.oneDto(tx, created.id);
    });
  }

  async updateCriterion(
    workspaceId: string,
    iterationId: string,
    criterionId: string,
    dto: UpdateCriterionDto,
  ) {
    return this.prisma.$transaction(async (tx) => {
      await this.lockedMilestone(tx, workspaceId, iterationId);
      const c = await tx.milestoneCriterion.findFirst({
        where: { id: criterionId, iterationId },
      });
      if (!c) throw new NotFoundException('Exit criterion not found');

      const data: Prisma.MilestoneCriterionUpdateInput = {};
      if (dto.title !== undefined) {
        const title = dto.title.trim();
        if (title === '')
          throw new BadRequestException('A criterion needs a title');
        data.title = title.slice(0, MAX_CRITERION_TITLE);
      }
      if (dto.done !== undefined) {
        if (c.taskId !== null) {
          throw new BadRequestException({
            message: 'This criterion follows its task: finish the task instead',
            code: 'CRITERION_FOLLOWS_TASK',
          });
        }
        data.doneAt = dto.done ? new Date() : null;
      }
      if (Object.keys(data).length > 0) {
        await tx.milestoneCriterion.update({
          where: { id: criterionId },
          data,
        });
      }
      return this.oneDto(tx, criterionId);
    });
  }

  async removeCriterion(
    workspaceId: string,
    iterationId: string,
    criterionId: string,
  ) {
    await this.prisma.$transaction(async (tx) => {
      await this.lockedMilestone(tx, workspaceId, iterationId);
      const res = await tx.milestoneCriterion.deleteMany({
        where: { id: criterionId, iterationId },
      });
      if (res.count === 0)
        throw new NotFoundException('Exit criterion not found');
    });
  }

  // ---------------------------------------------------------------- helpers

  /**
   * The milestone, read under a share lock: a close (which takes the update lock) and an edit of
   * its criteria take turns, so a close never judges criteria that are changing under it.
   */
  private async lockedMilestone(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    id: string,
  ) {
    await tx.$queryRaw`SELECT id FROM iterations WHERE id = ${id} FOR SHARE`;
    const it = await this.getOrThrow(tx, workspaceId, id);
    this.assertSupports(it.kind, 'exitCriteria');
    if (it.state === IterationState.CLOSED) {
      throw new ConflictException({
        message: 'A closed milestone cannot be changed: reopen it first',
        code: ITERATION_CLOSED,
      });
    }
    return it;
  }

  private async oneDto(tx: Prisma.TransactionClient, id: string) {
    const row = await tx.milestoneCriterion.findUniqueOrThrow({
      where: { id },
      select: {
        id: true,
        iterationId: true,
        title: true,
        taskId: true,
        doneAt: true,
        position: true,
        task: { select: { id: true, number: true, title: true, status: true } },
      },
    });
    return criterionDto(row);
  }

  private assertSupports(
    kind: keyof typeof KIND_PROFILE,
    capability: 'road' | 'exitCriteria',
  ) {
    if (!KIND_PROFILE[kind][capability]) {
      throw new BadRequestException({
        message: `A ${kind.toLowerCase()} has no ${capability === 'road' ? 'road' : 'exit criteria'}`,
        code: KIND_NOT_SUPPORTED,
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
