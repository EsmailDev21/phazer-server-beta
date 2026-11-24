import { ConflictException } from '@nestjs/common';
import { IterationState, TaskStatus } from '@prisma/client';
import {
  CRITERIA_UNMET,
  CriterionState,
  HealthInput,
  assertExitCriteriaMet,
  buildReleaseNotes,
  criterionMet,
  milestoneHealth,
  slipSummary,
  summarizeCriteria,
  targetChangeToRecord,
} from './milestone-rules';

const S = IterationState;
const T = TaskStatus;
const NOW = new Date('2026-11-03T10:00:00Z');

const crit = (over: Partial<CriterionState> = {}): CriterionState => ({
  taskId: null,
  taskStatus: null,
  doneAt: null,
  ...over,
});

describe('criterion met', () => {
  it('a plain criterion is met when a person checked it', () => {
    expect(criterionMet(crit())).toBe(false);
    expect(criterionMet(crit({ doneAt: NOW }))).toBe(true);
  });

  it('a task-backed criterion follows its task, whatever doneAt says', () => {
    expect(criterionMet(crit({ taskId: 't1', taskStatus: T.DONE }))).toBe(true);
    expect(
      criterionMet(crit({ taskId: 't1', taskStatus: T.IN_PROGRESS })),
    ).toBe(false);
    expect(
      criterionMet(crit({ taskId: 't1', taskStatus: T.TODO, doneAt: NOW })),
    ).toBe(false);
    expect(
      criterionMet(crit({ taskId: 't1', taskStatus: T.DONE, doneAt: null })),
    ).toBe(true);
  });

  it('when the task was deleted the criterion falls back to a person checking it', () => {
    expect(criterionMet(crit({ taskId: null, taskStatus: null }))).toBe(false);
    expect(
      criterionMet(crit({ taskId: null, taskStatus: null, doneAt: NOW })),
    ).toBe(true);
  });

  it('counts the met ones', () => {
    expect(
      summarizeCriteria([
        crit({ doneAt: NOW }),
        crit(),
        crit({ taskId: 't', taskStatus: T.DONE }),
      ]),
    ).toEqual({ total: 3, met: 2 });
    expect(summarizeCriteria([])).toEqual({ total: 0, met: 0 });
  });
});

describe('the closing gate', () => {
  it('lets a milestone with every criterion met close', () => {
    expect(() =>
      assertExitCriteriaMet({ total: 3, met: 3 }, true),
    ).not.toThrow();
    expect(() =>
      assertExitCriteriaMet({ total: 3, met: 3 }, undefined),
    ).not.toThrow();
  });

  it('lets a milestone with no criteria close', () => {
    expect(() =>
      assertExitCriteriaMet({ total: 0, met: 0 }, undefined),
    ).not.toThrow();
  });

  it('is a 409 saying how many are missing', () => {
    try {
      assertExitCriteriaMet({ total: 4, met: 1 }, undefined);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ConflictException);
      const body = (e as ConflictException).getResponse() as Record<
        string,
        unknown
      >;
      expect(body.code).toBe(CRITERIA_UNMET);
      expect(body.details).toEqual({ unmet: 3, total: 4 });
      expect(String(body.message)).toContain('3 of 4');
    }
  });

  it('can be switched off', () => {
    expect(() =>
      assertExitCriteriaMet({ total: 4, met: 0 }, false),
    ).not.toThrow();
  });
});

