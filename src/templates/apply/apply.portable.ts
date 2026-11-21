import {
  AUTOMATION_LIMITS,
  RuleV1,
  UnsupportedConstruct,
} from '../../automations/dsl';
import { VIEW_LIMITS, ViewConfigV1 } from '../../views/dsl';
import { ResolvedBlueprint } from '../resolve';
import { foldName } from '../blueprint';
import {
  EntityModel,
  classifyItem,
  evaluateRuleItem,
  evaluateViewItem,
} from '../portable';
import {
  ApplyPlan,
  PlanAutomation,
  PlanIssue,
  PlanView,
  WorkspaceState,
} from './apply.types';

/** Real ids for what the apply creates or reuses; absent at preview time (placeholders are used). */
export interface RealIds {
  tag: ReadonlyMap<string, string>; // folded name -> id
  type: ReadonlyMap<string, string>;
  field: ReadonlyMap<string, { id: string } | null>; // key (lower) -> field | null (skipped)
  project: ReadonlyMap<string, string>; // nodeKey -> id
  status: ReadonlyMap<string, ReadonlyMap<string, string>>; // project nodeKey -> status key -> id
  iteration: ReadonlyMap<string, string>; // nodeKey -> id
}

/**
 * The entity model of THIS apply: what the template will find in the workspace once the apply has
 * created or reused its tags, fields, types, iterations and projects. A field the apply SKIPS is absent
 * (so an automation naming it cannot bind), and a REUSED field keeps the options it already has.
 */
export function modelFromPlan(
  resolved: ResolvedBlueprint,
  plan: Pick<ApplyPlan, 'tags' | 'customFields' | 'issueTypes'>,
  real?: RealIds,
) {
  const model: EntityModel = {
    tags: plan.tags.map((t, i) => ({
      name: t.name,
      id: real ? (real.tag.get(foldName(t.name)) ?? `tag${i}`) : `tag${i}`,
    })),
    issueTypes: plan.issueTypes.map((t, i) => ({
      name: t.name,
      id: real ? (real.type.get(foldName(t.name)) ?? `type${i}`) : `type${i}`,
    })),
    customFields: plan.customFields
      .filter((f) => f.action !== 'SKIP')
      .map((f, i) => ({
        key: f.key,
        id: real
          ? (real.field.get(f.key.toLowerCase())?.id ?? `field${i}`)
          : `field${i}`,
        dataType: f.dataType,
        options: (f.action === 'REUSE' ? f.existingOptions : f.options) ?? null,
      })),
    iterations: resolved.workspace.iterations.map((it, i) => ({
      nodeKey: it.nodeKey,
      id: real ? (real.iteration.get(it.nodeKey) ?? `iter${i}`) : `iter${i}`,
    })),
    projects: resolved.projects.map((p, i) => ({
      nodeKey: p.nodeKey,
      id: real ? (real.project.get(p.nodeKey) ?? `proj${i}`) : `proj${i}`,
    })),
    statuses: resolved.projects.flatMap((p, pi) =>
      (p.workflow?.statuses ?? []).map((s, si) => ({
        projectKey: p.nodeKey,
        key: s.key,
        id: real
          ? (real.status.get(p.nodeKey)?.get(s.key) ?? `status${pi}x${si}`)
          : `status${pi}x${si}`,
        category: s.category,
      })),
    ),
  };
  return model;
}

/** "Name" -> "Name (2)" -> "(3)"..., compared the way automation names are compared, never exceeding the limit. */
export function uniqueAutomationName(name: string, taken: Set<string>): string {
  const key = (n: string) =>
    n.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!taken.has(key(name))) return name;
  for (let n = 2; ; n++) {
    const suffix = ` (${n})`;
    const candidate = `${name.slice(0, AUTOMATION_LIMITS.maxNameLength - suffix.length)}${suffix}`;
    if (!taken.has(key(candidate))) return candidate;
  }
}

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();
const firstIssue = (issues: Array<{ code: string; path: string }>) =>
  `${issues[0].code} at ${issues[0].path || '/'}`;

