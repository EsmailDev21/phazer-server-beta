import { TaskStatus } from '@prisma/client';

/**
 * ADR-0005. Maximum number of EDGES below a root: root (0) -> subtask (1) ->
 * sub-subtask (2) = three levels. Raising it later breaks nothing; lowering it
 * would strand existing deeper trees, so this starts low on purpose.
 */
export const MAX_TASK_DEPTH = 2;

export interface TreeNode {
  id: string;
  parentId: string | null;
  status: TaskStatus;
  isArchived: boolean;
  /** ADR-0006 decision 10: the task's status is left out of progress (Canceled). */
  excludeFromProgress?: boolean;
}

export interface LeafProgress {
  done: number;
  total: number;
  /** Rounded 0-100. */
  percent: number;
}

/**
 * Progress of a set of tasks counted by their LEAVES (ADR-0005 decision 6).
 *
 * A leaf is a counted task (not archived, not excluded from progress) with no
 * counted child among `nodes`.
 * Containers (tasks that have children) are not counted themselves, and a
 * parent's own status never changes the result. Archived tasks are ignored
 * entirely, and an archived child does not make its parent a container.
 *
 * `null` when there are no leaves at all (nothing to measure) - callers decide
 * whether that is 0 (a project) or "no progress to show" (a task without
 * subtasks).
 *
 * For a flat list (no parent links) every task is a leaf, so the result equals
 * the old `done / total`: this is why the existing project-progress numbers do
 * not change for projects without subtasks.
 */
export function leafProgress(nodes: TreeNode[]): LeafProgress | null {
  const leaves = countedLeaves(nodes);
  const total = leaves.length;
  if (total === 0) return null;
  const done = leaves.filter((n) => n.status === TaskStatus.DONE).length;
  return { done, total, percent: Math.round((done / total) * 100) };
}

/**
 * The leaves that count (the rule in `leafProgress`'s doc), as the nodes themselves.
 * Archived tasks and excluded (Canceled) tasks are removed FIRST, so a parent whose
 * only subtasks are excluded counts as a leaf itself (ADR-0006 d.10). Shared by
 * progress and by iteration points/velocity so the two can never disagree.
 */
export function countedLeaves<T extends TreeNode>(nodes: T[]): T[] {
  const live = nodes.filter((n) => !n.isArchived && !n.excludeFromProgress);
  const hasLiveChild = new Set<string>();
  for (const n of live) if (n.parentId) hasLiveChild.add(n.parentId);
  return live.filter((n) => !hasLiveChild.has(n.id));
}
