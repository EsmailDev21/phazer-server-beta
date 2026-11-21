import type { Condition } from '../../automations/dsl/rule.types';
import {
  TaskSnapshot,
  evaluateCondition,
  evaluateConditions,
} from '../../automations/engine/conditions-eval';
import {
  VIEW_RUN_DEFAULTS,
  VIEW_RUN_HARD_MAX,
  viewRunLimits,
} from './run.settings';
import { viewFilters } from './view-filters';

const NOW = new Date('2026-10-26T12:00:00.000Z');
const DAY = 86_400_000;
const snap = (over: Partial<TaskSnapshot> = {}): TaskSnapshot => ({
  status: 'TODO',
  workflowStatusId: null,
  priority: null,
  assigneeIds: [],
  tagIds: [],
  issueTypeId: null,
  projectId: 'p1',
  estimate: null,
  dueDate: null,
  parentId: null,
  createdById: 'creator',
  customValues: {},
  ...over,
});
const ctx = { now: NOW, actorId: 'actor', viewerId: 'viewer' };
const C = (field: string, op: string, value?: unknown): Condition =>
  ({ field, op, ...(value === undefined ? {} : { value }) }) as Condition;

describe('view-only fields in the evaluator (step 5.11)', () => {
  it.each([
    // [condition, snapshot overrides, expected]
    [C('TITLE', 'CONTAINS', 'login'), { title: 'Fix LOGIN bug' }, true],
    [C('TITLE', 'CONTAINS', 'LOGIN'), { title: 'fix login bug' }, true],
    [C('TITLE', 'CONTAINS', 'logout'), { title: 'Fix login bug' }, false],
    [C('TITLE', 'CONTAINS', '%'), { title: '100% done' }, true],
    [C('TITLE', 'CONTAINS', '_'), { title: 'ab' }, false],
    [C('TITLE', 'CONTAINS', 'x'), {}, false],
    [C('TITLE', 'CONTAINS', 5), { title: '5' }, false],
    [C('TITLE', 'EQ', 'a'), { title: 'a' }, false],
    [C('START_DATE', 'IS_SET'), { startDate: NOW }, true],
    [C('START_DATE', 'IS_SET'), { startDate: null }, false],
    [C('START_DATE', 'IS_SET'), {}, false],
    [C('START_DATE', 'IS_NOT_SET'), {}, true],
    [C('ITERATION', 'IS_SET'), { iterationId: 'i1' }, true],
    [C('ITERATION', 'IS_NOT_SET'), { iterationId: null }, true],
    [C('ITERATION', 'IN', ['i1', 'i2']), { iterationId: 'i2' }, true],
    [C('ITERATION', 'IN', ['i1']), { iterationId: null }, false],
    [C('ITERATION', 'NOT_IN', ['i1']), { iterationId: null }, true],
    [C('ITERATION', 'NOT_IN', ['i1']), { iterationId: 'i1' }, false],
    [C('CREATED_BY', 'IN', ['creator']), {}, true],
    [C('CREATED_BY', 'IN', ['ME']), { createdById: 'viewer' }, true],
    [C('CREATED_BY', 'IN', ['ME']), { createdById: 'someone' }, false],
    [C('CREATED_BY', 'NOT_IN', ['ME']), { createdById: 'viewer' }, false],
    [C('CREATED_BY', 'NOT_IN', ['ME']), { createdById: 'someone' }, true],
    [C('ASSIGNEES', 'INCLUDES_ANY', ['ME']), { assigneeIds: ['viewer'] }, true],
    [C('ASSIGNEES', 'INCLUDES_ANY', ['ME']), { assigneeIds: ['x'] }, false],
    [
      C('ASSIGNEES', 'INCLUDES_NONE', ['ME']),
      { assigneeIds: ['viewer'] },
      false,
    ],
  ])('%j on %j is %s', (c, over, want) => {
    expect(evaluateCondition(c, snap(over), ctx)).toBe(want);
  });

  it('ME with nobody looking (a rule) matches nobody, never everybody', () => {
    const rule = { now: NOW, actorId: 'actor' };
    expect(evaluateCondition(C('CREATED_BY', 'IN', ['ME']), snap(), rule)).toBe(
      false,
    );
    expect(
      evaluateCondition(C('CREATED_BY', 'NOT_IN', ['ME']), snap(), rule),
    ).toBe(true);
    expect(
      evaluateCondition(
        C('ASSIGNEES', 'INCLUDES_ANY', ['ME']),
        snap({ assigneeIds: ['ME'] }),
        rule,
      ),
    ).toBe(false);
  });

  describe('DUE_WITHIN_DAYS: not done, due from now up to N days ahead, ends included', () => {
    const due = (ms: number, status = 'TODO') =>
      snap({ dueDate: new Date(NOW.getTime() + ms), status });
    const within = (n: unknown) => C('DUE_DATE', 'DUE_WITHIN_DAYS', n);
    it.each([
      [0, true, 'due exactly now, N=0'],
      [2 * DAY, true, 'due exactly at the end (N=2)'],
      [2 * DAY + 1, false, 'one millisecond past the end'],
      [1 * DAY, true, 'inside'],
      [-1, false, 'one millisecond overdue (that is IS_OVERDUE)'],
      [-3 * DAY, false, 'long overdue'],
    ])('%d ms from now: %s (%s)', (ms, want) => {
      expect(evaluateCondition(within(2), due(ms), ctx)).toBe(want);
    });
    it('is false for a done task, a task with no due date, and a non-number N', () => {
      expect(evaluateCondition(within(2), due(DAY, 'DONE'), ctx)).toBe(false);
      expect(evaluateCondition(within(2), snap(), ctx)).toBe(false);
      expect(evaluateCondition(within('2'), due(DAY), ctx)).toBe(false);
    });
    it('a task is never both overdue and due-within', () => {
      for (const ms of [-DAY, -1, 0, 1, DAY, 5 * DAY]) {
        const s = due(ms);
        expect(
          evaluateCondition(C('DUE_DATE', 'IS_OVERDUE'), s, ctx) &&
            evaluateCondition(within(7), s, ctx),
        ).toBe(false);
      }
    });
  });

  it('combines like any conditions block', () => {
    const s = snap({ title: 'Fix it', priority: 'HIGH' });
    expect(
      evaluateConditions(
        {
          all: [C('TITLE', 'CONTAINS', 'fix')],
          any: [C('PRIORITY', 'IN', ['HIGH']), C('PRIORITY', 'IS_NOT_SET')],
        },
        s,
        ctx,
      ),
    ).toBe(true);
  });
});