/** What the apply will actually write (bound to this workspace's ids). Never part of a plan: a plan carries names and counts only. */
export type PortableWork =
  | {
      kind: 'rule';
      project: string;
      name: string;
      rule: RuleV1;
      triggerType: string;
      unsupported: UnsupportedConstruct[];
    }
  | {
      kind: 'raw';
      project: string;
      name: string;
      item: Record<string, unknown>;
    }
  | {
      kind: 'view';
      project: string;
      name: string;
      layout: string;
      shared: boolean;
      config: ViewConfigV1;
    };

export interface PortablePlan {
  /** in the order they must be written */
  work: PortableWork[];
  automations: PlanAutomation[];
  views: PlanView[];
  warnings: PlanIssue[];
  blockers: PlanIssue[];
  counts: {
    automations: { create: number; raw: number; skip: number };
    savedViews: { personal: number; shared: number; skip: number };
  };
}

/**
 * Step 5.5, pure. For every automation and view the template carries: will it be created, kept as
 * an inert imported rule, or skipped here, and why? Uses the SAME evaluation the apply uses (so the
 * preview and the result agree) over the model of what this apply will do.
 *
 *  - automations are ALWAYS created OFF: a template must never switch on something that acts on a
 *    workspace's work by itself; an admin reviews and enables them
 *  - an item that is not in the portable form is kept as an inert imported rule (nothing is lost)
 *  - a view is shared only if the template asks AND the person applying may share; otherwise it is
 *    theirs alone (a warning says so)
 */