describe('milestone health', () => {
  const base: HealthInput = {
    state: S.ACTIVE,
    startDate: '2026-11-01',
    endDate: '2026-11-30',
    today: '2026-11-11',
    done: 5,
    total: 10,
    blockers: 0,
  };

  it('is DONE once closed, whatever the dates', () => {
    expect(
      milestoneHealth({ ...base, state: S.CLOSED, today: '2027-01-01' }).status,
    ).toBe('DONE');
  });

  it('is NO_DATE without a target', () => {
    expect(milestoneHealth({ ...base, endDate: null })).toEqual({
      status: 'NO_DATE',
      projectedDate: null,
      daysLeft: null,
      reasons: [],
    });
  });

  it('is on track at an even pace', () => {
    // 5 done in 10 days -> 0.5/day -> 5 more take 10 days -> 21 Nov, before the 30th
    const h = milestoneHealth(base);
    expect(h).toEqual({
      status: 'ON_TRACK',
      projectedDate: '2026-11-21',
      daysLeft: 19,
      reasons: [],
    });
  });

  it('is at risk when the pace lands after the target', () => {
    // 1 done in 10 days -> 9 more take 90 days
    const h = milestoneHealth({ ...base, done: 1 });
    expect(h.status).toBe('AT_RISK');
    expect(h.reasons).toEqual(['PROJECTED_LATE']);
    expect(h.projectedDate).toBe('2027-02-09');
  });

  it('finishing exactly on the target is still on track', () => {
    // 10 days elapsed, 5 done -> 10 more days -> 21 Nov; target 21 Nov
    expect(milestoneHealth({ ...base, endDate: '2026-11-21' }).status).toBe(
      'ON_TRACK',
    );
    expect(milestoneHealth({ ...base, endDate: '2026-11-20' }).status).toBe(
      'AT_RISK',
    );
  });

  it('does not project from fewer than three days of history', () => {
    const h = milestoneHealth({
      ...base,
      today: '2026-11-03',
      done: 1,
      total: 100,
    });
    expect(h.projectedDate).toBeNull();
    expect(h.status).toBe('ON_TRACK');
    expect(
      milestoneHealth({ ...base, today: '2026-11-04', done: 1, total: 100 })
        .status,
    ).toBe('AT_RISK');
  });

  it('is slipped the day after the target while work is open, never on the day itself', () => {
    const late = milestoneHealth({ ...base, today: '2026-12-01' });
    expect(late).toMatchObject({
      status: 'SLIPPED',
      daysLeft: -1,
      reasons: ['PAST_TARGET'],
    });
    expect(milestoneHealth({ ...base, today: '2026-11-30' }).daysLeft).toBe(0);
    expect(milestoneHealth({ ...base, today: '2026-11-30' }).status).not.toBe(
      'SLIPPED',
    );
  });

  it('is at risk with nothing done a quarter of the way in', () => {
    // 30-day span, 8 days elapsed = 27%
    const h = milestoneHealth({ ...base, today: '2026-11-09', done: 0 });
    expect(h.status).toBe('AT_RISK');
    expect(h.reasons).toEqual(['NOTHING_DONE']);
    // 5 days elapsed = 17%: too early to worry
    expect(
      milestoneHealth({ ...base, today: '2026-11-06', done: 0 }).status,
    ).toBe('ON_TRACK');
  });

  it('is at risk with a blocker within a week of the target, not before', () => {
    const near = milestoneHealth({
      ...base,
      today: '2026-11-23',
      done: 9,
      blockers: 1,
    });
    expect(near.status).toBe('AT_RISK');
    expect(near.reasons).toContain('BLOCKED_NEAR_DEADLINE');
    expect(milestoneHealth({ ...base, blockers: 3 }).status).toBe('ON_TRACK');
    expect(
      milestoneHealth({ ...base, today: '2026-11-22', done: 9, blockers: 1 })
        .reasons,
    ).not.toContain('BLOCKED_NEAR_DEADLINE');
  });

  it('lists every reason that applies', () => {
    const h = milestoneHealth({
      ...base,
      today: '2026-11-24',
      done: 1,
      blockers: 2,
    });
    expect(h.reasons).toEqual(['PROJECTED_LATE', 'BLOCKED_NEAR_DEADLINE']);
  });

  it('work that is all finished is never at risk, even blocked or late-looking', () => {
    const h = milestoneHealth({
      ...base,
      done: 10,
      total: 10,
      blockers: 4,
      today: '2026-11-29',
    });
    expect(h).toMatchObject({ status: 'ON_TRACK', reasons: [] });
  });

  it('a milestone with no work yet and no history is on track', () => {
    expect(
      milestoneHealth({ ...base, done: 0, total: 0, today: '2026-11-02' })
        .status,
    ).toBe('ON_TRACK');
  });

  it('without a start date it still judges lateness, blockers and the target', () => {
    const h = milestoneHealth({ ...base, startDate: null, done: 1 });
    expect(h.projectedDate).toBeNull();
    expect(h.status).toBe('ON_TRACK');
    expect(
      milestoneHealth({ ...base, startDate: null, today: '2026-12-02' }).status,
    ).toBe('SLIPPED');
  });
});

