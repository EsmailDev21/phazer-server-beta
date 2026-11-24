import { ConflictException } from '@nestjs/common';
import { countedLeaves } from '../tasks/task-tree';
import { Measure, MetricNode, round2 } from './iteration-metrics';

/**
 * ADR-0044. The pure rules of sprint tracking: the one-active rule, what a snapshot and a
 * commitment hold, the ideal line and the burndown series, per-person load, and which task
 * moves count as scope changes. No database, so each rule is unit-tested directly.
 * Days are 'YYYY-MM-DD' strings (UTC calendar days), never Date objects, so no time zone
 * can move a point to the neighbouring day.
 */

export const SPRINT_ALREADY_ACTIVE = 'SPRINT_ALREADY_ACTIVE';
/** A sprint longer than this is not drawn day by day (only the days that have a snapshot). */
export const MAX_BURNDOWN_DAYS = 120;

// ------------------------------------------------------------------ one active

export function assertNoOtherActiveSprint(
  others: Array<{ id: string; name: string }>,
): void {
  if (others.length === 0) return;
  throw new ConflictException({
    message: `"${others[0].name}" is already the active sprint here: close it first`,
    code: SPRINT_ALREADY_ACTIVE,
    details: { activeIterationId: others[0].id },
  });
}

// ------------------------------------------------------------------- snapshots

export interface SnapshotValues {
  totalPoints: number;
  totalCount: number;
  remainingPoints: number;
  remainingCount: number;
}

/** Leaf-only numbers (ADR-0008) -> what one daily row holds. */
export function snapshotValues(m: Measure): SnapshotValues {
  return {
    totalPoints: round2(m.totalPoints),
    totalCount: m.totalCount,
    remainingPoints: round2(Math.max(0, m.totalPoints - m.completedPoints)),
    remainingCount: Math.max(0, m.totalCount - m.completedCount),
  };
}

export interface Commitment {
  /** ISO timestamp of the start. */
  at: string;
  committedPoints: number;
  committedCount: number;
  /** Leaves in the commitment that had no estimate (they add 0 points). */
  unestimated: number;
}

export function commitmentFrom(m: Measure, at: Date): Commitment {
  return {
    at: at.toISOString(),
    committedPoints: round2(m.totalPoints),
    committedCount: m.totalCount,
    unestimated: m.unestimatedTotal,
  };
}

// ----------------------------------------------------------------- date helpers

const DAY_MS = 86_400_000;
const toMs = (day: string) => Date.parse(`${day}T00:00:00.000Z`);
const fromMs = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function addDays(day: string, n: number): string {
  return fromMs(toMs(day) + n * DAY_MS);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((toMs(to) - toMs(from)) / DAY_MS);
}

export function isWeekday(day: string): boolean {
  const w = new Date(toMs(day)).getUTCDay();
  return w !== 0 && w !== 6;
}

/** Weekdays in (from, through]: the days of work that happen after `from` up to and including `through`. */
export function weekdaysAfter(from: string, through: string): number {
  let n = 0;
  for (let d = addDays(from, 1); d <= through; d = addDays(d, 1)) {
    if (isWeekday(d)) n += 1;
  }
  return n;
}

/**
 * Where the remaining points should be on `day` if the sprint burns evenly over its working
 * days (Mon-Fri): the full commitment on the start day, 0 on the end day, flat over weekends.
 */
export function idealRemaining(
  committed: number,
  start: string,
  end: string,
  day: string,
): number {
  if (day <= start) return round2(committed);
  if (day >= end) return 0;
  const total = weekdaysAfter(start, end);
  if (total === 0) return round2(committed);
  const elapsed = weekdaysAfter(start, day);
  return round2(committed * (1 - elapsed / total));
}

// -------------------------------------------------------------------- burndown

export interface SnapshotRow extends SnapshotValues {
  day: string;
}

export interface BurndownDay {
  day: string;
  /** null without a commitment or without both dates. */
  ideal: number | null;
  /** null for a day with no snapshot (the future, or a missed run). */
  remainingPoints: number | null;
  remainingCount: number | null;
  totalPoints: number | null;
}

export interface BurndownInput {
  startDate: string | null;
  endDate: string | null;
  commitment: Commitment | null;
  snapshots: SnapshotRow[];
  /** Today's numbers measured now (ACTIVE only); overrides today's stored row. */
  live: SnapshotRow | null;
}

export interface BurndownResult {
  days: BurndownDay[];
  /** Committed vs now. null until the sprint has started. */
  scope: {
    committedPoints: number;
    totalPoints: number;
    addedPoints: number;
  } | null;
}

