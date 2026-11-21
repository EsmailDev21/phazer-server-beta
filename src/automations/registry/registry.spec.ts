import { FieldType, Role, TaskStatus } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';
import { RefWalker } from '../../templates/portable/portable.refs';
import { buildCatalogue, renderCatalogueMarkdown } from '../catalogue';
import {
  ACTION_TYPES,
  TRIGGER_TYPES,
  WorkspaceRuleContext,
  checkRuleSemantics,
  collectReferences,
  validateRule,
} from '../dsl';
import { TASKLESS_ACTIONS } from '../dsl/rule.validator';
import {
  ACTIONS,
  ACTION_TYPE_LIST,
  RefSlot,
  TRIGGER_DESCRIPTORS,
  TRIGGER_TYPE_LIST,
  getAction,
  getTrigger,
} from './index';

/** Step 5.8: what every descriptor MUST have, and the proof that one declaration drives every consumer. */

const LEGACY_ACTIONS = [
  'SET_STATUS',
  'SET_PRIORITY',
  'ASSIGN',
  'SET_DUE_DATE',
  'SET_CUSTOM_FIELD',
  'ADD_TAG',
  'REMOVE_TAG',
  'COMMENT',
  'CREATE_SUBTASK',
  'NOTIFY_CHANNEL',
  'CREATE_TASK',
  'RENAME_TASK',
  'SET_DESCRIPTION',
  'SET_ESTIMATE',
  'SET_ISSUE_TYPE',
  'SET_ITERATION',
  'CHANGE_PRIORITY',
  'SET_START_DATE',
  'ARCHIVE_TASK',
  'RESTORE_TASK',
  'IF',
  'FOR_EACH',
  'WITH',
  'RUN_RULE',
  'NOTIFY',
  'WAIT',
];

const ctx = (): WorkspaceRuleContext => ({
  projectIds: new Set(['p1']),
  statuses: new Map([['s1', { projectId: 'p1', category: TaskStatus.TODO }]]),
  tagIds: new Set(['t1']),
  issueTypeIds: new Set(),
  iterationIds: new Set(),
  customFields: new Map<
    string,
    { dataType: FieldType; options: string[] | null }
  >(),
  validUserIds: new Set(),
});

const PROBE = 'PROBE';
const probeFor = (slot: RefSlot): unknown =>
  slot.shape === 'one'
    ? PROBE
    : slot.shape === 'list'
      ? [PROBE]
      : slot.shape === 'statusRef'
        ? { statusId: PROBE }
        : [{ statusId: PROBE }];

const BASE_ACTION = { type: 'ADD_TAG', tagId: 't1' };
const BASE_TRIGGER = { type: 'STATUS_CHANGED' };
const ruleWithTrigger = (t: Record<string, unknown>) =>
  t.type === 'SCHEDULE'
    ? { trigger: t, actions: [{ type: 'CREATE_TASK', title: 'x' }] }
    : { trigger: t, actions: [BASE_ACTION] };
/** `before`: actions the example needs ahead of it (a WITH needs the Create action that captures its task) */
const ruleWithAction = (
  a: Record<string, unknown>,
  before: Array<Record<string, unknown>> = [],
) => ({
  trigger: BASE_TRIGGER,
  actions: [...before, a],
});
const beforeOf = (d: { type: string }) =>
  (ACTIONS.find((x) => x.type === d.type)?.exampleBefore ?? []) as Array<
    Record<string, unknown>
  >;

