import { IterationState } from '@prisma/client';
import {
  assertCanBeMoveTarget,
  assertDatesOrdered,
  assertTransition,
  formatDateOnly,
  parseDateOnly,
  planClose,
} from './iteration-rules';

const S = IterationState;

describe('iteration state machine (ADR-0007)', () => {
  it.each([
    [S.PLANNED, S.ACTIVE],
    [S.PLANNED, S.CLOSED],
    [S.ACTIVE, S.CLOSED],
    [S.CLOSED, S.ACTIVE], // reopen
  ])('%s -> %s is allowed', (from, to) => {
    expect(() => assertTransition(from, to)).not.toThrow();
  });

  it.each([
    [S.ACTIVE, S.PLANNED],
    [S.CLOSED, S.PLANNED],
    [S.PLANNED, S.PLANNED],
    [S.ACTIVE, S.ACTIVE],
    [S.CLOSED, S.CLOSED],
  ])('%s -> %s is a 409', (from, to) => {
    expect(() => assertTransition(from, to)).toThrow(/cannot go from/);
  });
});

describe('dates', () => {
  it('parses a real calendar date and round-trips it', () => {
    const d = parseDateOnly('2026-02-28', 'startDate');
    expect(formatDateOnly(d)).toBe('2026-02-28');
    expect(formatDateOnly(null)).toBeNull();
  });

  it.each(['2026-02-30', '2026-13-01', '2026-1-1', 'tomorrow', '2026-03-01T10:00:00Z', ''])(
    'rejects %p',
    (bad) => {
      expect(() => parseDateOnly(bad, 'startDate')).toThrow(/startDate/);
    },
  );

  it('end before start is a 400; equal and open-ended are fine', () => {
    const a = parseDateOnly('2026-03-01', 'a');
    const b = parseDateOnly('2026-03-02', 'b');
    expect(() => assertDatesOrdered(b, a)).toThrow(/before/);
    expect(() => assertDatesOrdered(a, a)).not.toThrow();
    expect(() => assertDatesOrdered(a, null)).not.toThrow();
    expect(() => assertDatesOrdered(undefined, b)).not.toThrow();
  });
});

describe('planClose - unfinished tasks must be decided (decision 1)', () => {
  const base = { sourceId: 'it1' };

  it('nothing unfinished: closes without a decision', () => {
    expect(planClose({ ...base, unfinishedCount: 0 })).toEqual({ kind: 'NONE' });
  });

  it('unfinished tasks and no action: 409 with the count, never a default', () => {
    try {
      planClose({ ...base, unfinishedCount: 3 });
      fail('should throw');
    } catch (e: any) {
      expect(e.getStatus()).toBe(409);
      expect(e.getResponse()).toMatchObject({
        code: 'UNFINISHED_TASKS_DECISION_REQUIRED',
        details: { unfinishedCount: 3 },
      });
    }
  });

  it('LEAVE and BACKLOG need nothing else; MOVE needs a target', () => {
    expect(planClose({ ...base, unfinishedCount: 2, action: 'LEAVE' })).toEqual({ kind: 'LEAVE' });
    expect(planClose({ ...base, unfinishedCount: 2, action: 'BACKLOG' })).toEqual({ kind: 'BACKLOG' });
    expect(planClose({ ...base, unfinishedCount: 2, action: 'MOVE', moveToIterationId: 'it2' })).toEqual({
      kind: 'MOVE',
      targetId: 'it2',
    });
    expect(() => planClose({ ...base, unfinishedCount: 2, action: 'MOVE' })).toThrow(/needs moveToIterationId/);
  });

  it('nonsense combinations are 400 even when nothing is unfinished', () => {
    expect(() => planClose({ ...base, unfinishedCount: 0, action: 'MOVE' })).toThrow(/needs moveToIterationId/);
    expect(() => planClose({ ...base, unfinishedCount: 0, moveToIterationId: 'x' })).toThrow(/only goes with action MOVE/);
    expect(() => planClose({ ...base, unfinishedCount: 1, action: 'LEAVE', moveToIterationId: 'x' })).toThrow(/only goes with/);
    expect(() => planClose({ ...base, unfinishedCount: 1, action: 'MOVE', moveToIterationId: 'it1' })).toThrow(/being closed/);
  });

  it('a closed iteration cannot be a move target', () => {
    expect(() => assertCanBeMoveTarget(S.CLOSED)).toThrow(/closed iteration/);
    expect(() => assertCanBeMoveTarget(S.PLANNED)).not.toThrow();
    expect(() => assertCanBeMoveTarget(S.ACTIVE)).not.toThrow();
  });
});
