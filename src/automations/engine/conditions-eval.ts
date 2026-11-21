import { Conditions, Condition } from '../dsl/rule.types';

/** The facts about a task a rule's conditions may look at, read once per run. */
export interface TaskSnapshot {
  status: string;
  workflowStatusId: string | null;
  priority: string | null;
  assigneeIds: string[];
  tagIds: string[];
  issueTypeId: string | null;
  projectId: string | null;
  estimate: number | null;
  dueDate: Date | null;
  parentId: string | null;
  createdById: string;
  customValues: Record<string, unknown>;
  // Only a saved view filters on these (step 5.11); a rule's snapshot may leave them out (treated as empty).
  title?: string;
  startDate?: Date | null;
  iterationId?: string | null;
}

export interface EvalContext {
  now: Date;
  /** whoever caused the event */
  actorId: string | null;
  /** whoever is LOOKING (a saved view's `ME`); null/absent for a rule */
  viewerId?: string | null;
}

const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const isSet = (v: unknown): boolean =>
  v !== null &&
  v !== undefined &&
  v !== '' &&
  !(Array.isArray(v) && v.length === 0);

/** TRIGGERER / CREATOR become user ids. */
function resolveUsers(
  refs: unknown[],
  snap: TaskSnapshot,
  ctx: EvalContext,
): string[] {
  return refs
    .map((r) =>
      r === 'TRIGGERER'
        ? ctx.actorId
        : r === 'CREATOR'
          ? snap.createdById
          : r === 'ME'
            ? (ctx.viewerId ?? null)
            : r,
    )
    .filter((r): r is string => typeof r === 'string');
}

const overlap = (a: unknown[], b: unknown[]): boolean =>
  a.some((x) => b.includes(x));

function num(op: string, actual: number | null, expected: unknown): boolean {
  if (typeof expected !== 'number') return false;
  if (actual === null) return op === 'NE'; // "no estimate" is not equal to 5
  switch (op) {
    case 'EQ':
      return actual === expected;
    case 'NE':
      return actual !== expected;
    case 'GT':
      return actual > expected;
    case 'GTE':
      return actual >= expected;
    case 'LT':
      return actual < expected;
    case 'LTE':
      return actual <= expected;
  }
  return false;
}

function custom(
  c: Condition,
  raw: unknown,
  snap: TaskSnapshot,
  ctx: EvalContext,
): boolean {
  const expected = c.value;
  const list = asList(expected);
  const actualList = Array.isArray(raw) ? raw : isSet(raw) ? [raw] : [];
  switch (c.op) {
    case 'IS_SET':
      return isSet(raw);
    case 'IS_NOT_SET':
      return !isSet(raw);
    case 'IS_TRUE':
      return raw === true;
    case 'IS_FALSE':
      return raw !== true;
    case 'EQ':
      return isSet(raw) && raw === expected;
    case 'NE':
      return !(isSet(raw) && raw === expected);
    case 'CONTAINS':
      return (
        typeof raw === 'string' &&
        typeof expected === 'string' &&
        raw.toLowerCase().includes(expected.toLowerCase())
      );
    case 'GT':
    case 'GTE':
    case 'LT':
    case 'LTE': {
      if (!isSet(raw) || typeof raw !== typeof expected) return false;
      if (typeof raw !== 'number' && typeof raw !== 'string') return false;
      const a = raw as number | string;
      const b = expected as number | string;
      return c.op === 'GT'
        ? a > b
        : c.op === 'GTE'
          ? a >= b
          : c.op === 'LT'
            ? a < b
            : a <= b; // numbers, or ISO dates compared as text
    }
    case 'IN':
      return isSet(raw) && list.includes(raw);
    case 'NOT_IN':
      return !(isSet(raw) && list.includes(raw));
    case 'HAS_ANY':
      return overlap(actualList, list);
    case 'HAS_ALL':
      return list.length > 0 && list.every((x) => actualList.includes(x));
    case 'HAS_NONE':
      return !overlap(actualList, list);
    case 'INCLUDES_ANY':
      return overlap(actualList, resolveUsers(list, snap, ctx));
    case 'INCLUDES_NONE':
      return !overlap(actualList, resolveUsers(list, snap, ctx));
  }
  return false;
}