describe('target date history', () => {
  it('records a move of a date that was set, not the first time it is chosen', () => {
    expect(targetChangeToRecord(null, '2026-11-30')).toBeNull();
    expect(targetChangeToRecord('2026-11-30', '2026-11-30')).toBeNull();
    expect(targetChangeToRecord('2026-11-30', '2026-12-14')).toEqual({
      previous: '2026-11-30',
      next: '2026-12-14',
    });
    expect(targetChangeToRecord('2026-11-30', null)).toEqual({
      previous: '2026-11-30',
      next: null,
    });
  });

  const change = (
    previous: string | null,
    next: string | null,
    at: string,
  ) => ({ previous, next, at, byId: 'u1' });

  it('counts only moves to a later date, and adds up the days', () => {
    const s = slipSummary(
      [
        change('2026-11-30', '2026-12-07', '2026-11-20T00:00:00Z'),
        change('2026-12-07', '2026-12-01', '2026-11-25T00:00:00Z'), // pulled in: not a slip
        change('2026-12-01', '2026-12-04', '2026-11-28T00:00:00Z'),
      ],
      '2026-12-04',
    );
    expect(s).toEqual({
      count: 2,
      totalDays: 10,
      originalTarget: '2026-11-30',
    });
  });

  it('is clean when the date never moved', () => {
    expect(slipSummary([], '2026-11-30')).toEqual({
      count: 0,
      totalDays: 0,
      originalTarget: '2026-11-30',
    });
    expect(slipSummary([], null)).toEqual({
      count: 0,
      totalDays: 0,
      originalTarget: null,
    });
  });

  it('does not count removing or adding a date as a slip', () => {
    const s = slipSummary(
      [
        change('2026-11-30', null, '2026-11-20T00:00:00Z'),
        change(null, '2026-12-20', '2026-11-21T00:00:00Z'),
      ],
      '2026-12-20',
    );
    expect(s.count).toBe(0);
    expect(s.originalTarget).toBe('2026-11-30');
  });

  it('orders by time, not by the order given', () => {
    const s = slipSummary(
      [
        change('2026-12-07', '2026-12-14', '2026-11-28T00:00:00Z'),
        change('2026-11-30', '2026-12-07', '2026-11-20T00:00:00Z'),
      ],
      '2026-12-14',
    );
    expect(s.originalTarget).toBe('2026-11-30');
    expect(s.totalDays).toBe(14);
  });
});

describe('release notes', () => {
  it('lists finished work in number order, then merged pull requests', () => {
    const md = buildReleaseNotes({
      name: 'Checkout v2 beta',
      targetDate: '2026-12-12',
      tasks: [
        { number: 12, title: 'Fix   login' },
        { number: 3, title: 'Payment form' },
      ],
      prs: [{ title: 'Add Stripe', url: 'https://github.com/o/r/pull/9' }],
    });
    expect(md).toBe(
      [
        '# Checkout v2 beta',
        '',
        'Target: 2026-12-12',
        '',
        '## Done',
        '',
        '- #3 Payment form',
        '- #12 Fix login',
        '',
        '## Merged pull requests',
        '',
        '- [Add Stripe](https://github.com/o/r/pull/9)',
        '',
      ].join('\n'),
    );
  });

  it('says so when nothing is finished, and omits empty sections', () => {
    const md = buildReleaseNotes({
      name: 'M',
      targetDate: null,
      tasks: [],
      prs: [],
    });
    expect(md).toContain('_Nothing finished yet._');
    expect(md).not.toContain('Target');
    expect(md).not.toContain('pull requests');
  });

  it('keeps a newline in a title from breaking the list', () => {
    const md = buildReleaseNotes({
      name: 'M\nx',
      targetDate: null,
      tasks: [{ number: 1, title: 'a\nb' }],
      prs: [],
    });
    expect(md).toContain('# M x');
    expect(md).toContain('- #1 a b');
  });
});
