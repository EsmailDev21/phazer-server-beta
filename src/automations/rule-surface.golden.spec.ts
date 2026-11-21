import { FieldType, TaskStatus } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';
import { RefWalker } from '../templates/portable/portable.refs';
import { ActionExecutor, ActionRun } from './action-executor.service';
import {
  checkRuleSemantics,
  collectCustomUserIds,
  collectReferences,
  validateRule,
  WorkspaceRuleContext,
} from './dsl';
import { matchesTrigger } from './engine/trigger-match';

/**
 * Step 5.8 characterization ("golden") test. It records, for every trigger and every action, what the
 * rule surface does TODAY: structural validation, reference collection, semantic issues, the template
 * walker's rewrites, and the exact calls the executor makes. The registry refactor must leave this
 * file's golden JSON byte-for-byte unchanged. Regenerate ONLY on purpose: UPDATE_GOLDEN=1 npx jest <this file>
 */
const GOLDEN = path.join(__dirname, '__golden__', 'rule-surface.golden.json');

const ctx = (): WorkspaceRuleContext => ({
  projectIds: new Set(['p1', 'p2']),
  statuses: new Map([
    ['s_todo', { projectId: 'p1', category: TaskStatus.TODO }],
    ['s_done', { projectId: 'p1', category: TaskStatus.DONE }],
    ['s_other', { projectId: 'p2', category: TaskStatus.DONE }],
  ]),
  tagIds: new Set(['t1']),
  issueTypeIds: new Set(['it1']),
  iterationIds: new Set(['i1']),
  customFields: new Map<
    string,
    { dataType: FieldType; options: string[] | null }
  >([
    ['f_num', { dataType: FieldType.NUMBER, options: null }],
    ['f_sel', { dataType: FieldType.SELECT, options: ['red', 'blue'] }],
    ['f_user', { dataType: FieldType.USER, options: null }],
    ['f_text', { dataType: FieldType.TEXT, options: null }],
  ]),
  validUserIds: new Set(['u1', 'u2']),
});

type Fx = { name: string; rule: Record<string, unknown> };
const T = { type: 'STATUS_CHANGED' };
const withTrigger = (trigger: unknown, actions: unknown[]): Fx['rule'] => ({
  trigger,
  actions,
});
const act = (
  name: string,
  a: Record<string, unknown>,
  trigger: unknown = T,
): Fx => ({
  name: `action ${name}`,
  rule: withTrigger(trigger, [a]),
});
const trig = (name: string, t: Record<string, unknown>): Fx => ({
  name: `trigger ${name}`,
  rule:
    t.type === 'SCHEDULE'
      ? withTrigger(t, [{ type: 'CREATE_TASK', title: 'Weekly {{date}}' }])
      : withTrigger(t, [{ type: 'ADD_TAG', tagId: 't1' }]),
});

