import { ConflictException } from '@nestjs/common';
import { IterationState, TaskStatus } from '@prisma/client';
import { addDays, daysBetween } from './sprint-rules';

/**
 * ADR-0046. The pure rules of milestones: when an exit criterion is met, the gate on closing, the
 * health of a milestone, the history of its target date and the release notes. No database, so each
 * rule is unit-tested directly. Days are 'YYYY-MM-DD' strings (UTC), compared as text.
 */

export const CRITERIA_UNMET = 'CRITERIA_UNMET';
export const MAX_CRITERIA_PER_MILESTONE = 50;
export const MAX_CRITERION_TITLE = 200;
/** Within this many days of the target, an open blocker makes a milestone at risk. */
export const BLOCKER_WARNING_DAYS = 7;
/** Projections need this many days of history, or one quiet week looks like a trend. */
export const MIN_DAYS_FOR_PROJECTION = 3;
/** With nothing done by this fraction of the time, a milestone is at risk. */
export const NOTHING_DONE_AFTER = 0.25;

// ------------------------------------------------------------------- criteria

export interface CriterionState {
  /** The task that backs this criterion, if any. */
  taskId: string | null;
  /** Status of that task now. null when there is no task (or it was deleted). */
  taskStatus: TaskStatus | null;
  doneAt: Date | null;
}

/**
 * Met when its task is DONE; a criterion with no task (or whose task was deleted) is met when a person
 * has checked it. A task that exists decides: a stale `doneAt` on a task-backed criterion is ignored.
 */
export function criterionMet(c: CriterionState): boolean {
  if (c.taskId !== null && c.taskStatus !== null)
    return c.taskStatus === TaskStatus.DONE;
  return c.doneAt !== null;
}

export function summarizeCriteria(list: CriterionState[]): {
  total: number;
  met: number;
} {
  return { total: list.length, met: list.filter(criterionMet).length };
}

/** Closing needs every criterion met, unless the milestone says it does not (`requireExitCriteria: false`). */
export function assertExitCriteriaMet(
  summary: { total: number; met: number },
  requireExitCriteria: boolean | undefined,
): void {
  if (requireExitCriteria === false) return;
  const unmet = summary.total - summary.met;
  if (unmet <= 0) return;
  throw new ConflictException({
    message: `${unmet} of ${summary.total} exit criteria are not met yet`,
    code: CRITERIA_UNMET,
    details: { unmet, total: summary.total },
  });
}

// --------------------------------------------------------------------- health

export type HealthStatus =
  'ON_TRACK' | 'AT_RISK' | 'SLIPPED' | 'DONE' | 'NO_DATE';
export type HealthReason =
  'PAST_TARGET' | 'PROJECTED_LATE' | 'NOTHING_DONE' | 'BLOCKED_NEAR_DEADLINE';

export interface HealthInput {
  state: IterationState;
  startDate: string | null;
  /** The target date. */
  endDate: string | null;
  today: string;
  /** Units of work finished and in total (tasks, or criteria when there are no tasks). */
  done: number;
  total: number;
  /** Tasks of the milestone that wait on an unfinished task. */
  blockers: number;
}

export interface Health {
  status: HealthStatus;
  /** When the work would finish at the pace so far. null when there is not enough to say. */
  projectedDate: string | null;
  /** Days to the target; negative once it has passed. null without a target. */
  daysLeft: number | null;
  reasons: HealthReason[];
}

/**
 * Whether a milestone will make its date, from facts only:
 *  - CLOSED is DONE; no target date is NO_DATE;
 *  - the day after the target with work still open is SLIPPED;
 *  - otherwise AT_RISK when the pace so far lands after the target (needs 3 days of history and some
 *    work done), when nothing is done a quarter of the way in, or when something is blocked within
 *    a week of the target;
 *  - otherwise ON_TRACK. Work that is all finished is never at risk.
 */