export function buildBurndown(input: BurndownInput): BurndownResult {
  const byDay = new Map<string, SnapshotRow>();
  for (const s of input.snapshots) byDay.set(s.day, s);
  if (input.live) byDay.set(input.live.day, input.live);

  const { startDate, endDate, commitment } = input;
  const span =
    startDate && endDate && endDate >= startDate
      ? daysBetween(startDate, endDate) + 1
      : null;
  let dayList: string[];
  if (startDate && endDate && span !== null && span <= MAX_BURNDOWN_DAYS) {
    dayList = [];
    for (let i = 0; i < span; i += 1) dayList.push(addDays(startDate, i));
    // A snapshot outside the planned dates (a sprint that ran over) is still drawn.
    for (const d of byDay.keys()) if (!dayList.includes(d)) dayList.push(d);
    dayList.sort();
  } else {
    dayList = [...byDay.keys()].sort();
  }

  const days: BurndownDay[] = dayList.map((day) => {
    const row = byDay.get(day);
    return {
      day,
      ideal:
        commitment && startDate && endDate
          ? idealRemaining(commitment.committedPoints, startDate, endDate, day)
          : null,
      remainingPoints: row ? row.remainingPoints : null,
      remainingCount: row ? row.remainingCount : null,
      totalPoints: row ? row.totalPoints : null,
    };
  });

  const latest =
    input.live ??
    [...input.snapshots].sort((a, b) => a.day.localeCompare(b.day)).pop() ??
    null;
  const scope =
    commitment && latest
      ? {
          committedPoints: commitment.committedPoints,
          totalPoints: latest.totalPoints,
          addedPoints: round2(
            Math.max(0, latest.totalPoints - commitment.committedPoints),
          ),
        }
      : null;
  return { days, scope };
}

// ------------------------------------------------------------------------ load

export interface LoadNode extends MetricNode {
  assigneeIds: string[];
}

export interface LoadRow {
  userId: string;
  /** null = no capacity set for this person. */
  capacity: number | null;
  assignedPoints: number;
  assignedCount: number;
  /** Their tasks with no estimate (0 points each). */
  unestimated: number;
  over: boolean;
  overBy: number;
}

export interface LoadResult {
  rows: LoadRow[];
  unassigned: { points: number; count: number; unestimated: number };
}

/**
 * How loaded each person is, over the sprint's whole scope (leaf tasks only, ADR-0008). A task
 * with several assignees splits its points equally between them (and counts as one task for each).
 * Everyone with a capacity is listed, assigned or not; so is everyone assigned, capacity or not.
 */
export function capacityLoad(
  capacity: Record<string, number> | undefined,
  nodes: LoadNode[],
): LoadResult {
  const acc = new Map<
    string,
    { points: number; count: number; unestimated: number }
  >();
  const bucket = (id: string) => {
    let b = acc.get(id);
    if (!b) {
      b = { points: 0, count: 0, unestimated: 0 };
      acc.set(id, b);
    }
    return b;
  };
  const unassigned = { points: 0, count: 0, unestimated: 0 };

  for (const leaf of countedLeaves(nodes)) {
    const points = leaf.estimate ?? 0;
    const people = [...new Set(leaf.assigneeIds)];
    if (people.length === 0) {
      unassigned.points += points;
      unassigned.count += 1;
      if (leaf.estimate === null) unassigned.unestimated += 1;
      continue;
    }
    for (const id of people) {
      const b = bucket(id);
      b.points += points / people.length;
      b.count += 1;
      if (leaf.estimate === null) b.unestimated += 1;
    }
  }
  for (const id of Object.keys(capacity ?? {})) bucket(id);

  const rows: LoadRow[] = [...acc.entries()].map(([userId, b]) => {
    const cap = capacity && userId in capacity ? capacity[userId] : null;
    const assigned = round2(b.points);
    const over = cap !== null && assigned > cap;
    return {
      userId,
      capacity: cap,
      assignedPoints: assigned,
      assignedCount: b.count,
      unestimated: b.unestimated,
      over,
      overBy: over && cap !== null ? round2(assigned - cap) : 0,
    };
  });
  rows.sort(
    (a, b) =>
      b.assignedPoints - a.assignedPoints || a.userId.localeCompare(b.userId),
  );
  return {
    rows,
    unassigned: { ...unassigned, points: round2(unassigned.points) },
  };
}

// --------------------------------------------------------------- scope changes

export interface RawChange {
  taskId: string;
  at: Date;
  from: string | null;
  to: string | null;
  actorId: string | null;
}

export interface ScopeChange {
  taskId: string;
  at: string;
  kind: 'ADDED' | 'REMOVED';
  actorId: string | null;
}

/**
 * Task moves into or out of this sprint AFTER it started (before the start it is planning, not
 * a scope change). `since` is the start time; null (never started) means there is nothing to report.
 */
export function classifyScopeChanges(
  iterationId: string,
  changes: RawChange[],
  since: string | null,
): ScopeChange[] {
  if (!since) return [];
  const sinceMs = Date.parse(since);
  const out: ScopeChange[] = [];
  for (const c of changes) {
    if (c.at.getTime() < sinceMs) continue;
    if (c.to === iterationId && c.from !== iterationId) {
      out.push({
        taskId: c.taskId,
        at: c.at.toISOString(),
        kind: 'ADDED',
        actorId: c.actorId,
      });
    } else if (c.from === iterationId && c.to !== iterationId) {
      out.push({
        taskId: c.taskId,
        at: c.at.toISOString(),
        kind: 'REMOVED',
        actorId: c.actorId,
      });
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}
