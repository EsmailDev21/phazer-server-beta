import { FieldType, TaskStatus } from '@prisma/client';
import {
  contextOf,
  forwardMapper,
  reverseMapper,
  RULE_TOKENS,
  VIEW_TOKENS,
} from './portable.model';
import {
  classifyItem,
  evaluateRuleItem,
  evaluateViewItem,
} from './portable.evaluate';
import { RefWalker } from './portable.refs';
import { EntityModel } from './portable.types';

/** A workspace as ids: what an extractor sees. */
const IDS: EntityModel = {
  tags: [
    { name: 'Needs review', id: 'tagA' },
    { name: 'urgent', id: 'tagB' },
  ],
  issueTypes: [
    { name: 'Bug', id: 'itBug' },
    { name: 'Story', id: 'itStory' },
  ],
  customFields: [
    { key: 'score', id: 'fNum', dataType: FieldType.NUMBER, options: null },
    {
      key: 'colour',
      id: 'fSel',
      dataType: FieldType.SELECT,
      options: ['red', 'blue'],
    },
    { key: 'owner', id: 'fUser', dataType: FieldType.USER, options: null },
    {
      key: 'labels',
      id: 'fMulti',
      dataType: FieldType.MULTI_SELECT,
      options: ['a', 'b'],
    },
  ],
  iterations: [{ nodeKey: 'sprint1', id: 'iter1' }],
  projects: [
    { nodeKey: 'proj', id: 'pid1' },
    { nodeKey: 'other', id: 'pid2' },
  ],
  statuses: [
    {
      projectKey: 'proj',
      key: 'todo',
      id: 'stTodo',
      category: TaskStatus.TODO,
    },
    {
      projectKey: 'proj',
      key: 'review',
      id: 'stReview',
      category: TaskStatus.IN_PROGRESS,
    },
    {
      projectKey: 'proj',
      key: 'done',
      id: 'stDone',
      category: TaskStatus.DONE,
    },
    {
      projectKey: 'other',
      key: 'todo',
      id: 'stOtherTodo',
      category: TaskStatus.TODO,
    },
  ],
};
/** The same workspace as a different one's ids: what an apply sees. */
const OTHER: EntityModel = {
  tags: [
    { name: 'needs   review', id: 'T1' },
    { name: 'Urgent', id: 'T2' },
  ],
  issueTypes: [
    { name: 'BUG', id: 'IT1' },
    { name: 'story', id: 'IT2' },
  ],
  customFields: [
    { key: 'SCORE', id: 'F1', dataType: FieldType.NUMBER, options: null },
    {
      key: 'colour',
      id: 'F2',
      dataType: FieldType.SELECT,
      options: ['red', 'blue'],
    },
    { key: 'owner', id: 'F3', dataType: FieldType.USER, options: null },
    {
      key: 'labels',
      id: 'F4',
      dataType: FieldType.MULTI_SELECT,
      options: ['a', 'b'],
    },
  ],
  iterations: [{ nodeKey: 'sprint1', id: 'I1' }],
  projects: [
    { nodeKey: 'proj', id: 'P1' },
    { nodeKey: 'other', id: 'P2' },
  ],
  statuses: [
    { projectKey: 'proj', key: 'todo', id: 'S1', category: TaskStatus.TODO },
    {
      projectKey: 'proj',
      key: 'review',
      id: 'S2',
      category: TaskStatus.IN_PROGRESS,
    },
    { projectKey: 'proj', key: 'done', id: 'S3', category: TaskStatus.DONE },
    { projectKey: 'other', key: 'todo', id: 'S4', category: TaskStatus.TODO },
  ],
};

