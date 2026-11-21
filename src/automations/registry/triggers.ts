import { AUTOMATION_LIMITS as L } from '../dsl/rule.limits';
import {
  arr,
  isObject,
  int,
  literal,
  obj,
  objExactlyOne,
  oneOf,
  opt,
  req,
  str,
} from '../dsl/rule.schema';
import { BUILTIN_FIELDS, StatusRef, Trigger } from '../dsl/rule.types';
import {
  ADAPTERS_LATER,
  FIELDS_WITH_CHANGE_EVENTS,
  LINK_KINDS,
  NO_EVENT_YET,
  PROVIDERS,
  duration,
  id,
  scheduleTrigger,
  statusRef,
  unsupportedAt,
} from './checks';
import type { TriggerDescriptor } from './descriptor';

type T<K extends Trigger['type']> = Extract<Trigger, { type: K }>;
const trigger = <K extends Trigger['type']>(
  d: TriggerDescriptor<T<K>>,
): TriggerDescriptor<T<K>> => d;

const WITH_TASK = { task: true } as const;

const refMatches = (
  ref: StatusRef,
  sid: string | null,
  category: string | null,
): boolean =>
  'statusId' in ref
    ? sid !== null && ref.statusId === sid
    : category !== null && ref.category === category;

const anyMatches = (
  refs: StatusRef[] | undefined,
  sid: string | null,
  category: string | null,
): boolean =>
  refs === undefined ||
  refs.length === 0 ||
  refs.some((r) => refMatches(r, sid, category));

const TASK_CREATED = trigger<'TASK_CREATED'>({
  type: 'TASK_CREATED',
  needs: WITH_TASK,
  label: 'Task created',
  summary: 'Fires when a task is created.',
  example: { type: 'TASK_CREATED' },
  schema: obj({ type: req(literal('TASK_CREATED')) }),
  refs: [],
  match: (_t, e) => e.kind === 'TASK_CREATED',
  describe: () => 'When a task is created',
});

const STATUS_CHANGED = trigger<'STATUS_CHANGED'>({
  type: 'STATUS_CHANGED',
  needs: WITH_TASK,
  label: 'Status changed',
  summary: 'Fires when a task changes status; `from` and `to` narrow it.',
  example: { type: 'STATUS_CHANGED', to: [{ category: 'DONE' }] },
  schema: obj({
    type: req(literal('STATUS_CHANGED')),
    from: opt(arr(statusRef, { min: 1, max: L.maxListItems })),
    to: opt(arr(statusRef, { min: 1, max: L.maxListItems })),
  }),
  refs: [
    { key: 'from', kind: 'status', shape: 'statusRefList' },
    { key: 'to', kind: 'status', shape: 'statusRefList' },
  ],
  match: (t, e) => {
    if (e.kind !== 'STATUS_CHANGED' || !e.statusChange) return false;
    const c = e.statusChange;
    return (
      anyMatches(t.to, c.toStatusId, c.toCategory) &&
      anyMatches(t.from, c.fromStatusId, c.fromCategory)
    );
  },
  describe: () => 'When a task changes status',
});

const FIELD_CHANGED = trigger<'FIELD_CHANGED'>({
  type: 'FIELD_CHANGED',
  needs: WITH_TASK,
  label: 'Field changed',
  summary:
    'Fires when a built-in field changes (only some fields record a change yet).',
  example: { type: 'FIELD_CHANGED', field: 'PRIORITY' },
  schema: (v, path, sink) => {
    objExactlyOne(['field', 'customFieldId'], {
      type: req(literal('FIELD_CHANGED')),
      field: opt(oneOf(BUILTIN_FIELDS, 'field')),
      customFieldId: opt(id('custom field id')),
    })(v, path, sink);
    if (!isObject(v)) return;
    if (v.customFieldId !== undefined)
      unsupportedAt(sink, path, 'FIELD_CHANGED(custom field)', NO_EVENT_YET);
    else if (
      typeof v.field === 'string' &&
      !FIELDS_WITH_CHANGE_EVENTS.includes(v.field)
    )
      unsupportedAt(sink, path, `FIELD_CHANGED(${v.field})`, NO_EVENT_YET);
  },
  refs: [{ key: 'customFieldId', kind: 'customField', shape: 'one' }],
  match: (t, e) =>
    e.kind === 'FIELD_CHANGED' && t.field !== undefined && e.field === t.field,
  describe: (t) =>
    t.field
      ? `When ${t.field.toLowerCase().replace('_', ' ')} changes`
      : 'When a custom field changes',
});

