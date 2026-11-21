import { HttpException } from '@nestjs/common';
import type { StatusRef } from '../dsl/rule.types';
import type { ActionRun, ActionServices } from './descriptor';

/** `{category}` or `{statusId}` as the task API's own fields */
export const statusDto = (ref: StatusRef) =>
  'statusId' in ref
    ? { workflowStatusId: ref.statusId }
    : { status: ref.category };

/**
 * TRIGGERER / CREATOR / ASSIGNEES / WATCHERS / a user id -> user ids. A token with nobody behind it (a
 * sweep's triggerer, the assignees of a task with none) gives nobody. ASSIGNEES and WATCHERS are those of
 * the CURRENT task, as they are now, and cost one query each only when used.
 */
export async function resolveUsers(
  refs: string[],
  run: ActionRun,
  x: Pick<ActionServices, 'prisma'>,
): Promise<string[]> {
  const out: string[] = [];
  for (const r of refs) {
    if (r === 'TRIGGERER') {
      if (run.triggererId) out.push(run.triggererId);
    } else if (r === 'CREATOR') out.push(run.createdById);
    else if (r === 'ASSIGNEES') {
      if (run.taskId)
        out.push(
          ...(
            (await x.prisma.task.findUnique({
              where: { id: run.taskId },
              select: { assignees: { select: { id: true } } },
            })) ?? { assignees: [] }
          ).assignees.map((u) => u.id),
        );
    } else if (r === 'WATCHERS') {
      if (run.taskId)
        out.push(
          ...(
            await x.prisma.watch.findMany({
              where: { targetType: 'TASK', targetId: run.taskId },
              select: { userId: true },
            })
          ).map((w) => w.userId),
        );
    } else out.push(r);
  }
  return [...new Set(out)];
}

export function todayParts(plusDays: number): [number, number, number] {
  const now = new Date();
  return [now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + plusDays];
}

/** "In N days": counted from today (UTC midnight), or shifting the task's own due date (keeping its time of day). */
export async function relativeDate(
  x: ActionServices,
  run: ActionRun,
  inDays: number,
  from: 'NOW' | 'DUE_DATE' | undefined,
): Promise<Date> {
  if (from !== 'DUE_DATE') return new Date(Date.UTC(...todayParts(inDays)));
  const due = (
    await x.prisma.task.findUnique({
      where: { id: run.taskId! },
      select: { dueDate: true },
    })
  )?.dueDate;
  if (!due)
    throw new HttpException('The task has no due date to count from', 422);
  return new Date(due.getTime() + inDays * 86_400_000);
}

/** a day count as a human phrase, for `describe` */
export const days = (n: number): string =>
  n === 0
    ? 'today'
    : n > 0
      ? `in ${n} day${n === 1 ? '' : 's'}`
      : `${-n} day${n === -1 ? '' : 's'} before`;

export const statusText = (s: StatusRef): string =>
  'statusId' in s ? 'a specific status' : `a ${s.category} status`;
