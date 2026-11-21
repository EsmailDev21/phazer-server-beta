import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { TaskStatus } from '@prisma/client';

/**
 * ADR-0006. The pure rules of workflow statuses: no database, no Nest providers,
 * so every decision in the ADR can be tested row by row. WorkflowService loads a
 * snapshot, calls these, and persists the result.
 */

/** Decision 11: keeps transitions <= 900 rows and boards usable. */
export const MAX_WORKFLOW_STATUSES = 30;

/** Decision 4: a project must always keep a status in each of these. BLOCKED is optional. */
export const REQUIRED_CATEGORIES: readonly TaskStatus[] = [
  TaskStatus.TODO,
  TaskStatus.IN_PROGRESS,
  TaskStatus.DONE,
];

export const CATEGORY_LABEL: Record<TaskStatus, string> = {
  TODO: 'To Do',
  IN_PROGRESS: 'In Progress',
  BLOCKED: 'Blocked',
  DONE: 'Done',
};

/** Decision 2: one per category, in this order, each the category default. */
export const DEFAULT_WORKFLOW: ReadonlyArray<{
  name: string;
  color: string;
  category: TaskStatus;
}> = [
  { name: 'To Do', color: '#94A3B8', category: TaskStatus.TODO },
  { name: 'In Progress', color: '#3B82F6', category: TaskStatus.IN_PROGRESS },
  { name: 'Blocked', color: '#EF4444', category: TaskStatus.BLOCKED },
  { name: 'Done', color: '#22C55E', category: TaskStatus.DONE },
];

export interface StatusRow {
  id: string;
  name: string;
  nameKey: string;
  color: string;
  position: number;
  category: TaskStatus;
  isDefault: boolean;
  excludeFromProgress: boolean;
}

export interface TransitionRow {
  fromStatusId: string;
  toStatusId: string;
}

export interface WorkflowSnapshot {
  projectId: string;
  statuses: StatusRow[];
  /** Project.defaultWorkflowStatusId (may be null on a damaged row; callers fall back). */
  initialStatusId: string | null;
  enforceTransitions: boolean;
  transitions: TransitionRow[];
}

export interface CurrentTaskStatus {
  status: TaskStatus;
  workflowStatusId: string | null;
}

export interface ResolvedStatus {
  status: TaskStatus;
  workflowStatusId: string;
}

export const TRANSITION_NOT_ALLOWED = 'TRANSITION_NOT_ALLOWED';
export const CATEGORY_HAS_NO_STATUS = 'CATEGORY_HAS_NO_STATUS';

const byPosition = (a: StatusRow, b: StatusRow) =>
  a.position - b.position || a.id.localeCompare(b.id);

/** The status a category-only request lands on: the flagged default, else the first by position. */
export function categoryDefault(
  statuses: StatusRow[],
  category: TaskStatus,
): StatusRow | null {
  const inCategory = statuses.filter((s) => s.category === category);
  if (inCategory.length === 0) return null;
  return (
    inCategory.find((s) => s.isDefault) ?? [...inCategory].sort(byPosition)[0]
  );
}

/** Where a new task starts: Project.defaultWorkflowStatusId, else the TODO default. */
export function initialStatus(snapshot: WorkflowSnapshot): StatusRow {
  const explicit = snapshot.statuses.find(
    (s) => s.id === snapshot.initialStatusId,
  );
  const found = explicit ?? categoryDefault(snapshot.statuses, TaskStatus.TODO);
  if (!found) {
    // Required-category rules make this unreachable for a healthy project.
    throw new ConflictException({
      message: 'This project has no To Do status',
      code: CATEGORY_HAS_NO_STATUS,
    });
  }
  return found;
}

function noStatusIn(category: TaskStatus): ConflictException {
  return new ConflictException({
    message: `This project's workflow has no ${CATEGORY_LABEL[category]} status`,
    code: CATEGORY_HAS_NO_STATUS,
  });
}

export interface WriteRequest {
  status?: TaskStatus;
  workflowStatusId?: string;
}

export interface ResolveResult extends ResolvedStatus {
  /** false = the request changes nothing about the task's status. */
  changed: boolean;
}

/**
 * ADR-0006 decision 5 (the table) + decision 7 (transitions).
 *
 * `current` null = a task being CREATED (never restricted by transitions).
 * `enforce` false = a system writer (IMPORT / TEMPLATE) that reproduces history.
 */
