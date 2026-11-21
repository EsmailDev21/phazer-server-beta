import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, TaskStatus } from '@prisma/client';
import { PlanLimitsService } from '../../access-control/plan-limits.service';
import { PlanLimitExceededException } from '../../common/exceptions/plan-limit-exceeded.exception';
import { PrismaService } from '../../prisma/prisma.service';
import { MAX_TASK_DEPTH } from './task-tree';

type Db = Prisma.TransactionClient | PrismaService;

export interface TreeRow {
  id: string;
  parentId: string | null;
  status: TaskStatus;
  isArchived: boolean;
  excludeFromProgress: boolean;
  /** 1 = direct child of the root asked about. */
  depth: number;
}

export interface ParentCheck {
  parentId: string;
  workspaceId: string;
  /** The task being (re)parented, if it already exists - for cycle detection. */
  childId?: string;
  /**
   * The project the child will be in. `undefined` = "inherit the parent's"
   * (create only); `null` = the Inbox. Anything else must equal the parent's.
   */
  childProjectId?: string | null;
  /** Edges below the child that move with it (0 for a brand-new task). */
  subtreeHeight: number;
}

/**
 * ADR-0005. Everything about the shape of the task tree: the lock, the
 * walks, parent validation and the cap check on moves. TasksService calls this;
 * nothing else writes `Task.parentId`.
 *
 * Depth is bounded (MAX_TASK_DEPTH), so ancestors and descendants are walked
 * one level per query - no recursive SQL, and a walk that exceeds the bound is
 * itself evidence of corrupt data and fails loudly rather than looping.
 */
