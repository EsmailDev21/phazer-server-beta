import { ConflictException } from '@nestjs/common';
import { TaskStatus } from '@prisma/client';
import {
  LoadNode,
  MAX_BURNDOWN_DAYS,
  SPRINT_ALREADY_ACTIVE,
  addDays,
  assertNoOtherActiveSprint,
  buildBurndown,
  capacityLoad,
  classifyScopeChanges,
  commitmentFrom,
  daysBetween,
  idealRemaining,
  isWeekday,
  snapshotValues,
  weekdaysAfter,
} from './sprint-rules';

const measureOf = (o: Partial<Record<string, number>> = {}) => ({
  totalCount: 6,
  totalPoints: 18,
  completedCount: 2,
  completedPoints: 5,
  unestimatedTotal: 1,
  unestimatedCompleted: 0,
  ...o,
});

describe('one active sprint per scope (ADR-0044 d.2)', () => {
  it('allows the start when nothing else is active', () => {
    expect(() => assertNoOtherActiveSprint([])).not.toThrow();
  });

  it('is a 409 naming the active sprint', () => {
    try {
      assertNoOtherActiveSprint([{ id: 's1', name: 'Sprint 13' }]);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ConflictException);
      const body = (e as ConflictException).getResponse() as Record<
        string,
        unknown
      >;
      expect(body.code).toBe(SPRINT_ALREADY_ACTIVE);
      expect(body.details).toEqual({ activeIterationId: 's1' });
      expect(String(body.message)).toContain('Sprint 13');
    }
  });
});

describe('snapshot and commitment values', () => {
  it('remaining = total - completed, rounded', () => {
    expect(
      snapshotValues(measureOf({ totalPoints: 18.005, completedPoints: 5 })),
    ).toEqual({
      totalPoints: 18.01,
      totalCount: 6,
      remainingPoints: 13.01,
      remainingCount: 4,
    });
  });

  it('never goes below zero', () => {
    expect(
      snapshotValues(
        measureOf({
          totalPoints: 3,
          completedPoints: 3.0000001,
          completedCount: 6,
        }),
      ),
    ).toMatchObject({ remainingPoints: 0, remainingCount: 0 });
  });

  it('a commitment keeps what the sprint held at the start', () => {
    const at = new Date('2026-11-02T09:00:00.000Z');
    expect(commitmentFrom(measureOf(), at)).toEqual({
      at: '2026-11-02T09:00:00.000Z',
      committedPoints: 18,
      committedCount: 6,
      unestimated: 1,
    });
  });
});

describe('date helpers', () => {
  it('adds days and counts the distance', () => {
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
    expect(daysBetween('2026-11-02', '2026-11-13')).toBe(11);
  });

  it('knows weekends', () => {
    expect(isWeekday('2026-11-06')).toBe(true); // Friday
    expect(isWeekday('2026-11-07')).toBe(false); // Saturday
    expect(isWeekday('2026-11-08')).toBe(false); // Sunday
  });

  it('counts weekdays after the start, up to and including the day', () => {
    expect(weekdaysAfter('2026-11-02', '2026-11-13')).toBe(9);
    expect(weekdaysAfter('2026-11-02', '2026-11-02')).toBe(0);
  });
});

describe('ideal line', () => {
  // Mon 2 Nov -> Fri 13 Nov 2026: 9 working days after the start.
  const S = '2026-11-02';
  const E = '2026-11-13';

  it('starts at the commitment and ends at zero', () => {
    expect(idealRemaining(18, S, E, S)).toBe(18);
    expect(idealRemaining(18, S, E, E)).toBe(0);
    expect(idealRemaining(18, S, E, '2026-12-01')).toBe(0);
    expect(idealRemaining(18, S, E, '2026-10-01')).toBe(18);
  });

  it('burns on working days and stays flat over the weekend', () => {
    expect(idealRemaining(18, S, E, '2026-11-06')).toBe(10); // 4 of 9 days gone
    expect(idealRemaining(18, S, E, '2026-11-07')).toBe(10);
    expect(idealRemaining(18, S, E, '2026-11-08')).toBe(10);
    expect(idealRemaining(18, S, E, '2026-11-09')).toBe(8);
  });

  it('a sprint with no working days keeps the commitment until the end', () => {
    expect(idealRemaining(10, '2026-11-07', '2026-11-08', '2026-11-07')).toBe(
      10,
    );
    expect(idealRemaining(10, '2026-11-07', '2026-11-08', '2026-11-08')).toBe(
      0,
    );
  });
});