/** Uses EVERY position a reference can live in. */
const RICH_RULE = {
  trigger: {
    type: 'STATUS_CHANGED',
    from: [{ statusId: 'stTodo' }, { category: 'BLOCKED' }],
    to: [{ statusId: 'stDone' }],
  },
  conditions: {
    all: [
      { field: 'STATUS', op: 'IN', value: ['stReview'] },
      { field: 'TAGS', op: 'HAS_ANY', value: ['tagA', 'tagB'] },
      { field: 'ISSUE_TYPE', op: 'IN', value: ['itBug'] },
      { field: 'PROJECT', op: 'IN', value: ['pid1'] },
      {
        field: 'ASSIGNEES',
        op: 'INCLUDES_ANY',
        value: ['TRIGGERER', 'CREATOR'],
      },
      { field: 'CUSTOM', customFieldId: 'fNum', op: 'GT', value: 3 },
      {
        field: 'CUSTOM',
        customFieldId: 'fUser',
        op: 'INCLUDES_NONE',
        value: ['CREATOR'],
      },
    ],
    any: [
      { field: 'CUSTOM', customFieldId: 'fSel', op: 'EQ', value: 'red' },
      { field: 'IS_SUBTASK', op: 'IS_FALSE' },
    ],
  },
  actions: [
    { type: 'SET_STATUS', status: { statusId: 'stReview' } },
    { type: 'SET_STATUS', status: { category: 'DONE' } },
    { type: 'ADD_TAG', tagId: 'tagA' },
    { type: 'REMOVE_TAG', tagId: 'tagB' },
    { type: 'SET_CUSTOM_FIELD', customFieldId: 'fSel', value: 'blue' },
    { type: 'ASSIGN', mode: 'ADD', users: ['TRIGGERER'] },
    {
      type: 'CREATE_SUBTASK',
      title: 'Review {{task.title}}',
      assignees: ['CREATOR'],
    },
    { type: 'COMMENT', body: 'Moved {{task.key}} to {{trigger.to}}' },
  ],
};
const RICH_VIEW = {
  filters: {
    all: [
      { field: 'ITERATION', op: 'IN', value: ['iter1'] },
      { field: 'TAGS', op: 'HAS_ALL', value: ['tagA'] },
      { field: 'ASSIGNEES', op: 'INCLUDES_ANY', value: ['ME'] },
      { field: 'CREATED_BY', op: 'IN', value: ['ME'] },
      { field: 'STATUS', op: 'IN', value: ['stTodo'] },
      { field: 'ISSUE_TYPE', op: 'IN', value: ['itStory'] },
      { field: 'PROJECT', op: 'IN', value: ['pid1'] },
      { field: 'CUSTOM', customFieldId: 'fNum', op: 'LT', value: 9 },
    ],
  },
  group: { customFieldId: 'fSel' },
  sort: [
    { customFieldId: 'fNum', dir: 'DESC' },
    { field: 'TITLE', dir: 'ASC' },
  ],
  columns: ['KEY', 'custom:fNum', 'custom:fSel'],
};

const idsOf = (m: EntityModel) => [
  ...m.tags.map((x) => x.id),
  ...m.issueTypes.map((x) => x.id),
  ...m.customFields.map((x) => x.id),
  ...m.iterations.map((x) => x.id),
  ...m.projects.map((x) => x.id),
  ...m.statuses.map((x) => x.id),
];

