import { IterationState } from '@prisma/client';
import {
  CycleView,
  MAX_NAME_LENGTH,
  completionPct,
  nextCycleDates,
  nextCycleName,
  orderCycles,
  ringWindow,
  shouldAutoStart,
  shouldCreateNext,
  shouldRollover,
} from './cycle-rules';

const S = IterationState;
const cycle = (over: Partial<CycleView> = {}): CycleView => ({
  state: S.ACTIVE,
  startDate: '2026-11-02',
  endDate: '2026-11-15',
  config: { cadenceWeeks: 2, autoCreateNext: true, autoRollover: true },
  ...over,
});

describe('next cycle dates', () => {
  it('starts the day after the end and lasts whole weeks', () => {
    expect(nextCycleDates('2026-11-15', 2, 0)).toEqual({
      startDate: '2026-11-16',
      endDate: '2026-11-29',
    });
  });

  it('leaves a cooldown gap before the start', () => {
    expect(nextCycleDates('2026-11-15', 2, 2)).toEqual({
      startDate: '2026-11-18',
      endDate: '2026-12-01',
    });
  });

  it('crosses month and year ends', () => {
    expect(nextCycleDates('2026-12-27', 1, 0)).toEqual({
      startDate: '2026-12-28',
      endDate: '2027-01-03',
    });
  });

  it('a one-week cycle is seven days, both ends counted', () => {
    const { startDate, endDate } = nextCycleDates('2026-11-01', 1, 0);
    expect([startDate, endDate]).toEqual(['2026-11-02', '2026-11-08']);
  });
});

describe('next cycle name', () => {
  it('counts up a trailing number', () => {
    expect(nextCycleName('Cycle 12', [])).toBe('Cycle 13');
    expect(nextCycleName('  Cycle 9  ', [])).toBe('Cycle 10');
  });

  it('adds 2 to a name with no number', () => {
    expect(nextCycleName('Platform', [])).toBe('Platform 2');
  });

  it('skips names already taken, ignoring case', () => {
    expect(nextCycleName('Cycle 1', ['cycle 2', 'CYCLE 3'])).toBe('Cycle 4');
  });

  it('keeps the name within the length limit', () => {
    const long = `${'x'.repeat(MAX_NAME_LENGTH - 2)} 9`;
    const next = nextCycleName(long, []);
    expect(next.length).toBeLessThanOrEqual(MAX_NAME_LENGTH);
    expect(next.endsWith('10')).toBe(true);
  });

  it('counts up a trailing year (rename once and the chain follows)', () => {
    expect(nextCycleName('Q4-2026', [])).toBe('Q4-2027');
  });
});

describe('create the next cycle', () => {
  it('only for an active cycle that opted in, has a cadence and an end, and has no successor', () => {
    expect(shouldCreateNext(cycle(), false)).toBe(true);
    expect(shouldCreateNext(cycle(), true)).toBe(false);
    expect(shouldCreateNext(cycle({ state: S.PLANNED }), false)).toBe(false);
    expect(shouldCreateNext(cycle({ state: S.CLOSED }), false)).toBe(false);
    expect(shouldCreateNext(cycle({ endDate: null }), false)).toBe(false);
    expect(shouldCreateNext(cycle({ config: null }), false)).toBe(false);
    expect(
      shouldCreateNext(
        cycle({ config: { autoCreateNext: false, cadenceWeeks: 2 } }),
        false,
      ),
    ).toBe(false);
    expect(
      shouldCreateNext(cycle({ config: { autoCreateNext: true } }), false),
    ).toBe(false);
  });
});