describe('burndown series', () => {
  const commitment = {
    at: '2026-11-02T09:00:00.000Z',
    committedPoints: 18,
    committedCount: 6,
    unestimated: 0,
  };
  const row = (day: string, total: number, remaining: number) => ({
    day,
    totalPoints: total,
    totalCount: 6,
    remainingPoints: remaining,
    remainingCount: 3,
  });

  it('lists every day of the sprint, with gaps where there is no snapshot', () => {
    const r = buildBurndown({
      startDate: '2026-11-02',
      endDate: '2026-11-06',
      commitment,
      snapshots: [row('2026-11-02', 18, 18), row('2026-11-04', 18, 12)],
      live: null,
    });
    expect(r.days.map((d) => d.day)).toEqual([
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
      '2026-11-05',
      '2026-11-06',
    ]);
    expect(r.days.map((d) => d.remainingPoints)).toEqual([
      18,
      null,
      12,
      null,
      null,
    ]);
    expect(r.days[0].ideal).toBe(18);
    expect(r.days[4].ideal).toBe(0);
  });

  it("today's live numbers override today's stored row", () => {
    const r = buildBurndown({
      startDate: '2026-11-02',
      endDate: '2026-11-04',
      commitment,
      snapshots: [row('2026-11-03', 18, 15)],
      live: row('2026-11-03', 21, 14),
    });
    expect(r.days[1]).toMatchObject({ remainingPoints: 14, totalPoints: 21 });
    expect(r.scope).toEqual({
      committedPoints: 18,
      totalPoints: 21,
      addedPoints: 3,
    });
  });

  it('reports no scope before the sprint has started', () => {
    const r = buildBurndown({
      startDate: '2026-11-02',
      endDate: '2026-11-04',
      commitment: null,
      snapshots: [],
      live: null,
    });
    expect(r.scope).toBeNull();
    expect(
      r.days.every((d) => d.ideal === null && d.remainingPoints === null),
    ).toBe(true);
  });

  it('draws a snapshot that falls outside the planned dates (a sprint that ran over)', () => {
    const r = buildBurndown({
      startDate: '2026-11-02',
      endDate: '2026-11-03',
      commitment,
      snapshots: [row('2026-11-05', 18, 4)],
      live: null,
    });
    expect(r.days.map((d) => d.day)).toEqual([
      '2026-11-02',
      '2026-11-03',
      '2026-11-05',
    ]);
  });

  it('without dates, or with a very long span, only the days that have data are drawn', () => {
    const none = buildBurndown({
      startDate: null,
      endDate: null,
      commitment,
      snapshots: [row('2026-11-03', 18, 15), row('2026-11-02', 18, 18)],
      live: null,
    });
    expect(none.days.map((d) => d.day)).toEqual(['2026-11-02', '2026-11-03']);
    expect(none.days[0].ideal).toBeNull();

    const long = buildBurndown({
      startDate: '2026-01-01',
      endDate: addDays('2026-01-01', MAX_BURNDOWN_DAYS + 5),
      commitment,
      snapshots: [row('2026-01-03', 18, 15)],
      live: null,
    });
    expect(long.days).toHaveLength(1);
  });

  it('scope never reports a negative addition', () => {
    const r = buildBurndown({
      startDate: '2026-11-02',
      endDate: '2026-11-04',
      commitment,
      snapshots: [row('2026-11-03', 12, 9)],
      live: null,
    });
    expect(r.scope).toEqual({
      committedPoints: 18,
      totalPoints: 12,
      addedPoints: 0,
    });
  });
});

