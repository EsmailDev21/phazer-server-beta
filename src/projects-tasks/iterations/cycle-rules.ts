import { IterationState } from '@prisma/client';
import { CycleConfig } from './iteration-kinds';
import { addDays } from './sprint-rules';

/**
 * ADR-0045. The pure rules of cycles that repeat: when the next one is created, what dates and
 * name it gets, when a finished one closes itself, and which cycles the ring around the current
 * one shows. No database, so each rule is unit-tested directly. Days are 'YYYY-MM-DD' strings
 * (UTC), compared as text.
 */

export const MAX_NAME_LENGTH = 200;
/** Cycles shown before and after the current one in the ring. */
export const RING_BEFORE = 3;
export const RING_AFTER = 2;

export interface CycleView {
  state: IterationState;
  startDate: string | null;
  endDate: string | null;
  config: CycleConfig | null;
}

// --------------------------------------------------------------------- dates

/**
 * The next cycle starts the day after this one ends, plus the cooldown, and lasts whole weeks
 * (7 x weeks days, both ends included). Weekends are not special: a cycle is calendar time.
 */
export function nextCycleDates(
  previousEnd: string,
  cadenceWeeks: number,
  cooldownDays: number,
): { startDate: string; endDate: string } {
  const startDate = addDays(previousEnd, 1 + cooldownDays);
  return { startDate, endDate: addDays(startDate, cadenceWeeks * 7 - 1) };
}

// --------------------------------------------------------------------- names

const key = (s: string) => s.trim().toLowerCase();

/**
 * "Cycle 12" -> "Cycle 13"; a name without a trailing number gets " 2". Skips any name already
 * taken in the same scope (case-insensitive), so two cycles never share a name by accident.
 * A name that ends in a year ("Q4-2026") simply counts up the year: rename it once and the
 * chain follows.
 */
export function nextCycleName(name: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map(key));
  const trimmed = name.trim();
  const m = /^(.*?)(\d+)\s*$/.exec(trimmed);
  const base = m ? (m[1] ?? '') : `${trimmed} `;
  let n = m ? Number(m[2]) + 1 : 2;
  for (let i = 0; i < 1000; i += 1, n += 1) {
    const suffix = String(n);
    const candidate = `${base.slice(0, Math.max(0, MAX_NAME_LENGTH - suffix.length))}${suffix}`;
    if (!used.has(key(candidate))) return candidate;
  }
  return `${base.slice(0, Math.max(0, MAX_NAME_LENGTH - 8))}${Date.now()}`;
}

// ------------------------------------------------------------- what to do now

/**
 * An ACTIVE cycle that wants a successor and has none: create it ahead of time, so the ring can
 * show what comes next and tasks can already be planned into it.
 */
export function shouldCreateNext(c: CycleView, hasSuccessor: boolean): boolean {
  return (
    c.state === IterationState.ACTIVE &&
    c.config?.autoCreateNext === true &&
    c.config.cadenceWeeks !== undefined &&
    c.endDate !== null &&
    !hasSuccessor
  );
}

/**
 * An ACTIVE cycle whose last day has passed, that closes itself, and whose unfinished tasks move to
 * the cycle after it. Needs that successor (never guesses a place to put work) and an open one.
 */
export function shouldRollover(
  c: CycleView,
  today: string,
  successor: { state: IterationState } | null,
): boolean {
  return (
    c.state === IterationState.ACTIVE &&
    c.config?.autoRollover === true &&
    c.endDate !== null &&
    c.endDate < today &&
    successor !== null &&
    successor.state !== IterationState.CLOSED
  );
}

/**
 * A planned cycle of an automated chain starts itself when its first day comes, if nothing else in
 * its scope is running (so a cooldown ends by itself) and it is not already over.
 */
export function shouldAutoStart(
  c: CycleView,
  today: string,
  activeInScope: boolean,
): boolean {
  return (
    c.state === IterationState.PLANNED &&
    c.config?.autoCreateNext === true &&
    c.startDate !== null &&
    c.startDate <= today &&
    c.endDate !== null &&
    c.endDate >= today &&
    !activeInScope
  );
}

// ---------------------------------------------------------------------- ring

export interface Orderable {
  id: string;
  startDate: string | null;
  createdAt: Date;
}

/** Oldest first by start date; undated ones go last, by creation. */
export function orderCycles<T extends Orderable>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    if (a.startDate && b.startDate && a.startDate !== b.startDate) {
      return a.startDate < b.startDate ? -1 : 1;
    }
    if (a.startDate && !b.startDate) return -1;
    if (!a.startDate && b.startDate) return 1;
    return (
      a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id)
    );
  });
}

/** The current cycle with up to `before` before it and `after` after it. [] when it is not in the list. */
export function ringWindow<T extends { id: string }>(
  ordered: T[],
  currentId: string,
  before: number = RING_BEFORE,
  after: number = RING_AFTER,
): T[] {
  const idx = ordered.findIndex((x) => x.id === currentId);
  if (idx === -1) return [];
  return ordered.slice(Math.max(0, idx - before), idx + after + 1);
}

export function completionPct(done: number, total: number): number {
  return total > 0 ? Math.round((done / total) * 100) : 0;
}
