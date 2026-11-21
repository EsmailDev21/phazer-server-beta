import { AUTOMATION_LIMITS as L } from './rule.limits';
import {
  Check,
  RuleIssue,
  Sink,
  UnsupportedConstruct,
  arr,
  at,
  depthOf,
  int,
  isObject,
  num,
  obj,
  oneOf,
  opt,
  req,
  str,
  tagged,
} from './rule.schema';
import { checkCaptures } from './rule.captures';
import { checkWaits } from './rule.waits';
import { maxJsonDepthFor, treeLimits } from './rule.settings';
import { Action, RuleV1 } from './rule.types';
import {
  NEEDS_TASK,
  bindConditionsCheck,
  PRIORITIES,
  TASK_STATUSES,
  TOKEN,
  id,
  scalar,
  userRef,
} from '../registry/checks';
import {
  ACTION_TYPE_LIST,
  TASKLESS_ACTION_LIST,
  ACTION_CHECK,
  countActions,
  getAction,
  getTrigger,
  triggerVariants,
} from '../registry';

// these used to be defined here; the registry's shared checks own them now and the old import paths keep working
export {
  FIELDS_WITH_CHANGE_EVENTS,
  TEMPLATE_VARIABLES,
} from '../registry/checks';

// ------------------------------------------------------------------ triggers and actions --------
// The structural schema of every trigger and action lives in its DESCRIPTOR (src/automations/registry);
// these two unions are built from the registry, so a new trigger or action cannot be forgotten here.
const trigger: Check = tagged('type', triggerVariants(), 'trigger');
const action: Check = ACTION_CHECK;

// ------------------------------------------------------------------ conditions -----------------
export type ValueKind =
  | 'none'
  | 'statusCategories'
  | 'priorities'
  | 'ids'
  | 'userRefs'
  | 'number'
  | 'customList'
  | 'customScalar'
  | 'text'
  | 'days';
export type ConditionTable = Record<string, Record<string, ValueKind>>;

/** field -> operator -> the kind of `value` it takes. The single source of truth for conditions. */
export const CONDITION_TABLE: ConditionTable = {
  STATUS_CATEGORY: { IN: 'statusCategories', NOT_IN: 'statusCategories' },
  STATUS: { IN: 'ids', NOT_IN: 'ids' },
  PRIORITY: {
    IN: 'priorities',
    NOT_IN: 'priorities',
    IS_SET: 'none',
    IS_NOT_SET: 'none',
  },
  ASSIGNEES: {
    INCLUDES_ANY: 'userRefs',
    INCLUDES_NONE: 'userRefs',
    IS_EMPTY: 'none',
    IS_NOT_EMPTY: 'none',
  },
  TAGS: { HAS_ANY: 'ids', HAS_ALL: 'ids', HAS_NONE: 'ids' },
  ISSUE_TYPE: { IN: 'ids', NOT_IN: 'ids', IS_SET: 'none', IS_NOT_SET: 'none' },
  PROJECT: { IN: 'ids', NOT_IN: 'ids' },
  ESTIMATE: {
    EQ: 'number',
    NE: 'number',
    GT: 'number',
    GTE: 'number',
    LT: 'number',
    LTE: 'number',
    IS_SET: 'none',
    IS_NOT_SET: 'none',
  },
  DUE_DATE: {
    IS_SET: 'none',
    IS_NOT_SET: 'none',
    IS_OVERDUE: 'none',
    IS_NOT_OVERDUE: 'none',
  },
  IS_SUBTASK: { IS_TRUE: 'none', IS_FALSE: 'none' },
  CUSTOM: {
    EQ: 'customScalar',
    NE: 'customScalar',
    CONTAINS: 'customScalar',
    GT: 'customScalar',
    GTE: 'customScalar',
    LT: 'customScalar',
    LTE: 'customScalar',
    IN: 'customList',
    NOT_IN: 'customList',
    HAS_ANY: 'customList',
    HAS_ALL: 'customList',
    HAS_NONE: 'customList',
    INCLUDES_ANY: 'customList',
    INCLUDES_NONE: 'customList',
    IS_SET: 'none',
    IS_NOT_SET: 'none',
    IS_TRUE: 'none',
    IS_FALSE: 'none',
  },
};