export function resolveWrite(
  snapshot: WorkflowSnapshot,
  current: CurrentTaskStatus | null,
  req: WriteRequest,
  opts: { enforce: boolean },
): ResolveResult {
  const { statuses } = snapshot;
  let target: StatusRow | null = null;

  if (req.workflowStatusId !== undefined) {
    target = statuses.find((s) => s.id === req.workflowStatusId) ?? null;
    if (!target) {
      throw new BadRequestException(
        'workflowStatusId does not belong to this project',
      );
    }
    if (req.status !== undefined && req.status !== target.category) {
      throw new BadRequestException(
        `status ${req.status} does not match the category (${target.category}) of workflowStatusId`,
      );
    }
  } else if (req.status !== undefined) {
    const currentRow = current?.workflowStatusId
      ? statuses.find((s) => s.id === current.workflowStatusId)
      : undefined;
    if (currentRow && currentRow.category === req.status) {
      // An old client re-sending the category must not reset a custom status.
      return {
        status: currentRow.category,
        workflowStatusId: currentRow.id,
        changed: false,
      };
    }
    target = categoryDefault(statuses, req.status);
    if (!target) throw noStatusIn(req.status);
    if (current && !currentRow && current.status === req.status) {
      // Unmapped task (no status row) re-sent its own category: attach the default
      // quietly - nothing the user would call a status change.
      return {
        status: target.category,
        workflowStatusId: target.id,
        changed: false,
      };
    }
  } else if (current === null) {
    target = initialStatus(snapshot);
  } else {
    // Nothing requested on an existing task.
    const row = current.workflowStatusId
      ? statuses.find((s) => s.id === current.workflowStatusId)
      : undefined;
    const healed = row ?? categoryDefault(statuses, current.status);
    if (!healed) throw noStatusIn(current.status);
    return {
      status: current.status,
      workflowStatusId: healed.id,
      changed: false,
    };
  }

  if (current === null) {
    return {
      status: target.category,
      workflowStatusId: target.id,
      changed: true,
    };
  }

  if (target.id === current.workflowStatusId) {
    return {
      status: target.category,
      workflowStatusId: target.id,
      changed: false,
    };
  }

  if (
    opts.enforce &&
    snapshot.enforceTransitions &&
    current.workflowStatusId !== null &&
    statuses.some((s) => s.id === current.workflowStatusId)
  ) {
    const allowed = snapshot.transitions
      .filter((t) => t.fromStatusId === current.workflowStatusId)
      .map((t) => t.toStatusId);
    if (!allowed.includes(target.id)) {
      throw new ConflictException({
        message: `This project does not allow moving a task from its current status to "${target.name}"`,
        code: TRANSITION_NOT_ALLOWED,
        details: { allowedStatusIds: allowed },
      });
    }
  }
  return {
    status: target.category,
    workflowStatusId: target.id,
    changed: true,
  };
}

/**
 * Decision 6: the status a task gets in another project. Exact name match
 * (case-insensitive, via nameKey) inside the same category, else that category's
 * default there. null target project = the Inbox (no specific status).
 */
export function remapForProject(
  targetStatuses: StatusRow[] | null,
  current: { category: TaskStatus; nameKey: string | null },
): string | null {
  if (targetStatuses === null) return null;
  const sameName = targetStatuses.find(
    (s) => s.category === current.category && s.nameKey === current.nameKey,
  );
  if (sameName) return sameName.id;
  const fallback = categoryDefault(targetStatuses, current.category);
  if (!fallback) throw noStatusIn(current.category);
  return fallback.id;
}

/**
 * Repairs `isDefault` so every non-empty category has exactly one default:
 * keeps the lowest-position flagged one, or flags the lowest-position status.
 * Pure; returns new objects.
 */
export function electDefaults(statuses: StatusRow[]): StatusRow[] {
  const out = statuses.map((s) => ({ ...s }));
  for (const category of Object.values(TaskStatus)) {
    const inCat = out.filter((s) => s.category === category).sort(byPosition);
    if (inCat.length === 0) continue;
    const keeper = inCat.find((s) => s.isDefault) ?? inCat[0];
    for (const s of inCat) s.isDefault = s === keeper;
  }
  return out;
}

/** Re-numbers positions 0..n-1 in the given order. */
export function renumber(ordered: StatusRow[]): StatusRow[] {
  return ordered.map((s, i) => ({ ...s, position: i }));
}

/**
 * The invariants a workflow must satisfy AFTER any edit (decisions 4, 10, 11).
 * Throws the exception the caller should surface; returns nothing.
 */
export function assertWorkflowValid(
  statuses: StatusRow[],
  initialStatusId: string | null,
): void {
  if (statuses.length > MAX_WORKFLOW_STATUSES) {
    throw new ConflictException(
      `A project can have at most ${MAX_WORKFLOW_STATUSES} statuses`,
    );
  }
  for (const category of REQUIRED_CATEGORIES) {
    if (!statuses.some((s) => s.category === category)) {
      throw new ConflictException({
        message: `A project must keep at least one ${CATEGORY_LABEL[category]} status`,
        code: CATEGORY_HAS_NO_STATUS,
      });
    }
  }
  for (const s of statuses) {
    if (s.excludeFromProgress && s.category !== TaskStatus.DONE) {
      throw new BadRequestException(
        'Only a status in the Done category can be left out of progress',
      );
    }
  }
  const initial = statuses.find((s) => s.id === initialStatusId);
  if (!initial) {
    throw new ConflictException(
      'The project needs an initial status (the status new tasks start in)',
    );
  }
  if (initial.category !== TaskStatus.TODO) {
    throw new ConflictException(
      'The initial status must be in the To Do category: make another To Do status the initial one first',
    );
  }
}

export function findStatusOrThrow(
  statuses: StatusRow[],
  id: string,
): StatusRow {
  const s = statuses.find((x) => x.id === id);
  if (!s) throw new NotFoundException('Status not found');
  return s;
}

/** Hard-capped names: same normalisation idea as tags, own limit. */
export const STATUS_NAME_MAX_LENGTH = 50;
