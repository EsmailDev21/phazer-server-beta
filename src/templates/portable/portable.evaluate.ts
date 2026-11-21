import {
  RuleIssue,
  RuleV1,
  UnsupportedConstruct,
  checkRuleSemantics,
  validateRule,
} from '../../automations/dsl';
import {
  ViewConfigV1,
  checkViewSemantics,
  validateViewConfig,
} from '../../views/dsl';
import { VIEW_LIMITS } from '../../views/dsl';
import { AUTOMATION_LIMITS } from '../../automations/dsl';
import {
  contextOf,
  forwardMapper,
  RULE_TOKENS,
  VIEW_TOKENS,
} from './portable.model';
import { RefWalker } from './portable.refs';
import { EntityModel, ItemClass, RULE_KIND, VIEW_KIND } from './portable.types';

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** `rule`, `view`, or `raw` (anything else: stays opaque JSON, carried untouched, as before step 5.5). */
export function classifyItem(item: unknown): ItemClass {
  if (isObj(item) && item.kind === RULE_KIND) return 'rule';
  if (isObj(item) && item.kind === VIEW_KIND) return 'view';
  return 'raw';
}

export type EvaluatedRule = {
  ok: true;
  kind: 'rule';
  name: string;
  rule: RuleV1;
  triggerType: string;
  unsupported: UnsupportedConstruct[];
};
export type EvaluatedView = {
  ok: true;
  kind: 'view';
  name: string;
  layout: string;
  shared: boolean;
  config: ViewConfigV1;
};
export type Failed = {
  ok: false;
  kind: 'rule' | 'view';
  name: string;
  issues: RuleIssue[];
};
export type Evaluated = EvaluatedRule | EvaluatedView | Failed;

const RULE_KEYS = ['kind', 'name', 'trigger', 'conditions', 'actions'];
const VIEW_KEYS = ['kind', 'name', 'layout', 'shared', 'config'];

function nameIssue(name: unknown): RuleIssue | null {
  if (typeof name !== 'string')
    return { code: 'MISSING', path: '/name', message: 'A name is required' };
  const collapsed = name.replace(/\s+/g, ' ').trim();
  if (
    collapsed.length === 0 ||
    collapsed.length > AUTOMATION_LIMITS.maxNameLength ||
    /[\u0000-\u001f\u007f]/.test(collapsed)
  ) {
    return {
      code: 'BAD_NAME',
      path: '/name',
      message: `The name must be 1 to ${AUTOMATION_LIMITS.maxNameLength} printable characters`,
    };
  }
  return null;
}

function shapeIssues(
  item: Record<string, unknown>,
  allowed: string[],
  required: string[],
): RuleIssue[] {
  const issues: RuleIssue[] = [];
  for (const k of Object.keys(item))
    if (!allowed.includes(k))
      issues.push({
        code: 'UNKNOWN_KEY',
        path: `/${k}`,
        message: `"${k}" is not allowed here`,
      });
  for (const k of required)
    if (item[k] === undefined)
      issues.push({
        code: 'MISSING',
        path: `/${k}`,
        message: `"${k}" is required`,
      });
  const n = nameIssue(item.name);
  if (n) issues.push(n);
  return issues;
}

const scopeId = (model: EntityModel, projectKey: string) =>
  model.projects.find((p) => p.nodeKey === projectKey)?.id ?? null;

/**
 * Pure: a portable automation -> a rule in terms of THIS model's ids, or why not. The same pipeline
 * runs at publish time (model = the blueprint, synthetic ids), in the apply preview (model = what the
 * apply will do) and at apply (model = real ids): a template cannot pass one and fail another by
 * construction, only because the workspace it lands in differs (a custom field it cannot reuse).
 */
export function evaluateRuleItem(
  item: unknown,
  model: EntityModel,
  projectKey: string,
): Evaluated {
  const name = isObj(item) && typeof item.name === 'string' ? item.name : '';
  if (!isObj(item))
    return {
      ok: false,
      kind: 'rule',
      name,
      issues: [
        {
          code: 'WRONG_TYPE',
          path: '',
          message: 'An automation must be an object',
        },
      ],
    };
  const shape = shapeIssues(item, RULE_KEYS, ['trigger', 'actions']);
  if (shape.length > 0) return { ok: false, kind: 'rule', name, issues: shape };

  const walker = new RefWalker(forwardMapper(model, projectKey, RULE_TOKENS));
  const bound = walker.rule({
    trigger: item.trigger,
    conditions: item.conditions,
    actions: item.actions,
  });
  if (walker.issues.length > 0)
    return { ok: false, kind: 'rule', name, issues: walker.issues };

  const parsed = validateRule(bound);
  if (parsed.ok === false)
    return { ok: false, kind: 'rule', name, issues: parsed.issues };
  const issues = checkRuleSemantics(
    parsed.rule,
    scopeId(model, projectKey),
    contextOf(model),
  );
  if (issues.length > 0) return { ok: false, kind: 'rule', name, issues };
  return {
    ok: true,
    kind: 'rule',
    name,
    rule: parsed.rule,
    triggerType: parsed.triggerType,
    unsupported: parsed.unsupported,
  };
}

/** Pure: a portable saved view -> a config in terms of THIS model's ids, or why not. */
export function evaluateViewItem(
  item: unknown,
  model: EntityModel,
  projectKey: string,
): Evaluated {
  const name = isObj(item) && typeof item.name === 'string' ? item.name : '';
  if (!isObj(item))
    return {
      ok: false,
      kind: 'view',
      name,
      issues: [
        { code: 'WRONG_TYPE', path: '', message: 'A view must be an object' },
      ],
    };
  const shape = shapeIssues(item, VIEW_KEYS, ['layout', 'config']);
  if (item.shared !== undefined && typeof item.shared !== 'boolean')
    shape.push({
      code: 'WRONG_TYPE',
      path: '/shared',
      message: 'shared must be true or false',
    });
  if (shape.length > 0) return { ok: false, kind: 'view', name, issues: shape };

  const walker = new RefWalker(forwardMapper(model, projectKey, VIEW_TOKENS));
  const bound = walker.viewConfig(item.config);
  if (walker.issues.length > 0)
    return {
      ok: false,
      kind: 'view',
      name,
      issues: walker.issues.map((i) => ({ ...i, path: `/config${i.path}` })),
    };

  const parsed = validateViewConfig(item.layout, bound);
  if (parsed.ok === false)
    return {
      ok: false,
      kind: 'view',
      name,
      issues: parsed.issues.map((i) => ({
        ...i,
        path: i.path.startsWith('/layout') ? i.path : `/config${i.path}`,
      })),
    };
  const issues = checkViewSemantics(
    parsed.layout,
    parsed.config,
    scopeId(model, projectKey),
    contextOf(model),
  );
  if (issues.length > 0)
    return {
      ok: false,
      kind: 'view',
      name,
      issues: issues.map((i) => ({ ...i, path: `/config${i.path}` })),
    };
  return {
    ok: true,
    kind: 'view',
    name,
    layout: parsed.layout,
    shared: item.shared === true,
    config: parsed.config,
  };
}

export const PORTABLE_LIMITS = {
  maxRules: AUTOMATION_LIMITS.maxAutomationsPerWorkspace,
  maxViews: VIEW_LIMITS.maxSharedPerWorkspace,
} as const;
