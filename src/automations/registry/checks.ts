import { Priority, TaskStatus } from '@prisma/client';
import { AUTOMATION_LIMITS as L } from '../dsl/rule.limits';
import {
  Check,
  Sink,
  arr,
  at,
  int,
  isObject,
  literal,
  num,
  obj,
  oneOf,
  opt,
  req,
  str,
  objExactlyOne,
} from '../dsl/rule.schema';

/**
 * Step 5.8. The small schema pieces the trigger and action descriptors are built from. They used to
 * live in `rule.validator.ts`; they moved here so the descriptors (which the validator now imports)
 * can use them without an import cycle. The validator re-exports what it used to export.
 */
const ID = /^[A-Za-z0-9_-]{1,64}$/;
export const id = (what: string): Check => str({ max: 64, pattern: ID, what });
export const TASK_STATUSES = Object.values(TaskStatus);
export const PRIORITIES = Object.values(Priority);
export const PROVIDERS = [
  'DISCORD',
  'SLACK',
  'GITHUB',
  'CLICKUP',
  'JIRA',
  'LINEAR',
] as const;
export const LINK_KINDS = [
  'PR',
  'ISSUE',
  'COMMIT',
  'BRANCH',
  'MESSAGE',
  'THREAD',
] as const;

// ------------------------------------------------------------------ text with {{variables}} ----
/** The only placeholders a comment / title / message may contain. Filled in by the runner (5.2). */
export const TEMPLATE_VARIABLES = [
  'task.title',
  'task.key',
  'task.status',
  'task.priority',
  'trigger.from',
  'trigger.to',
  'actor.name',
  /** today's date (UTC, YYYY-MM-DD) when the rule runs; the only placeholder a SCHEDULE rule has besides its own text */
  'date',
] as const;
/** placeholders that need a task, so a SCHEDULE rule (no task) cannot use them */
export const NEEDS_TASK = /^(task|trigger|actor)\./;
export const TOKEN = /\{\{\s*([^{}]*?)\s*\}\}/g;

// ------------------------------------------------------------------ captured variables -----------
/** What `as` captures from a created task, and what `{{name.prop}}` can ask for (step 5.13). */
export const TASK_CAPTURE_PROPS = [
  'id',
  'key',
  'title',
  'status',
  'priority',
  'project',
  'assignees',
  'dueDate',
] as const;
/** the groups the runner owns, so a capture cannot shadow `{{task.title}}` and friends */
export const RESERVED_NAMES = ['task', 'trigger', 'actor', 'date', 'item'];
export const CAPTURE_NAME = /^[a-z][A-Za-z0-9]{0,29}$/;
/** `{{name.prop}}`: syntax only here; whether `name` was captured, and has `prop`, is the rule-level pass */
export const VARIABLE_REF = /^([a-z][A-Za-z0-9]{0,29})\.([a-z][A-Za-z]{0,29})$/;
export const isVariableRef = (token: string): RegExpExecArray | null => {
  const m = VARIABLE_REF.exec(token);
  return m && !['task', 'trigger', 'actor'].includes(m[1]) ? m : null;
};

/** the name a create action captures its result under */
export const captureName: Check = (v, path, sink) => {
  str({ max: 30, pattern: CAPTURE_NAME, what: 'variable name' })(v, path, sink);
  if (typeof v === 'string' && RESERVED_NAMES.includes(v))
    sink.add(
      'RESERVED_NAME',
      path,
      `"${v}" is used by the rule itself; pick another name`,
    );
};

export function templateText(max: number, what: string): Check {
  const base = str({ max, what });
  return (v, path, sink) => {
    base(v, path, sink);
    if (typeof v !== 'string') return;
    for (const m of v.matchAll(TOKEN)) {
      if (
        !(TEMPLATE_VARIABLES as readonly string[]).includes(m[1]) &&
        !isVariableRef(m[1])
      )
        sink.add(
          'UNKNOWN_VARIABLE',
          path,
          `"{{${m[1].slice(0, 30)}}}" is not a known placeholder`,
        );
    }
    if (/\{\{|\}\}/.test(v.replace(TOKEN, '')))
      sink.add(
        'BAD_TEMPLATE',
        path,
        'a "{{" or "}}" is not part of a complete placeholder',
      );
  };
}

// ------------------------------------------------------------------ shared pieces ---------------
export const statusRef: Check = objExactlyOne(['category', 'statusId'], {
  category: opt(oneOf(TASK_STATUSES, 'status category')),
  statusId: opt(id('status id')),
});
export const userRef = str({ max: 64, pattern: ID, what: 'user' });

export function duration(): Check {
  const base = obj({
    amount: req(int({ min: 1, max: 720 })),
    unit: req(oneOf(['HOURS', 'DAYS'], 'unit')),
  });
  return (v, path, sink) => {
    base(v, path, sink);
    if (
      isObject(v) &&
      v.unit === 'DAYS' &&
      typeof v.amount === 'number' &&
      v.amount > 90
    ) {
      sink.add('OUT_OF_RANGE', at(path, 'amount'), 'at most 90 days');
    }
  };
}

