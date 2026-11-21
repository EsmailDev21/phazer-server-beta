import { FieldType, TaskStatus } from '@prisma/client';
import {
  checkRuleSemantics,
  collectCustomUserIds,
  collectReferences,
} from './rule.semantic';
import { RuleV1, WorkspaceRuleContext } from './rule.types';
import { validateRule } from './rule.validator';

const ctx = (
  over: Partial<WorkspaceRuleContext> = {},
): WorkspaceRuleContext => ({
  projectIds: new Set(['p1', 'p2']),
  statuses: new Map([
    ['s_todo', { projectId: 'p1', category: TaskStatus.TODO }],
    ['s_done', { projectId: 'p1', category: TaskStatus.DONE }],
    ['s_other', { projectId: 'p2', category: TaskStatus.DONE }],
  ]),
  tagIds: new Set(['t1']),
  issueTypeIds: new Set(['it1']),
  iterationIds: new Set(),
  customFields: new Map<
    string,
    { dataType: FieldType; options: string[] | null }
  >([
    ['f_num', { dataType: FieldType.NUMBER, options: null }],
    ['f_sel', { dataType: FieldType.SELECT, options: ['red', 'blue'] }],
    ['f_multi', { dataType: FieldType.MULTI_SELECT, options: ['a', 'b'] }],
    ['f_date', { dataType: FieldType.DATE, options: null }],
    ['f_check', { dataType: FieldType.CHECKBOX, options: null }],
    ['f_user', { dataType: FieldType.USER, options: null }],
    ['f_url', { dataType: FieldType.URL, options: null }],
    ['f_text', { dataType: FieldType.TEXT, options: null }],
  ]),
  validUserIds: new Set(['u1']),
  ...over,
});
const rule = (r: Record<string, unknown>): RuleV1 => {
  const v = validateRule({
    trigger: { type: 'TASK_CREATED' },
    actions: [{ type: 'ADD_TAG', tagId: 't1' }],
    ...r,
  });
  if (v.ok === false) throw new Error(JSON.stringify(v.issues));
  return v.rule;
};
const codes = (r: RuleV1, scope: string | null = 'p1', c = ctx()) =>
  checkRuleSemantics(r, scope, c).map((i) => `${i.code}@${i.path}`);

