import { DependencyType } from '@prisma/client';
import { VariableTypes } from '../blueprint';
import {
  BLUEPRINT_LIMITS as L,
  BlueprintTask,
  BlueprintV1,
  validateBlueprint,
} from './resolve.deps';
import { isCalendarDate } from '../blueprint';
import { offsetDate } from './resolve.dates';
import { expandModules } from './resolve.modules';
import { assigneesFor, resolveRoles } from './resolve.roles';
import { renderText } from './resolve.text';
import {
  Issues,
  ResolveIssue,
  ResolvedBlueprint,
  ResolvedCustomValue,
  ResolvedIteration,
  ResolvedProject,
  ResolvedTask,
  VariableValues,
} from './resolve.types';
import { resolveVariables } from './resolve.variables';

/**
 * Step 3.2. Pipeline steps 2-5 of diagram 15, as one pure function:
 *   validate -> variable values -> expand modules -> render text + resolve dates -> roles
 * (step 1 is validation, step 6 "materialise the plan" and 7 "apply" are step 3.6).
 *
 * `today` is passed in ("YYYY-MM-DD"): the anchor falls back to it when the template names no
 * anchor variable, and a function that reads the clock cannot be tested or replayed.
 */
export interface ResolveInput {
  variables?: unknown;
  modules?: unknown;
  roles?: unknown;
  /** Users that MEMBER role choices may name (the target workspace's members). */
  eligibleUserIds?: ReadonlySet<string>;
  today: string;
}

export type ResolveResult =
  | { ok: true; resolved: ResolvedBlueprint }
  | { ok: false; issues: ResolveIssue[]; truncated: boolean };

export function resolveBlueprint(blueprint: unknown, input: ResolveInput): ResolveResult {
  const issues = new Issues();
  const fail = (): ResolveResult => ({ ok: false, issues: issues.items, truncated: issues.truncated });

  if (!isCalendarDate(input.today)) {
    issues.add('DATE_INVALID', '/today', '"today" must be a real date, "YYYY-MM-DD"');
    return fail();
  }
  // never trust the caller to have validated: the resolvers rely on the guarantees
  const checked = validateBlueprint(blueprint);
  if (checked.ok === false) {
    for (const i of checked.issues.slice(0, 20)) issues.add('BLUEPRINT_INVALID', i.path, `${i.code}: ${i.message}`);
    return fail();
  }
  const bp = checked.blueprint;

  const types: VariableTypes = new Map((bp.variables ?? []).map((v) => [v.key, v.type]));
  const values = resolveVariables(bp.variables, input.variables, issues);
  const mod = expandModules(bp, input.modules, issues);
  const roles = resolveRoles(bp.roles, input.roles, input.eligibleUserIds ?? new Set(), issues);

  const anchorVar = bp.dateAnchor?.variable;
  const anchorValue = anchorVar === undefined ? input.today : values.get(anchorVar);
  if (typeof anchorValue !== 'string' || !isCalendarDate(anchorValue)) {
    if (anchorVar !== undefined && issues.count === 0) {
      issues.add('VARIABLE_MISSING', `/variables/${anchorVar}`, 'The anchor date has no value');
    }
  }
  if (issues.count > 0) return fail();
  const anchor = anchorValue as string;
  const skip = bp.dateAnchor?.skipWeekends === true;

  const ctx = new Ctx(values, types, anchor, skip, issues);
  const src = mod.blueprint;
  const ws = src.workspace ?? {};

  const iterations: ResolvedIteration[] = (ws.iterations ?? []).map((it, i) => {
    const p = `/workspace/iterations/${i}`;
    return {
      nodeKey: it.nodeKey,
      kind: it.kind,
      name: ctx.text(`${p}/name`, it.name, L.iterationName),
      goal: it.goal === undefined ? undefined : ctx.text(`${p}/goal`, it.goal, L.iterationGoal),
      startDate: ctx.date(`${p}/startOffsetDays`, it.startOffsetDays),
      endDate: ctx.date(`${p}/endOffsetDays`, it.endOffsetDays),
      project: it.project,
    };
  });

  const projects: ResolvedProject[] = src.projects.map((proj) => {
    const pi = bp.projects.findIndex((x) => x.nodeKey === proj.nodeKey);
    const pp = `/projects/${pi}`;
    const task = (t: BlueprintTask, path: string): ResolvedTask => ({
      nodeKey: t.nodeKey,
      title: ctx.text(`${path}/title`, t.title, L.taskTitle),
      description: t.description === undefined ? undefined : ctx.text(`${path}/description`, t.description, L.taskDescription, true),
      issueType: t.issueType,
      status: t.status,
      priority: t.priority,
      tags: t.tags ?? [],
      customValues: ctx.customValues(path, t),
      assigneeRoles: t.assigneeRoles ?? [],
      assigneeUserIds: assigneesFor(t.assigneeRoles ?? [], roles),
      startDate: ctx.date(`${path}/startOffsetDays`, t.startOffsetDays),
      dueDate: ctx.date(`${path}/dueOffsetDays`, t.dueOffsetDays),
      estimate: t.estimate,
      iteration: t.iteration,
      children: (t.children ?? []).map((c, ci) => task(c, `${path}/children/${ci}`)),
      comments: (t.comments ?? []).map((c, ci) => ({
        body: ctx.text(`${path}/comments/${ci}/body`, c.body, L.commentBody),
        authorRole: c.authorRole,
      })),
      attachments: t.attachments ?? [],
    });
    // paths point into the ORIGINAL document, so index by original position
    const tasks = proj.tasks.map((t) => {
      const ti = bp.projects[pi].tasks.findIndex((x) => x.nodeKey === t.nodeKey);
      return task(t, `${pp}/tasks/${ti}`);
    });
    return {
      nodeKey: proj.nodeKey,
      name: ctx.text(`${pp}/name`, proj.name, L.projectName),
      description: proj.description === undefined ? undefined : ctx.text(`${pp}/description`, proj.description, L.projectDescription, true),
      workflow: proj.workflow,
      tasks,
      dependencies: (proj.dependencies ?? []).map((d) => ({ from: d.from, to: d.to, type: d.type ?? DependencyType.BLOCKS })),
      automations: proj.automations ?? [],
      views: proj.views ?? [],
    };
  });

  if (issues.count > 0) return fail();
  return {
    ok: true,
    resolved: {
      meta: src.meta,
      anchorDate: anchor,
      workspace: {
        name: ws.name === undefined ? undefined : ctx.text('/workspace/name', ws.name, L.workspaceName),
        key: ws.key,
        icon: ws.icon,
        description: ws.description === undefined ? undefined : ctx.text('/workspace/description', ws.description, L.workspaceDescription, true),
        tags: ws.tags ?? [],
        customFields: ws.customFields ?? [],
        issueTypes: ws.issueTypes ?? [],
        iterations,
      },
      projects,
      assets: src.assets ?? [],
      roles,
      dropped: mod.dropped,
    },
  };
}