const VALUE_CHECKS: Record<Exclude<ValueKind, 'none'>, Check> = {
  statusCategories: arr(oneOf(TASK_STATUSES, 'status category'), {
    min: 1,
    max: TASK_STATUSES.length,
  }),
  priorities: arr(oneOf(PRIORITIES, 'priority'), {
    min: 1,
    max: PRIORITIES.length,
  }),
  ids: arr(id('id'), { min: 1, max: L.maxListItems }),
  userRefs: arr(userRef, { min: 1, max: L.maxListItems }),
  number: num({ min: -1e9, max: 1e9 }),
  customList: arr(str({ max: 100, what: 'value' }), {
    min: 1,
    max: L.maxListItems,
  }),
  customScalar: scalar,
  text: str({ max: 200, what: 'text' }),
  days: int({ min: 0, max: 365 }),
};

/** One condition, checked against a field table. Automations and saved views each have their own table; the checking is the same. */
export function makeConditionCheck(table: ConditionTable): Check {
  return (v, path, sink) => {
    if (!isObject(v)) return sink.add('WRONG_TYPE', path, 'must be an object');
    const shape = obj({
      field: req(str({ max: 30 })),
      op: req(str({ max: 30 })),
      value: opt(() => undefined),
      customFieldId: opt(id('custom field id')),
    });
    shape(v, path, sink);
    const ops =
      typeof v.field === 'string' &&
      Object.prototype.hasOwnProperty.call(table, v.field)
        ? table[v.field]
        : undefined;
    if (!ops)
      return typeof v.field === 'string'
        ? sink.add(
            'UNKNOWN_FIELD',
            at(path, 'field'),
            `unknown field "${v.field.slice(0, 30)}"`,
          )
        : undefined;
    if ((v.field === 'CUSTOM') !== (v.customFieldId !== undefined)) {
      return sink.add(
        'EXACTLY_ONE_OF',
        at(path, 'customFieldId'),
        'customFieldId is required for CUSTOM and not allowed otherwise',
      );
    }
    if (typeof v.op !== 'string') return;
    const kind = Object.prototype.hasOwnProperty.call(ops, v.op)
      ? ops[v.op]
      : undefined;
    if (!kind)
      return sink.add(
        'UNKNOWN_OPERATOR',
        at(path, 'op'),
        `"${v.op.slice(0, 30)}" does not work with ${v.field}`,
      );
    if (kind === 'none') {
      if (v.value !== undefined)
        sink.add(
          'VALUE_NOT_ALLOWED',
          at(path, 'value'),
          `${v.op} takes no value`,
        );
    } else if (v.value === undefined) {
      sink.add('MISSING', at(path, 'value'), `${v.op} needs a value`);
    } else {
      VALUE_CHECKS[kind](v.value, at(path, 'value'), sink);
    }
  };
}

/** `{all?, any?}` of conditions, at most `maxConditions` in total. */
export function makeConditionsCheck(table: ConditionTable): Check {
  const condition = makeConditionCheck(table);
  return (v, path, sink) => {
    obj({
      all: opt(arr(condition, { min: 1, max: L.maxConditions })),
      any: opt(arr(condition, { min: 1, max: L.maxConditions })),
    })(v, path, sink);
    if (isObject(v)) {
      const lens = [v.all, v.any].map((x) => (Array.isArray(x) ? x.length : 0));
      // one report only: a list that is already too long was reported by `arr`
      if (
        lens.every((n) => n <= L.maxConditions) &&
        lens[0] + lens[1] > L.maxConditions
      ) {
        sink.add(
          'TOO_MANY',
          path,
          `at most ${L.maxConditions} conditions in total`,
        );
      }
    }
  };
}

const conditions: Check = makeConditionsCheck(CONDITION_TABLE);
// an IF checks its own conditions with the very same check a rule's conditions get
bindConditionsCheck(conditions);

// ------------------------------------------------------------------ the rule --------------------
/** Every action type, in the registry's order (it is the API's order). */
export const ACTION_TYPES = ACTION_TYPE_LIST as readonly Action['type'][];

/** What a rule with no task (SCHEDULE) can do: the actions whose descriptor says they need no task. */
export const TASKLESS_ACTIONS: readonly string[] = TASKLESS_ACTION_LIST;

export type RuleValidation =
  | {
      ok: true;
      rule: RuleV1;
      triggerType: string;
      unsupported: UnsupportedConstruct[];
    }
  | { ok: false; issues: RuleIssue[] };

