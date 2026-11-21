import { TaskStatus } from '@prisma/client';
import { MetricNode, averageVelocity, measure } from './iteration-metrics';

const { TODO, DONE, IN_PROGRESS } = TaskStatus;
const n = (
  id: string,
  status: TaskStatus,
  estimate: number | null,
  over: Partial<MetricNode> = {},
): MetricNode => ({
  id,
  parentId: null,
  status,
  isArchived: false,
  estimate,
  excludeFromProgress: false,
  ...over,
});

describe('measure (ADR-0008)', () => {
  it('sums points and counts of Done tasks; the total includes the unfinished', () => {
    expect(measure([n('a', DONE, 3), n('b', DONE, 5), n('c', TODO, 8), n('d', IN_PROGRESS, 2)])).toEqual({
      totalCount: 4,
      totalPoints: 18,
      completedCount: 2,
      completedPoints: 8,
      unestimatedTotal: 0,
      unestimatedCompleted: 0,
    });
  });

  it('a task without an estimate adds 0 points and is reported, never guessed', () => {
    const m = measure([n('a', DONE, null), n('b', DONE, 2), n('c', TODO, null)]);
    expect(m).toMatchObject({
      completedCount: 2,
      completedPoints: 2,
      unestimatedTotal: 2,
      unestimatedCompleted: 1,
    });
  });

  it('only LEAVES count: a parent and its subtasks are never both summed', () => {
    const m = measure([
      n('p', DONE, 13),
      n('c1', DONE, 3, { parentId: 'p' }),
      n('c2', TODO, 5, { parentId: 'p' }),
    ]);
    expect(m).toMatchObject({ totalCount: 2, totalPoints: 8, completedCount: 1, completedPoints: 3 });
  });

  it('archived and excluded (Canceled) tasks never count; a parent of only-excluded children is a leaf', () => {
    const m = measure([
      n('a', DONE, 5, { isArchived: true }),
      n('b', DONE, 8, { excludeFromProgress: true }),
      n('p', DONE, 2),
      n('c', DONE, 99, { parentId: 'p', excludeFromProgress: true }),
    ]);
    expect(m).toMatchObject({ totalCount: 1, totalPoints: 2, completedCount: 1, completedPoints: 2 });
  });

  it('half points add up exactly and are rounded to 2 decimals', () => {
    expect(measure([n('a', DONE, 0.5), n('b', DONE, 0.5), n('c', DONE, 1.25)]).completedPoints).toBe(2.25);
    expect(measure([n('a', DONE, 0.1), n('b', DONE, 0.2)]).completedPoints).toBe(0.3);
  });

  it('empty is all zeros', () => {
    expect(measure([])).toEqual({
      totalCount: 0, totalPoints: 0, completedCount: 0, completedPoints: 0, unestimatedTotal: 0, unestimatedCompleted: 0,
    });
  });
});

describe('averageVelocity', () => {
  it('is the mean over the given iterations, 2 decimals; null for none', () => {
    expect(
      averageVelocity([
        { completedCount: 3, completedPoints: 10 },
        { completedCount: 4, completedPoints: 13 },
        { completedCount: 5, completedPoints: 14 },
      ]),
    ).toEqual({ completedCount: 4, completedPoints: 12.33 });
    expect(averageVelocity([])).toBeNull();
  });
});