export function planPortable(
  resolved: ResolvedBlueprint,
  plan: Pick<ApplyPlan, 'tags' | 'customFields' | 'issueTypes'>,
  state: WorkspaceState,
  real?: RealIds,
): PortablePlan {
  const warnings: PlanIssue[] = [];
  const blockers: PlanIssue[] = [];
  const automations: PlanAutomation[] = [];
  const views: PlanView[] = [];
  const work: PortableWork[] = [];
  const model = modelFromPlan(resolved, plan, real);
  const taken = new Set(state.automations?.nameKeys ?? []);
  const canShare = state.savedViews?.canShare ?? false;
  let rawIndex = 0;

  for (const p of resolved.projects) {
    for (const item of p.automations) {
      const cls = classifyItem(item);
      if (cls === 'rule') {
        const out = evaluateRuleItem(item, model, p.nodeKey);
        if (out.ok === false) {
          automations.push({
            project: p.nodeKey,
            name: out.name,
            finalName: out.name,
            action: 'SKIP',
            unsupported: 0,
            reason: firstIssue(out.issues),
          });
          continue;
        }
        const name = collapse(out.name);
        const finalName = uniqueAutomationName(name, taken);
        taken.add(
          finalName.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase(),
        );
        automations.push({
          project: p.nodeKey,
          name,
          finalName,
          action: 'CREATE',
          unsupported: out.kind === 'rule' ? out.unsupported.length : 0,
        });
        if (out.kind === 'rule')
          work.push({
            kind: 'rule',
            project: p.nodeKey,
            name: finalName,
            rule: out.rule,
            triggerType: out.triggerType,
            unsupported: out.unsupported,
          });
      } else {
        // not in the portable form: carried, never interpreted
        const given =
          typeof (item as { name?: unknown }).name === 'string'
            ? collapse((item as { name: string }).name)
            : '';
        const base =
          given.length > 0 &&
          given.length <= AUTOMATION_LIMITS.maxNameLength &&
          !/[\u0000-\u001f\u007f]/.test(given)
            ? given
            : `Imported automation ${++rawIndex}`;
        const finalName = uniqueAutomationName(base, taken);
        taken.add(
          finalName.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase(),
        );
        automations.push({
          project: p.nodeKey,
          name: base,
          finalName,
          action: 'RAW',
          unsupported: 0,
        });
        work.push({
          kind: 'raw',
          project: p.nodeKey,
          name: finalName,
          item: item as Record<string, unknown>,
        });
      }
    }
    for (const item of p.views) {
      if (classifyItem(item) !== 'view') {
        views.push({
          project: p.nodeKey,
          name:
            typeof (item as { name?: unknown }).name === 'string'
              ? (item as { name: string }).name
              : '',
          action: 'SKIP',
          shared: false,
          reason: 'not a recognised saved view',
        });
        continue;
      }
      const out = evaluateViewItem(item, model, p.nodeKey);
      if (out.ok === false) {
        views.push({
          project: p.nodeKey,
          name: out.name,
          action: 'SKIP',
          shared: false,
          reason: firstIssue(out.issues),
        });
        continue;
      }
      const shared = out.kind === 'view' && out.shared && canShare;
      views.push({
        project: p.nodeKey,
        name: collapse(out.name),
        action: 'CREATE',
        shared,
      });
      if (out.kind === 'view')
        work.push({
          kind: 'view',
          project: p.nodeKey,
          name: collapse(out.name),
          layout: out.layout,
          shared,
          config: out.config,
        });
    }
  }

  const count = <T extends { action: string }>(xs: T[], a: string) =>
    xs.filter((x) => x.action === a).length;
  const counts = {
    automations: {
      create: count(automations, 'CREATE'),
      raw: count(automations, 'RAW'),
      skip: count(automations, 'SKIP'),
    },
    savedViews: {
      personal: views.filter((v) => v.action === 'CREATE' && !v.shared).length,
      shared: views.filter((v) => v.action === 'CREATE' && v.shared).length,
      skip: count(views, 'SKIP'),
    },
  };

  const made = counts.automations.create + counts.automations.raw;
  if (made > 0) {
    warnings.push({
      code: 'AUTOMATIONS_CREATED_OFF',
      message: `${made} automation(s) will be added switched OFF. Review them, then turn on the ones you want.`,
    });
  }
  for (const a of automations.filter((x) => x.action === 'SKIP')) {
    warnings.push({
      code: 'AUTOMATION_SKIPPED',
      message: `Automation "${a.name}" is not added: ${a.reason}.`,
    });
  }
  for (const a of automations.filter(
    (x) => x.action === 'CREATE' && x.finalName !== x.name,
  )) {
    warnings.push({
      code: 'AUTOMATION_RENAMED',
      message: `An automation named "${a.name}" already exists; the new one is "${a.finalName}".`,
    });
  }
  for (const v of views.filter((x) => x.action === 'SKIP')) {
    warnings.push({
      code: 'VIEW_SKIPPED',
      message: `View "${v.name}" is not added: ${v.reason}.`,
    });
  }
  const wantedShared = resolved.projects
    .flatMap((p) => p.views)
    .filter(
      (v) =>
        classifyItem(v) === 'view' &&
        (v as { shared?: unknown }).shared === true,
    ).length;
  if (!canShare && wantedShared > 0) {
    warnings.push({
      code: 'VIEW_NOT_SHARED',
      message: `${wantedShared} view(s) are meant to be shared with the workspace; only an admin can do that, so they are added as your own personal views.`,
    });
  }

  const existing = state.automations?.count ?? 0;
  if (existing + made > AUTOMATION_LIMITS.maxAutomationsPerWorkspace) {
    blockers.push({
      code: 'AUTOMATION_LIMIT',
      message: `A workspace holds at most ${AUTOMATION_LIMITS.maxAutomationsPerWorkspace} automations; this would make ${existing + made}.`,
      suggestions: [
        'Delete automations you no longer use.',
        'Turn off optional parts of the template (modules).',
      ],
    });
  }
  const sv = state.savedViews;
  if (
    sv &&
    sv.personalOfUser + counts.savedViews.personal >
      VIEW_LIMITS.maxPersonalPerUserPerWorkspace
  ) {
    blockers.push({
      code: 'VIEW_LIMIT',
      message: `You can have at most ${VIEW_LIMITS.maxPersonalPerUserPerWorkspace} personal views in a workspace.`,
      suggestions: ['Delete views you no longer use.'],
    });
  }
  if (
    sv &&
    sv.shared + counts.savedViews.shared > VIEW_LIMITS.maxSharedPerWorkspace
  ) {
    blockers.push({
      code: 'VIEW_LIMIT',
      message: `A workspace holds at most ${VIEW_LIMITS.maxSharedPerWorkspace} shared views.`,
      suggestions: ['Delete shared views you no longer use.'],
    });
  }
  return { work, automations, views, warnings, blockers, counts };
}