describe('viewFilters', () => {
  it('is empty for a view with no filters and no switches', () => {
    expect(viewFilters({})).toEqual({});
  });
  it('passes filters through untouched', () => {
    const f = {
      all: [C('PRIORITY', 'IS_SET')],
      any: [C('IS_SUBTASK', 'IS_TRUE')],
    };
    expect(viewFilters({ filters: f })).toEqual(f);
  });
  it('hideCompleted adds "not done"; only an explicit showSubtasks:false hides subtasks', () => {
    expect(viewFilters({ hideCompleted: true })).toEqual({
      all: [C('STATUS_CATEGORY', 'NOT_IN', ['DONE'])],
    });
    expect(viewFilters({ hideCompleted: false })).toEqual({});
    expect(viewFilters({ showSubtasks: true })).toEqual({});
    expect(viewFilters({ showSubtasks: false })).toEqual({
      all: [C('IS_SUBTASK', 'IS_FALSE')],
    });
  });
  it("adds the switches AFTER the view's own conditions and never mutates the config", () => {
    const cfg = {
      filters: { all: [C('PRIORITY', 'IS_SET')] },
      hideCompleted: true,
      showSubtasks: false,
    };
    const copy = JSON.parse(JSON.stringify(cfg));
    expect(viewFilters(cfg).all).toEqual([
      C('PRIORITY', 'IS_SET'),
      C('STATUS_CATEGORY', 'NOT_IN', ['DONE']),
      C('IS_SUBTASK', 'IS_FALSE'),
    ]);
    expect(cfg).toEqual(copy);
  });
});

describe('view run limits (configurable)', () => {
  const keys = ['VIEW_RUN_MAX_PAGE', 'VIEW_RUN_MAX_SCAN'];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() =>
    keys.forEach((k) => ((saved[k] = process.env[k]), delete process.env[k])),
  );
  afterEach(() =>
    keys.forEach((k) =>
      saved[k] === undefined
        ? delete process.env[k]
        : (process.env[k] = saved[k]),
    ),
  );
  it('default to 100 per page and 5000 scanned', () => {
    expect(viewRunLimits()).toEqual({ maxPage: 100, maxScan: 5000 });
    expect(VIEW_RUN_DEFAULTS).toEqual({ maxPage: 100, maxScan: 5000 });
  });
  it('follow the environment, up to the ceilings, and ignore anything else', () => {
    process.env.VIEW_RUN_MAX_PAGE = '250';
    process.env.VIEW_RUN_MAX_SCAN = '20000';
    expect(viewRunLimits()).toEqual({ maxPage: 250, maxScan: 20000 });
    process.env.VIEW_RUN_MAX_PAGE = String(VIEW_RUN_HARD_MAX.maxPage + 1);
    process.env.VIEW_RUN_MAX_SCAN = 'lots';
    expect(viewRunLimits()).toEqual(VIEW_RUN_DEFAULTS);
    process.env.VIEW_RUN_MAX_PAGE = '0';
    process.env.VIEW_RUN_MAX_SCAN = '-5';
    expect(viewRunLimits()).toEqual(VIEW_RUN_DEFAULTS);
  });
});
