import { FieldType } from '@prisma/client';
import { CONDITION_TABLE } from './rule.validator';
import {
  OPS_BY_TYPE,
  SPECIAL_USERS,
  checkSlotReferences,
  collectSlotReferences,
  getAction,
  getTrigger,
  misfit,
  walkActions,
} from '../registry';
import { RuleIssue } from './rule.schema';
import {
  Condition,
  Conditions,
  RuleReferences,
  RuleV1,
  WorkspaceRuleContext,
} from './rule.types';

// SPECIAL_USERS and the custom-field typing live in the registry now (descriptors need them); same exports as before
export { SPECIAL_USERS, misfit };

type Json = Record<string, unknown>;
/** The ids a `{all, any}` block of conditions mentions, added to `r`. `special` = user tokens that are not ids. */
export function collectConditionReferences(
  conditions: Conditions,
  r: RuleReferences,
  special: ReadonlySet<string>,
): void {
  const user = (u: string) => {
    if (!special.has(u)) r.userIds.add(u);
  };
  for (const c of [...(conditions.all ?? []), ...(conditions.any ?? [])]) {
    if (c.customFieldId) r.customFieldIds.add(c.customFieldId);
    const list = Array.isArray(c.value) ? (c.value as string[]) : [];
    if (c.field === 'STATUS') list.forEach((x) => r.statusIds.add(x));
    if (c.field === 'TAGS') list.forEach((x) => r.tagIds.add(x));
    if (c.field === 'ISSUE_TYPE') list.forEach((x) => r.issueTypeIds.add(x));
    if (c.field === 'PROJECT') list.forEach((x) => r.projectIds.add(x));
    if (c.field === 'ITERATION') list.forEach((x) => r.iterationIds.add(x));
    if (c.field === 'ASSIGNEES' || c.field === 'CREATED_BY') list.forEach(user);
  }
}

/** Every id the rule mentions, so the caller loads only those. Works on a structurally valid rule. */
export function collectReferences(rule: RuleV1): RuleReferences {
  const r: RuleReferences = {
    ruleIds: new Set(),
    viewIds: new Set(),
    statusIds: new Set(),
    tagIds: new Set(),
    issueTypeIds: new Set(),
    projectIds: new Set(),
    customFieldIds: new Set(),
    userIds: new Set(),
    iterationIds: new Set(),
  };
  const t = getTrigger(rule.trigger.type);
  if (t) collectSlotReferences(t.refs, rule.trigger as Json, r);
  collectConditionReferences(rule.conditions, r, SPECIAL_USERS);
  // actions form a tree (IF): walk every node, and the conditions an IF carries
  walkActions(rule.actions, ({ action, conditions, extraConditions }) => {
    const d = getAction(String(action.type));
    if (d) collectSlotReferences(d.refs, action, r);
    if (conditions) collectConditionReferences(conditions, r, SPECIAL_USERS);
    for (const c of extraConditions ?? [])
      collectConditionReferences(c.conditions, r, SPECIAL_USERS);
  });
  return r;
}

/** The user ids a USER-typed custom field mentions: needs the field's type, so a second pass. */
export function collectCustomUserIds(
  rule: Pick<RuleV1, 'conditions' | 'actions'>,
  typeOf: (fieldId: string) => FieldType | undefined,
  special: ReadonlySet<string> = SPECIAL_USERS,
): string[] {
  const out: string[] = [];
  const add = (v: unknown) => {
    if (typeof v === 'string' && !special.has(v)) out.push(v);
  };
  const fromConditions = (cs: Conditions | undefined) => {
    for (const c of [...(cs?.all ?? []), ...(cs?.any ?? [])]) {
      if (
        c.field === 'CUSTOM' &&
        c.customFieldId &&
        typeOf(c.customFieldId) === FieldType.USER
      )
        (Array.isArray(c.value) ? c.value : [c.value]).forEach(add);
    }
  };
  fromConditions(rule.conditions);
  walkActions(rule.actions, ({ action, conditions, extraConditions }) => {
    fromConditions(conditions);
    for (const c of extraConditions ?? []) fromConditions(c.conditions);
    if (
      action.type === 'SET_CUSTOM_FIELD' &&
      typeOf(action.customFieldId as string) === FieldType.USER
    ) {
      const v = action.value;
      (Array.isArray(v) ? v : [v]).forEach(add);
    }
  });
  return out;
}

// ------------------------------------------------------------------ the check -------------------
/**
 * Pure: does this structurally valid rule make sense in this workspace and scope?
 *   - every id exists (and a status belongs to the rule's PROJECT: a workspace-wide rule can only
 *     name status CATEGORIES, because statuses are per project)
 *   - an operator and value fit the custom field's type
 *   - a rule cannot create the very thing that triggers it (TASK_CREATED -> CREATE_SUBTASK)
 */