describe('registry: the lists are the API', () => {
  it('has the 26 actions and 12 triggers, in the legacy order (IF, FOR_EACH, WITH, RUN_RULE, NOTIFY, WAIT and CALLED appended in 5.10-5.15)', () => {
    expect([...ACTION_TYPE_LIST]).toEqual(LEGACY_ACTIONS);
    expect([...ACTION_TYPES]).toEqual(LEGACY_ACTIONS);
    expect([...TRIGGER_TYPE_LIST]).toEqual([...TRIGGER_TYPES]);
    expect(TRIGGER_TYPE_LIST).toHaveLength(12);
  });

  it('has no duplicate types, and getAction/getTrigger find each one', () => {
    expect(new Set(ACTION_TYPE_LIST).size).toBe(ACTION_TYPE_LIST.length);
    expect(new Set(TRIGGER_TYPE_LIST).size).toBe(TRIGGER_TYPE_LIST.length);
    for (const d of ACTIONS) expect(getAction(d.type)).toBe(d);
    for (const d of TRIGGER_DESCRIPTORS) expect(getTrigger(d.type)).toBe(d);
    expect(getAction('NOPE')).toBeUndefined();
    expect(getAction('__proto__')).toBeUndefined();
    expect(getTrigger('constructor')).toBeUndefined();
  });
});

describe.each([
  ['action', ACTIONS as ReadonlyArray<(typeof ACTIONS)[number]>],
  [
    'trigger',
    TRIGGER_DESCRIPTORS as ReadonlyArray<(typeof TRIGGER_DESCRIPTORS)[number]>,
  ],
] as const)('every %s descriptor is complete', (kind, list) => {
  it.each(list.map((d) => [d.type, d] as const))(
    '%s has a label, summary, schema, refs, example and describe',
    (_type, d) => {
      expect(d.label.trim().length).toBeGreaterThan(2);
      expect(d.summary.trim().length).toBeGreaterThan(10);
      expect(typeof d.schema).toBe('function');
      expect(Array.isArray(d.refs)).toBe(true);
      expect(d.example.type).toBe(d.type);
      expect(
        typeof (d.describe as (x: never) => string)(d.example as never),
      ).toBe('string');
      expect(
        (d.describe as (x: never) => string)(d.example as never).length,
      ).toBeGreaterThan(3);
      if (kind === 'action') {
        const a = d as (typeof ACTIONS)[number];
        expect(typeof a.execute).toBe('function');
        expect(a.ceiling).toBe(Role.ADMIN); // 5.9 will raise some of these AND enforce them
        expect(typeof a.portable).toBe('boolean');
        expect(typeof a.needs.task).toBe('boolean');
      } else {
        expect(typeof (d as (typeof TRIGGER_DESCRIPTORS)[number]).match).toBe(
          'function',
        );
      }
    },
  );

  it.each(list.map((d) => [d.type, d] as const))(
    '%s: its example is accepted by the validator',
    (_type, d) => {
      const v = validateRule(
        kind === 'action'
          ? ruleWithAction(d.example, beforeOf(d))
          : ruleWithTrigger(d.example),
      );
      expect(v.ok).toBe(true);
    },
  );

  it.each(list.map((d) => [d.type, d] as const))(
    '%s: each declared reference slot is a real property of the right shape',
    (_type, d) => {
      for (const slot of d.refs) {
        const node: Record<string, unknown> = {
          ...d.example,
          [slot.key]: probeFor(slot),
        };
        const v = validateRule(
          kind === 'action'
            ? ruleWithAction(node, beforeOf(d))
            : ruleWithTrigger(node),
        );
        if (v.ok === false)
          // FIELD_CHANGED takes exactly one of field / customFieldId: the example has `field`
          expect(v.issues.map((i) => i.code)).toEqual(['EXACTLY_ONE_OF']);
      }
    },
  );

  it.each(list.map((d) => [d.type, d] as const))(
    '%s: one declaration drives collecting, checking and the template walker',
    (_type, d) => {
      for (const slot of d.refs) {
        const node: Record<string, unknown> = { ...d.example };
        if (d.type === 'FIELD_CHANGED') delete node.field;
        node[slot.key] = probeFor(slot);
        const v = validateRule(
          kind === 'action'
            ? ruleWithAction(node, beforeOf(d))
            : ruleWithTrigger(node),
        );
        expect(v.ok).toBe(true);
        if (v.ok === false) return;

        // 1. the walker visits it, with the slot's kind
        const calls: Array<[string, string, string]> = [];
        new RefWalker((k, value, p) => {
          calls.push([k, value, p]);
          return value;
        }).rule(v.rule);
        const hit = calls.filter(([, value]) => value === PROBE);
        expect(hit).toHaveLength(1);
        expect(hit[0][0]).toBe(slot.kind);

        // 2. the collector gathers it (a chat channel is not looked up as an id)
        const refs = collectReferences(v.rule);
        const all = [
          ...refs.statusIds,
          ...refs.tagIds,
          ...refs.issueTypeIds,
          ...refs.projectIds,
          ...refs.customFieldIds,
          ...refs.userIds,
          ...refs.iterationIds,
          ...refs.ruleIds,
          ...refs.viewIds,
        ];
        expect(all.includes(PROBE)).toBe(slot.kind !== 'channel');

        // 3. the workspace check reports the unknown id at the very pointer the walker used
        const issues = checkRuleSemantics(v.rule, 'p1', ctx()).filter(
          (i) => i.path === hit[0][2],
        );
        if (slot.kind === 'channel') expect(issues).toHaveLength(0);
        else expect(issues).toHaveLength(1);
      }
    },
  );
});

