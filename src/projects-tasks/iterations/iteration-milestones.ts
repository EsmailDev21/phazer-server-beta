import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { formatDateOnly } from './iteration-rules';
import {
  CriterionState,
  summarizeCriteria,
  targetChangeToRecord,
} from './milestone-rules';

/**
 * ADR-0046. The few database reads and writes shared by IterationsService (the closing gate, the
 * target date history) and MilestoneService (the road, the criteria). The decisions are in
 * milestone-rules.ts; this file only moves rows.
 */

type Db = Prisma.TransactionClient | PrismaService;

export interface CriterionRow {
  id: string;
  iterationId: string;
  title: string;
  taskId: string | null;
  doneAt: Date | null;
  position: number;
  task: {
    id: string;
    number: number;
    title: string;
    status: CriterionState['taskStatus'];
  } | null;
}

export async function loadCriteria(
  db: Db,
  iterationId: string,
): Promise<CriterionRow[]> {
  return db.milestoneCriterion.findMany({
    where: { iterationId },
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
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
}

export const stateOf = (c: CriterionRow): CriterionState => ({
  taskId: c.taskId,
  taskStatus: c.task?.status ?? null,
  doneAt: c.doneAt,
});

export async function criteriaSummary(db: Db, iterationId: string) {
  return summarizeCriteria((await loadCriteria(db, iterationId)).map(stateOf));
}

/** Writes a history row when a target date that was set has moved (or was removed). */
export async function recordTargetChange(
  db: Db,
  iterationId: string,
  previous: Date | null,
  next: Date | null,
  actorId: string | null,
): Promise<void> {
  const change = targetChangeToRecord(
    formatDateOnly(previous),
    formatDateOnly(next),
  );
  if (!change) return;
  await db.iterationTargetChange.create({
    data: {
      iterationId,
      previousDate: previous,
      newDate: next,
      changedById: actorId,
    },
  });
}