describe('portable automations and views', () => {
  describe('the reference walker', () => {
    it('extracting names everything: no id survives, tokens stay, and the rest of the document is untouched', () => {
      const w = new RefWalker(reverseMapper(IDS, 'proj', RULE_TOKENS));
      const named = w.rule(RICH_RULE);
      expect(w.issues).toEqual([]);
      const text = JSON.stringify(named);
      for (const id of idsOf(IDS)) expect(text).not.toContain(`"${id}"`);
      expect(text).toContain('"Needs review"');
      expect(text).toContain('"review"');
      expect(text).toContain('"score"');
      expect(text).toContain('"TRIGGERER"');
      expect((named.actions as any[])[6]).toEqual({
        type: 'CREATE_SUBTASK',
        title: 'Review {{task.title}}',
        assignees: ['CREATOR'],
      });
      expect((named.trigger as any).from).toEqual([
        { statusId: 'todo' },
        { category: 'BLOCKED' },
      ]);
    });
    it("rule: extract then apply into a DIFFERENT workspace gives the same rule in that workspace's ids (names folded, keys case-insensitive)", () => {
      const named = new RefWalker(reverseMapper(IDS, 'proj', RULE_TOKENS)).rule(
        RICH_RULE,
      );
      const w = new RefWalker(forwardMapper(OTHER, 'proj', RULE_TOKENS));
      const bound = w.rule(named) as any;
      expect(w.issues).toEqual([]);
      expect(bound.trigger.from[0]).toEqual({ statusId: 'S1' });
      expect(bound.conditions.all[1].value).toEqual(['T1', 'T2']);
      expect(bound.conditions.all[5].customFieldId).toBe('F1');
      expect(bound.actions[0].status).toEqual({ statusId: 'S2' });
      // and back again is the original, with the ids of the first workspace
      const back = new RefWalker(forwardMapper(IDS, 'proj', RULE_TOKENS)).rule(
        named,
      );
      expect(back).toEqual(RICH_RULE);
    });
    it('view config: the same round trip, including custom columns, sort keys and group', () => {
      const named = new RefWalker(
        reverseMapper(IDS, 'proj', VIEW_TOKENS),
      ).viewConfig(RICH_VIEW) as any;
      const text = JSON.stringify(named);
      for (const id of idsOf(IDS)) expect(text).not.toContain(id);
      expect(named.group).toEqual({ customFieldId: 'colour' });
      expect(named.columns).toEqual(['KEY', 'custom:score', 'custom:colour']);
      expect(named.sort[0]).toEqual({ customFieldId: 'score', dir: 'DESC' });
      expect(
        new RefWalker(forwardMapper(IDS, 'proj', VIEW_TOKENS)).viewConfig(
          named,
        ),
      ).toEqual(RICH_VIEW);
      const w = new RefWalker(forwardMapper(OTHER, 'proj', VIEW_TOKENS));
      const bound = w.viewConfig(named) as any;
      expect(w.issues).toEqual([]);
      expect(bound.columns).toEqual(['KEY', 'custom:F1', 'custom:F2']);
    });
    it("what cannot be named is reported with its path: unknown names, people, chat channels, other projects' statuses", () => {
      const w = new RefWalker(reverseMapper(IDS, 'proj', RULE_TOKENS));
      w.rule({
        trigger: { type: 'STATUS_CHANGED', to: [{ statusId: 'stOtherTodo' }] },
        conditions: {
          all: [
            { field: 'ASSIGNEES', op: 'INCLUDES_ANY', value: ['u123'] },
            { field: 'TAGS', op: 'HAS_ANY', value: ['gone'] },
          ],
        },
        actions: [
          { type: 'NOTIFY_CHANNEL', channelLinkId: 'cl1', message: 'x' },
          { type: 'ASSIGN', mode: 'ADD', users: ['u9'] },
        ],
      });
      expect(w.issues.map((i) => `${i.code}@${i.path}`)).toEqual([
        'UNKNOWN_REF@/trigger/to/0/statusId',
        'NOT_PORTABLE@/conditions/all/0/value/0',
        'UNKNOWN_REF@/conditions/all/1/value/0',
        'NOT_PORTABLE@/actions/0/channelLinkId',
        'NOT_PORTABLE@/actions/1/users/0',
      ]);
    });
    it('never mutates its input', () => {
      const copy = JSON.parse(JSON.stringify(RICH_RULE));
      new RefWalker(reverseMapper(IDS, 'proj', RULE_TOKENS)).rule(RICH_RULE);
      new RefWalker(reverseMapper(IDS, 'proj', VIEW_TOKENS)).viewConfig(
        RICH_VIEW,
      );
      expect(RICH_RULE).toEqual(copy);
    });
    it('tolerates shapes it does not know (the validator reports those, not the walker)', () => {
      const w = new RefWalker(forwardMapper(OTHER, 'proj', RULE_TOKENS));
      expect(() =>
        w.rule({ trigger: 5, conditions: 'x', actions: 'y' } as any),
      ).not.toThrow();
      expect(() =>
        w.rule({
          trigger: { type: 'STATUS_CHANGED', to: 'x' },
          conditions: { all: [null, 5, { field: 'TAGS', value: 'x' }] },
          actions: [null, { type: 'ADD_TAG', tagId: 7 }],
        } as any),
      ).not.toThrow();
      expect(() =>
        new RefWalker(forwardMapper(OTHER, 'proj', VIEW_TOKENS)).viewConfig({
          sort: [1, null],
          columns: [3, 'custom:'],
          group: 5,
        } as any),
      ).not.toThrow();
    });
  });

  describe('classifying items', () => {
    it('only an explicit kind makes an item interpretable; everything else stays opaque', () => {
      expect(classifyItem({ kind: 'rule.v1' })).toBe('rule');
      expect(classifyItem({ kind: 'view.v1' })).toBe('view');
      for (const raw of [
        {},
        { kind: 'rule.v2' },
        { kind: 'jira.rule' },
        { trigger: 'x' },
        null,
        'x',
        5,
        [],
      ])
        expect(classifyItem(raw)).toBe('raw');
    });
  });

  describe('evaluating a portable automation against a model', () => {
    const item = (over: Record<string, unknown> = {}) => ({
      kind: 'rule.v1',
      name: 'Close when reviewed',
      trigger: { type: 'STATUS_CHANGED', to: [{ statusId: 'review' }] },
      actions: [{ type: 'ADD_TAG', tagId: 'needs review' }],
      ...over,
    });
    it("binds to the model's ids and passes the same checks a stored rule passes", () => {
      const r = evaluateRuleItem(item(), OTHER, 'proj');
      expect(r.ok).toBe(true);
      if (r.ok && r.kind === 'rule') {
        expect(r.rule.trigger).toEqual({
          type: 'STATUS_CHANGED',
          to: [{ statusId: 'S2' }],
        });
        expect(r.rule.actions).toEqual([{ type: 'ADD_TAG', tagId: 'T1' }]);
        expect(r.triggerType).toBe('STATUS_CHANGED');
        expect(r.unsupported).toEqual([]);
      }
    });
    it('a rule using something this build cannot run yet is still accepted, with it listed', () => {
      const r = evaluateRuleItem(
        item({ trigger: { type: 'FIELD_CHANGED', field: 'TITLE' } }),
        OTHER,
        'proj',
      );
      expect(
        r.ok && r.kind === 'rule' && r.unsupported.map((u) => u.construct),
      ).toEqual(['FIELD_CHANGED(TITLE)']);
    });
    it.each([
      [
        'an unknown tag',
        { actions: [{ type: 'ADD_TAG', tagId: 'nope' }] },
        'UNKNOWN_REF@/actions/0/tagId',
      ],
      [
        'a status of ANOTHER project',
        { trigger: { type: 'STATUS_CHANGED', to: [{ statusId: 'nope' }] } },
        'UNKNOWN_REF@/trigger/to/0/statusId',
      ],
      [
        'a person',
        { actions: [{ type: 'ASSIGN', mode: 'ADD', users: ['someone'] }] },
        'NOT_PORTABLE@/actions/0/users/0',
      ],
      [
        'a chat channel',
        {
          actions: [
            { type: 'NOTIFY_CHANNEL', channelLinkId: 'abc', message: 'm' },
          ],
        },
        'NOT_PORTABLE@/actions/0/channelLinkId',
      ],
      ['an unknown key', { extra: 1 }, 'UNKNOWN_KEY@/extra'],
      ['a missing trigger', { trigger: undefined }, 'MISSING@/trigger'],
      ['a blank name', { name: '   ' }, 'BAD_NAME@/name'],
      [
        'a name with a control character',
        { name: 'a\u0000b' },
        'BAD_NAME@/name',
      ],
      ['a structurally invalid rule', { actions: [] }, 'TOO_FEW@/actions'],
      [
        'a value the field cannot hold',
        {
          actions: [
            {
              type: 'SET_CUSTOM_FIELD',
              customFieldId: 'colour',
              value: 'green',
            },
          ],
        },
        'VALUE_MISMATCH@/actions/0/value',
      ],
      [
        'a person as a custom USER value',
        {
          actions: [
            { type: 'SET_CUSTOM_FIELD', customFieldId: 'owner', value: 'u5' },
          ],
        },
        'VALUE_MISMATCH@/actions/0/value',
      ],
      [
        'a rule that creates what triggers it',
        {
          trigger: { type: 'TASK_CREATED' },
          actions: [{ type: 'CREATE_SUBTASK', title: 't' }],
        },
        'UNBOUNDED_RECURSION@/actions/0',
      ],
    ])('refuses %s', (_l, over, expected) => {
      const r = evaluateRuleItem(item(over), OTHER, 'proj');
      expect(
        r.ok === false && r.issues.map((i) => `${i.code}@${i.path}`),
      ).toContain(expected);
    });
    it('a token is fine, a custom field the apply would SKIP is "unknown"', () => {
      expect(
        evaluateRuleItem(
          item({
            actions: [{ type: 'ASSIGN', mode: 'ADD', users: ['TRIGGERER'] }],
          }),
          OTHER,
          'proj',
        ).ok,
      ).toBe(true);
      const without = {
        ...OTHER,
        customFields: OTHER.customFields.filter((f) => f.key !== 'colour'),
      };
      const r = evaluateRuleItem(
        item({
          actions: [
            { type: 'SET_CUSTOM_FIELD', customFieldId: 'colour', value: 'red' },
          ],
        }),
        without,
        'proj',
      );
      expect(r.ok === false && r.issues[0].code).toBe('UNKNOWN_REF');
    });
    it('a field REUSED with different options is judged by the options it actually has', () => {
      const narrower = {
        ...OTHER,
        customFields: OTHER.customFields.map((f) =>
          f.key === 'colour' ? { ...f, options: ['red'] } : f,
        ),
      };
      const a = item({
        actions: [
          { type: 'SET_CUSTOM_FIELD', customFieldId: 'colour', value: 'blue' },
        ],
      });
      expect(evaluateRuleItem(a, OTHER, 'proj').ok).toBe(true);
      expect(evaluateRuleItem(a, narrower, 'proj').ok).toBe(false);
    });
    it('is deterministic and does not mutate the item', () => {
      const i = item();
      const copy = JSON.parse(JSON.stringify(i));
      expect(JSON.stringify(evaluateRuleItem(i, OTHER, 'proj'))).toBe(
        JSON.stringify(evaluateRuleItem(i, OTHER, 'proj')),
      );
      expect(i).toEqual(copy);
    });
  });

  describe('evaluating a portable view against a model', () => {
    const view = (over: Record<string, unknown> = {}) => ({
      kind: 'view.v1',
      name: 'Open work',
      layout: 'LIST',
      config: {
        filters: {
          all: [{ field: 'ASSIGNEES', op: 'INCLUDES_ANY', value: ['ME'] }],
        },
      },
      ...over,
    });
    it('binds a config and carries the sharing wish', () => {
      const r = evaluateViewItem(
        view({
          shared: true,
          layout: 'BOARD',
          config: {
            group: { customFieldId: 'colour' },
            columns: ['TITLE', 'custom:score'],
          },
        }),
        OTHER,
        'proj',
      );
      expect(
        r.ok && r.kind === 'view' && [r.layout, r.shared, r.config],
      ).toEqual([
        'BOARD',
        true,
        { group: { customFieldId: 'F2' }, columns: ['TITLE', 'custom:F1'] },
      ]);
      expect(
        evaluateViewItem(view(), OTHER, 'proj').ok &&
          (evaluateViewItem(view(), OTHER, 'proj') as any).shared,
      ).toBe(false);
    });
    it('a status by key in a project view; the rule tokens are not valid in a view', () => {
      expect(
        evaluateViewItem(
          view({
            config: {
              filters: {
                all: [{ field: 'STATUS', op: 'IN', value: ['review'] }],
              },
            },
          }),
          OTHER,
          'proj',
        ).ok,
      ).toBe(true);
      const r = evaluateViewItem(
        view({
          config: {
            filters: {
              all: [
                {
                  field: 'ASSIGNEES',
                  op: 'INCLUDES_ANY',
                  value: ['TRIGGERER'],
                },
              ],
            },
          },
        }),
        OTHER,
        'proj',
      );
      expect(r.ok === false && r.issues[0].code).toBe('NOT_PORTABLE');
    });
    it.each([
      ['an unknown layout', { layout: 'GANTT' }, 'BAD_VALUE@/layout'],
      [
        'a calendar without its date',
        { layout: 'CALENDAR', config: {} },
        'MISSING@/config/calendar',
      ],
      [
        'a custom field that cannot be grouped by',
        { config: { group: { customFieldId: 'score' } } },
        'GROUP_TYPE_MISMATCH@/config/group/customFieldId',
      ],
      [
        'an unknown iteration',
        {
          config: {
            filters: {
              all: [{ field: 'ITERATION', op: 'IN', value: ['nope'] }],
            },
          },
        },
        'UNKNOWN_REF@/config/filters/all/0/value/0',
      ],
      ['an unknown key', { bogus: 1 }, 'UNKNOWN_KEY@/bogus'],
      ['a non-boolean shared', { shared: 'yes' }, 'WRONG_TYPE@/shared'],
      ['a blank name', { name: '' }, 'BAD_NAME@/name'],
    ])('refuses %s', (_l, over, expected) => {
      const r = evaluateViewItem(view(over), OTHER, 'proj');
      expect(
        r.ok === false && r.issues.map((i) => `${i.code}@${i.path}`),
      ).toContain(expected);
    });
  });

  it('the context derived from a model knows exactly its entities (and no people)', () => {
    const ctx = contextOf(OTHER);
    expect([...ctx.tagIds].sort()).toEqual(['T1', 'T2']);
    expect(ctx.statuses.get('S4')).toEqual({
      projectId: 'P2',
      category: TaskStatus.TODO,
    });
    expect(ctx.validUserIds.size).toBe(0);
    expect(ctx.customFields.get('F2')).toEqual({
      dataType: FieldType.SELECT,
      options: ['red', 'blue'],
    });
  });
});

