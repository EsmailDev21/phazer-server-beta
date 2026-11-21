import { Activity, ActivityAction, ActivityTargetType } from '@prisma/client';
import { AUTOMATION_LIMITS } from '../dsl/rule.limits';
import { BuiltinField } from '../dsl/rule.types';

export type EventKind =
  | 'TASK_CREATED'
  | 'STATUS_CHANGED'
  | 'FIELD_CHANGED'
  | 'DUE_APPROACHING'
  // step 5.6
  | 'COMMENT_ADDED'
  | 'TASK_ARCHIVED'
  | 'TASK_RESTORED'
  | 'ALL_SUBTASKS_DONE'
  | 'TASK_OVERDUE'
  | 'SCHEDULE';

export interface StatusChange {
  fromStatusId: string | null;
  toStatusId: string | null;
  fromCategory: string | null;
  toCategory: string | null;
}

/** What a rule reacts to. Built from an activity row (people, adapters, other rules) or by the due-date sweep. */
export interface RuleEvent {
  /** Unique per occurrence: the activity id, or `due:<task>:<dueDate>` for the sweep. With the rule id it is the idempotency key. */
  eventId: string;
  kind: EventKind;
  /** FIELD_CHANGED only */
  field?: BuiltinField;
  workspaceId: string;
  /** null for SCHEDULE: a scheduled run has no task */
  taskId: string | null;
  actorId: string | null;
  /** 0 = a person or adapter made the change; n = the n-th rule-made hop. */
  depth: number;
  /** The rule whose write caused this event, if one did. */
  causedBy: string | null;
  statusChange?: StatusChange;
  /** COMMENT_ADDED: the comment's id (from the activity) and, once the runner has read it, its text and whether a rule wrote it */
  commentId?: string;
  comment?: { text: string; byAutomation: boolean };
  /** SCHEDULE: the moment this run is for */
  slot?: Date;
  at: Date;
}

const FIELD_OF: Partial<Record<ActivityAction, BuiltinField>> = {
  PRIORITY_CHANGED: 'PRIORITY',
  DUE_DATE_CHANGED: 'DUE_DATE',
  ASSIGNED: 'ASSIGNEES',
  UNASSIGNED: 'ASSIGNEES',
  ISSUE_TYPE_CHANGED: 'ISSUE_TYPE',
  ITERATION_CHANGED: 'ITERATION',
  TAG_ADDED: 'TAGS',
  TAG_REMOVED: 'TAGS',
  DESCRIPTION_UPDATED: 'DESCRIPTION',
};

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const strOrNull = (v: unknown): string | null =>
  typeof v === 'string' ? v : null;

/** Who made the write, from the metadata the runner stamps on its own writes. Untrusted shape: parsed defensively. */
export function automationOrigin(
  metadata: unknown,
): { id: string; depth: number } | null {
  if (!isObj(metadata) || !isObj(metadata.automation)) return null;
  const { id, depth } = metadata.automation;
  if (typeof id !== 'string' || id.length === 0 || id.length > 64) return null;
  if (
    typeof depth !== 'number' ||
    !Number.isInteger(depth) ||
    depth < 0 ||
    depth > AUTOMATION_LIMITS.maxChainDepth + 7
  )
    return null;
  return { id, depth };
}

/** Pure. null = this activity is not something a rule can react to. */
export function activityToRuleEvent(
  a: Pick<
    Activity,
    | 'id'
    | 'action'
    | 'targetType'
    | 'targetId'
    | 'workspaceId'
    | 'actorId'
    | 'metadata'
    | 'createdAt'
  >,
): RuleEvent | null {
  if (a.targetType !== ActivityTargetType.TASK) return null;
  const origin = automationOrigin(a.metadata);
  const base = {
    eventId: a.id,
    workspaceId: a.workspaceId,
    taskId: a.targetId,
    actorId: a.actorId,
    depth: origin?.depth ?? 0,
    causedBy: origin?.id ?? null,
    at: a.createdAt,
  };

  if (a.action === ActivityAction.CREATED)
    return { ...base, kind: 'TASK_CREATED' };
  if (a.action === ActivityAction.ARCHIVED)
    return { ...base, kind: 'TASK_ARCHIVED' };
  if (a.action === ActivityAction.RESTORED)
    return { ...base, kind: 'TASK_RESTORED' };
  if (a.action === ActivityAction.COMMENTED) {
    const commentId = isObj(a.metadata)
      ? strOrNull(a.metadata.commentId)
      : null;
    return commentId ? { ...base, kind: 'COMMENT_ADDED', commentId } : null;
  }
  if (a.action === ActivityAction.STATUS_CHANGED) {
    const m = isObj(a.metadata) ? a.metadata : {};
    const statusChange: StatusChange = {
      fromStatusId: strOrNull(m.fromStatusId),
      toStatusId: strOrNull(m.toStatusId),
      fromCategory: strOrNull(m.fromCategory),
      toCategory: strOrNull(m.toCategory),
    };
    if (!statusChange.toCategory && !statusChange.toStatusId) return null;
    return { ...base, kind: 'STATUS_CHANGED', statusChange };
  }
  const field = FIELD_OF[a.action];
  return field ? { ...base, kind: 'FIELD_CHANGED', field } : null;
}

/**
 * Pure. A subtask just reached DONE: if it was the last open one, the PARENT has just had all of its
 * subtasks completed, which is an event of its own (ALL_SUBTASKS_DONE, on the parent). `openSiblings`
 * is how many other subtasks of that parent are still not done.
 */
export function allSubtasksDoneEvent(
  statusEvent: RuleEvent,
  parentId: string | null,
  openSiblings: number,
): RuleEvent | null {
  if (
    statusEvent.kind !== 'STATUS_CHANGED' ||
    statusEvent.statusChange?.toCategory !== 'DONE'
  )
    return null;
  if (!parentId || openSiblings > 0) return null;
  return {
    ...statusEvent,
    kind: 'ALL_SUBTASKS_DONE',
    taskId: parentId,
    eventId: `subs:${parentId}:${statusEvent.eventId}`,
    statusChange: undefined,
  };
}