const FIXTURES: Fx[] = [
  // ---------------- triggers
  trig('TASK_CREATED', { type: 'TASK_CREATED' }),
  trig('STATUS_CHANGED any', { type: 'STATUS_CHANGED' }),
  trig('STATUS_CHANGED ids ok', {
    type: 'STATUS_CHANGED',
    from: [{ statusId: 's_todo' }],
    to: [{ statusId: 's_done' }, { category: 'DONE' }],
  }),
  trig('STATUS_CHANGED ids bad', {
    type: 'STATUS_CHANGED',
    from: [{ statusId: 'zz' }],
    to: [{ statusId: 's_other' }],
  }),
  trig('FIELD_CHANGED PRIORITY', { type: 'FIELD_CHANGED', field: 'PRIORITY' }),
  trig('FIELD_CHANGED TITLE (no event)', {
    type: 'FIELD_CHANGED',
    field: 'TITLE',
  }),
  trig('FIELD_CHANGED custom ok', {
    type: 'FIELD_CHANGED',
    customFieldId: 'f_num',
  }),
  trig('FIELD_CHANGED custom bad', {
    type: 'FIELD_CHANGED',
    customFieldId: 'zz',
  }),
  trig('FIELD_CHANGED both (invalid)', {
    type: 'FIELD_CHANGED',
    field: 'PRIORITY',
    customFieldId: 'f_num',
  }),
  trig('DUE_APPROACHING', {
    type: 'DUE_APPROACHING',
    offset: { amount: 2, unit: 'DAYS' },
  }),
  trig('DUE_APPROACHING too long', {
    type: 'DUE_APPROACHING',
    offset: { amount: 91, unit: 'DAYS' },
  }),
  trig('EXTERNAL_LINK_STATE_CHANGED', {
    type: 'EXTERNAL_LINK_STATE_CHANGED',
    provider: 'GITHUB',
    kind: 'PR',
    state: 'merged',
  }),
  trig('COMMENT_ADDED', {
    type: 'COMMENT_ADDED',
    contains: 'ship',
    by: 'ANYONE',
  }),
  trig('COMMENT_ADDED bare', { type: 'COMMENT_ADDED' }),
  trig('TASK_ARCHIVED', { type: 'TASK_ARCHIVED' }),
  trig('TASK_RESTORED', { type: 'TASK_RESTORED' }),
  trig('ALL_SUBTASKS_DONE', { type: 'ALL_SUBTASKS_DONE' }),
  trig('TASK_OVERDUE', { type: 'TASK_OVERDUE', afterHours: 24 }),
  trig('SCHEDULE daily', { type: 'SCHEDULE', frequency: 'DAILY', hour: 9 }),
  trig('SCHEDULE weekly', {
    type: 'SCHEDULE',
    frequency: 'WEEKLY',
    hour: 9,
    weekdays: [1, 3],
  }),
  trig('SCHEDULE weekly missing days', {
    type: 'SCHEDULE',
    frequency: 'WEEKLY',
    hour: 9,
  }),
  trig('SCHEDULE monthly', {
    type: 'SCHEDULE',
    frequency: 'MONTHLY',
    hour: 0,
    dayOfMonth: 15,
  }),
  trig('unknown trigger', { type: 'NOPE' }),
  // ---------------- actions
  act('SET_STATUS id ok', {
    type: 'SET_STATUS',
    status: { statusId: 's_done' },
  }),
  act('SET_STATUS id bad', { type: 'SET_STATUS', status: { statusId: 'zz' } }),
  act('SET_STATUS category', {
    type: 'SET_STATUS',
    status: { category: 'DONE' },
  }),
  act('SET_PRIORITY', { type: 'SET_PRIORITY', priority: 'HIGH' }),
  act('SET_PRIORITY clear', { type: 'SET_PRIORITY', priority: null }),
  act('ASSIGN SET', {
    type: 'ASSIGN',
    mode: 'SET',
    users: ['u1', 'TRIGGERER', 'CREATOR'],
  }),
  act('ASSIGN ADD bad user', { type: 'ASSIGN', mode: 'ADD', users: ['zz'] }),
  act('ASSIGN REMOVE', { type: 'ASSIGN', mode: 'REMOVE', users: ['u1'] }),
  act('ASSIGN ADD empty', { type: 'ASSIGN', mode: 'ADD', users: [] }),
  act('SET_DUE_DATE', { type: 'SET_DUE_DATE', inDays: 3 }),
  act('SET_DUE_DATE from due', {
    type: 'SET_DUE_DATE',
    inDays: -2,
    from: 'DUE_DATE',
  }),
  act('SET_DUE_DATE negative now', {
    type: 'SET_DUE_DATE',
    inDays: -2,
    from: 'NOW',
  }),
  act('SET_DUE_DATE clear', { type: 'SET_DUE_DATE', inDays: null }),
  act('SET_CUSTOM_FIELD number', {
    type: 'SET_CUSTOM_FIELD',
    customFieldId: 'f_num',
    value: 5,
  }),
  act('SET_CUSTOM_FIELD mismatch', {
    type: 'SET_CUSTOM_FIELD',
    customFieldId: 'f_num',
    value: 'x',
  }),
  act('SET_CUSTOM_FIELD unknown', {
    type: 'SET_CUSTOM_FIELD',
    customFieldId: 'zz',
    value: 1,
  }),
  act('SET_CUSTOM_FIELD user ok', {
    type: 'SET_CUSTOM_FIELD',
    customFieldId: 'f_user',
    value: ['u1', 'TRIGGERER'],
  }),
  act('SET_CUSTOM_FIELD user bad', {
    type: 'SET_CUSTOM_FIELD',
    customFieldId: 'f_user',
    value: ['zz'],
  }),
  act('SET_CUSTOM_FIELD select', {
    type: 'SET_CUSTOM_FIELD',
    customFieldId: 'f_sel',
    value: 'red',
  }),
  act('SET_CUSTOM_FIELD clear', {
    type: 'SET_CUSTOM_FIELD',
    customFieldId: 'f_text',
    value: null,
  }),
  act('ADD_TAG ok', { type: 'ADD_TAG', tagId: 't1' }),
  act('ADD_TAG bad', { type: 'ADD_TAG', tagId: 'zz' }),
  act('REMOVE_TAG', { type: 'REMOVE_TAG', tagId: 't1' }),
  act('COMMENT', {
    type: 'COMMENT',
    body: 'Hi {{task.title}} from {{actor.name}}',
  }),
  act('COMMENT bad placeholder', { type: 'COMMENT', body: 'Hi {{nope}}' }),
  act('CREATE_SUBTASK', {
    type: 'CREATE_SUBTASK',
    title: 'Sub of {{task.key}}',
    priority: 'LOW',
    assignees: ['u1', 'CREATOR', 'zz'],
  }),
  act('NOTIFY_CHANNEL', {
    type: 'NOTIFY_CHANNEL',
    channelLinkId: 'ch1',
    message: 'ping',
  }),
  act('CREATE_TASK full', {
    type: 'CREATE_TASK',
    title: 'T {{date}}',
    description: 'D',
    priority: 'HIGH',
    dueInDays: 4,
    tags: ['t1', 'zz'],
    assignees: ['u2', 'TRIGGERER'],
    status: { statusId: 's_todo' },
  }),
  act('RENAME_TASK', { type: 'RENAME_TASK', title: 'New {{task.title}}' }),
  act('SET_DESCRIPTION replace', {
    type: 'SET_DESCRIPTION',
    text: 'x',
    mode: 'REPLACE',
  }),
  act('SET_DESCRIPTION append', {
    type: 'SET_DESCRIPTION',
    text: 'x',
    mode: 'APPEND',
  }),
  act('SET_ESTIMATE', { type: 'SET_ESTIMATE', estimate: 3 }),
  act('SET_ESTIMATE clear', { type: 'SET_ESTIMATE', estimate: null }),
  act('SET_ISSUE_TYPE ok', { type: 'SET_ISSUE_TYPE', issueTypeId: 'it1' }),
  act('SET_ISSUE_TYPE bad', { type: 'SET_ISSUE_TYPE', issueTypeId: 'zz' }),
  act('SET_ISSUE_TYPE clear', { type: 'SET_ISSUE_TYPE', issueTypeId: null }),
  act('SET_ITERATION ok', { type: 'SET_ITERATION', iterationId: 'i1' }),
  act('SET_ITERATION bad', { type: 'SET_ITERATION', iterationId: 'zz' }),
  act('SET_ITERATION clear', { type: 'SET_ITERATION', iterationId: null }),
  act('CHANGE_PRIORITY up', { type: 'CHANGE_PRIORITY', direction: 'UP' }),
  act('CHANGE_PRIORITY down', { type: 'CHANGE_PRIORITY', direction: 'DOWN' }),
  act('SET_START_DATE', { type: 'SET_START_DATE', inDays: 1 }),
  act('SET_START_DATE from due', {
    type: 'SET_START_DATE',
    inDays: -1,
    from: 'DUE_DATE',
  }),
  act('ARCHIVE_TASK', { type: 'ARCHIVE_TASK' }),
  act('RESTORE_TASK', { type: 'RESTORE_TASK' }),
  act('unknown action', { type: 'NOPE' }),
  // ---------------- whole-rule checks
  {
    name: 'conditions: every field',
    rule: {
      trigger: { type: 'TASK_CREATED' },
      conditions: {
        all: [
          { field: 'STATUS_CATEGORY', op: 'IN', value: ['TODO'] },
          { field: 'STATUS', op: 'IN', value: ['s_todo', 'zz'] },
          { field: 'PRIORITY', op: 'IN', value: ['HIGH'] },
          {
            field: 'ASSIGNEES',
            op: 'INCLUDES_ANY',
            value: ['u1', 'TRIGGERER', 'zz'],
          },
          { field: 'TAGS', op: 'HAS_ANY', value: ['t1', 'zz'] },
          { field: 'ISSUE_TYPE', op: 'IN', value: ['it1', 'zz'] },
          { field: 'PROJECT', op: 'IN', value: ['p1', 'zz'] },
          { field: 'ESTIMATE', op: 'GT', value: 2 },
          { field: 'DUE_DATE', op: 'IS_SET' },
          { field: 'IS_SUBTASK', op: 'IS_FALSE' },
          { field: 'CUSTOM', op: 'GT', value: 3, customFieldId: 'f_num' },
          {
            field: 'CUSTOM',
            op: 'INCLUDES_ANY',
            value: ['u1', 'zz'],
            customFieldId: 'f_user',
          },
          { field: 'CUSTOM', op: 'EQ', value: 'x', customFieldId: 'zz' },
        ],
      },
      actions: [{ type: 'CREATE_TASK', title: 'x' }],
    },
  },
  {
    name: 'recursion: TASK_CREATED -> CREATE_SUBTASK unguarded',
    rule: withTrigger({ type: 'TASK_CREATED' }, [
      { type: 'CREATE_SUBTASK', title: 's' },
    ]),
  },
  {
    name: 'recursion: TASK_CREATED -> CREATE_SUBTASK guarded',
    rule: {
      trigger: { type: 'TASK_CREATED' },
      conditions: { all: [{ field: 'IS_SUBTASK', op: 'IS_FALSE' }] },
      actions: [{ type: 'CREATE_SUBTASK', title: 's' }],
    },
  },
  {
    name: 'recursion: TASK_CREATED -> CREATE_TASK no conditions',
    rule: withTrigger({ type: 'TASK_CREATED' }, [
      { type: 'CREATE_TASK', title: 's' },
    ]),
  },
  {
    name: 'SCHEDULE with a task action',
    rule: withTrigger({ type: 'SCHEDULE', frequency: 'DAILY', hour: 1 }, [
      { type: 'ADD_TAG', tagId: 't1' },
    ]),
  },
  {
    name: 'SCHEDULE with conditions and task placeholder',
    rule: {
      trigger: { type: 'SCHEDULE', frequency: 'DAILY', hour: 1 },
      conditions: { all: [{ field: 'IS_SUBTASK', op: 'IS_FALSE' }] },
      actions: [
        {
          type: 'CREATE_TASK',
          title: '{{task.title}}',
          description: '{{actor.name}}',
        },
      ],
    },
  },
  {
    name: 'ten mixed actions',
    rule: {
      trigger: { type: 'STATUS_CHANGED' },
      actions: [
        { type: 'SET_STATUS', status: { statusId: 's_done' } },
        { type: 'ASSIGN', mode: 'ADD', users: ['u1'] },
        { type: 'ADD_TAG', tagId: 't1' },
        { type: 'REMOVE_TAG', tagId: 'zz' },
        { type: 'SET_ITERATION', iterationId: 'i1' },
        { type: 'SET_ISSUE_TYPE', issueTypeId: 'it1' },
        { type: 'SET_CUSTOM_FIELD', customFieldId: 'f_user', value: ['u2'] },
        { type: 'COMMENT', body: 'done' },
        { type: 'CREATE_SUBTASK', title: 'follow up', assignees: ['u2'] },
        { type: 'ARCHIVE_TASK' },
      ],
    },
  },
];

