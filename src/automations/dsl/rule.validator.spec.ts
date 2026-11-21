import { validateRule } from './rule.validator';

const ok = {
  trigger: { type: 'TASK_CREATED' },
  actions: [{ type: 'ADD_TAG', tagId: 'tag1' }],
};
const codes = (input: unknown) => {
  const r = validateRule(input);
  return r.ok === true ? [] : r.issues.map((i) => `${i.code}@${i.path}`);
};
const withTrigger = (trigger: unknown) => ({ ...ok, trigger });
const withAction = (a: unknown) => ({ ...ok, actions: [a] });
const withCond = (c: unknown) => ({ ...ok, conditions: { all: [c] } });

describe('automation rule DSL v1: structure', () => {
  it('accepts a minimal rule and fills conditions with {}', () => {
    const r = validateRule(ok);
    expect(r.ok && r.rule.conditions).toEqual({});
    expect(r.ok && r.triggerType).toBe('TASK_CREATED');
    expect(r.ok && r.unsupported).toEqual([]);
  });

  it('accepts one valid example of every trigger', () => {
    for (const t of [
      { type: 'TASK_CREATED' },
      { type: 'STATUS_CHANGED' },
      {
        type: 'STATUS_CHANGED',
        from: [{ category: 'TODO' }],
        to: [{ category: 'DONE' }, { statusId: 's1' }],
      },
      { type: 'FIELD_CHANGED', field: 'PRIORITY' },
      { type: 'FIELD_CHANGED', customFieldId: 'cf1' },
      { type: 'DUE_APPROACHING', offset: { amount: 2, unit: 'DAYS' } },
      {
        type: 'EXTERNAL_LINK_STATE_CHANGED',
        provider: 'GITHUB',
        kind: 'PR',
        state: 'merged',
      },
    ])
      expect(codes(withTrigger(t))).toEqual([]);
  });

  it('accepts one valid example of every action', () => {
    for (const a of [
      { type: 'SET_STATUS', status: { category: 'DONE' } },
      { type: 'SET_PRIORITY', priority: 'HIGH' },
      { type: 'SET_PRIORITY', priority: null },
      { type: 'ASSIGN', mode: 'ADD', users: ['TRIGGERER'] },
      { type: 'ASSIGN', mode: 'SET', users: [] },
      { type: 'SET_DUE_DATE', inDays: 3 },
      { type: 'SET_DUE_DATE', inDays: null },
      { type: 'SET_CUSTOM_FIELD', customFieldId: 'cf', value: 5 },
      { type: 'SET_CUSTOM_FIELD', customFieldId: 'cf', value: null },
      { type: 'ADD_TAG', tagId: 't' },
      { type: 'REMOVE_TAG', tagId: 't' },
      {
        type: 'COMMENT',
        body: 'Moved {{task.key}} to {{trigger.to}} by {{ actor.name }}',
      },
      {
        type: 'CREATE_SUBTASK',
        title: 'Review {{task.title}}',
        priority: 'LOW',
        assignees: ['CREATOR'],
      },
    ])
      expect(codes(withAction(a))).toEqual([]);
  });

  describe('refuses', () => {
    it('non-objects, missing parts, unknown keys', () => {
      expect(codes(null)).toEqual(['WRONG_TYPE@']);
      expect(codes([])).toEqual(['WRONG_TYPE@']);
      expect(codes({})).toEqual(
        expect.arrayContaining(['MISSING@/trigger', 'MISSING@/actions']),
      );
      expect(codes({ ...ok, extra: 1 })).toEqual(['UNKNOWN_KEY@/extra']);
      expect(codes({ ...ok, actions: [] })).toEqual(['TOO_FEW@/actions']);
    });
    it('an unknown trigger / action type, naming the path', () => {
      expect(codes(withTrigger({ type: 'RUN_SCRIPT' }))).toEqual([
        'UNKNOWN_TRIGGER@/trigger/type',
      ]);
      expect(codes(withAction({ type: 'RUN_SCRIPT', code: 'x' }))).toEqual([
        'UNKNOWN_ACTION@/actions/0/type',
      ]);
      expect(codes(withAction({ type: 'toString' }))).toEqual([
        'UNKNOWN_ACTION@/actions/0/type',
      ]); // not an object-prototype lookup
      expect(codes(withAction({ type: '__proto__' }))).toEqual([
        'UNKNOWN_ACTION@/actions/0/type',
      ]);
    });
    it('typo keys inside a valid type (a rule must not silently do nothing)', () => {
      expect(codes(withAction({ type: 'ADD_TAG', tagID: 't' }))).toEqual(
        expect.arrayContaining([
          'UNKNOWN_KEY@/actions/0/tagID',
          'MISSING@/actions/0/tagId',
        ]),
      );
    });
    it('bad trigger details', () => {
      expect(codes(withTrigger({ type: 'FIELD_CHANGED' }))).toEqual([
        'EXACTLY_ONE_OF@/trigger',
      ]);
      expect(
        codes(
          withTrigger({
            type: 'FIELD_CHANGED',
            field: 'PRIORITY',
            customFieldId: 'x',
          }),
        ),
      ).toEqual(['EXACTLY_ONE_OF@/trigger']);
      expect(
        codes(withTrigger({ type: 'FIELD_CHANGED', field: 'NOPE' })),
      ).toEqual(['BAD_VALUE@/trigger/field']);
      expect(
        codes(
          withTrigger({
            type: 'STATUS_CHANGED',
            to: [{ category: 'DONE', statusId: 'x' }],
          }),
        ),
      ).toEqual(['EXACTLY_ONE_OF@/trigger/to/0']);
      expect(codes(withTrigger({ type: 'STATUS_CHANGED', to: [] }))).toEqual([
        'TOO_FEW@/trigger/to',
      ]);
      expect(
        codes(
          withTrigger({
            type: 'DUE_APPROACHING',
            offset: { amount: 91, unit: 'DAYS' },
          }),
        ),
      ).toEqual(['OUT_OF_RANGE@/trigger/offset/amount']);
      expect(
        codes(
          withTrigger({
            type: 'DUE_APPROACHING',
            offset: { amount: 0, unit: 'HOURS' },
          }),
        ),
      ).toEqual(['OUT_OF_RANGE@/trigger/offset/amount']);
      expect(
        codes(
          withTrigger({
            type: 'DUE_APPROACHING',
            offset: { amount: 1.5, unit: 'HOURS' },
          }),
        ),
      ).toEqual(['WRONG_TYPE@/trigger/offset/amount']);
      expect(
        codes(
          withTrigger({ type: 'EXTERNAL_LINK_STATE_CHANGED', provider: 'FAX' }),
        ),
      ).toEqual(['BAD_VALUE@/trigger/provider']);
    });
    it('bad action details', () => {
      expect(
        codes(withAction({ type: 'SET_PRIORITY', priority: 'EXTREME' })),
      ).toEqual(['BAD_VALUE@/actions/0/priority']);
      expect(
        codes(withAction({ type: 'ASSIGN', mode: 'ADD', users: [] })),
      ).toEqual(['TOO_FEW@/actions/0/users']);
      expect(
        codes(
          withAction({
            type: 'ASSIGN',
            mode: 'SET',
            users: Array(11).fill('u'),
          }),
        ),
      ).toEqual(['TOO_MANY@/actions/0/users']);
      expect(codes(withAction({ type: 'SET_DUE_DATE', inDays: 366 }))).toEqual([
        'OUT_OF_RANGE@/actions/0/inDays',
      ]);
      expect(
        codes(withAction({ type: 'ADD_TAG', tagId: 'has space' })),
      ).toEqual(['BAD_FORMAT@/actions/0/tagId']);
      expect(codes(withAction({ type: 'COMMENT', body: '' }))).toEqual([
        'TOO_SHORT@/actions/0/body',
      ]);
      expect(
        codes(withAction({ type: 'COMMENT', body: 'x'.repeat(2001) })),
      ).toEqual(['TOO_LONG@/actions/0/body']);
    });
    it('more than 10 actions', () => {
      expect(codes({ ...ok, actions: Array(11).fill(ok.actions[0]) })).toEqual([
        'TOO_MANY@/actions',
      ]);
      expect(codes({ ...ok, actions: Array(10).fill(ok.actions[0]) })).toEqual(
        [],
      );
    });
    it('unknown or broken {{placeholders}} (no code, no expressions)', () => {
      expect(
        codes(withAction({ type: 'COMMENT', body: 'hi {{task.secret}}' })),
      ).toEqual(['UNKNOWN_VARIABLE@/actions/0/body']);
      expect(
        codes(
          withAction({
            type: 'COMMENT',
            body: '{{constructor.constructor("x")()}}',
          }),
        ),
      ).toEqual(['UNKNOWN_VARIABLE@/actions/0/body']);
      expect(
        codes(withAction({ type: 'COMMENT', body: 'oops {{task.title' })),
      ).toEqual(['BAD_TEMPLATE@/actions/0/body']);
      expect(codes(withAction({ type: 'COMMENT', body: 'oops }}' }))).toEqual([
        'BAD_TEMPLATE@/actions/0/body',
      ]);
      expect(
        codes(
          withAction({ type: 'COMMENT', body: '${process.env.X} <script>' }),
        ),
      ).toEqual([]); // plain text, never evaluated
    });
  });

  describe('conditions', () => {
    it('accepts every field with a valid operator and value', () => {
      for (const c of [
        { field: 'STATUS_CATEGORY', op: 'IN', value: ['DONE', 'BLOCKED'] },
        { field: 'STATUS', op: 'NOT_IN', value: ['s1'] },
        { field: 'PRIORITY', op: 'IN', value: ['HIGH'] },
        { field: 'PRIORITY', op: 'IS_NOT_SET' },
        { field: 'ASSIGNEES', op: 'INCLUDES_ANY', value: ['TRIGGERER', 'u1'] },
        { field: 'ASSIGNEES', op: 'IS_EMPTY' },
        { field: 'TAGS', op: 'HAS_ALL', value: ['t1', 't2'] },
        { field: 'ISSUE_TYPE', op: 'IS_SET' },
        { field: 'PROJECT', op: 'IN', value: ['p1'] },
        { field: 'ESTIMATE', op: 'GTE', value: 5 },
        { field: 'DUE_DATE', op: 'IS_OVERDUE' },
        { field: 'IS_SUBTASK', op: 'IS_FALSE' },
        { field: 'CUSTOM', customFieldId: 'cf', op: 'EQ', value: 'x' },
        { field: 'CUSTOM', customFieldId: 'cf', op: 'HAS_ANY', value: ['a'] },
        { field: 'CUSTOM', customFieldId: 'cf', op: 'IS_TRUE' },
      ])
        expect(codes(withCond(c))).toEqual([]);
    });
    it('refuses an operator that does not belong to the field, and values that do not fit the operator', () => {
      expect(
        codes(withCond({ field: 'PRIORITY', op: 'GT', value: 1 })),
      ).toEqual(['UNKNOWN_OPERATOR@/conditions/all/0/op']);
      expect(codes(withCond({ field: 'NOPE', op: 'IN' }))).toEqual([
        'UNKNOWN_FIELD@/conditions/all/0/field',
      ]);
      expect(
        codes(withCond({ field: 'PRIORITY', op: 'IS_SET', value: 'x' })),
      ).toEqual(['VALUE_NOT_ALLOWED@/conditions/all/0/value']);
      expect(codes(withCond({ field: 'PRIORITY', op: 'IN' }))).toEqual([
        'MISSING@/conditions/all/0/value',
      ]);
      expect(
        codes(withCond({ field: 'PRIORITY', op: 'IN', value: ['EXTREME'] })),
      ).toEqual(['BAD_VALUE@/conditions/all/0/value/0']);
      expect(
        codes(withCond({ field: 'ESTIMATE', op: 'GT', value: '5' })),
      ).toEqual(['WRONG_TYPE@/conditions/all/0/value']);
      expect(
        codes(withCond({ field: 'STATUS_CATEGORY', op: 'IN', value: [] })),
      ).toEqual(['TOO_FEW@/conditions/all/0/value']);
      expect(
        codes(withCond({ field: 'CUSTOM', op: 'EQ', value: 'x' })),
      ).toEqual(['EXACTLY_ONE_OF@/conditions/all/0/customFieldId']);
      expect(
        codes(
          withCond({
            field: 'TAGS',
            customFieldId: 'x',
            op: 'HAS_ANY',
            value: ['a'],
          }),
        ),
      ).toEqual(['EXACTLY_ONE_OF@/conditions/all/0/customFieldId']);
      expect(codes(withCond({ field: 'toString', op: 'x' }))).toEqual([
        'UNKNOWN_FIELD@/conditions/all/0/field',
      ]);
    });
    it('caps conditions at 20 in total across all+any', () => {
      const c = { field: 'IS_SUBTASK', op: 'IS_TRUE' };
      expect(codes({ ...ok, conditions: { all: Array(20).fill(c) } })).toEqual(
        [],
      );
      expect(codes({ ...ok, conditions: { all: Array(21).fill(c) } })).toEqual([
        'TOO_MANY@/conditions/all',
      ]);
      expect(
        codes({
          ...ok,
          conditions: { all: Array(11).fill(c), any: Array(10).fill(c) },
        }),
      ).toEqual(['TOO_MANY@/conditions']);
      expect(codes({ ...ok, conditions: { all: [] } })).toEqual([
        'TOO_FEW@/conditions/all',
      ]);
      expect(codes({ ...ok, conditions: { not: [] } })).toEqual([
        'UNKNOWN_KEY@/conditions/not',
      ]);
    });
  });

  describe('unavailable constructs are stored, not refused', () => {
    it('NOTIFY_CHANNEL validates and is reported as unsupported with its path', () => {
      const r = validateRule({
        ...ok,
        actions: [
          ok.actions[0],
          {
            type: 'NOTIFY_CHANNEL',
            channelLinkId: 'cl1',
            message: 'Done: {{task.title}}',
          },
        ],
      });
      expect(r.ok).toBe(true);
      expect(r.ok && r.unsupported).toEqual([
        {
          path: '/actions/1',
          construct: 'NOTIFY_CHANNEL',
          reason: expect.stringContaining('Phase 2'),
        },
      ]);
    });
    it('but a malformed NOTIFY_CHANNEL is still an error', () => {
      expect(
        codes(withAction({ type: 'NOTIFY_CHANNEL', message: 'x' })),
      ).toEqual(['MISSING@/actions/0/channelLinkId']);
    });
  });

  describe('valid but not runnable yet (stored, never enabled)', () => {
    const unsupported = (input: unknown) => {
      const r = validateRule(input);
      return r.ok === true
        ? r.unsupported.map((u) => `${u.construct}@${u.path}`)
        : ['INVALID'];
    };
    it('triggers that nothing can fire yet', () => {
      expect(
        unsupported(withTrigger({ type: 'FIELD_CHANGED', field: 'TITLE' })),
      ).toEqual(['FIELD_CHANGED(TITLE)@/trigger']);
      expect(
        unsupported(
          withTrigger({ type: 'FIELD_CHANGED', field: 'START_DATE' }),
        ),
      ).toEqual(['FIELD_CHANGED(START_DATE)@/trigger']);
      expect(
        unsupported(withTrigger({ type: 'FIELD_CHANGED', field: 'ESTIMATE' })),
      ).toEqual(['FIELD_CHANGED(ESTIMATE)@/trigger']);
      expect(
        unsupported(
          withTrigger({ type: 'FIELD_CHANGED', customFieldId: 'cf' }),
        ),
      ).toEqual(['FIELD_CHANGED(custom field)@/trigger']);
      expect(
        unsupported(
          withTrigger({ type: 'EXTERNAL_LINK_STATE_CHANGED', state: 'merged' }),
        ),
      ).toEqual(['EXTERNAL_LINK_STATE_CHANGED@/trigger']);
    });
    it('the fields that DO have change events are fine', () => {
      for (const field of [
        'PRIORITY',
        'ASSIGNEES',
        'DUE_DATE',
        'ISSUE_TYPE',
        'ITERATION',
        'TAGS',
        'DESCRIPTION',
      ]) {
        expect(
          unsupported(withTrigger({ type: 'FIELD_CHANGED', field })),
        ).toEqual([]);
      }
      expect(unsupported(withTrigger({ type: 'STATUS_CHANGED' }))).toEqual([]);
      expect(
        unsupported(
          withTrigger({
            type: 'DUE_APPROACHING',
            offset: { amount: 1, unit: 'DAYS' },
          }),
        ),
      ).toEqual([]);
    });
    it('clearing a priority or a due date (the task API cannot)', () => {
      expect(
        unsupported(withAction({ type: 'SET_PRIORITY', priority: null })),
      ).toEqual(['SET_PRIORITY(clear)@/actions/0']);
      expect(
        unsupported(withAction({ type: 'SET_DUE_DATE', inDays: null })),
      ).toEqual(['SET_DUE_DATE(clear)@/actions/0']);
      expect(
        unsupported(withAction({ type: 'SET_PRIORITY', priority: 'HIGH' })),
      ).toEqual([]);
      expect(
        unsupported(withAction({ type: 'SET_DUE_DATE', inDays: 2 })),
      ).toEqual([]);
    });
    it('every unsupported construct is reported once, with its own path', () => {
      const r = unsupported({
        trigger: { type: 'FIELD_CHANGED', field: 'TITLE' },
        actions: [
          { type: 'SET_PRIORITY', priority: null },
          { type: 'ADD_TAG', tagId: 't' },
          { type: 'NOTIFY_CHANNEL', channelLinkId: 'c', message: 'm' },
        ],
      });
      expect(r).toEqual([
        'FIELD_CHANGED(TITLE)@/trigger',
        'SET_PRIORITY(clear)@/actions/0',
        'NOTIFY_CHANNEL@/actions/2',
      ]);
    });
  });

  describe('hostile input', () => {
    it('too large, too deep, circular, not JSON-able', () => {
      expect(codes({ ...ok, junk: 'x'.repeat(70_000) })).toEqual([
        'TOO_LARGE@',
      ]);
      let deep: any = {};
      const root = deep;
      for (let i = 0; i < 50; i++) {
        deep.a = {};
        deep = deep.a;
      }
      expect(codes({ ...ok, x: root })).toEqual(['TOO_DEEP@']);
      const circular: any = { ...ok };
      circular.self = circular;
      expect(codes(circular)).toEqual(['NOT_JSON@']);
    });
    it('reports at most 50 issues, then says there are more', () => {
      const r = validateRule({
        ...ok,
        junk: 1,
        trigger: { type: 'NOPE' },
        actions: Array(10).fill({ type: 'X1' }),
        conditions: { all: Array(20).fill({ field: 'N', op: 'N', extra: 1 }) },
      });
      expect(r.ok === false && r.issues.length).toBeLessThanOrEqual(51);
      expect(
        r.ok === false && r.issues.some((i) => i.code === 'TOO_MANY_ISSUES'),
      ).toBe(true);
    });
    it('does not mutate its input', () => {
      const input = JSON.parse(JSON.stringify(ok));
      validateRule(input);
      expect(input).toEqual(ok);
    });
  });
});