/**
 * Structural validation of `{trigger, conditions?, actions}`: pure, no database. Strict (unknown
 * keys are errors), bounded (size, depth, list lengths), and it never runs or evaluates anything.
 * What needs the workspace (do these ids exist? does this operator fit that custom field?) is
 * `checkRuleSemantics`.
 */
export function validateRule(input: unknown): RuleValidation {
  const sink = new Sink();
  if (!isObject(input))
    return {
      ok: false,
      issues: [
        { code: 'WRONG_TYPE', path: '', message: 'A rule must be an object' },
      ],
    };

  let bytes = 0;
  try {
    bytes = Buffer.byteLength(JSON.stringify(input), 'utf8');
  } catch {
    return {
      ok: false,
      issues: [
        {
          code: 'NOT_JSON',
          path: '',
          message: 'The rule is not valid JSON data',
        },
      ],
    };
  }
  if (bytes > L.maxRuleBytes)
    return {
      ok: false,
      issues: [
        {
          code: 'TOO_LARGE',
          path: '',
          message: `A rule is at most ${L.maxRuleBytes / 1024} KB`,
        },
      ],
    };
  const maxDepth = maxJsonDepthFor(L.maxJsonDepth);
  if (depthOf(input, maxDepth + 1) > maxDepth)
    return {
      ok: false,
      issues: [
        {
          code: 'TOO_DEEP',
          path: '',
          message: 'The rule is nested too deeply',
        },
      ],
    };

  obj({
    trigger: req(trigger),
    conditions: opt(conditions),
    actions: req(arr(action, { min: 1, max: L.maxActions })),
  })(input, '', sink);
  // captured variables: defined before use, visible only where they were captured
  if (sink.issues.length === 0) checkCaptures(input.actions, sink);
  // where a Wait may sit
  if (sink.issues.length === 0) checkWaits(input.actions, sink);
  // actions inside IF branches count too (and each IF itself): the cap is on the whole rule
  if (sink.issues.length === 0) {
    const total = countActions(input.actions);
    const max = treeLimits().maxTotalActions;
    if (total > max)
      sink.add(
        'TOO_MANY_ACTIONS',
        '/actions',
        `A rule has at most ${max} actions in all, counting those inside IF branches (this one has ${total})`,
      );
  }
  if (sink.issues.length === 0) scheduleRules(input, sink);
  if (sink.issues.length > 0) return { ok: false, issues: sink.issues };

  const rule: RuleV1 = {
    trigger: input.trigger as RuleV1['trigger'],
    conditions: (input.conditions ?? {}) as RuleV1['conditions'],
    actions: input.actions as RuleV1['actions'],
  };
  return {
    ok: true,
    rule,
    triggerType: rule.trigger.type,
    unsupported: sink.unsupported,
  };
}

/** A SCHEDULE rule runs with no task: no conditions, only task-less actions, no task placeholders. */
function scheduleRules(input: Record<string, unknown>, sink: Sink): void {
  // the triggers that fire with no task (their descriptor says so): today SCHEDULE
  if (
    !isObject(input.trigger) ||
    typeof input.trigger.type !== 'string' ||
    getTrigger(input.trigger.type)?.needs.task !== false
  )
    return;
  if (isObject(input.conditions) && Object.keys(input.conditions).length > 0) {
    sink.add(
      'CONDITIONS_NEED_TASK',
      '/conditions',
      'A scheduled rule runs with no task, so it has nothing to check conditions on',
    );
  }
  (Array.isArray(input.actions) ? input.actions : []).forEach((a, i) => {
    if (!isObject(a) || typeof a.type !== 'string') return;
    // most actions are decided by their type; a FOR_EACH over a query by its own shape (it selects its tasks)
    const d = getAction(a.type);
    const withoutTask = d?.taskless
      ? d.taskless(a as never)
      : TASKLESS_ACTIONS.includes(a.type);
    if (!withoutTask) {
      sink.add(
        'ACTION_NEEDS_TASK',
        `/actions/${i}/type`,
        `${a.type} acts on a task, and a scheduled rule has none; it can only create tasks`,
      );
      return;
    }
    for (const key of ['title', 'description'] as const) {
      const text = a[key];
      if (typeof text !== 'string') continue;
      for (const m of text.matchAll(TOKEN)) {
        if (NEEDS_TASK.test(m[1]))
          sink.add(
            'VARIABLE_NEEDS_TASK',
            `/actions/${i}/${key}`,
            `"{{${m[1].slice(0, 30)}}}" needs a task; a scheduled rule only has {{date}}`,
          );
      }
    }
  });
}
