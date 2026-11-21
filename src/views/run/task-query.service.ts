import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Conditions } from '../../automations/dsl/rule.types';
import { evaluateConditions } from '../../automations/engine/conditions-eval';
import { PrismaService } from '../../prisma/prisma.service';
import { TaskVisibilityService } from '../../projects-tasks/tasks/task-visibility.service';
import { SNAPSHOT_SELECT, toSnapshot } from '../../automations/task-snapshot';
import { viewRunLimits } from './run.settings';
import { conditionsToWhere } from './task-where';

export interface TaskQueryInput {
  workspaceId: string;
  /**
   * whose eyes: their project access applies and `ME` means them. NULL = the system (a rule's loop):
   * every non-archived task of the workspace, no per-person visibility (until step 5.9 gives rules an
   * author's authority).
   */
  userId: string | null;
  /** whoever `TRIGGERER` means in the conditions (a rule's loop); defaults to `userId` */
  actorId?: string | null;
  /** extra structural narrowing: a parent, "not this task", ... */
  structural?: Prisma.TaskWhereInput;
  /** lets an internal caller ask for more than the public page maximum (a loop's own limit applies instead) */
  pageCap?: number;
  filters?: Conditions;
  /** narrow to one project (a view that belongs to one) */
  projectId?: string | null;
  limit?: number;
  /** the id of the last task of the previous page */
  cursor?: string | null;
  now?: Date;
}

export interface TaskQueryItem {
  id: string;
  /** `KEY-12`, as a person sees it */
  key: string;
  statusName: string;
  createdById: string;
  title: string;
  projectId: string | null;
  parentId: string | null;
  status: string;
  workflowStatusId: string | null;
  priority: string | null;
  dueDate: Date | null;
}

export interface TaskQueryResult {
  items: TaskQueryItem[];
  /** pass it back as `cursor` for the next page; null = nothing more */
  nextCursor: string | null;
  /** rows looked at to build this page */
  scanned: number;
  /** true = stopped because it hit the scan limit, not because the page was full: more may follow */
  capped: boolean;
}

const BATCH = 200;

/**
 * Step 5.11. "Which tasks match this filter, for this person": the engine behind running a saved view and
 * behind a rule's FOR_EACH. The caller's visibility comes from TaskVisibilityService (the one rule for
 * who sees which task); the database narrows with what `conditionsToWhere` can translate exactly; and
 * EVERY candidate is then checked by `evaluateConditions`, the single definition of a condition. So the
 * pre-filter can only make it faster, never change the answer.
 *
 * Order is by task id (stable, so a cursor can resume); sorting and grouping are the client's, for now.
 */
@Injectable()
export class TaskQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly visibility: TaskVisibilityService,
  ) {}

  async run(input: TaskQueryInput): Promise<TaskQueryResult> {
    const limits = viewRunLimits();
    const limit = Math.min(
      Math.max(input.limit ?? 50, 1),
      input.pageCap ?? limits.maxPage,
    );
    const now = input.now ?? new Date();
    const filters: Conditions = input.filters ?? {};
    const visible: Prisma.TaskWhereInput =
      input.userId === null
        ? { workspaceId: input.workspaceId, isArchived: false }
        : await this.visibility.buildVisibleTasksWhere(input.userId, {
            workspaceId: input.workspaceId,
            ...(input.projectId ? { projectId: input.projectId } : {}),
          });
    const system = input.userId === null;
    const narrowed = conditionsToWhere(filters, {
      now,
      viewerId: input.userId,
    });
    const ctx = {
      now,
      actorId: input.actorId !== undefined ? input.actorId : input.userId,
      viewerId: input.userId,
    };

    const items: TaskQueryItem[] = [];
    let after = input.cursor ?? null;
    let scanned = 0;
    let lastScanned: string | null = null;
    let exhausted = false;

    scan: while (scanned < limits.maxScan) {
      const take = Math.min(BATCH, limits.maxScan - scanned);
      const rows = await this.prisma.task.findMany({
        where: {
          AND: [
            visible,
            ...(system && input.projectId
              ? [{ projectId: input.projectId }]
              : []),
            ...(input.structural ? [input.structural] : []),
            narrowed,
            ...(after ? [{ id: { gt: after } }] : []),
          ],
        },
        orderBy: { id: 'asc' },
        take,
        select: {
          id: true,
          number: true,
          workspace: { select: { key: true } },
          workflowStatus: { select: { name: true } },
          ...SNAPSHOT_SELECT,
        },
      });
      for (const row of rows) {
        scanned++;
        lastScanned = row.id;
        if (!evaluateConditions(filters, toSnapshot(row), ctx)) continue;
        items.push({
          id: row.id,
          key: `${row.workspace.key}-${row.number}`,
          statusName: row.workflowStatus?.name ?? row.status,
          createdById: row.createdById,
          title: row.title,
          projectId: row.projectId,
          parentId: row.parentId,
          status: row.status,
          workflowStatusId: row.workflowStatusId,
          priority: row.priority,
          dueDate: row.dueDate,
        });
        if (items.length > limit) break scan; // one extra: there IS a next page
      }
      if (rows.length < take) {
        exhausted = true; // the database has nothing more after these
        break;
      }
      after = rows[rows.length - 1].id;
    }

    if (items.length > limit) {
      items.length = limit;
      return {
        items,
        nextCursor: items[limit - 1].id,
        scanned,
        capped: false,
      };
    }
    const capped = !exhausted && scanned >= limits.maxScan;
    return {
      items,
      nextCursor: exhausted ? null : lastScanned,
      scanned,
      capped,
    };
  }
}