const DUE_APPROACHING = trigger<'DUE_APPROACHING'>({
  type: 'DUE_APPROACHING',
  needs: WITH_TASK,
  label: 'Due date approaching',
  summary:
    'Fires once, a set time before a task is due (checked every 5 minutes).',
  example: { type: 'DUE_APPROACHING', offset: { amount: 2, unit: 'DAYS' } },
  schema: obj({
    type: req(literal('DUE_APPROACHING')),
    offset: req(duration()),
  }),
  refs: [],
  match: (_t, e) => e.kind === 'DUE_APPROACHING',
  describe: (t) =>
    `${t.offset.amount} ${t.offset.unit.toLowerCase()} before a task is due`,
});

const EXTERNAL_LINK_STATE_CHANGED = trigger<'EXTERNAL_LINK_STATE_CHANGED'>({
  type: 'EXTERNAL_LINK_STATE_CHANGED',
  needs: WITH_TASK,
  label: 'Linked item changed state',
  summary:
    'Fires when a linked pull request or issue changes state. Needs the GitHub/Jira adapters (Phase 2).',
  example: {
    type: 'EXTERNAL_LINK_STATE_CHANGED',
    provider: 'GITHUB',
    kind: 'PR',
    state: 'merged',
  },
  schema: obj({
    type: req(literal('EXTERNAL_LINK_STATE_CHANGED')),
    provider: opt(oneOf(PROVIDERS, 'provider')),
    kind: opt(oneOf(LINK_KINDS, 'link kind')),
    state: opt(str({ max: 50, what: 'state' })),
  }),
  unavailable: ADAPTERS_LATER,
  refs: [],
  // nothing emits it until the adapters exist (Phase 2); such a rule cannot be enabled
  match: () => false,
  describe: () => 'When a linked item changes state',
});

const COMMENT_ADDED = trigger<'COMMENT_ADDED'>({
  type: 'COMMENT_ADDED',
  needs: WITH_TASK,
  label: 'Comment added',
  summary:
    "Fires on a new comment, optionally containing some text. A rule's own comments are ignored unless `by` is ANYONE.",
  example: { type: 'COMMENT_ADDED', contains: 'ship it' },
  schema: obj({
    type: req(literal('COMMENT_ADDED')),
    contains: opt(str({ max: 100, what: 'text' })),
    by: opt(oneOf(['PEOPLE', 'ANYONE'], 'who')),
  }),
  refs: [],
  match: (t, e) => {
    if (e.kind !== 'COMMENT_ADDED' || !e.comment) return false;
    // a rule's own comments never trigger rules unless the rule asks for ANYONE
    if ((t.by ?? 'PEOPLE') === 'PEOPLE' && e.comment.byAutomation) return false;
    return (
      t.contains === undefined ||
      e.comment.text.toLowerCase().includes(t.contains.toLowerCase())
    );
  },
  describe: (t) =>
    t.contains
      ? `When a comment mentions "${t.contains}"`
      : 'When a comment is added',
});

const TASK_ARCHIVED = trigger<'TASK_ARCHIVED'>({
  type: 'TASK_ARCHIVED',
  needs: WITH_TASK,
  label: 'Task archived',
  summary: 'Fires when a task is archived.',
  example: { type: 'TASK_ARCHIVED' },
  schema: obj({ type: req(literal('TASK_ARCHIVED')) }),
  refs: [],
  match: (_t, e) => e.kind === 'TASK_ARCHIVED',
  describe: () => 'When a task is archived',
});