const sorted = (s: Set<string>) => [...s].sort();

/** what the rule surface says about one rule, as plain JSON */
function surface(rule: Record<string, unknown>) {
  const v = validateRule(rule);
  if (v.ok === false) return { valid: false as const, issues: v.issues };
  const refs = collectReferences(v.rule);
  const calls: string[] = [];
  const walker = new RefWalker((kind, value, p) => {
    calls.push(`${kind}:${value}@${p}`);
    return `<${kind}:${value}>`;
  });
  const walked = walker.rule(v.rule);
  const typeOf = (id: string) => ctx().customFields.get(id)?.dataType;
  return {
    valid: true as const,
    triggerType: v.triggerType,
    unsupported: v.unsupported,
    refs: {
      statusIds: sorted(refs.statusIds),
      tagIds: sorted(refs.tagIds),
      issueTypeIds: sorted(refs.issueTypeIds),
      projectIds: sorted(refs.projectIds),
      customFieldIds: sorted(refs.customFieldIds),
      userIds: sorted(refs.userIds),
      iterationIds: sorted(refs.iterationIds),
    },
    customUserIds: collectCustomUserIds(v.rule, typeOf),
    semanticInProject: checkRuleSemantics(v.rule, 'p1', ctx()),
    semanticWorkspaceWide: checkRuleSemantics(v.rule, null, ctx()),
    walked,
    walkerCalls: calls,
    walkerIssues: walker.issues,
  };
}