class Ctx {
  constructor(
    private readonly values: VariableValues,
    private readonly types: VariableTypes,
    private readonly anchor: string,
    private readonly skip: boolean,
    private readonly issues: Issues,
  ) {}

  /** Render, then re-check what the substitution produced: it can be longer, or blank. */
  text(path: string, source: string, max: number, multiline = false): string {
    const r = renderText(source, this.values, this.types);
    if (r.ok === false) {
      this.issues.add('RENDER_FAILED', path, r.message);
      return source;
    }
    if (r.text.trim() === '') this.issues.add('TEXT_BLANK', path, 'Is blank once the variables are filled in');
    if (r.text.length > max) this.issues.add('TEXT_TOO_LONG', path, `Is ${r.text.length} characters once the variables are filled in; the limit is ${max}`);
    if (!multiline && /[\r\n]/.test(r.text)) this.issues.add('RENDER_FAILED', path, 'Would contain a line break');
    return r.text;
  }

  date(path: string, offset: number | undefined): string | undefined {
    if (offset === undefined) return undefined;
    const d = offsetDate(this.anchor, offset, this.skip);
    if (d === null) this.issues.add('DATE_OUT_OF_RANGE', path, 'The date falls outside 1900-2200');
    return d ?? undefined;
  }

  customValues(taskPath: string, t: BlueprintTask): Record<string, ResolvedCustomValue> {
    const out: Record<string, ResolvedCustomValue> = {};
    for (const [key, v] of Object.entries(t.customValues ?? {})) {
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        const d = this.date(`${taskPath}/customValues/${key}`, v.offsetDays);
        if (d !== undefined) out[key] = d;
      } else {
        out[key] = v as ResolvedCustomValue;
      }
    }
    return out;
  }
}
