import { Prisma, TaskStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { Measure, MetricNode } from './iteration-metrics';
import { LoadNode, SnapshotRow, snapshotValues } from './sprint-rules';

/**
 * ADR-0044. The few database reads and writes shared by IterationsService (start / close) and
 * SprintService (reads, the daily sweep). Everything that decides anything lives in the pure
 * sprint-rules.ts; this file only moves rows.
 */

type Db = Prisma.TransactionClient | PrismaService;

export const todayUtc = (now: Date = new Date()): string =>
  now.toISOString().slice(0, 10);

/** Prisma task rows -> the pure metric nodes. */
export function toMetricNodes(
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

const NODE_SELECT = {
  id: true,
  parentId: true,
  status: true,
  isArchived: true,
  estimate: true,
  workflowStatus: { select: { excludeFromProgress: true } },
} as const;

export async function loadMetricNodes(
  db: Db,
  iterationId: string,
): Promise<MetricNode[]> {
  const rows = await db.task.findMany({
    where: { iterationId, isArchived: false },
    select: NODE_SELECT,
  });
  return toMetricNodes(rows);
}

export async function loadLoadNodes(
  db: Db,
  iterationId: string,
): Promise<LoadNode[]> {
  const rows = await db.task.findMany({
    where: { iterationId, isArchived: false },
    select: { ...NODE_SELECT, assignees: { select: { id: true } } },
  });
  const nodes = toMetricNodes(rows);
  return nodes.map((n, i) => ({
    ...n,
    assigneeIds: rows[i].assignees.map((a) => a.id),
  }));
}

const dayDate = (day: string) => new Date(`${day}T00:00:00.000Z`);

/** One row per iteration per day: the last write of the day wins. */
export async function upsertSnapshot(
  db: Db,
  iterationId: string,
  day: string,
  m: Measure,
): Promise<void> {
  const v = snapshotValues(m);
  await db.iterationSnapshot.upsert({
    where: { iterationId_day: { iterationId, day: dayDate(day) } },
    create: { iterationId, day: dayDate(day), ...v },
    update: v,
  });
}

export async function loadSnapshots(
  db: Db,
  iterationId: string,
): Promise<SnapshotRow[]> {
  const rows = await db.iterationSnapshot.findMany({
    where: { iterationId },
    orderBy: { day: 'asc' },
  });
  return rows.map((r) => ({
    day: r.day.toISOString().slice(0, 10),
    totalPoints: r.totalPoints,
    totalCount: r.totalCount,
    remainingPoints: r.remainingPoints,
    remainingCount: r.remainingCount,
  }));
}
