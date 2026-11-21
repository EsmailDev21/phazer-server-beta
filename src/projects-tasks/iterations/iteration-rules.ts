import {
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { IterationState } from '@prisma/client';

/**
 * ADR-0007. The pure rules of iterations: state machine, dates, and what closing
 * must be told about tasks that are not finished. No database, so each rule is
 * unit-tested directly; IterationsService loads rows and persists the outcome.
 */

export const MAX_ISSUE_TYPES_PER_WORKSPACE = 50;
export const MAX_ITERATIONS_PER_WORKSPACE = 1000;

export const ITERATION_CLOSED = 'ITERATION_CLOSED';
export const UNFINISHED_DECISION_REQUIRED = 'UNFINISHED_TASKS_DECISION_REQUIRED';

/** What closing does with tasks that are not Done (decision: asked each time). */
export type UnfinishedAction = 'LEAVE' | 'MOVE' | 'BACKLOG';

const TRANSITIONS: Record<IterationState, IterationState[]> = {
  PLANNED: ['ACTIVE', 'CLOSED'], // CLOSED straight from PLANNED = skipped / cancelled
  ACTIVE: ['CLOSED'],
  CLOSED: ['ACTIVE'], // reopen
};

export function assertTransition(
  from: IterationState,
  to: IterationState,
): void {
  if (!TRANSITIONS[from].includes(to)) {
    throw new ConflictException(
      `An iteration cannot go from ${from} to ${to}`,
    );
  }
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** 'YYYY-MM-DD' (a real calendar date) -> Date at UTC midnight. */
export function parseDateOnly(value: string, field: string): Date {
  if (!DATE_ONLY.test(value)) {
    throw new BadRequestException(`${field} must be a date like 2026-03-31`);
  }
  const d = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) {
    throw new BadRequestException(`${field} is not a real calendar date`);
  }
  return d;
}

export function formatDateOnly(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

export function assertDatesOrdered(
  start: Date | null | undefined,
  end: Date | null | undefined,
): void {
  if (start && end && end.getTime() < start.getTime()) {
    throw new BadRequestException('endDate must not be before startDate');
  }
}

export interface ClosePlanInput {
  unfinishedCount: number;
  action?: UnfinishedAction;
  moveToIterationId?: string;
  sourceId: string;
}

export type ClosePlan =
  | { kind: 'NONE' } // nothing unfinished: just close
  | { kind: 'LEAVE' }
  | { kind: 'BACKLOG' }
  | { kind: 'MOVE'; targetId: string };

/**
 * The close decision. With unfinished tasks the caller MUST choose; there is no
 * default (decision 1). `action`/`moveToIterationId` that make no sense are 400s
 * even when nothing is unfinished, so a client bug is not hidden by an empty sprint.
 */
export function planClose(input: ClosePlanInput): ClosePlan {
  const { unfinishedCount, action, moveToIterationId, sourceId } = input;
  if (action === 'MOVE') {
    if (!moveToIterationId) {
      throw new BadRequestException('action MOVE needs moveToIterationId');
    }
    if (moveToIterationId === sourceId) {
      throw new BadRequestException('Cannot move tasks into the iteration being closed');
    }
  } else if (moveToIterationId) {
    throw new BadRequestException('moveToIterationId only goes with action MOVE');
  }
  if (unfinishedCount === 0) return { kind: 'NONE' };
  if (!action) {
    throw new ConflictException({
      message: `${unfinishedCount} task(s) are not done: choose what happens to them (action LEAVE, MOVE or BACKLOG)`,
      code: UNFINISHED_DECISION_REQUIRED,
      details: { unfinishedCount },
    });
  }
  if (action === 'MOVE') return { kind: 'MOVE', targetId: moveToIterationId! };
  return { kind: action };
}

export function assertCanBeMoveTarget(state: IterationState): void {
  if (state === IterationState.CLOSED) {
    throw new ConflictException({
      message: 'Cannot move tasks into a closed iteration',
      code: ITERATION_CLOSED,
    });
  }
}