export function checkRuleSemantics(
  rule: RuleV1,
  scopeProjectId: string | null,
  ctx: WorkspaceRuleContext,
): RuleIssue[] {
  const issues: RuleIssue[] = [];
  const add = (code: string, path: string, message: string) =>
    issues.push({ code, path, message });

  // trigger: each descriptor says where its ids live; one loop checks them all
  const t = getTrigger(rule.trigger.type);
  if (t)
    checkSlotReferences(
      t.refs,
      rule.trigger as Json,
      '/trigger',
      scopeProjectId,
      ctx,
      add,
    );

  // conditions
  issues.push(
    ...checkConditionRefs(
      rule.conditions,
      '/conditions',
      scopeProjectId,
      ctx,
      SPECIAL_USERS,
    ),
  );

  // actions (a tree): the ids, then whatever the action itself says (a custom-field value must fit its
  // field); an IF's own conditions are checked like the rule's, at the IF's pointer
  walkActions(
    rule.actions,
    ({
      action,
      pointer,
      conditions: block,
      conditionsKey,
      extraConditions,
    }) => {
      const d = getAction(String(action.type));
      if (!d) return;
      checkSlotReferences(d.refs, action, pointer, scopeProjectId, ctx, add);
      d.semantic?.(action as never, pointer, ctx, add, {
        rule,
        scopeProjectId,
      });
      if (block)
        issues.push(
          ...checkConditionRefs(
            block,
            `${pointer}/${conditionsKey}`,
            scopeProjectId,
            ctx,
            SPECIAL_USERS,
          ),
        );
      for (const c of extraConditions ?? [])
        issues.push(
          ...checkConditionRefs(
            c.conditions,
            c.pointer,
            scopeProjectId,
            ctx,
            SPECIAL_USERS,
          ),
        );
    },
  );

  // rule-wide checks a descriptor owns (a rule must not create what triggers it; a schedule needs a
  // project). Each runs once per rule, at the action's first use.
  if (t?.ruleCheck) issues.push(...t.ruleCheck(rule, scopeProjectId));
  const seen = new Set<string>();
  walkActions(rule.actions, ({ action, pointer }) => {
    const type = String(action.type);
    if (seen.has(type)) return;
    seen.add(type);
    const d = getAction(type);
    if (d?.ruleCheck)
      issues.push(...d.ruleCheck(rule, pointer, scopeProjectId));
  });
  return issues;
}

/**
 * Pure: do the ids and values in a `{all, any}` block of conditions make sense in this workspace?
 * Shared by automation rules and saved views (each passes its own `special` user tokens).
 */
export function checkConditionRefs(
  conditions: Conditions,
  basePath: string,
  scopeProjectId: string | null,
  ctx: WorkspaceRuleContext,
  special: ReadonlySet<string>,
): RuleIssue[] {
  const issues: RuleIssue[] = [];
  const add = (code: string, path: string, message: string) =>
    issues.push({ code, path, message });
  const statusId = (sid: string, path: string) => {
    if (!scopeProjectId)
      return add(
        'STATUS_NEEDS_PROJECT',
        path,
        'A specific status can only be named when the scope is one project; use a status category instead',
      );
    const s = ctx.statuses.get(sid);
    if (!s || s.projectId !== scopeProjectId)
      add('UNKNOWN_STATUS', path, 'That status does not exist in this project');
  };
  const user = (u: string, path: string) => {
    if (!special.has(u) && !ctx.validUserIds.has(u))
      add('UNKNOWN_USER', path, 'That user is not a member of this workspace');
  };
  const customField = (fid: string, path: string) => {
    const f = ctx.customFields.get(fid);
    if (!f)
      add(
        'UNKNOWN_CUSTOM_FIELD',
        path,
        'That custom field does not exist in this workspace',
      );
    return f;
  };
  (['all', 'any'] as const).forEach((group) =>
    (conditions[group] ?? []).forEach((c: Condition, i) => {
      const base = `${basePath}/${group}/${i}`;
      const list = Array.isArray(c.value) ? (c.value as string[]) : [];
      const each = (check: (v: string, p: string) => void) =>
        list.forEach((v, j) => check(v, `${base}/value/${j}`));
      if (c.field === 'STATUS') each((v, p) => statusId(v, p));
      if (c.field === 'TAGS')
        each((v, p) => {
          if (!ctx.tagIds.has(v))
            add('UNKNOWN_TAG', p, 'That tag does not exist in this workspace');
        });
      if (c.field === 'ISSUE_TYPE')
        each((v, p) => {
          if (!ctx.issueTypeIds.has(v))
            add(
              'UNKNOWN_ISSUE_TYPE',
              p,
              'That issue type does not exist in this workspace',
            );
        });
      if (c.field === 'PROJECT')
        each((v, p) => {
          if (!ctx.projectIds.has(v))
            add(
              'UNKNOWN_PROJECT',
              p,
              'That project does not exist in this workspace',
            );
        });
      if (c.field === 'ASSIGNEES' || c.field === 'CREATED_BY')
        each((v, p) => user(v, p));
      if (c.field === 'ITERATION')
        each((v, p) => {
          if (!ctx.iterationIds.has(v))
            add(
              'UNKNOWN_ITERATION',
              p,
              'That iteration does not exist in this workspace',
            );
        });
      if (c.field === 'CUSTOM' && c.customFieldId) {
        const f = customField(c.customFieldId, `${base}/customFieldId`);
        if (!f) return;
        if (!OPS_BY_TYPE[f.dataType].includes(c.op))
          return add(
            'OPERATOR_MISMATCH',
            `${base}/op`,
            `${c.op} does not work with a ${f.dataType} field`,
          );
        const kind = CONDITION_TABLE.CUSTOM[c.op];
        if (kind !== 'none') {
          const why = misfit(f.dataType, f.options, c.value, ctx, special);
          if (why) add('VALUE_MISMATCH', `${base}/value`, `The value ${why}`);
        }
      }
    }),
  );

  return issues;
}