describe('the richer actions travel in templates too (step 5.6)', () => {
  const RULE = {
    trigger: { type: 'ALL_SUBTASKS_DONE' },
    actions: [
      {
        type: 'CREATE_TASK',
        title: 'Retro for {{task.title}}',
        tags: ['tagA', 'tagB'],
        assignees: ['CREATOR'],
        status: { statusId: 'stReview' },
      },
      { type: 'SET_ISSUE_TYPE', issueTypeId: 'itBug' },
      { type: 'SET_ITERATION', iterationId: 'iter1' },
      { type: 'SET_ISSUE_TYPE', issueTypeId: null },
      { type: 'SET_ITERATION', iterationId: null },
      { type: 'CHANGE_PRIORITY', direction: 'UP' },
      { type: 'ARCHIVE_TASK' },
    ],
  };
  it("extract names every new reference position; no id survives; applying gives the other workspace's ids", () => {
    const named = new RefWalker(reverseMapper(IDS, 'proj', RULE_TOKENS)).rule(
      RULE,
    ) as any;
    const text = JSON.stringify(named);
    for (const id of idsOf(IDS)) expect(text).not.toContain(`"${id}"`);
    expect(named.actions[0]).toEqual({
      type: 'CREATE_TASK',
      title: 'Retro for {{task.title}}',
      tags: ['Needs review', 'urgent'],
      assignees: ['CREATOR'],
      status: { statusId: 'review' },
    });
    expect(named.actions[1]).toEqual({
      type: 'SET_ISSUE_TYPE',
      issueTypeId: 'Bug',
    });
    expect(named.actions[2]).toEqual({
      type: 'SET_ITERATION',
      iterationId: 'sprint1',
    });
    expect(named.actions[3]).toEqual({
      type: 'SET_ISSUE_TYPE',
      issueTypeId: null,
    }); // clearing names nothing
    const w = new RefWalker(forwardMapper(OTHER, 'proj', RULE_TOKENS));
    const bound = w.rule(named) as any;
    expect(w.issues).toEqual([]);
    expect(bound.actions[0]).toMatchObject({
      tags: ['T1', 'T2'],
      status: { statusId: 'S2' },
    });
    expect(bound.actions[1].issueTypeId).toBe('IT1');
    expect(bound.actions[2].iterationId).toBe('I1');
    expect(
      new RefWalker(forwardMapper(IDS, 'proj', RULE_TOKENS)).rule(named),
    ).toEqual(RULE);
  });
  it('a template rule using them passes the same checks as a stored one, and names that are missing are caught', () => {
    const item = {
      kind: 'rule.v1',
      name: 'On done',
      ...(new RefWalker(reverseMapper(IDS, 'proj', RULE_TOKENS)).rule(
        RULE,
      ) as object),
    };
    expect(evaluateRuleItem(item, OTHER, 'proj').ok).toBe(true);
    const bad = {
      ...item,
      actions: [{ type: 'SET_ITERATION', iterationId: 'nope' }],
    };
    const r = evaluateRuleItem(bad, OTHER, 'proj');
    expect(r.ok === false && r.issues[0]).toMatchObject({
      code: 'UNKNOWN_REF',
      path: '/actions/0/iterationId',
    });
  });
  it('a schedule travels with its project (the model gives it one) and creates in it', () => {
    const sched = {
      kind: 'rule.v1',
      name: 'Standup',
      trigger: { type: 'SCHEDULE', frequency: 'DAILY', hour: 9 },
      actions: [
        {
          type: 'CREATE_TASK',
          title: 'Standup {{date}}',
          tags: ['needs review'],
        },
      ],
    };
    expect(evaluateRuleItem(sched, OTHER, 'proj').ok).toBe(true);
    const task = { ...sched, actions: [{ type: 'COMMENT', body: 'x' }] };
    const r = evaluateRuleItem(task, OTHER, 'proj');
    expect(r.ok === false && r.issues[0].code).toBe('ACTION_NEEDS_TASK');
  });
});