// ------------------------------------------------------------------ executor calls -------------
const RUN: ActionRun = {
  ruleId: 'rule1',
  writeDepth: 2,
  workspaceId: 'w1',
  projectId: 'p1',
  taskId: 'task1',
  createdById: 'creator1',
  triggererId: 'trig1',
  actorId: 'system1',
  vars: {
    'task.title': 'Fix it',
    'task.key': 'ABC-1',
    'actor.name': 'Ann',
    date: '2026-10-26',
  },
};

function recorder(
  log: unknown[],
  name: string,
  results: Record<string, unknown> = {},
) {
  return new Proxy(
    {},
    {
      get:
        (_t, method: string) =>
        async (...args: unknown[]) => {
          log.push({ call: `${name}.${method}`, args });
          return results[method] ?? { id: 'new1' };
        },
    },
  );
}

async function executorCalls(
  action: Record<string, unknown>,
  taskRow: Record<string, unknown>,
) {
  const log: unknown[] = [];
  const prisma = {
    task: {
      findUnique: async (q: unknown) => {
        log.push({ call: 'prisma.task.findUnique', args: [q] });
        return taskRow;
      },
    },
  };
  const ex = new ActionExecutor(
    prisma as never,
    recorder(log, 'tasks') as never,
    recorder(log, 'tags') as never,
    recorder(log, 'customFields') as never,
    recorder(log, 'comments') as never,
    recorder(log, 'domainWriter') as never,
    {} as never, // the task query: no loop in these tests
    {} as never, // the notifier
  );
  const result = await ex.execute([action as never], RUN);
  return { result, log };
}

