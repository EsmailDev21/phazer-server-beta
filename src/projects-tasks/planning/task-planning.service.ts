import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { IterationState, Prisma } from '@prisma/client';
import { ITERATION_CLOSED } from '../iterations/iteration-rules';

type Tx = Prisma.TransactionClient;

export interface PlanningRequest {
  /** undefined = untouched, null = clear. */
  issueTypeId?: string | null;
  iterationId?: string | null;
}

export interface PlanningResult {
  data: { issueTypeId?: string | null; iterationId?: string | null };
  issueTypeChange: { from: string | null; to: string | null } | null;
  iterationChange: { from: string | null; to: string | null } | null;
}

/**
 * ADR-0007. Validates the `issueTypeId` / `iterationId` a task write asks for.
 * The ONLY place that decides whether a task may sit in an iteration or carry a type;
 * TasksService (create, bulk, update, project move) calls it, nothing else writes
 * those two columns.
 *
 * Rules: the type and the iteration must belong to the task's workspace; a
 * project-scoped iteration only takes tasks of that project; a CLOSED iteration takes
 * no new tasks (IMPORT / TEMPLATE writers may replay history: `allowClosed`); clearing
 * is always allowed, and leaving a task where it already is is never an error.
 *
 * LOCKING: every assignment takes the iteration row FOR SHARE, and callers invoke
 * `lockIterations` BEFORE they write any task row (IterationsService.close holds the
 * row FOR UPDATE and then updates tasks - the opposite order would deadlock).
 */
@Injectable()
export class TaskPlanningService {
  /** FOR SHARE, ids sorted, so two writers never take them in opposite orders. */
  async lockIterations(tx: Tx, ids: Array<string | null | undefined>) {
    const unique = Array.from(new Set(ids.filter((i): i is string => !!i))).sort();
    for (const id of unique) {
      await tx.$queryRaw`SELECT id FROM iterations WHERE id = ${id} FOR SHARE`;
    }
  }

  async resolveForCreate(
    tx: Tx,
    ctx: { workspaceId: string; projectId: string | null },
    req: PlanningRequest,
    opts: { allowClosed: boolean },
  ): Promise<{ issueTypeId: string | null; iterationId: string | null }> {
    await this.assertIssueType(tx, ctx.workspaceId, req.issueTypeId);
    await this.assertIteration(tx, ctx, req.iterationId, opts.allowClosed);
    return {
      issueTypeId: req.issueTypeId ?? null,
      iterationId: req.iterationId ?? null,
    };
  }

  async resolveForUpdate(
    tx: Tx,
    current: {
      workspaceId: string;
      projectId: string | null;
      issueTypeId: string | null;
      iterationId: string | null;
    },
    req: PlanningRequest,
    opts: { allowClosed: boolean },
  ): Promise<PlanningResult> {
    const data: PlanningResult['data'] = {};
    let issueTypeChange: PlanningResult['issueTypeChange'] = null;
    let iterationChange: PlanningResult['iterationChange'] = null;

    if (req.issueTypeId !== undefined && req.issueTypeId !== current.issueTypeId) {
      await this.assertIssueType(tx, current.workspaceId, req.issueTypeId);
      data.issueTypeId = req.issueTypeId;
      issueTypeChange = { from: current.issueTypeId, to: req.issueTypeId };
    }
    if (req.iterationId !== undefined && req.iterationId !== current.iterationId) {
      await this.assertIteration(tx, current, req.iterationId, opts.allowClosed);
      data.iterationId = req.iterationId;
      iterationChange = { from: current.iterationId, to: req.iterationId };
    }
    return { data, issueTypeChange, iterationChange };
  }

