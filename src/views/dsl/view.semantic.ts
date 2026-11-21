import { FieldType } from '@prisma/client';
import {
  RuleIssue,
  RuleReferences,
  WorkspaceRuleContext,
  checkConditionRefs,
  collectConditionReferences,
  collectCustomUserIds,
} from '../../automations/dsl';
import { VIEW_SPECIAL_USERS } from './view.fields';
import { Layout } from './view.fields';
import { ViewConfigV1 } from './view.types';

const GROUPABLE: readonly FieldType[] = [
  FieldType.SELECT,
  FieldType.USER,
  FieldType.CHECKBOX,
];
const BOARD_GROUPABLE: readonly FieldType[] = [FieldType.SELECT];
const SORTABLE: readonly FieldType[] = [
  FieldType.NUMBER,
  FieldType.DATE,
  FieldType.TEXT,
  FieldType.SELECT,
  FieldType.CHECKBOX,
  FieldType.URL,
];

const customColumnId = (c: string): string | null =>
  c.startsWith('custom:') ? c.slice('custom:'.length) : null;

/** Every id the config mentions, so the caller loads only those. */
export function collectViewReferences(
  config: ViewConfigV1,
  scopeProjectId: string | null,
): RuleReferences {
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
  collectConditionReferences(config.filters ?? {}, r, VIEW_SPECIAL_USERS);
  if (config.group?.customFieldId)
    r.customFieldIds.add(config.group.customFieldId);
  for (const k of config.sort ?? [])
    if (k.customFieldId) r.customFieldIds.add(k.customFieldId);
  for (const c of config.columns ?? []) {
    const id = customColumnId(c);
    if (id) r.customFieldIds.add(id);
  }
  if (scopeProjectId) r.projectIds.add(scopeProjectId);
  return r;
}

/** The users a USER-typed custom filter value names: needs the field's type, so a second pass. */
export function collectViewCustomUserIds(
  config: ViewConfigV1,
  typeOf: (fieldId: string) => FieldType | undefined,
): string[] {
  return collectCustomUserIds(
    { conditions: config.filters ?? {}, actions: [] },
    typeOf,
    VIEW_SPECIAL_USERS,
  );
}

/**
 * Pure: does this structurally valid config make sense in this workspace and scope?
 *   - filters: every id exists (a specific status only in a project view), values fit custom field types
 *   - a custom field can be grouped by only if its type has a small set of values (boards: select only)
 *   - a custom field can be sorted by only if its type has an order
 *   - custom columns exist
 */
export function checkViewSemantics(
  layout: Layout,
  config: ViewConfigV1,
  scopeProjectId: string | null,
  ctx: WorkspaceRuleContext,
): RuleIssue[] {
  const issues = checkConditionRefs(
    config.filters ?? {},
    '/filters',
    scopeProjectId,
    ctx,
    VIEW_SPECIAL_USERS,
  );
  const add = (code: string, path: string, message: string) =>
    issues.push({ code, path, message });

  if (config.group?.customFieldId) {
    const f = ctx.customFields.get(config.group.customFieldId);
    if (!f)
      add(
        'UNKNOWN_CUSTOM_FIELD',
        '/group/customFieldId',
        'That custom field does not exist in this workspace',
      );
    else if (
      !(layout === 'BOARD' ? BOARD_GROUPABLE : GROUPABLE).includes(f.dataType)
    ) {
      add(
        'GROUP_TYPE_MISMATCH',
        '/group/customFieldId',
        `A ${f.dataType} field cannot be grouped by${layout === 'BOARD' ? ' on a board' : ''}`,
      );
    }
  }
  (config.sort ?? []).forEach((k, i) => {
    if (!k.customFieldId) return;
    const f = ctx.customFields.get(k.customFieldId);
    if (!f)
      add(
        'UNKNOWN_CUSTOM_FIELD',
        `/sort/${i}/customFieldId`,
        'That custom field does not exist in this workspace',
      );
    else if (!SORTABLE.includes(f.dataType))
      add(
        'SORT_TYPE_MISMATCH',
        `/sort/${i}/customFieldId`,
        `A ${f.dataType} field has no order to sort by`,
      );
  });
  (config.columns ?? []).forEach((c, i) => {
    const id = customColumnId(c);
    if (id && !ctx.customFields.has(id))
      add(
        'UNKNOWN_CUSTOM_FIELD',
        `/columns/${i}`,
        'That custom field does not exist in this workspace',
      );
  });
  return issues;
}