describe('registry: a reference cannot be forgotten', () => {
  // A key that LOOKS like it holds an id (or a list of them) must be a declared slot. `from` is also the
  // "count from now or the due date" switch of the two date actions: not a reference.
  const REF_KEY = /(Id|Ids)$|^(tags|users|assignees|status|from|to)$/;
  const NOT_A_REFERENCE = new Set(['SET_DUE_DATE.from', 'SET_START_DATE.from']);

  it.each(
    [...ACTIONS, ...TRIGGER_DESCRIPTORS].map((d) => [d.type, d] as const),
  )(
    '%s: every reference-like key of its example is declared in `refs`',
    (_t, d) => {
      const declared = new Set(d.refs.map((r) => r.key));
      const undeclared = Object.keys(d.example).filter(
        (k) =>
          k !== 'type' &&
          REF_KEY.test(k) &&
          !NOT_A_REFERENCE.has(`${d.type}.${k}`) &&
          !declared.has(k),
      );
      expect(undeclared).toEqual([]);
    },
  );
});

describe('registry: declared properties', () => {
  it('only CREATE_TASK, WITH and WAIT need no task, and only SCHEDULE fires without one', () => {
    // CREATE_TASK makes its own task; WITH takes one a Create action captured
    expect([...TASKLESS_ACTIONS]).toEqual(['CREATE_TASK', 'WITH', 'WAIT']);
    expect(
      TRIGGER_DESCRIPTORS.filter((t) => !t.needs.task).map((t) => t.type),
    ).toEqual(['SCHEDULE']);
  });

  it('exactly the constructs that cannot run yet are marked unavailable', () => {
    expect(
      [...ACTIONS, ...TRIGGER_DESCRIPTORS]
        .filter((d) => d.unavailable !== undefined)
        .map((d) => d.type)
        .sort(),
    ).toEqual(['EXTERNAL_LINK_STATE_CHANGED', 'NOTIFY_CHANNEL']);
  });

  it('an action is not portable only because it names something that has no meaning in another workspace', () => {
    const notPortable = ACTIONS.filter((a) => !a.portable);
    expect(notPortable.map((a) => a.type)).toEqual([
      'NOTIFY_CHANNEL',
      'RUN_RULE',
    ]);
    for (const a of notPortable)
      expect(
        a.refs.some((r) => ['channel', 'rule', 'view'].includes(r.kind)),
      ).toBe(true);
    // and the walker agrees: a channel (or, until templates carry them by name, a rule or a view)
    // reference cannot be translated
    const w = new RefWalker(() => undefined);
    w.rule({
      trigger: { type: 'TASK_CREATED' },
      actions: [{ type: 'NOTIFY_CHANNEL', channelLinkId: 'c', message: 'm' }],
    });
    expect(w.issues.map((i) => i.code)).toEqual(['NOT_PORTABLE']);
  });

  it('rule-wide checks run once per rule, at the first use', () => {
    const v = validateRule({
      trigger: { type: 'TASK_CREATED' },
      actions: [
        { type: 'CREATE_SUBTASK', title: 'a' },
        { type: 'CREATE_SUBTASK', title: 'b' },
      ],
    });
    if (v.ok === false) throw new Error('fixture invalid');
    const issues = checkRuleSemantics(v.rule, 'p1', ctx());
    expect(issues.map((i) => `${i.code}@${i.path}`)).toEqual([
      'UNBOUNDED_RECURSION@/actions/0',
    ]);
  });
});

