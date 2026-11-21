import type { Prisma } from '@prisma/client';
import type { Condition, Conditions } from '../../automations/dsl/rule.types';

/**
 * Step 5.11. A saved view's (or a rule's) filter, as a Prisma `where`, so the database can narrow the
 * rows BEFORE anything is evaluated in memory.
 *
 * The in-memory evaluator (`evaluateConditions`) is the ONE definition of what a condition means; this is
 * a pre-filter and is only ever allowed to be EXACTLY equivalent for the conditions it translates (an
 * integration test generates varied tasks and compares the two on every translatable condition and
 * operator). What it cannot translate exactly it leaves out, and the evaluator decides:
 *   - CUSTOM (values are JSON; comparing them in SQL would not match the evaluator's rules)
 *   - TITLE contains (the evaluator lower-cases in JavaScript; SQL case folding differs on some Unicode)
 *   - anything it does not recognise
 * A condition inside `any` is pushed down only when EVERY `any` member can be (an OR with one unknown
 * arm cannot narrow anything).
 *
 * Pure: no clock (it gets `now`), no database.
 */
export interface WhereEnv {
  now: Date;
  /** the caller: what `ME` stands for in a view */
  viewerId: string | null;
}

const NOTHING: Prisma.TaskWhereInput = { id: { in: [] } };
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
/** a user reference as the evaluator resolves it in a view: ME is the viewer, anything else is an id */
const users = (v: unknown, env: WhereEnv): string[] =>
  strings(v)
    .map((r) => (r === 'ME' ? env.viewerId : r))
    .filter((r): r is string => typeof r === 'string');

/** an optional scalar column compared to a list: IN is false for null, NOT_IN is true for null */
function nullableIn(
  column: 'workflowStatusId' | 'issueTypeId' | 'projectId' | 'iterationId',
  op: string,
  value: unknown,
): Prisma.TaskWhereInput | null {
  const list = strings(value);
  if (op === 'IN') return { [column]: { in: list } };
  if (op === 'NOT_IN')
    return { OR: [{ [column]: null }, { [column]: { notIn: list } }] };
  return null;
}

function nullableCheck(
  column:
    | 'priority'
    | 'issueTypeId'
    | 'iterationId'
    | 'estimate'
    | 'startDate'
    | 'dueDate',
  op: string,
): Prisma.TaskWhereInput | null {
  if (op === 'IS_SET') return { [column]: { not: null } };
  if (op === 'IS_NOT_SET') return { [column]: null };
  return null;
}

/** null = "I cannot translate this exactly": the caller leaves it to the evaluator */
export function conditionToWhere(
  c: Condition,
  env: WhereEnv,
): Prisma.TaskWhereInput | null {
  const list = strings(c.value);
  switch (c.field) {
    case 'STATUS_CATEGORY':
      return c.op === 'IN'
        ? { status: { in: list as never } }
        : c.op === 'NOT_IN'
          ? { status: { notIn: list as never } }
          : null;
    case 'STATUS':
      return nullableIn('workflowStatusId', c.op, c.value);
    case 'PRIORITY': {
      const set = nullableCheck('priority', c.op);
      if (set) return set;
      if (c.op === 'IN') return { priority: { in: list as never } };
      if (c.op === 'NOT_IN')
        return {
          OR: [{ priority: null }, { priority: { notIn: list as never } }],
        };
      return null;
    }
    case 'ISSUE_TYPE':
      return (
        nullableCheck('issueTypeId', c.op) ??
        nullableIn('issueTypeId', c.op, c.value)
      );
    case 'ITERATION':
      return (
        nullableCheck('iterationId', c.op) ??
        nullableIn('iterationId', c.op, c.value)
      );
    case 'PROJECT':
      return nullableIn('projectId', c.op, c.value);
    case 'ASSIGNEES': {
      if (c.op === 'IS_EMPTY') return { assignees: { none: {} } };
      if (c.op === 'IS_NOT_EMPTY') return { assignees: { some: {} } };
      const ids = users(c.value, env);
      if (c.op === 'INCLUDES_ANY')
        return { assignees: { some: { id: { in: ids } } } };
      if (c.op === 'INCLUDES_NONE')
        return { assignees: { none: { id: { in: ids } } } };
      return null;
    }
    case 'TAGS':
      if (c.op === 'HAS_ANY')
        return { tags: { some: { tagId: { in: list } } } };
      if (c.op === 'HAS_NONE')
        return { tags: { none: { tagId: { in: list } } } };
      if (c.op === 'HAS_ALL')
        return list.length === 0
          ? NOTHING
          : { AND: list.map((tagId) => ({ tags: { some: { tagId } } })) };
      return null;
    case 'ESTIMATE': {
      const set = nullableCheck('estimate', c.op);
      if (set) return set;
      // the evaluator: a non-number operand is never true (not even NE); a missing estimate is only NE
      if (typeof c.value !== 'number') return NOTHING;
      const n = c.value;
      switch (c.op) {
        case 'EQ':
          return { estimate: n };
        case 'NE':
          return { OR: [{ estimate: null }, { estimate: { not: n } }] };
        case 'GT':
          return { estimate: { gt: n } };
        case 'GTE':
          return { estimate: { gte: n } };
        case 'LT':
          return { estimate: { lt: n } };
        case 'LTE':
          return { estimate: { lte: n } };
      }
      return null;
    }
    case 'IS_SUBTASK':
      return c.op === 'IS_TRUE'
        ? { parentId: { not: null } }
        : c.op === 'IS_FALSE'
          ? { parentId: null }
          : null;
    case 'START_DATE':
      return nullableCheck('startDate', c.op);
    case 'DUE_DATE': {
      const set = nullableCheck('dueDate', c.op);
      if (set) return set;
      const t = env.now.getTime();
      if (c.op === 'IS_OVERDUE')
        return {
          AND: [{ dueDate: { lt: env.now } }, { status: { not: 'DONE' } }],
        };
      if (c.op === 'IS_NOT_OVERDUE')
        return {
          OR: [
            { dueDate: null },
            { dueDate: { gte: env.now } },
            { status: 'DONE' },
          ],
        };
      if (c.op === 'DUE_WITHIN_DAYS') {
        if (typeof c.value !== 'number') return NOTHING;
        return {
          AND: [
            { dueDate: { gte: env.now } },
            { dueDate: { lte: new Date(t + c.value * 86_400_000) } },
            { status: { not: 'DONE' } },
          ],
        };
      }
      return null;
    }
    case 'CREATED_BY': {
      const ids = users(c.value, env);
      return c.op === 'IN'
        ? { createdById: { in: ids } }
        : c.op === 'NOT_IN'
          ? { createdById: { notIn: ids } }
          : null;
    }
    default:
      return null; // CUSTOM, TITLE, and anything unknown: the evaluator decides
  }
}

/** The pre-filter for a whole `{all, any}` block ({} = no narrowing). Never narrows more than the evaluator would. */
export function conditionsToWhere(
  conditions: Conditions | undefined,
  env: WhereEnv,
): Prisma.TaskWhereInput {
  if (!conditions) return {};
  const parts: Prisma.TaskWhereInput[] = [];
  for (const c of conditions.all ?? []) {
    const w = conditionToWhere(c, env);
    if (w) parts.push(w);
  }
  const any = conditions.any ?? [];
  if (any.length > 0) {
    const arms = any.map((c) => conditionToWhere(c, env));
    if (arms.every((a): a is Prisma.TaskWhereInput => a !== null))
      parts.push({ OR: arms });
  }
  return parts.length === 0 ? {} : { AND: parts };
}
