import type { WorkspaceRuleContext, RuleReferences } from '../dsl/rule.types';
import { ACTION_USER_TOKENS, SPECIAL_USERS } from './custom-field-typing';
import type { AddIssue, RefSlot, RuleRefKind } from './descriptor';

export { ACTION_USER_TOKENS, SPECIAL_USERS };

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** the RuleReferences set a kind is collected into (a chat channel is not looked up as an id) */
const SET_OF: Record<RuleRefKind, keyof RuleReferences | null> = {
  status: 'statusIds',
  tag: 'tagIds',
  issueType: 'issueTypeIds',
  customField: 'customFieldIds',
  iteration: 'iterationIds',
  project: 'projectIds',
  user: 'userIds',
  channel: null,
  rule: 'ruleIds',
  view: 'viewIds',
};

/** every id value the slot holds on `node`, in order: [value, pointer relative to the node] */
function values(slot: RefSlot, node: Json): Array<[string, string]> {
  const v = node[slot.key];
  const out: Array<[string, string]> = [];
  switch (slot.shape) {
    case 'one':
      if (typeof v === 'string') out.push([v, slot.key]);
      break;
    case 'list':
      if (Array.isArray(v))
        v.forEach((x, i) => {
          if (typeof x === 'string') out.push([x, `${slot.key}/${i}`]);
        });
      break;
    case 'statusRef':
      if (isObj(v) && typeof v.statusId === 'string')
        out.push([v.statusId, `${slot.key}/statusId`]);
      break;
    case 'statusRefList':
      if (Array.isArray(v))
        v.forEach((s, i) => {
          if (isObj(s) && typeof s.statusId === 'string')
            out.push([s.statusId, `${slot.key}/${i}/statusId`]);
        });
      break;
  }
  return out;
}

/** Adds the ids a descriptor's slots mention on `node` to `r` (user tokens like TRIGGERER are not ids). */
export function collectSlotReferences(
  slots: readonly RefSlot[],
  node: Json,
  r: RuleReferences,
): void {
  for (const slot of slots) {
    const set = SET_OF[slot.kind];
    if (!set) continue;
    for (const [value] of values(slot, node)) {
      if (slot.kind === 'user' && ACTION_USER_TOKENS.has(value)) continue;
      r[set].add(value);
    }
  }
}

/** The one place that says "does this name exist here?" for a slot kind. Returns the issue, or null. */
function missing(
  kind: RuleRefKind,
  value: string,
  ctx: WorkspaceRuleContext,
): { code: string; message: string } | null {
  switch (kind) {
    case 'tag':
      return ctx.tagIds.has(value)
        ? null
        : {
            code: 'UNKNOWN_TAG',
            message: 'That tag does not exist in this workspace',
          };
    case 'issueType':
      return ctx.issueTypeIds.has(value)
        ? null
        : {
            code: 'UNKNOWN_ISSUE_TYPE',
            message: 'That issue type does not exist in this workspace',
          };
    case 'iteration':
      return ctx.iterationIds.has(value)
        ? null
        : {
            code: 'UNKNOWN_ITERATION',
            message: 'That iteration does not exist in this workspace',
          };
    case 'customField':
      return ctx.customFields.has(value)
        ? null
        : {
            code: 'UNKNOWN_CUSTOM_FIELD',
            message: 'That custom field does not exist in this workspace',
          };
    case 'project':
      return ctx.projectIds.has(value)
        ? null
        : {
            code: 'UNKNOWN_PROJECT',
            message: 'That project does not exist in this workspace',
          };
    case 'user':
      return ACTION_USER_TOKENS.has(value) || ctx.validUserIds.has(value)
        ? null
        : {
            code: 'UNKNOWN_USER',
            message: 'That user is not a member of this workspace',
          };
    case 'rule':
      return ctx.rules?.has(value)
        ? null
        : {
            code: 'UNKNOWN_RULE',
            message: 'That rule does not exist in this workspace',
          };
    case 'view':
      return ctx.views?.has(value)
        ? null
        : {
            code: 'UNKNOWN_VIEW',
            message: 'That saved view does not exist in this workspace',
          };
    default:
      return null; // status is checked against the rule's project; a channel needs Phase 2
  }
}

/**
 * The workspace check for every slot of a descriptor: each id must exist (a status must belong to the
 * rule's PROJECT; a workspace-wide rule can only name status CATEGORIES). `base` is the pointer of the node.
 */
export function checkSlotReferences(
  slots: readonly RefSlot[],
  node: Json,
  base: string,
  scopeProjectId: string | null,
  ctx: WorkspaceRuleContext,
  add: AddIssue,
): void {
  const ptr = (rel: string) =>
    `${base}/${rel
      .split('/')
      .map((s) => s.replace(/~/g, '~0'))
      .join('/')}`;
  for (const slot of slots) {
    for (const [value, rel] of values(slot, node)) {
      const path = ptr(rel);
      if (slot.kind === 'status') {
        if (!scopeProjectId) {
          add(
            'STATUS_NEEDS_PROJECT',
            path,
            'A specific status can only be named in a rule that belongs to one project; use a status category instead',
          );
          continue;
        }
        const s = ctx.statuses.get(value);
        if (!s || s.projectId !== scopeProjectId)
          add(
            'UNKNOWN_STATUS',
            path,
            "That status does not exist in this rule's project",
          );
        continue;
      }
      const issue = missing(slot.kind, value, ctx);
      if (issue) add(issue.code, path, issue.message);
    }
  }
}

/**
 * Rewrites every reference a descriptor's slots hold on `node` through `ref(kind, value, path)`;
 * `basePath` is the node's pointer. Never mutates `node`. Values of other shapes pass through untouched.
 */
export function mapSlotReferences(
  slots: readonly RefSlot[],
  node: Json,
  basePath: string,
  ref: (kind: RuleRefKind, value: unknown, path: string) => unknown,
): Json {
  const out: Json = { ...node };
  for (const slot of slots) {
    const v = node[slot.key];
    const p = `${basePath}/${slot.key}`;
    switch (slot.shape) {
      case 'one':
        if (v !== undefined) out[slot.key] = ref(slot.kind, v, p);
        break;
      case 'list':
        if (Array.isArray(v))
          out[slot.key] = v.map((x, i) => ref(slot.kind, x, `${p}/${i}`));
        break;
      case 'statusRef':
        if (isObj(v) && v.statusId !== undefined)
          out[slot.key] = {
            ...v,
            statusId: ref('status', v.statusId, `${p}/statusId`),
          };
        break;
      case 'statusRefList':
        if (Array.isArray(v))
          out[slot.key] = v.map((s, i) =>
            isObj(s) && s.statusId !== undefined
              ? {
                  ...s,
                  statusId: ref('status', s.statusId, `${p}/${i}/statusId`),
                }
              : s,
          );
        break;
    }
  }
  return out;
}