describe('registry: import order does not matter (a cycle once broke this)', () => {
  const ENTRIES = [
    '../registry',
    '../dsl',
    '../dsl/rule.validator',
    '../dsl/rule.semantic',
    '../engine',
    '../engine/trigger-match',
    '../engine/render-text',
    '../action-executor.service',
    '../../templates/portable',
    '../../templates/portable/portable.refs',
    '../catalogue',
  ];
  it.each(ENTRIES)('loading %s first leaves a complete registry', (entry) => {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require(path.join(__dirname, entry));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const reg = require(path.join(__dirname, '../registry'));
      expect(reg.ACTIONS).toHaveLength(26);
      expect(reg.TRIGGER_DESCRIPTORS).toHaveLength(12);
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const dsl = require(path.join(__dirname, '../dsl'));
      expect(
        dsl.validateRule({
          trigger: { type: 'TASK_CREATED' },
          actions: [{ type: 'ARCHIVE_TASK' }],
        }).ok,
      ).toBe(true);
    });
  });
});

describe('catalogue', () => {
  it('lists every trigger and action with the registry facts, and is plain JSON', () => {
    const c = buildCatalogue();
    expect(c.triggers.map((t) => t.type)).toEqual([...TRIGGER_TYPE_LIST]);
    expect(c.actions.map((a) => a.type)).toEqual([...ACTION_TYPE_LIST]);
    expect(JSON.parse(JSON.stringify(c))).toEqual(c);
    const notify = c.actions.find((a) => a.type === 'NOTIFY_CHANNEL')!;
    expect(notify).toMatchObject({ available: false, portable: false });
    expect(notify.unavailableReason).toMatch(/Phase 2/);
    expect(c.actions.find((a) => a.type === 'CREATE_TASK')).toMatchObject({
      needsTask: false,
      needsProject: true,
    });
    expect(c.triggers.find((t) => t.type === 'SCHEDULE')!.needsTask).toBe(
      false,
    );
    expect(c.conditions.fields.STATUS_CATEGORY).toBeDefined();
    expect(c.userTokens.sort()).toEqual(['CREATOR', 'TRIGGERER']);
    expect(c.placeholders).toContain('date');
  });

  it('hands out copies: changing one cannot change a descriptor', () => {
    const c = buildCatalogue();
    (c.actions[0].example as Record<string, unknown>).type = 'HACKED';
    expect(buildCatalogue().actions[0].example.type).toBe('SET_STATUS');
    expect(getAction('SET_STATUS')!.example.type).toBe('SET_STATUS');
  });

  it('every trigger and action has a line in the generated reference (docs/design/automation-catalogue.md)', () => {
    const file = path.join(
      __dirname,
      '../../../docs/design/automation-catalogue.md',
    );
    const md = renderCatalogueMarkdown(buildCatalogue());
    if (process.env.UPDATE_GOLDEN === '1') fs.writeFileSync(file, md);
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe(md);
    for (const t of [...ACTION_TYPE_LIST, ...TRIGGER_TYPE_LIST])
      expect(md).toContain(`\`${t}\``);
  });
});