export function milestoneHealth(i: HealthInput): Health {
  if (i.state === IterationState.CLOSED) {
    return { status: 'DONE', projectedDate: null, daysLeft: null, reasons: [] };
  }
  if (!i.endDate)
    return {
      status: 'NO_DATE',
      projectedDate: null,
      daysLeft: null,
      reasons: [],
    };

  const daysLeft = daysBetween(i.today, i.endDate);
  const remaining = Math.max(0, i.total - i.done);
  if (i.today > i.endDate) {
    return {
      status: 'SLIPPED',
      projectedDate: null,
      daysLeft,
      reasons: ['PAST_TARGET'],
    };
  }
  if (i.total > 0 && remaining === 0) {
    return {
      status: 'ON_TRACK',
      projectedDate: i.today,
      daysLeft,
      reasons: [],
    };
  }

  const reasons: HealthReason[] = [];
  let projectedDate: string | null = null;
  const elapsed = i.startDate ? daysBetween(i.startDate, i.today) : null;

  if (elapsed !== null && elapsed >= MIN_DAYS_FOR_PROJECTION && i.done > 0) {
    const perDay = i.done / elapsed;
    projectedDate = addDays(i.today, Math.ceil(remaining / perDay));
    if (projectedDate > i.endDate) reasons.push('PROJECTED_LATE');
  }
  if (i.total > 0 && i.done === 0 && i.startDate && elapsed !== null) {
    const span = Math.max(1, daysBetween(i.startDate, i.endDate));
    if (elapsed / span >= NOTHING_DONE_AFTER) reasons.push('NOTHING_DONE');
  }
  if (i.blockers > 0 && daysLeft <= BLOCKER_WARNING_DAYS)
    reasons.push('BLOCKED_NEAR_DEADLINE');

  return {
    status: reasons.length > 0 ? 'AT_RISK' : 'ON_TRACK',
    projectedDate,
    daysLeft,
    reasons,
  };
}

// ---------------------------------------------------------------- target dates

export interface TargetChange {
  previous: string | null;
  next: string | null;
  at: string;
  byId: string | null;
}

/**
 * A change to record: only when the target was set before and is now different. The first time a
 * date is chosen is planning, not a slip.
 */
export function targetChangeToRecord(
  previous: string | null,
  next: string | null,
): { previous: string | null; next: string | null } | null {
  if (previous === null || previous === next) return null;
  return { previous, next };
}

export interface SlipSummary {
  /** Times the date moved later. */
  count: number;
  /** Days it moved later in total (earlier moves do not subtract). */
  totalDays: number;
  /** The date first promised, or the current one if it never moved. */
  originalTarget: string | null;
}

export function slipSummary(
  changes: TargetChange[],
  currentTarget: string | null,
): SlipSummary {
  const ordered = [...changes].sort((a, b) => a.at.localeCompare(b.at));
  let count = 0;
  let totalDays = 0;
  for (const c of ordered) {
    if (c.previous && c.next && c.next > c.previous) {
      count += 1;
      totalDays += daysBetween(c.previous, c.next);
    }
  }
  return {
    count,
    totalDays,
    originalTarget: ordered[0]?.previous ?? currentTarget,
  };
}

// --------------------------------------------------------------- release notes

export interface ReleaseNoteTask {
  number: number;
  title: string;
}
export interface ReleaseNotePr {
  title: string;
  url: string;
}

/** Markdown for a changelog: what was finished and which pull requests were merged for it. */
export function buildReleaseNotes(input: {
  name: string;
  targetDate: string | null;
  tasks: ReleaseNoteTask[];
  prs: ReleaseNotePr[];
}): string {
  const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
  const lines = [`# ${clean(input.name)}`];
  if (input.targetDate) lines.push('', `Target: ${input.targetDate}`);
  lines.push('', '## Done');
  if (input.tasks.length === 0) lines.push('', '_Nothing finished yet._');
  else {
    lines.push('');
    for (const t of [...input.tasks].sort((a, b) => a.number - b.number)) {
      lines.push(`- #${t.number} ${clean(t.title)}`);
    }
  }
  if (input.prs.length > 0) {
    lines.push('', '## Merged pull requests', '');
    for (const p of input.prs) lines.push(`- [${clean(p.title)}](${p.url})`);
  }
  return `${lines.join('\n')}\n`;
}
