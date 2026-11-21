import { AUTOMATION_LIMITS } from '../dsl/rule.limits';
import { Trigger } from '../dsl/rule.types';
import { RuleEvent } from './rule-event';

export type GuardBlock = 'SELF' | 'DEPTH';

/**
 * Loop guard, pure. An event made by a rule's own write never re-triggers that same rule (a rule that
 * sets status Done on "status Done" would otherwise chase itself), and a chain of rule-made changes
 * stops at `maxChainDepth` hops however the rules are arranged.
 */
export function loopGuard(
  event: Pick<RuleEvent, 'depth' | 'causedBy'>,
  ruleId: string,
  maxDepth: number = AUTOMATION_LIMITS.maxChainDepth,
): GuardBlock | null {
  if (event.causedBy === ruleId) return 'SELF';
  if (event.depth >= maxDepth) return 'DEPTH';
  return null;
}

/** Rate breaker, pure: has this rule already run its allowance in the window? */
export function rateExceeded(
  runsInWindow: number,
  max: number = AUTOMATION_LIMITS.maxRunsPerRulePerMinute,
): boolean {
  return runsInWindow >= max;
}

/** `DUE_APPROACHING`: the window of due dates that are "approaching" right now. Already-overdue is not approaching. */
export function dueWindow(
  now: Date,
  offset: { amount: number; unit: 'HOURS' | 'DAYS' },
): { from: Date; to: Date } {
  const ms = offset.amount * (offset.unit === 'HOURS' ? 3_600_000 : 86_400_000);
  return { from: now, to: new Date(now.getTime() + ms) };
}

/** The idempotency key of a due-date firing: a changed due date is a new occurrence, the same one is not. */
export const dueEventId = (taskId: string, dueDate: Date): string =>
  `due:${taskId}:${dueDate.toISOString()}`;

/** The idempotency key of an overdue firing: a changed due date is a new occurrence, the same one is not. */
export const overdueEventId = (taskId: string, dueDate: Date): string =>
  `overdue:${taskId}:${dueDate.toISOString()}`;

/**
 * TASK_OVERDUE, pure: due dates that count as "overdue by afterHours" right now. Bounded below, so a
 * rule created today does not fire for every old late task in the workspace.
 */
export function overdueWindow(
  now: Date,
  afterHours: number,
  lookbackDays: number = AUTOMATION_LIMITS.overdueLookbackDays,
): { from: Date; to: Date } {
  const to = new Date(now.getTime() - afterHours * 3_600_000);
  return { from: new Date(to.getTime() - lookbackDays * 86_400_000), to };
}

export const scheduleEventId = (slot: Date): string =>
  `sched:${slot.toISOString()}`;

/**
 * SCHEDULE, pure (UTC, ISO weekdays 1 = Monday). The latest slot that is due and not older than the
 * catch-up window, or null. A slot is the top of an hour; the sweep runs every few minutes, so a slot
 * is picked up shortly after it passes, and one missed while the worker was down still runs if recent.
 */
export function latestScheduleSlot(
  trigger: Extract<Trigger, { type: 'SCHEDULE' }>,
  now: Date,
  catchUpHours: number = AUTOMATION_LIMITS.scheduleCatchUpHours,
): Date | null {
  const top = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    now.getUTCHours(),
  );
  for (let back = 0; back < catchUpHours; back++) {
    const slot = new Date(top - back * 3_600_000);
    if (slot.getUTCHours() !== trigger.hour) continue;
    const weekday = slot.getUTCDay() === 0 ? 7 : slot.getUTCDay();
    const dayOk =
      trigger.frequency === 'DAILY' ||
      (trigger.frequency === 'WEEKLY' &&
        (trigger.weekdays ?? []).includes(weekday)) ||
      (trigger.frequency === 'MONTHLY' &&
        slot.getUTCDate() === trigger.dayOfMonth);
    if (dayOk) return slot;
  }
  return null;
}