const TASK_RESTORED = trigger<'TASK_RESTORED'>({
  type: 'TASK_RESTORED',
  needs: WITH_TASK,
  label: 'Task restored',
  summary: 'Fires when an archived task is restored.',
  example: { type: 'TASK_RESTORED' },
  schema: obj({ type: req(literal('TASK_RESTORED')) }),
  refs: [],
  match: (_t, e) => e.kind === 'TASK_RESTORED',
  describe: () => 'When a task is restored',
});

const ALL_SUBTASKS_DONE = trigger<'ALL_SUBTASKS_DONE'>({
  type: 'ALL_SUBTASKS_DONE',
  needs: WITH_TASK,
  label: 'All subtasks done',
  summary: 'Fires on the PARENT task when its last open subtask is finished.',
  example: { type: 'ALL_SUBTASKS_DONE' },
  schema: obj({ type: req(literal('ALL_SUBTASKS_DONE')) }),
  refs: [],
  match: (_t, e) => e.kind === 'ALL_SUBTASKS_DONE',
  describe: () => 'When all subtasks of a task are done',
});

const TASK_OVERDUE = trigger<'TASK_OVERDUE'>({
  type: 'TASK_OVERDUE',
  needs: WITH_TASK,
  label: 'Task overdue',
  summary:
    'Fires once when an open task passes its due date (optionally some hours later).',
  example: { type: 'TASK_OVERDUE', afterHours: 24 },
  schema: obj({
    type: req(literal('TASK_OVERDUE')),
    afterHours: opt(int({ min: 0, max: 720 })),
  }),
  refs: [],
  match: (_t, e) => e.kind === 'TASK_OVERDUE',
  describe: (t) =>
    t.afterHours
      ? `${t.afterHours} hours after a task becomes overdue`
      : 'When a task becomes overdue',
});

const SCHEDULE = trigger<'SCHEDULE'>({
  type: 'SCHEDULE',
  // fires with no task: such a rule has no conditions and may only use task-less actions
  needs: { task: false },
  label: 'On a schedule',
  summary:
    'Fires daily, weekly or monthly at a UTC hour. Has no task: it can only create tasks.',
  example: { type: 'SCHEDULE', frequency: 'WEEKLY', hour: 9, weekdays: [1] },
  schema: scheduleTrigger(),
  refs: [],
  match: (_t, e) => e.kind === 'SCHEDULE',
  // new work needs somewhere to live: a scheduled rule has no task to borrow a project from
  ruleCheck: (_rule, scopeProjectId) =>
    scopeProjectId
      ? []
      : [
          {
            code: 'SCHEDULE_NEEDS_PROJECT',
            path: '/trigger',
            message:
              'A scheduled rule creates its tasks in one project: give the rule a project',
          },
        ],
  describe: (t) =>
    `${t.frequency.toLowerCase()} at ${String(t.hour).padStart(2, '0')}:00 UTC`,
});

const CALLED = trigger<'CALLED'>({
  type: 'CALLED',
  needs: WITH_TASK,
  label: 'When called by another rule',
  summary:
    "Never fires on its own: the rule exists to be run by another rule's Run rule action. Use it for steps several rules share.",
  example: { type: 'CALLED' },
  schema: obj({ type: req(literal('CALLED')) }),
  refs: [],
  match: () => false,
  describe: () => 'When another rule runs this one',
});

export const TRIGGERS = {
  TASK_CREATED,
  STATUS_CHANGED,
  FIELD_CHANGED,
  DUE_APPROACHING,
  EXTERNAL_LINK_STATE_CHANGED,
  COMMENT_ADDED,
  TASK_ARCHIVED,
  TASK_RESTORED,
  ALL_SUBTASKS_DONE,
  TASK_OVERDUE,
  SCHEDULE,
  CALLED,
};
