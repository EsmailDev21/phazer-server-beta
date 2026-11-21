import { TaskStatus } from '@prisma/client';
import { TreeNode, countedLeaves } from '../tasks/task-tree';

/**
 * ADR-0008. Points and counts of an iteration, pure. Only LEAF tasks are measured
 * (the same leaves progress uses, via `countedLeaves`), so a parent and its subtasks
 * are never both summed, and Canceled (excluded) tasks never count. A task without an
 * estimate counts as 0 points and is reported, never guessed.
 */
export interface MetricNode extends TreeNode {
  estimate: number | null;
}

export interface Measure {
  totalCount: number;
  totalPoints: number;
  completedCount: number;
  completedPoints: number;
  /** Counted leaves with no estimate (in the total), and how many of them are Done. */
  unestimatedTotal: number;
  unestimatedCompleted: number;
}

export const round2 = (n: number) => Math.round(n * 100) / 100;

export function measure(nodes: MetricNode[]): Measure {
  const m: Measure = {
    totalCount: 0,
    totalPoints: 0,
    completedCount: 0,
    completedPoints: 0,
    unestimatedTotal: 0,
    unestimatedCompleted: 0,
  };
  for (const n of countedLeaves(nodes)) {
    const points = n.estimate ?? 0;
    m.totalCount += 1;
    m.totalPoints += points;
    if (n.estimate === null) m.unestimatedTotal += 1;
    if (n.status === TaskStatus.DONE) {
      m.completedCount += 1;
      m.completedPoints += points;
      if (n.estimate === null) m.unestimatedCompleted += 1;
    }
  }
  m.totalPoints = round2(m.totalPoints);
  m.completedPoints = round2(m.completedPoints);
  return m;
}

/** Mean of the completed numbers over the given measures; null when there are none. */
export function averageVelocity(
  rows: Array<Pick<Measure, 'completedCount' | 'completedPoints'>>,
): { completedCount: number; completedPoints: number } | null {
  if (rows.length === 0) return null;
  const sum = rows.reduce(
    (a, r) => ({
      count: a.count + r.completedCount,
      points: a.points + r.completedPoints,
    }),
    { count: 0, points: 0 },
  );
  return {
    completedCount: round2(sum.count / rows.length),
    completedPoints: round2(sum.points / rows.length),
  };
}
