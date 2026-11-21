import { FieldType } from '@prisma/client';
import type { WorkspaceRuleContext } from '../dsl/rule.types';

/** User tokens a rule may use in place of an id. (Saved views have their own: `ME`.) */
export const SPECIAL_USERS: ReadonlySet<string> = new Set([
  'TRIGGERER',
  'CREATOR',
]);
/**
 * What an ACTION may say in place of a person (an ASSIGN, a NOTIFY, a new task's assignees): the two
 * people of the event, and the two GROUPS of the task it is about. Conditions and custom-field values keep
 * the two single-person tokens above: a condition compares with one person at a time.
 */
export const ACTION_USER_TOKENS: ReadonlySet<string> = new Set([
  'TRIGGERER',
  'CREATOR',
  'ASSIGNEES',
  'WATCHERS',
]);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** A real calendar date: V8 happily parses 2026-02-30 as March 2nd, so compare the round trip. */
const isRealDate = (v: string): boolean => {
  const t = Date.parse(`${v}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === v;
};

export const OPS_BY_TYPE: Record<FieldType, readonly string[]> = {
  TEXT: ['EQ', 'NE', 'CONTAINS', 'IS_SET', 'IS_NOT_SET'],
  NUMBER: ['EQ', 'NE', 'GT', 'GTE', 'LT', 'LTE', 'IS_SET', 'IS_NOT_SET'],
  DATE: ['EQ', 'NE', 'GT', 'GTE', 'LT', 'LTE', 'IS_SET', 'IS_NOT_SET'],
  SELECT: ['EQ', 'NE', 'IN', 'NOT_IN', 'IS_SET', 'IS_NOT_SET'],
  MULTI_SELECT: ['HAS_ANY', 'HAS_ALL', 'HAS_NONE', 'IS_SET', 'IS_NOT_SET'],
  CHECKBOX: ['IS_TRUE', 'IS_FALSE'],
  USER: ['INCLUDES_ANY', 'INCLUDES_NONE', 'IS_SET', 'IS_NOT_SET'],
  URL: ['IS_SET', 'IS_NOT_SET', 'EQ', 'NE'],
};

/** Does `value` fit a field of this type? Returns a reason, or null when it fits. */
export function misfit(
  type: FieldType,
  options: readonly string[] | null,
  value: unknown,
  ctx: WorkspaceRuleContext,
  special: ReadonlySet<string> = SPECIAL_USERS,
): string | null {
  const opts = options ?? [];
  const one = (v: unknown): string | null => {
    switch (type) {
      case 'TEXT':
        return typeof v === 'string' ? null : 'needs text';
      case 'NUMBER':
        return typeof v === 'number' ? null : 'needs a number';
      case 'DATE':
        return typeof v === 'string' && DATE.test(v) && isRealDate(v)
          ? null
          : 'needs a date as YYYY-MM-DD';
      case 'SELECT':
      case 'MULTI_SELECT':
        return typeof v === 'string' && opts.includes(v)
          ? null
          : "is not one of the field's options";
      case 'CHECKBOX':
        return typeof v === 'boolean' ? null : 'needs true or false';
      case 'USER':
        return typeof v === 'string' &&
          (special.has(v) || ctx.validUserIds.has(v))
          ? null
          : 'is not a user of this workspace';
      case 'URL':
        return typeof v === 'string' && /^https?:\/\/\S+$/i.test(v)
          ? null
          : 'needs an http(s) link';
    }
  };
  if (Array.isArray(value)) {
    if (type === 'SELECT' || type === 'MULTI_SELECT' || type === 'USER') {
      for (const v of value) {
        const r = one(v);
        if (r) return r;
      }
      return null;
    }
    return 'does not take a list';
  }
  return one(value);
}
