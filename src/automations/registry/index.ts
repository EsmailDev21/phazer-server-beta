import type { Action, Trigger } from '../dsl/rule.types';
import { tagged, type Variant } from '../dsl/rule.schema';
import { bindActionCheck } from './checks';
import { TASK_ACTIONS } from './actions.task';
import { FLOW_ACTIONS } from './actions.flow';
import { WORK_ACTIONS } from './actions.work';
import type { ActionDescriptor, TriggerDescriptor } from './descriptor';
import { TRIGGERS } from './triggers';

export * from './descriptor';
export * from './refs';
export { misfit, OPS_BY_TYPE } from './custom-field-typing';
export * from './action-helpers';
export * from './tree';

/**
 * Step 5.8. The ONE list of what a rule can start on and do. Everything that used to be a switch on the
 * type (structural schema, reference collection, workspace checks, the template walker, trigger matching,
 * the executor) reads a descriptor from here, so adding an action or a trigger is writing one descriptor
 * (and the completeness test tells you what you forgot).
 *
 * The order below is the order of the old `ACTION_TYPES` / `TRIGGER_TYPES`; it is part of the API.
 */
const ALL_ACTIONS = { ...TASK_ACTIONS, ...WORK_ACTIONS, ...FLOW_ACTIONS };
const ACTION_ORDER: ReadonlyArray<Action['type']> = [
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
  // control flow (5.10): appended, the order is the API's
  'IF',
  'FOR_EACH',
  'WITH',
  'RUN_RULE',
  'NOTIFY',
  'WAIT',
];
const TRIGGER_ORDER: ReadonlyArray<Trigger['type']> = [
  'TASK_CREATED',
  'STATUS_CHANGED',
  'FIELD_CHANGED',
  'DUE_APPROACHING',
  'EXTERNAL_LINK_STATE_CHANGED',
  'COMMENT_ADDED',
  'TASK_ARCHIVED',
  'TASK_RESTORED',
  'ALL_SUBTASKS_DONE',
  'TASK_OVERDUE',
  'SCHEDULE',
  'CALLED',
];

// the descriptors are stored widened: each was checked against ITS action's shape where it was defined
/* eslint-disable @typescript-eslint/no-explicit-any */
export const ACTIONS: readonly ActionDescriptor<any>[] = ACTION_ORDER.map(
  (t) => ALL_ACTIONS[t],
);
export const TRIGGER_DESCRIPTORS: readonly TriggerDescriptor<any>[] =
  TRIGGER_ORDER.map((t) => TRIGGERS[t]);
/* eslint-enable @typescript-eslint/no-explicit-any */

const ACTION_BY_TYPE: ReadonlyMap<string, ActionDescriptor> = new Map(
  ACTIONS.map((d) => [d.type, d]),
);
const TRIGGER_BY_TYPE: ReadonlyMap<string, TriggerDescriptor> = new Map(
  TRIGGER_DESCRIPTORS.map((d) => [d.type, d]),
);

/** undefined for a type nobody has heard of (stored rules are validated, so this is a safety net) */
export const getAction = (type: string): ActionDescriptor | undefined =>
  ACTION_BY_TYPE.get(type);
export const getTrigger = (type: string): TriggerDescriptor | undefined =>
  TRIGGER_BY_TYPE.get(type);

export const ACTION_TYPE_LIST: readonly string[] = ACTIONS.map((d) => d.type);
export const TRIGGER_TYPE_LIST: readonly string[] = TRIGGER_DESCRIPTORS.map(
  (d) => d.type,
);

/** What a rule with no task (SCHEDULE) can do: the actions that need no task. */
export const TASKLESS_ACTION_LIST: readonly string[] = ACTIONS.filter(
  (d) => !d.needs.task,
).map((d) => d.type);

/** the `variants` argument of the `tagged` combinator, so the validator's union IS the registry */
export const actionVariants = (): Record<string, Variant> =>
  Object.fromEntries(
    ACTIONS.map((d) => [
      d.type,
      { check: d.schema, unavailable: d.unavailable },
    ]),
  );
export const triggerVariants = (): Record<string, Variant> =>
  Object.fromEntries(
    TRIGGER_DESCRIPTORS.map((d) => [
      d.type,
      { check: d.schema, unavailable: d.unavailable },
    ]),
  );

/**
 * The structural check of ONE action (the union of every descriptor's schema). The validator uses it for
 * a rule's actions and an `IF` uses it, recursively, for its branches.
 */
export const ACTION_CHECK = tagged('type', actionVariants(), 'action');
bindActionCheck(ACTION_CHECK);