describe('automation rules against a workspace', () => {
  it('a rule whose ids all exist has no issues', () => {
    expect(
      codes(
        rule({
          trigger: { type: 'STATUS_CHANGED', to: [{ statusId: 's_done' }] },
          conditions: {
            all: [
              { field: 'TAGS', op: 'HAS_ANY', value: ['t1'] },
              {
                field: 'ASSIGNEES',
                op: 'INCLUDES_ANY',
                value: ['u1', 'TRIGGERER'],
              },
            ],
          },
          actions: [
            { type: 'SET_STATUS', status: { statusId: 's_todo' } },
            { type: 'ASSIGN', mode: 'ADD', users: ['CREATOR'] },
          ],
        }),
      ),
    ).toEqual([]);
  });

  describe('statuses are per project', () => {
    it('a workspace-wide rule may name categories but not a specific status', () => {
      expect(
        codes(
          rule({
            actions: [{ type: 'SET_STATUS', status: { category: 'DONE' } }],
          }),
          null,
        ),
      ).toEqual([]);
      expect(
        codes(
          rule({
            actions: [{ type: 'SET_STATUS', status: { statusId: 's_done' } }],
          }),
          null,
        ),
      ).toEqual(['STATUS_NEEDS_PROJECT@/actions/0/status/statusId']);
      expect(
        codes(
          rule({
            trigger: { type: 'STATUS_CHANGED', to: [{ statusId: 's_done' }] },
          }),
          null,
        ),
      ).toEqual(['STATUS_NEEDS_PROJECT@/trigger/to/0/statusId']);
    });
    it("a project rule cannot name another project's status or a missing one", () => {
      expect(
        codes(
          rule({
            actions: [{ type: 'SET_STATUS', status: { statusId: 's_other' } }],
          }),
        ),
      ).toEqual(['UNKNOWN_STATUS@/actions/0/status/statusId']);
      expect(
        codes(
          rule({
            actions: [{ type: 'SET_STATUS', status: { statusId: 'nope' } }],
          }),
        ),
      ).toEqual(['UNKNOWN_STATUS@/actions/0/status/statusId']);
      expect(
        codes(
          rule({
            conditions: {
              all: [
                { field: 'STATUS', op: 'IN', value: ['s_todo', 's_other'] },
              ],
            },
          }),
        ),
      ).toEqual(['UNKNOWN_STATUS@/conditions/all/0/value/1']);
    });
  });

  it('flags every unknown reference with its path', () => {
    const r = rule({
      trigger: { type: 'FIELD_CHANGED', customFieldId: 'gone' },
      conditions: {
        any: [
          { field: 'TAGS', op: 'HAS_ANY', value: ['t1', 'nope'] },
          { field: 'ISSUE_TYPE', op: 'IN', value: ['bad'] },
          { field: 'PROJECT', op: 'IN', value: ['p9'] },
          { field: 'ASSIGNEES', op: 'INCLUDES_ANY', value: ['ghost'] },
        ],
      },
      actions: [
        { type: 'ADD_TAG', tagId: 'x' },
        { type: 'REMOVE_TAG', tagId: 'y' },
        { type: 'ASSIGN', mode: 'SET', users: ['ghost2'] },
        { type: 'CREATE_SUBTASK', title: 't', assignees: ['ghost3'] },
      ],
    });
    expect(codes(r)).toEqual([
      'UNKNOWN_CUSTOM_FIELD@/trigger/customFieldId',
      'UNKNOWN_TAG@/conditions/any/0/value/1',
      'UNKNOWN_ISSUE_TYPE@/conditions/any/1/value/0',
      'UNKNOWN_PROJECT@/conditions/any/2/value/0',
      'UNKNOWN_USER@/conditions/any/3/value/0',
      'UNKNOWN_TAG@/actions/0/tagId',
      'UNKNOWN_TAG@/actions/1/tagId',
      'UNKNOWN_USER@/actions/2/users/0',
      'UNKNOWN_USER@/actions/3/assignees/0',
    ]);
  });

  describe('custom fields: operator and value must fit the field type', () => {
    const cond = (customFieldId: string, op: string, value?: unknown) =>
      rule({
        conditions: { all: [{ field: 'CUSTOM', customFieldId, op, value }] },
      });
    it.each([
      ['f_num', 'GT', 5, []],
      ['f_num', 'CONTAINS', 'x', ['OPERATOR_MISMATCH@/conditions/all/0/op']],
      ['f_num', 'EQ', 'five', ['VALUE_MISMATCH@/conditions/all/0/value']],
      ['f_sel', 'EQ', 'red', []],
      ['f_sel', 'IN', ['red', 'blue'], []],
      ['f_sel', 'EQ', 'green', ['VALUE_MISMATCH@/conditions/all/0/value']],
      ['f_multi', 'HAS_ALL', ['a'], []],
      ['f_multi', 'HAS_ANY', ['z'], ['VALUE_MISMATCH@/conditions/all/0/value']],
      ['f_multi', 'EQ', 'a', ['OPERATOR_MISMATCH@/conditions/all/0/op']],
      ['f_date', 'LT', '2026-10-17', []],
      [
        'f_date',
        'LT',
        '17/10/2026',
        ['VALUE_MISMATCH@/conditions/all/0/value'],
      ],
      [
        'f_date',
        'LT',
        '2026-13-45',
        ['VALUE_MISMATCH@/conditions/all/0/value'],
      ],
      [
        'f_date',
        'LT',
        '2026-02-30',
        ['VALUE_MISMATCH@/conditions/all/0/value'],
      ],
      ['f_date', 'LT', '2028-02-29', []],
      ['f_check', 'IS_TRUE', undefined, []],
      ['f_check', 'EQ', true, ['OPERATOR_MISMATCH@/conditions/all/0/op']],
      ['f_user', 'INCLUDES_ANY', ['u1'], []],
      [
        'f_user',
        'INCLUDES_ANY',
        ['ghost'],
        ['VALUE_MISMATCH@/conditions/all/0/value'],
      ],
      ['f_url', 'EQ', 'https://example.com', []],
      [
        'f_url',
        'EQ',
        'javascript:alert(1)',
        ['VALUE_MISMATCH@/conditions/all/0/value'],
      ],
      ['f_text', 'CONTAINS', 'abc', []],
      ['f_text', 'IS_SET', undefined, []],
      [
        'missing',
        'EQ',
        'x',
        ['UNKNOWN_CUSTOM_FIELD@/conditions/all/0/customFieldId'],
      ],
    ] as const)('%s %s %j', (field, op, value, expected) => {
      expect(codes(cond(field, op, value))).toEqual(expected);
    });

    it('SET_CUSTOM_FIELD checks the value type; null clears any field', () => {
      const set = (customFieldId: string, value: unknown) =>
        rule({ actions: [{ type: 'SET_CUSTOM_FIELD', customFieldId, value }] });
      expect(codes(set('f_num', 3))).toEqual([]);
      expect(codes(set('f_num', 'x'))).toEqual([
        'VALUE_MISMATCH@/actions/0/value',
      ]);
      expect(codes(set('f_sel', 'green'))).toEqual([
        'VALUE_MISMATCH@/actions/0/value',
      ]);
      expect(codes(set('f_multi', ['a', 'b']))).toEqual([]);
      expect(codes(set('f_num', ['1']))).toEqual([
        'VALUE_MISMATCH@/actions/0/value',
      ]);
      expect(codes(set('f_check', true))).toEqual([]);
      expect(codes(set('f_user', 'ghost'))).toEqual([
        'VALUE_MISMATCH@/actions/0/value',
      ]);
      expect(codes(set('f_date', '2026-02-30'))).toEqual([
        'VALUE_MISMATCH@/actions/0/value',
      ]);
      for (const f of [
        'f_num',
        'f_sel',
        'f_multi',
        'f_date',
        'f_check',
        'f_user',
        'f_url',
        'f_text',
      ])
        expect(codes(set(f, null))).toEqual([]);
    });
  });

  describe('a rule must not create what triggers it', () => {
    const sub = { type: 'CREATE_SUBTASK', title: 'Follow up' };
    it('TASK_CREATED -> CREATE_SUBTASK is refused unless limited to non-subtasks', () => {
      expect(codes(rule({ actions: [sub] }))).toEqual([
        'UNBOUNDED_RECURSION@/actions/0',
      ]);
      expect(
        codes(
          rule({
            conditions: { all: [{ field: 'IS_SUBTASK', op: 'IS_FALSE' }] },
            actions: [sub],
          }),
        ),
      ).toEqual([]);
      // "any" does not guard: the rule could still match a subtask
      expect(
        codes(
          rule({
            conditions: { any: [{ field: 'IS_SUBTASK', op: 'IS_FALSE' }] },
            actions: [sub],
          }),
        ),
      ).toEqual(['UNBOUNDED_RECURSION@/actions/0']);
      // other triggers are not recursive by themselves
      expect(
        codes(rule({ trigger: { type: 'STATUS_CHANGED' }, actions: [sub] })),
      ).toEqual([]);
    });
  });

  describe('collecting references', () => {
    it('lists exactly the ids a rule mentions, special users excluded', () => {
      const r = rule({
        trigger: {
          type: 'STATUS_CHANGED',
          from: [{ statusId: 'sa' }],
          to: [{ category: 'DONE' }, { statusId: 'sb' }],
        },
        conditions: {
          all: [
            { field: 'TAGS', op: 'HAS_ANY', value: ['t1'] },
            { field: 'ISSUE_TYPE', op: 'IN', value: ['it1'] },
            { field: 'PROJECT', op: 'IN', value: ['p1'] },
            {
              field: 'ASSIGNEES',
              op: 'INCLUDES_ANY',
              value: ['u1', 'TRIGGERER'],
            },
            {
              field: 'CUSTOM',
              customFieldId: 'f_user',
              op: 'INCLUDES_ANY',
              value: ['u2', 'CREATOR'],
            },
          ],
        },
        actions: [
          { type: 'SET_STATUS', status: { statusId: 'sc' } },
          { type: 'ADD_TAG', tagId: 't2' },
          { type: 'ASSIGN', mode: 'ADD', users: ['u3', 'CREATOR'] },
          { type: 'SET_CUSTOM_FIELD', customFieldId: 'f_user', value: 'u4' },
        ],
      });
      const refs = collectReferences(r);
      expect([...refs.statusIds].sort()).toEqual(['sa', 'sb', 'sc']);
      expect([...refs.tagIds].sort()).toEqual(['t1', 't2']);
      expect([...refs.issueTypeIds]).toEqual(['it1']);
      expect([...refs.projectIds]).toEqual(['p1']);
      expect([...refs.customFieldIds].sort()).toEqual(['f_user']);
      expect([...refs.userIds].sort()).toEqual(['u1', 'u3']);
      expect(
        collectCustomUserIds(
          r,
          (id) => ctx().customFields.get(id)?.dataType,
        ).sort(),
      ).toEqual(['u2', 'u4']);
    });
  });
});