describe('capacity load', () => {
  const leaf = (
    id: string,
    estimate: number | null,
    assigneeIds: string[],
    extra: Partial<LoadNode> = {},
  ): LoadNode => ({
    id,
    parentId: null,
    status: TaskStatus.TODO,
    isArchived: false,
    estimate,
    assigneeIds,
    ...extra,
  });

  it('adds up each person and flags the overloaded', () => {
    const r = capacityLoad({ ana: 10, ben: 10 }, [
      leaf('a', 5, ['ana']),
      leaf('b', 3, ['ana']),
      leaf('c', 8, ['ben']),
      leaf('d', 5, ['ben']),
    ]);
    const ben = r.rows.find((x) => x.userId === 'ben')!;
    expect(ben).toMatchObject({ assignedPoints: 13, over: true, overBy: 3 });
    expect(r.rows.find((x) => x.userId === 'ana')).toMatchObject({
      assignedPoints: 8,
      over: false,
    });
    expect(r.rows[0].userId).toBe('ben'); // heaviest first
  });

  it('splits a shared task equally and counts it once for each person', () => {
    const r = capacityLoad({}, [leaf('a', 5, ['ana', 'ben'])]);
    expect(
      r.rows.map((x) => [x.userId, x.assignedPoints, x.assignedCount]),
    ).toEqual([
      ['ana', 2.5, 1],
      ['ben', 2.5, 1],
    ]);
  });

  it('reports unassigned and unestimated work separately', () => {
    const r = capacityLoad({ ana: 4 }, [
      leaf('a', null, ['ana']),
      leaf('b', 3, []),
      leaf('c', null, []),
    ]);
    expect(r.rows[0]).toMatchObject({
      userId: 'ana',
      assignedPoints: 0,
      unestimated: 1,
    });
    expect(r.unassigned).toEqual({ points: 3, count: 2, unestimated: 1 });
  });

  it('lists a person with capacity and no work, and one with work and no capacity', () => {
    const r = capacityLoad({ idle: 8 }, [leaf('a', 2, ['busy'])]);
    expect(r.rows.find((x) => x.userId === 'idle')).toMatchObject({
      capacity: 8,
      assignedPoints: 0,
      over: false,
    });
    expect(r.rows.find((x) => x.userId === 'busy')).toMatchObject({
      capacity: null,
      over: false,
      overBy: 0,
    });
  });

  it('counts only leaves: a parent and its subtasks are never both loaded on someone', () => {
    const r = capacityLoad({}, [
      leaf('p', 10, ['ana']),
      leaf('c1', 2, ['ben'], { parentId: 'p' }),
      leaf('c2', 3, ['ben'], { parentId: 'p' }),
    ]);
    expect(r.rows.map((x) => [x.userId, x.assignedPoints])).toEqual([
      ['ben', 5],
    ]);
  });

  it('ignores archived and excluded (canceled) tasks', () => {
    const r = capacityLoad({}, [
      leaf('a', 5, ['ana'], { isArchived: true }),
      leaf('b', 5, ['ana'], { excludeFromProgress: true }),
    ]);
    expect(r.rows).toEqual([]);
  });
});

describe('scope changes', () => {
  const at = (s: string) => new Date(s);
  const ch = (
    taskId: string,
    when: string,
    from: string | null,
    to: string | null,
  ) => ({
    taskId,
    at: at(when),
    from,
    to,
    actorId: 'u1',
  });

  it('reports adds and removes after the start, oldest first', () => {
    const r = classifyScopeChanges(
      'it1',
      [
        ch('t2', '2026-11-04T10:00:00Z', 'it1', null),
        ch('t1', '2026-11-03T10:00:00Z', null, 'it1'),
      ],
      '2026-11-02T09:00:00Z',
    );
    expect(r.map((x) => [x.taskId, x.kind])).toEqual([
      ['t1', 'ADDED'],
      ['t2', 'REMOVED'],
    ]);
  });

  it('planning before the start is not a scope change', () => {
    expect(
      classifyScopeChanges(
        'it1',
        [ch('t1', '2026-10-30T10:00:00Z', null, 'it1')],
        '2026-11-02T09:00:00Z',
      ),
    ).toEqual([]);
  });

  it('a sprint that never started has no scope changes', () => {
    expect(
      classifyScopeChanges(
        'it1',
        [ch('t1', '2026-11-03T10:00:00Z', null, 'it1')],
        null,
      ),
    ).toEqual([]);
  });

  it('a move between two other sprints, or from this one to itself, is not ours', () => {
    expect(
      classifyScopeChanges(
        'it1',
        [
          ch('t1', '2026-11-03T10:00:00Z', 'other', 'another'),
          ch('t2', '2026-11-03T11:00:00Z', 'it1', 'it1'),
        ],
        '2026-11-02T09:00:00Z',
      ),
    ).toEqual([]);
  });

  it('moving a task from one sprint straight into this one is an add', () => {
    const r = classifyScopeChanges(
      'it1',
      [ch('t1', '2026-11-03T10:00:00Z', 'other', 'it1')],
      '2026-11-02T09:00:00Z',
    );
    expect(r).toHaveLength(1);
    expect(r[0].kind).toBe('ADDED');
  });
});