const TASK_ROW = {
  dueDate: new Date('2026-11-01T10:30:00.000Z'),
  assignees: [{ id: 'u9' }, { id: 'u1' }],
  description: 'old text',
  priority: 'MEDIUM',
};

describe('rule surface golden (step 5.8: the registry must not change any of this)', () => {
  beforeAll(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-26T12:00:00.000Z'));
  });
  afterAll(() => jest.useRealTimers());

  it('matches the recorded behaviour', async () => {
    const out: Record<string, unknown> = {};
    for (const f of FIXTURES) {
      const entry: Record<string, unknown> = { surface: surface(f.rule) };
      const a = (f.rule.actions as Array<Record<string, unknown>>)[0];
      if (
        f.name.startsWith('action ') &&
        typeof a.type === 'string' &&
        a.type !== 'NOPE'
      )
        entry.executor = await executorCalls(a, TASK_ROW);
      out[f.name] = entry;
    }
    // priority edges and an action with no due date to count from
    out['executor CHANGE_PRIORITY at top'] = await executorCalls(
      { type: 'CHANGE_PRIORITY', direction: 'UP' },
      { ...TASK_ROW, priority: 'URGENT' },
    );
    out['executor CHANGE_PRIORITY unset down'] = await executorCalls(
      { type: 'CHANGE_PRIORITY', direction: 'DOWN' },
      { ...TASK_ROW, priority: null },
    );
    out['executor CHANGE_PRIORITY unset up'] = await executorCalls(
      { type: 'CHANGE_PRIORITY', direction: 'UP' },
      { ...TASK_ROW, priority: null },
    );
    out['executor SET_DUE_DATE from missing due'] = await executorCalls(
      { type: 'SET_DUE_DATE', inDays: 1, from: 'DUE_DATE' },
      { ...TASK_ROW, dueDate: null },
    );
    out['executor ASSIGN no-op'] = await executorCalls(
      { type: 'ASSIGN', mode: 'ADD', users: ['u1'] },
      TASK_ROW,
    );
    out['executor SET_DESCRIPTION too long'] = await executorCalls(
      { type: 'SET_DESCRIPTION', text: 'y'.repeat(100), mode: 'APPEND' },
      { ...TASK_ROW, description: 'x'.repeat(9_950) },
    );
    const json = JSON.stringify(out, null, 1) + '\n';
    if (process.env.UPDATE_GOLDEN === '1') {
      fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
      fs.writeFileSync(GOLDEN, json);
    }
    expect(fs.existsSync(GOLDEN)).toBe(true);
    expect(json).toBe(fs.readFileSync(GOLDEN, 'utf8'));
  });

  it('trigger matching is recorded too', () => {
    const events = [
      { kind: 'TASK_CREATED' },
      {
        kind: 'STATUS_CHANGED',
        statusChange: {
          fromStatusId: 's_todo',
          fromCategory: 'TODO',
          toStatusId: 's_done',
          toCategory: 'DONE',
        },
      },
      { kind: 'FIELD_CHANGED', field: 'PRIORITY' },
      { kind: 'FIELD_CHANGED', field: 'TAGS' },
      { kind: 'DUE_APPROACHING' },
      {
        kind: 'COMMENT_ADDED',
        comment: { text: 'Please SHIP it', byAutomation: false },
      },
      { kind: 'COMMENT_ADDED', comment: { text: 'ship', byAutomation: true } },
      { kind: 'TASK_ARCHIVED' },
      { kind: 'TASK_RESTORED' },
      { kind: 'ALL_SUBTASKS_DONE' },
      { kind: 'TASK_OVERDUE' },
      { kind: 'SCHEDULE' },
    ];
    const triggers = FIXTURES.filter(
      (f) =>
        f.name.startsWith('trigger ') && f.name !== 'trigger unknown trigger',
    ).map((f) => f.rule.trigger as never);
    const table = triggers.map((t) => ({
      trigger: t,
      fires: events.map((e) => matchesTrigger(t, e as never)),
    }));
    const file = path.join(
      __dirname,
      '__golden__',
      'trigger-match.golden.json',
    );
    const json = JSON.stringify(table, null, 1) + '\n';
    if (process.env.UPDATE_GOLDEN === '1') fs.writeFileSync(file, json);
    expect(json).toBe(fs.readFileSync(file, 'utf8'));
  });
});