/** a text, number or boolean (conditions and custom-field values) */
export const scalar: Check = (v, path, sink) => {
  if (typeof v === 'string')
    return str({ max: L.maxStringValue, what: 'value' })(v, path, sink);
  if (typeof v === 'number')
    return num({ min: -1e12, max: 1e12 })(v, path, sink);
  if (typeof v !== 'boolean')
    sink.add('WRONG_TYPE', path, 'must be text, a number or true/false');
};

// ------------------------------------------------------------------ what can run yet -------------
/** FIELD_CHANGED fields that write a change event today. The rest are valid but cannot fire (yet). */
export const FIELDS_WITH_CHANGE_EVENTS: readonly string[] = [
  'PRIORITY',
  'ASSIGNEES',
  'DUE_DATE',
  'ISSUE_TYPE',
  'ITERATION',
  'TAGS',
  'DESCRIPTION',
];
export const NO_EVENT_YET =
  'Nothing records a change to this yet, so this trigger cannot fire; the rule is saved but cannot be switched on';
export const NO_CLEAR_YET =
  'The task API cannot clear this value yet; the rule is saved but cannot be switched on';
export const ADAPTERS_LATER =
  'Link state changes come from the GitHub/Jira adapters (Phase 2); the rule is saved but cannot be switched on yet';
export const CHANNELS_LATER =
  'Chat notifications need the chat integration (Phase 2); the rule is saved but cannot be switched on yet';

export const unsupportedAt = (
  sink: Sink,
  path: string,
  construct: string,
  reason: string,
) => sink.unsupported.push({ path, construct, reason });

/** inDays counts from now (0 to 365) or shifts the task's own due date (-365 to 365). */
export function relativeDays(v: unknown, path: string, sink: Sink): void {
  if (
    isObject(v) &&
    typeof v.inDays === 'number' &&
    v.inDays < 0 &&
    v.from !== 'DUE_DATE'
  ) {
    sink.add(
      'OUT_OF_RANGE',
      at(path, 'inDays'),
      'a negative number of days needs "from": "DUE_DATE" (counting back from now is the past)',
    );
  }
}

/** SCHEDULE: DAILY / WEEKLY (weekdays, ISO 1=Monday) / MONTHLY (day 1..28), at a UTC hour. Exactly the parts its frequency uses. */
export function scheduleTrigger(): Check {
  const base = obj({
    type: req(literal('SCHEDULE')),
    frequency: req(oneOf(['DAILY', 'WEEKLY', 'MONTHLY'], 'frequency')),
    hour: req(int({ min: 0, max: 23 })),
    weekdays: opt(arr(int({ min: 1, max: 7 }), { min: 1, max: 7 })),
    dayOfMonth: opt(int({ min: 1, max: 28 })),
  });
  return (v, path, sink) => {
    base(v, path, sink);
    if (!isObject(v)) return;
    const f = v.frequency;
    if (f === 'WEEKLY' && v.weekdays === undefined)
      sink.add(
        'MISSING',
        at(path, 'weekdays'),
        'a weekly schedule names its weekdays (1 = Monday ... 7 = Sunday)',
      );
    if (f === 'MONTHLY' && v.dayOfMonth === undefined)
      sink.add(
        'MISSING',
        at(path, 'dayOfMonth'),
        'a monthly schedule names its day of the month (1 to 28)',
      );
    if (f !== 'WEEKLY' && v.weekdays !== undefined)
      sink.add(
        'NOT_FOR_FREQUENCY',
        at(path, 'weekdays'),
        'weekdays only apply to a weekly schedule',
      );
    if (f !== 'MONTHLY' && v.dayOfMonth !== undefined)
      sink.add(
        'NOT_FOR_FREQUENCY',
        at(path, 'dayOfMonth'),
        'dayOfMonth only applies to a monthly schedule',
      );
    if (
      Array.isArray(v.weekdays) &&
      new Set(v.weekdays).size !== v.weekdays.length
    )
      sink.add('DUPLICATE', at(path, 'weekdays'), 'a weekday is listed twice');
  };
}

// ------------------------------------------------------------------ recursion (IF) ---------------
// An `IF` holds actions and conditions, so its schema needs the checks that are built FROM the registry
// (the action union) and from the validator (the condition table). They are bound once at load time;
// binding late is what keeps the registry free of an import cycle with the validator.
let boundAction: Check | undefined;
let boundConditions: Check | undefined;
export const bindActionCheck = (c: Check): void => void (boundAction = c);
export const bindConditionsCheck = (c: Check): void =>
  void (boundConditions = c);
const bound = (what: string, c: Check | undefined): Check => {
  if (!c)
    throw new Error(
      `The ${what} check is not bound: load the DSL (src/automations/dsl) before validating an IF`,
    );
  return c;
};
export const actionCheck: Check = (v, path, sink) =>
  bound('action', boundAction)(v, path, sink);
export const conditionsCheck: Check = (v, path, sink) =>
  bound('conditions', boundConditions)(v, path, sink);
