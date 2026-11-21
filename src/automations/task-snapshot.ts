import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { TaskSnapshot } from './engine/conditions-eval';

/** The columns a condition may look at. One select, so a rule, an IF and a saved view read the same facts. */
export const SNAPSHOT_SELECT = {
  title: true,
  status: true,
  workflowStatusId: true,
  priority: true,
  estimate: true,
  dueDate: true,
  startDate: true,
  createdById: true,
  issueTypeId: true,
  iterationId: true,
  projectId: true,
  parentId: true,
  assignees: { select: { id: true } },
  tags: { select: { tagId: true } },
  customValues: { select: { fieldId: true, value: true } },
} satisfies Prisma.TaskSelect;

export type SnapshotRow = Prisma.TaskGetPayload<{
  select: typeof SNAPSHOT_SELECT;
}>;

export function toSnapshot(t: SnapshotRow): TaskSnapshot {
  return {
    title: t.title,
    status: t.status,
    workflowStatusId: t.workflowStatusId,
    priority: t.priority,
    assigneeIds: t.assignees.map((u) => u.id),
    tagIds: t.tags.map((x) => x.tagId),
    issueTypeId: t.issueTypeId,
    iterationId: t.iterationId,
    projectId: t.projectId,
    estimate: t.estimate,
    dueDate: t.dueDate,
    startDate: t.startDate,
    parentId: t.parentId,
    createdById: t.createdById,
    customValues: Object.fromEntries(
      t.customValues.map((v) => [v.fieldId, v.value]),
    ),
  };
}

/**
 * The facts a rule's conditions look at, as the task is NOW. The runner reads this once per run for the
 * rule's own conditions; an `IF` reads it again when it runs, because the actions before it may have
 * changed the task. Null when the task is gone.
 */
export async function loadTaskSnapshot(
  prisma: PrismaService,
  taskId: string,
): Promise<TaskSnapshot | null> {
  const t = await prisma.task.findUnique({
    where: { id: taskId },
    select: SNAPSHOT_SELECT,
  });
  return t ? toSnapshot(t) : null;
}