/** Pure: one condition against one task. An unknown field/operator is false (the validator keeps them out). */
export function evaluateCondition(
  c: Condition,
  snap: TaskSnapshot,
  ctx: EvalContext,
): boolean {
  const list = asList(c.value);
  switch (c.field) {
    case 'STATUS_CATEGORY':
      return c.op === 'IN'
        ? list.includes(snap.status)
        : c.op === 'NOT_IN'
          ? !list.includes(snap.status)
          : false;
    case 'STATUS': {
      const inList =
        snap.workflowStatusId !== null && list.includes(snap.workflowStatusId);
      return c.op === 'IN' ? inList : c.op === 'NOT_IN' ? !inList : false;
    }
    case 'PRIORITY': {
      if (c.op === 'IS_SET') return snap.priority !== null;
      if (c.op === 'IS_NOT_SET') return snap.priority === null;
      const inList = snap.priority !== null && list.includes(snap.priority);
      return c.op === 'IN' ? inList : c.op === 'NOT_IN' ? !inList : false;
    }
    case 'ASSIGNEES': {
      if (c.op === 'IS_EMPTY') return snap.assigneeIds.length === 0;
      if (c.op === 'IS_NOT_EMPTY') return snap.assigneeIds.length > 0;
      const any = overlap(snap.assigneeIds, resolveUsers(list, snap, ctx));
      return c.op === 'INCLUDES_ANY'
        ? any
        : c.op === 'INCLUDES_NONE'
          ? !any
          : false;
    }
    case 'TAGS':
      return c.op === 'HAS_ANY'
        ? overlap(snap.tagIds, list)
        : c.op === 'HAS_ALL'
          ? list.length > 0 &&
            list.every((t) => snap.tagIds.includes(t as string))
          : c.op === 'HAS_NONE'
            ? !overlap(snap.tagIds, list)
            : false;
    case 'ISSUE_TYPE': {
      if (c.op === 'IS_SET') return snap.issueTypeId !== null;
      if (c.op === 'IS_NOT_SET') return snap.issueTypeId === null;
      const inList =
        snap.issueTypeId !== null && list.includes(snap.issueTypeId);
      return c.op === 'IN' ? inList : c.op === 'NOT_IN' ? !inList : false;
    }
    case 'PROJECT': {
      const inList = snap.projectId !== null && list.includes(snap.projectId);
      return c.op === 'IN' ? inList : c.op === 'NOT_IN' ? !inList : false;
    }
    case 'ESTIMATE':
      return c.op === 'IS_SET'
        ? snap.estimate !== null
        : c.op === 'IS_NOT_SET'
          ? snap.estimate === null
          : num(c.op, snap.estimate, c.value);
    case 'DUE_DATE': {
      const overdue =
        snap.dueDate !== null &&
        snap.dueDate.getTime() < ctx.now.getTime() &&
        snap.status !== 'DONE';
      if (c.op === 'DUE_WITHIN_DAYS') {
        // not done, due from now up to N days (24h each) ahead; the overdue ones are IS_OVERDUE
        if (typeof c.value !== 'number' || snap.dueDate === null) return false;
        const t = snap.dueDate.getTime();
        return (
          snap.status !== 'DONE' &&
          t >= ctx.now.getTime() &&
          t <= ctx.now.getTime() + c.value * 86_400_000
        );
      }
      return c.op === 'IS_SET'
        ? snap.dueDate !== null
        : c.op === 'IS_NOT_SET'
          ? snap.dueDate === null
          : c.op === 'IS_OVERDUE'
            ? overdue
            : c.op === 'IS_NOT_OVERDUE'
              ? !overdue
              : false;
    }
    case 'START_DATE':
      return c.op === 'IS_SET'
        ? (snap.startDate ?? null) !== null
        : c.op === 'IS_NOT_SET'
          ? (snap.startDate ?? null) === null
          : false;
    case 'ITERATION': {
      const it = snap.iterationId ?? null;
      if (c.op === 'IS_SET') return it !== null;
      if (c.op === 'IS_NOT_SET') return it === null;
      const inList = it !== null && list.includes(it);
      return c.op === 'IN' ? inList : c.op === 'NOT_IN' ? !inList : false;
    }
    case 'TITLE':
      return (
        c.op === 'CONTAINS' &&
        typeof c.value === 'string' &&
        (snap.title ?? '').toLowerCase().includes(c.value.toLowerCase())
      );
    case 'CREATED_BY': {
      const hit = resolveUsers(list, snap, ctx).includes(snap.createdById);
      return c.op === 'IN' ? hit : c.op === 'NOT_IN' ? !hit : false;
    }
    case 'IS_SUBTASK':
      return c.op === 'IS_TRUE'
        ? snap.parentId !== null
        : c.op === 'IS_FALSE'
          ? snap.parentId === null
          : false;
    case 'CUSTOM':
      return (
        c.customFieldId !== undefined &&
        custom(c, snap.customValues[c.customFieldId], snap, ctx)
      );
  }
  return false;
}

/** `all` must all hold, `any` needs one (when given); both given = both. No conditions = always. */
export function evaluateConditions(
  conditions: Conditions,
  snap: TaskSnapshot,
  ctx: EvalContext,
): boolean {
  const all = conditions.all ?? [];
  const any = conditions.any ?? [];
  return (
    all.every((c) => evaluateCondition(c, snap, ctx)) &&
    (any.length === 0 || any.some((c) => evaluateCondition(c, snap, ctx)))
  );
}