describe('richer actions against a workspace (step 5.6)', () => {
  const c = (over: Record<string, unknown>, scope: string | null = 'p1') => {
    const v = validateRule({
      trigger: { type: 'TASK_CREATED' },
      conditions: { all: [{ field: 'IS_SUBTASK', op: 'IS_FALSE' }] },
      actions: [{ type: 'ADD_TAG', tagId: 't1' }],
      ...over,
    });
    if (v.ok === false) throw new Error(JSON.stringify(v.issues));
    return checkRuleSemantics(v.rule, scope, {
      ...ctx(),
      iterationIds: new Set(['i1']),
    }).map((i) => `${i.code}@${i.path}`);
  };
  it("CREATE_TASK: its tags, people and status are checked like any rule's", () => {
    expect(
      c({
        actions: [
          {
            type: 'CREATE_TASK',
            title: 'x',
            tags: ['t1'],
            assignees: ['u1', 'CREATOR'],
            status: { statusId: 's_todo' },
          },
        ],
      }),
    ).toEqual([]);
    expect(
      c({
        actions: [
          {
            type: 'CREATE_TASK',
            title: 'x',
            tags: ['nope'],
            assignees: ['ghost'],
            status: { statusId: 's_other' },
          },
        ],
      }),
    ).toEqual([
      'UNKNOWN_TAG@/actions/0/tags/0',
      'UNKNOWN_USER@/actions/0/assignees/0',
      'UNKNOWN_STATUS@/actions/0/status/statusId',
    ]);
    expect(
      c(
        {
          actions: [
            { type: 'CREATE_TASK', title: 'x', status: { statusId: 's_todo' } },
          ],
        },
        null,
      ),
    ).toEqual(['STATUS_NEEDS_PROJECT@/actions/0/status/statusId']);
  });
  it('SET_ISSUE_TYPE and SET_ITERATION need real ones; null clears', () => {
    expect(
      c({
        actions: [
          { type: 'SET_ISSUE_TYPE', issueTypeId: 'it1' },
          { type: 'SET_ITERATION', iterationId: 'i1' },
        ],
      }),
    ).toEqual([]);
    expect(
      c({
        actions: [
          { type: 'SET_ISSUE_TYPE', issueTypeId: null },
          { type: 'SET_ITERATION', iterationId: null },
        ],
      }),
    ).toEqual([]);
    expect(
      c({
        actions: [
          { type: 'SET_ISSUE_TYPE', issueTypeId: 'gone' },
          { type: 'SET_ITERATION', iterationId: 'gone' },
        ],
      }),
    ).toEqual([
      'UNKNOWN_ISSUE_TYPE@/actions/0/issueTypeId',
      'UNKNOWN_ITERATION@/actions/1/iterationId',
    ]);
  });
  it('a scheduled rule needs a project to create its tasks in', () => {
    const rule = {
      trigger: { type: 'SCHEDULE', frequency: 'DAILY', hour: 9 },
      conditions: undefined,
      actions: [{ type: 'CREATE_TASK', title: 'Daily' }],
    };
    expect(c(rule, 'p1')).toEqual([]);
    expect(c(rule, null)).toEqual(['SCHEDULE_NEEDS_PROJECT@/trigger']);
  });
  it('"a task for every new task" needs a condition saying which; with one it is fine', () => {
    const open = {
      trigger: { type: 'TASK_CREATED' },
      actions: [{ type: 'CREATE_TASK', title: 'Follow up' }],
    };
    expect(c({ ...open, conditions: undefined })).toEqual([
      'UNBOUNDED_RECURSION@/actions/0',
    ]);
    expect(
      c({
        ...open,
        conditions: {
          all: [{ field: 'PRIORITY', op: 'IN', value: ['URGENT'] }],
        },
      }),
    ).toEqual([]);
    expect(
      c({
        trigger: { type: 'STATUS_CHANGED' },
        conditions: undefined,
        actions: open.actions,
      }),
    ).toEqual([]);
  });
  it('collects the ids the new actions mention', () => {
    const v = validateRule({
      trigger: { type: 'TASK_CREATED' },
      conditions: { all: [{ field: 'IS_SUBTASK', op: 'IS_FALSE' }] },
      actions: [
        {
          type: 'CREATE_TASK',
          title: 'x',
          tags: ['t1', 't2'],
          assignees: ['u1', 'CREATOR'],
          status: { statusId: 's1' },
        },
        { type: 'SET_ISSUE_TYPE', issueTypeId: 'it9' },
        { type: 'SET_ITERATION', iterationId: 'i9' },
        { type: 'SET_ISSUE_TYPE', issueTypeId: null },
      ],
    });
    if (v.ok === false) throw new Error('invalid');
    const r = collectReferences(v.rule);
    expect([...r.tagIds].sort()).toEqual(['t1', 't2']);
    expect([...r.userIds]).toEqual(['u1']);
    expect([...r.statusIds]).toEqual(['s1']);
    expect([...r.issueTypeIds]).toEqual(['it9']);
    expect([...r.iterationIds]).toEqual(['i9']);
  });
});