@Injectable()
export class TaskTreeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly planLimits: PlanLimitsService,
  ) {}

  /**
   * Serialises every write that sets or changes a parent, per workspace.
   * Without it two concurrent reparents (A under B, B under A) would each pass
   * the cycle check. Transaction-scoped; must be called inside one. Same
   * mechanism as ADR-0004's key lock. `$executeRaw`, not `$queryRaw`: the
   * function returns `void`, which Prisma cannot deserialize.
   */
  async lockTree(
    tx: Prisma.TransactionClient,
    workspaceId: string,
  ): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`task-tree:${workspaceId}`}, 0))`;
  }

  /** Ancestors of `taskId`, nearest first (parent, grandparent, ...). */
  async ancestors(db: Db, taskId: string) {
    const chain: Array<{ id: string; parentId: string | null }> = [];
    let current = await db.task.findUnique({
      where: { id: taskId },
      select: { parentId: true },
    });
    while (current?.parentId) {
      if (chain.length > MAX_TASK_DEPTH) {
        throw new Error(
          `Task tree deeper than ${MAX_TASK_DEPTH} (or cyclic) above ${taskId}`,
        );
      }
      const parent = await db.task.findUnique({
        where: { id: current.parentId },
        select: { id: true, parentId: true },
      });
      if (!parent) break;
      chain.push(parent);
      current = parent;
    }
    return chain;
  }

  /**
   * Every descendant of `rootId`, level by level. `where` narrows which
   * children are followed (e.g. only non-archived ones).
   */
  async descendants(
    db: Db,
    rootId: string,
    where: Prisma.TaskWhereInput = {},
  ): Promise<TreeRow[]> {
    const out: TreeRow[] = [];
    let frontier = [rootId];
    for (let depth = 1; frontier.length > 0; depth++) {
      if (depth > MAX_TASK_DEPTH + 1) {
        throw new Error(
          `Task tree deeper than ${MAX_TASK_DEPTH} (or cyclic) below ${rootId}`,
        );
      }
      const children = await db.task.findMany({
        where: { parentId: { in: frontier }, ...where },
        select: {
          id: true,
          parentId: true,
          status: true,
          isArchived: true,
          workflowStatus: { select: { excludeFromProgress: true } },
        },
      });
      out.push(
        ...children.map(({ workflowStatus, ...c }) => ({
          ...c,
          excludeFromProgress: workflowStatus?.excludeFromProgress ?? false,
          depth,
        })),
      );
      frontier = children.map((c) => c.id);
    }
    return out;
  }

  /**
   * Validates `parentId` as the parent of a (new or existing) task and returns
   * the parent plus how deep it sits. Throws 404 for a missing parent or one in
   * another workspace (indistinguishable on purpose), 400 for the real rules.
   */
  async assertCanBeParent(db: Db, check: ParentCheck) {
    const parent = await db.task.findUnique({
      where: { id: check.parentId },
      select: {
        id: true,
        workspaceId: true,
        projectId: true,
        isArchived: true,
      },
    });
    if (!parent || parent.workspaceId !== check.workspaceId) {
      throw new NotFoundException('Parent task not found');
    }
    if (parent.isArchived) {
      throw new BadRequestException(
        'A subtask cannot be added to an archived task',
      );
    }
    if (
      check.childProjectId !== undefined &&
      check.childProjectId !== parent.projectId
    ) {
      throw new BadRequestException(
        'A subtask must be in the same project as its parent',
      );
    }

    const chain = await this.ancestors(db, parent.id);
    if (
      check.childId &&
      (parent.id === check.childId || chain.some((a) => a.id === check.childId))
    ) {
      throw new BadRequestException(
        'A task cannot be moved under itself or one of its own subtasks',
      );
    }
    const parentDepth = chain.length;
    if (parentDepth + 1 + check.subtreeHeight > MAX_TASK_DEPTH) {
      throw new BadRequestException(
        `Subtasks can be nested at most ${MAX_TASK_DEPTH + 1} levels deep`,
      );
    }
    return { parent, parentDepth };
  }

  /**
   * ADR-0005 decision 9: moving tasks into a project counts toward its cap.
   * Inbox targets are never capped (same rule as creating).
   */
  async assertCapacity(
    db: Prisma.TransactionClient,
    workspaceId: string,
    targetProjectId: string | null,
    additional: number,
  ): Promise<void> {
    if (!targetProjectId || additional <= 0) return;
    const ws = await db.workspace.findUnique({
      where: { id: workspaceId },
      select: { accountId: true },
    });
    if (!ws) return;
    const ok = await this.planLimits.checkLimit(
      'task',
      'editTask',
      { accountId: ws.accountId, workspaceId, projectId: targetProjectId },
      { additional, db },
    );
    if (!ok) {
      throw new PlanLimitExceededException(
        `Task limit reached for the target project: cannot add ${additional} task(s) to it`,
      );
    }
  }

  /**
   * Resolves the effect of an update on the tree: the final parent/project, the
   * subtree that moves with the task, and whether the cap needs checking. Runs
   * inside the update transaction, under lockTree. `task` must be re-read
   * under the lock by the caller.
   */
  async planChange(
    tx: Prisma.TransactionClient,
    task: {
      id: string;
      workspaceId: string;
      parentId: string | null;
      projectId: string | null;
    },
    change: { parentId?: string | null; projectId?: string },
  ) {
    const parentChanges =
      change.parentId !== undefined && change.parentId !== task.parentId;
    const projectChanges =
      change.projectId !== undefined && change.projectId !== task.projectId;
    const finalParentId = parentChanges
      ? (change.parentId as string | null)
      : task.parentId;
    const finalProjectId = projectChanges
      ? (change.projectId as string)
      : task.projectId;

    if (projectChanges && task.parentId && finalParentId === task.parentId) {
      throw new BadRequestException(
        'A subtask cannot change project on its own: move its parent, or detach it first (parentId: null)',
      );
    }

    const descendants = await this.descendants(tx, task.id);
    const height = descendants.reduce((max, d) => Math.max(max, d.depth), 0);

    if (parentChanges && finalParentId) {
      await this.assertCanBeParent(tx, {
        parentId: finalParentId,
        workspaceId: task.workspaceId,
        childId: task.id,
        childProjectId: finalProjectId,
        subtreeHeight: height,
      });
    }
    if (projectChanges) {
      await this.assertCapacity(
        tx,
        task.workspaceId,
        finalProjectId,
        1 + descendants.length,
      );
    }
    return {
      parentChanges,
      projectChanges,
      finalParentId,
      finalProjectId,
      descendantIds: descendants.map((d) => d.id),
    };
  }
}