describe('roll over a finished cycle', () => {
  const next = { state: S.PLANNED };

  it('closes once the last day has passed and there is an open successor', () => {
    expect(shouldRollover(cycle(), '2026-11-16', next)).toBe(true);
  });

  it('waits through the last day itself', () => {
    expect(shouldRollover(cycle(), '2026-11-15', next)).toBe(false);
    expect(shouldRollover(cycle(), '2026-11-10', next)).toBe(false);
  });

  it('never closes without a place to put the unfinished work', () => {
    expect(shouldRollover(cycle(), '2026-11-16', null)).toBe(false);
    expect(shouldRollover(cycle(), '2026-11-16', { state: S.CLOSED })).toBe(
      false,
    );
  });

  it('needs the cycle to have asked for it, and to be running', () => {
    expect(
      shouldRollover(
        cycle({ config: { autoRollover: false } }),
        '2026-11-16',
        next,
      ),
    ).toBe(false);
    expect(shouldRollover(cycle({ config: null }), '2026-11-16', next)).toBe(
      false,
    );
    expect(
      shouldRollover(cycle({ state: S.PLANNED }), '2026-11-16', next),
    ).toBe(false);
    expect(shouldRollover(cycle({ endDate: null }), '2026-11-16', next)).toBe(
      false,
    );
  });
});

describe('auto-start a planned cycle', () => {
  const planned = cycle({
    state: S.PLANNED,
    startDate: '2026-11-16',
    endDate: '2026-11-29',
  });

  it('starts on its first day when nothing else is running', () => {
    expect(shouldAutoStart(planned, '2026-11-16', false)).toBe(true);
    expect(shouldAutoStart(planned, '2026-11-20', false)).toBe(true);
  });

  it('waits for its first day, and for the running one to end (a cooldown)', () => {
    expect(shouldAutoStart(planned, '2026-11-15', false)).toBe(false);
    expect(shouldAutoStart(planned, '2026-11-16', true)).toBe(false);
  });

  it('does not start a cycle that is already over', () => {
    expect(shouldAutoStart(planned, '2026-11-30', false)).toBe(false);
  });

  it('only for a chain that opted in', () => {
    expect(
      shouldAutoStart(
        { ...planned, config: { cadenceWeeks: 2 } },
        '2026-11-16',
        false,
      ),
    ).toBe(false);
    expect(
      shouldAutoStart({ ...planned, config: null }, '2026-11-16', false),
    ).toBe(false);
  });

  it('only a planned one', () => {
    expect(
      shouldAutoStart({ ...planned, state: S.ACTIVE }, '2026-11-16', false),
    ).toBe(false);
  });
});

describe('ring', () => {
  const at = (n: number) => new Date(2026, 0, n);
  const c = (id: string, startDate: string | null, created = 1) => ({
    id,
    startDate,
    createdAt: at(created),
  });

  it('orders by start date, undated last', () => {
    const ordered = orderCycles([
      c('c', null),
      c('b', '2026-12-01'),
      c('a', '2026-11-01'),
    ]);
    expect(ordered.map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });

  it('breaks ties by creation, then id', () => {
    const ordered = orderCycles([
      c('y', '2026-11-01', 2),
      c('x', '2026-11-01', 1),
      c('a', '2026-11-01', 2),
    ]);
    expect(ordered.map((x) => x.id)).toEqual(['x', 'a', 'y']);
  });

  it('keeps three before and two after the current cycle', () => {
    const items = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((id) => ({
      id,
    }));
    expect(ringWindow(items, 'e').map((x) => x.id)).toEqual([
      'b',
      'c',
      'd',
      'e',
      'f',
      'g',
    ]);
  });

  it('is shorter at the edges and empty for an unknown cycle', () => {
    const items = ['a', 'b', 'c'].map((id) => ({ id }));
    expect(ringWindow(items, 'a').map((x) => x.id)).toEqual(['a', 'b', 'c']);
    expect(ringWindow(items, 'c').map((x) => x.id)).toEqual(['a', 'b', 'c']);
    expect(ringWindow(items, 'zzz')).toEqual([]);
  });

  it('completion is a rounded percentage, 0 for nothing', () => {
    expect(completionPct(1, 3)).toBe(33);
    expect(completionPct(2, 3)).toBe(67);
    expect(completionPct(0, 0)).toBe(0);
  });
});