describe('richer triggers and actions (step 5.6)', () => {
  const t = (trigger: unknown) =>
    codes({ trigger, actions: [{ type: 'ADD_TAG', tagId: 't' }] });
  const a = (action: unknown) =>
    codes({ trigger: { type: 'TASK_CREATED' }, actions: [action] });

  it('accepts every new trigger', () => {
    for (const trigger of [
      { type: 'COMMENT_ADDED' },
      { type: 'COMMENT_ADDED', contains: 'urgent', by: 'ANYONE' },
      { type: 'TASK_ARCHIVED' },
      { type: 'TASK_RESTORED' },
      { type: 'ALL_SUBTASKS_DONE' },
      { type: 'TASK_OVERDUE' },
      { type: 'TASK_OVERDUE', afterHours: 48 },
    ])
      expect(t(trigger)).toEqual([]);
  });

  it('accepts every new action', () => {
    for (const action of [
      {
        type: 'CREATE_TASK',
        title: 'Weekly review',
        description: 'On {{date}}',
        priority: 'LOW',
        dueInDays: 7,
        tags: ['t1'],
        assignees: ['CREATOR'],
        status: { category: 'TODO' },
      },
      { type: 'RENAME_TASK', title: '[Blocked] {{task.title}}' },
      { type: 'SET_DESCRIPTION', text: 'See {{task.key}}', mode: 'APPEND' },
      { type: 'SET_ESTIMATE', estimate: 3 },
      { type: 'SET_ESTIMATE', estimate: null },
      { type: 'SET_ISSUE_TYPE', issueTypeId: 'it1' },
      { type: 'SET_ISSUE_TYPE', issueTypeId: null },
      { type: 'SET_ITERATION', iterationId: 'i1' },
      { type: 'SET_ITERATION', iterationId: null },
      { type: 'CHANGE_PRIORITY', direction: 'UP' },
      { type: 'CHANGE_PRIORITY', direction: 'DOWN' },
      { type: 'SET_START_DATE', inDays: 1 },
      { type: 'SET_START_DATE', inDays: -2, from: 'DUE_DATE' },
      { type: 'SET_DUE_DATE', inDays: -1, from: 'DUE_DATE' },
      { type: 'SET_DUE_DATE', inDays: 3, from: 'NOW' },
      { type: 'ARCHIVE_TASK' },
      { type: 'RESTORE_TASK' },
    ])
      expect(a(action)).toEqual([]);
  });

  it('refuses bad details with paths', () => {
    expect(t({ type: 'COMMENT_ADDED', by: 'ROBOTS' })).toEqual([
      'BAD_VALUE@/trigger/by',
    ]);
    expect(t({ type: 'COMMENT_ADDED', contains: '' })).toEqual([
      'TOO_SHORT@/trigger/contains',
    ]);
    expect(t({ type: 'TASK_OVERDUE', afterHours: 721 })).toEqual([
      'OUT_OF_RANGE@/trigger/afterHours',
    ]);
    expect(t({ type: 'TASK_ARCHIVED', extra: 1 })).toEqual([
      'UNKNOWN_KEY@/trigger/extra',
    ]);
    expect(a({ type: 'SET_ESTIMATE', estimate: -1 })).toEqual([
      'OUT_OF_RANGE@/actions/0/estimate',
    ]);
    expect(a({ type: 'SET_ESTIMATE' })).toEqual([
      'MISSING@/actions/0/estimate',
    ]);
    expect(a({ type: 'CHANGE_PRIORITY', direction: 'SIDEWAYS' })).toEqual([
      'BAD_VALUE@/actions/0/direction',
    ]);
    expect(a({ type: 'SET_DESCRIPTION', text: 'x', mode: 'PREPEND' })).toEqual([
      'BAD_VALUE@/actions/0/mode',
    ]);
    expect(
      a({ type: 'SET_DESCRIPTION', text: 'x'.repeat(5001), mode: 'REPLACE' }),
    ).toEqual(['TOO_LONG@/actions/0/text']);
    expect(a({ type: 'CREATE_TASK', title: 'x', tags: [] })).toEqual([
      'TOO_FEW@/actions/0/tags',
    ]);
    expect(a({ type: 'CREATE_TASK', title: 'x', dueInDays: 366 })).toEqual([
      'OUT_OF_RANGE@/actions/0/dueInDays',
    ]);
    expect(
      a({
        type: 'CREATE_TASK',
        title: 'x',
        status: { category: 'DONE', statusId: 's' },
      }),
    ).toEqual(['EXACTLY_ONE_OF@/actions/0/status']);
    expect(a({ type: 'CREATE_TASK', title: '{{task.secret}}' })).toEqual([
      'UNKNOWN_VARIABLE@/actions/0/title',
    ]);
    expect(a({ type: 'RENAME_TASK', title: '' })).toEqual([
      'TOO_SHORT@/actions/0/title',
    ]);
  });

  it('relative days: negative only counts back from the due date', () => {
    expect(a({ type: 'SET_DUE_DATE', inDays: -1 })).toEqual([
      'OUT_OF_RANGE@/actions/0/inDays',
    ]);
    expect(a({ type: 'SET_START_DATE', inDays: -1, from: 'NOW' })).toEqual([
      'OUT_OF_RANGE@/actions/0/inDays',
    ]);
    expect(a({ type: 'SET_START_DATE', inDays: 366 })).toEqual([
      'OUT_OF_RANGE@/actions/0/inDays',
    ]);
    expect(a({ type: 'SET_DUE_DATE', inDays: 1, from: 'YESTERDAY' })).toEqual([
      'BAD_VALUE@/actions/0/from',
    ]);
  });

  describe('SCHEDULE', () => {
    const create = { type: 'CREATE_TASK', title: 'Standup notes for {{date}}' };
    const s = (trigger: unknown, extra: Record<string, unknown> = {}) =>
      codes({ trigger, actions: [create], ...extra });
    it('accepts a daily, weekly and monthly schedule', () => {
      expect(s({ type: 'SCHEDULE', frequency: 'DAILY', hour: 9 })).toEqual([]);
      expect(
        s({
          type: 'SCHEDULE',
          frequency: 'WEEKLY',
          hour: 0,
          weekdays: [1, 3, 5],
        }),
      ).toEqual([]);
      expect(
        s({ type: 'SCHEDULE', frequency: 'MONTHLY', hour: 23, dayOfMonth: 28 }),
      ).toEqual([]);
    });
    it('names exactly what its frequency uses', () => {
      expect(s({ type: 'SCHEDULE', frequency: 'WEEKLY', hour: 9 })).toEqual([
        'MISSING@/trigger/weekdays',
      ]);
      expect(s({ type: 'SCHEDULE', frequency: 'MONTHLY', hour: 9 })).toEqual([
        'MISSING@/trigger/dayOfMonth',
      ]);
      expect(
        s({ type: 'SCHEDULE', frequency: 'DAILY', hour: 9, weekdays: [1] }),
      ).toEqual(['NOT_FOR_FREQUENCY@/trigger/weekdays']);
      expect(
        s({
          type: 'SCHEDULE',
          frequency: 'WEEKLY',
          hour: 9,
          weekdays: [1],
          dayOfMonth: 3,
        }),
      ).toEqual(['NOT_FOR_FREQUENCY@/trigger/dayOfMonth']);
      expect(
        s({ type: 'SCHEDULE', frequency: 'WEEKLY', hour: 9, weekdays: [1, 1] }),
      ).toEqual(['DUPLICATE@/trigger/weekdays']);
      expect(
        s({ type: 'SCHEDULE', frequency: 'WEEKLY', hour: 9, weekdays: [0] }),
      ).toEqual(['OUT_OF_RANGE@/trigger/weekdays/0']);
      expect(
        s({ type: 'SCHEDULE', frequency: 'MONTHLY', hour: 9, dayOfMonth: 29 }),
      ).toEqual(['OUT_OF_RANGE@/trigger/dayOfMonth']); // every month has a 28th
      expect(s({ type: 'SCHEDULE', frequency: 'DAILY', hour: 24 })).toEqual([
        'OUT_OF_RANGE@/trigger/hour',
      ]);
      expect(s({ type: 'SCHEDULE', frequency: 'HOURLY', hour: 1 })).toEqual([
        'BAD_VALUE@/trigger/frequency',
      ]);
    });
    it('has no task: no conditions, only creating tasks, no task placeholders', () => {
      const daily = { type: 'SCHEDULE', frequency: 'DAILY', hour: 9 };
      expect(
        s(daily, {
          conditions: { all: [{ field: 'IS_SUBTASK', op: 'IS_FALSE' }] },
        }),
      ).toEqual(['CONDITIONS_NEED_TASK@/conditions']);
      expect(
        codes({
          trigger: daily,
          actions: [create, { type: 'ADD_TAG', tagId: 't' }],
        }),
      ).toEqual(['ACTION_NEEDS_TASK@/actions/1/type']);
      expect(
        codes({ trigger: daily, actions: [{ type: 'COMMENT', body: 'x' }] }),
      ).toEqual(['ACTION_NEEDS_TASK@/actions/0/type']);
      expect(
        codes({
          trigger: daily,
          actions: [{ type: 'CREATE_TASK', title: 'For {{task.title}}' }],
        }),
      ).toEqual(['VARIABLE_NEEDS_TASK@/actions/0/title']);
      expect(
        codes({
          trigger: daily,
          actions: [
            {
              type: 'CREATE_TASK',
              title: 'x',
              description: '{{actor.name}} {{date}}',
            },
          ],
        }),
      ).toEqual(['VARIABLE_NEEDS_TASK@/actions/0/description']);
      expect(
        codes({
          trigger: daily,
          actions: [{ type: 'CREATE_TASK', title: 'x', conditions: 1 }],
        }).length,
      ).toBeGreaterThan(0);
      expect(s(daily, { conditions: {} })).toEqual([]); // empty is "none"
    });
  });

  it('{{date}} is a placeholder for every rule', () => {
    expect(a({ type: 'COMMENT', body: 'Checked on {{date}}' })).toEqual([]);
  });
});