  /** Bulk create: each distinct type/iteration is loaded once. Returns one entry per item. */
  async resolveForBulk(
    tx: Tx,
    workspaceId: string,
    items: Array<{
      projectId?: string | null;
      issueTypeId?: string | null;
      iterationId?: string | null;
    }>,
    opts: { allowClosed: boolean },
  ): Promise<Array<{ issueTypeId: string | null; iterationId: string | null }>> {
    const typeIds = Array.from(
      new Set(items.map((i) => i.issueTypeId).filter((x): x is string => !!x)),
    );
    const iterIds = Array.from(
      new Set(items.map((i) => i.iterationId).filter((x): x is string => !!x)),
    );
    if (typeIds.length > 0) {
      const found = await tx.issueType.count({
        where: { id: { in: typeIds }, workspaceId },
      });
      if (found !== typeIds.length) {
        throw new BadRequestException(
          'issueTypeId does not belong to this workspace',
        );
      }
    }
    const iterations = new Map<string, { projectId: string | null; state: IterationState }>();
    if (iterIds.length > 0) {
      await this.lockIterations(tx, iterIds);
      const rows = await tx.iteration.findMany({
        where: { id: { in: iterIds }, workspaceId },
        select: { id: true, projectId: true, state: true },
      });
      for (const r of rows) iterations.set(r.id, r);
      if (rows.length !== iterIds.length) {
        throw new BadRequestException(
          'iterationId does not belong to this workspace',
        );
      }
    }
    return items.map((item) => {
      if (item.iterationId) {
        this.checkIteration(
          iterations.get(item.iterationId)!,
          item.projectId ?? null,
          opts.allowClosed,
        );
      }
      return {
        issueTypeId: item.issueTypeId ?? null,
        iterationId: item.iterationId ?? null,
      };
    });
  }

  /**
   * After tasks moved into `finalProjectId`: a project-scoped iteration of ANOTHER
   * project no longer fits, so the pointer is cleared (decision: a move never fails
   * because of an iteration, and never leaves a task in the wrong project's sprint).
   * Returns how many tasks were cleared.
   */
  async clearForMove(
    tx: Tx,
    taskIds: string[],
    finalProjectId: string | null,
  ): Promise<number> {
    if (taskIds.length === 0) return 0;
    const r = await tx.task.updateMany({
      where: {
        id: { in: taskIds },
        iteration: {
          AND: [
            { projectId: { not: null } },
            ...(finalProjectId ? [{ projectId: { not: finalProjectId } }] : []),
          ],
        },
      },
      data: { iterationId: null },
    });
    return r.count;
  }

  // -------------------------------------------------------------- internals

  private async assertIssueType(
    tx: Tx,
    workspaceId: string,
    id: string | null | undefined,
  ) {
    if (!id) return;
    const t = await tx.issueType.findFirst({
      where: { id, workspaceId },
      select: { id: true },
    });
    if (!t) {
      throw new BadRequestException('issueTypeId does not belong to this workspace');
    }
  }

  private async assertIteration(
    tx: Tx,
    ctx: { workspaceId: string; projectId: string | null },
    id: string | null | undefined,
    allowClosed: boolean,
  ) {
    if (!id) return; // clearing is always allowed
    await this.lockIterations(tx, [id]);
    const it = await tx.iteration.findFirst({
      where: { id, workspaceId: ctx.workspaceId },
      select: { projectId: true, state: true },
    });
    if (!it) {
      throw new BadRequestException('iterationId does not belong to this workspace');
    }
    this.checkIteration(it, ctx.projectId, allowClosed);
  }

  private checkIteration(
    it: { projectId: string | null; state: IterationState },
    taskProjectId: string | null,
    allowClosed: boolean,
  ) {
    if (it.state === IterationState.CLOSED && !allowClosed) {
      throw new ConflictException({
        message: 'This iteration is closed: reopen it or pick another one',
        code: ITERATION_CLOSED,
      });
    }
    if (it.projectId && it.projectId !== taskProjectId) {
      throw new BadRequestException(
        'This iteration belongs to another project: the task must be in that project',
      );
    }
  }
}
