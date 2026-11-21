import { foldName } from '../blueprint';
import {
  MAX_ISSUE_TYPES_PER_WORKSPACE,
  MAX_ITERATIONS_PER_WORKSPACE,
} from '../../projects-tasks/iterations/iteration-rules';
import { ResolvedBlueprint } from '../resolve';
import { planPortable } from './apply.portable';
import {
  ApplyPlan,
  ApplyTarget,
  flattenTasks,
  LimitState,
  PlanField,
  PlanIssue,
  PlanProject,
  WorkspaceState,
} from './apply.types';

const PROJECT_NAME_MAX = 120;

/** "Coursework" -> "Coursework (2)" -> "(3)"..., compared the way names fold, never exceeding 120. */
export function uniqueProjectName(name: string, taken: Set<string>): string {
  if (!taken.has(foldName(name))) return name;
  for (let n = 2; ; n++) {
    const suffix = ` (${n})`;
    const candidate = `${name.slice(0, PROJECT_NAME_MAX - suffix.length)}${suffix}`;
    if (!taken.has(foldName(candidate))) return candidate;
  }
}

/**
 * Step 3.6. Merge rules (diagram 16), as a pure function of the resolved blueprint and what the
 * target workspace already holds:
 *   tags         reuse by name (ignoring case/spacing)            else create
 *   custom fields reuse by key when the type matches; a type conflict SKIPS the field + warns
 *   issue types  reuse by name                                    else create
 *   projects     ALWAYS new; a name clash becomes "Name (2)"
 *   iterations   always new
 *   workspace    name / icon / description / key are NEVER touched
 * plus the limit preflight. Blockers stop the apply; warnings are shown in the preview.
 */
export function buildApplyPlan(
  resolved: ResolvedBlueprint,
  target: ApplyTarget,
  state: WorkspaceState,
  limits: LimitState,
): ApplyPlan {
  const warnings: PlanIssue[] = [];
  const blockers: PlanIssue[] = [];

  if (target.kind === 'PROJECT' && target.mode === 'NEW_WORKSPACE') {
    blockers.push({
      code: 'KIND_MODE_MISMATCH',
      message:
        'A project template is added to an existing workspace; it cannot create one.',
      suggestions: ['Create the workspace first, then apply into it (merge).'],
    });
  }
  if (
    target.mode === 'NEW_WORKSPACE' &&
    (state.projectCount > 0 || state.taskCount > 0)
  ) {
    blockers.push({
      code: 'WORKSPACE_NOT_EMPTY',
      message: 'NEW_WORKSPACE needs an empty workspace.',
      suggestions: ['Choose "merge into existing workspace" instead.'],
    });
  }
  if (target.kind === 'WORKSPACE' && resolved.workspace.name !== undefined) {
    warnings.push({
      code: 'WORKSPACE_IDENTITY_KEPT',
      message:
        "The workspace keeps its own name, key, icon and description; the template's are not applied.",
    });
  }

  // ---- tags
  const existingTag = new Map(state.tags.map((t) => [foldName(t.name), t]));
  const tags = resolved.workspace.tags.map((t) => {
    const hit = existingTag.get(foldName(t.name));
    return hit
      ? { name: t.name, action: 'REUSE' as const, existingId: hit.id }
      : { name: t.name, action: 'CREATE' as const };
  });

  // ---- custom fields
  const existingField = new Map(
    state.customFields.map((f) => [f.key.toLowerCase(), f]),
  );
  const customFields: PlanField[] = resolved.workspace.customFields.map((f) => {
    const hit = existingField.get(f.key.toLowerCase());
    const base = {
      key: f.key,
      name: f.name,
      dataType: f.dataType,
      options: f.options,
      order: f.order,
    };
    if (!hit) return { ...base, action: 'CREATE' };
    if (hit.dataType !== f.dataType) {
      warnings.push({
        code: 'FIELD_TYPE_CONFLICT',
        message: `Custom field "${f.key}" already exists as ${hit.dataType}; the template's ${f.dataType} field is skipped and its values are dropped.`,
      });
      return { ...base, action: 'SKIP', existingId: hit.id };
    }
    const existingOptions = Array.isArray(hit.options)
      ? (hit.options as string[])
      : undefined;
    if (
      existingOptions &&
      f.options &&
      f.options.some((o) => !existingOptions.includes(o))
    ) {
      warnings.push({
        code: 'FIELD_OPTIONS_DIFFER',
        message: `Custom field "${f.key}" exists with different options; template values that are not among them are dropped.`,
      });
    }
    return { ...base, action: 'REUSE', existingId: hit.id, existingOptions };
  });
  const fieldByKey = new Map(customFields.map((f) => [f.key, f]));

  // ---- issue types
  const existingType = new Map(
    state.issueTypes.map((t) => [foldName(t.name), t]),
  );
  const issueTypes = resolved.workspace.issueTypes.map((t) => {
    const hit = existingType.get(foldName(t.name));
    return hit
      ? { name: t.name, action: 'REUSE' as const, existingId: hit.id }
      : { name: t.name, action: 'CREATE' as const };
  });
  const typeCreates = issueTypes.filter((t) => t.action === 'CREATE').length;
  if (state.issueTypes.length + typeCreates > MAX_ISSUE_TYPES_PER_WORKSPACE) {
    blockers.push({
      code: 'ISSUE_TYPE_LIMIT',
      message: `A workspace holds at most ${MAX_ISSUE_TYPES_PER_WORKSPACE} issue types; this would make ${state.issueTypes.length + typeCreates}.`,
      suggestions: ['Delete issue types you no longer use.'],
    });
  }

  // ---- iterations
  if (
    state.iterationCount + resolved.workspace.iterations.length >
    MAX_ITERATIONS_PER_WORKSPACE
  ) {
    blockers.push({
      code: 'ITERATION_LIMIT',
      message: `A workspace holds at most ${MAX_ITERATIONS_PER_WORKSPACE} iterations.`,
    });
  }

  // ---- projects
  const taken = new Set(state.projectNames.map(foldName));
  const projects: PlanProject[] = resolved.projects.map((p) => {
    const name = uniqueProjectName(p.name, taken);
    taken.add(foldName(name));
    const tasks = flattenTasks(p.tasks).length;
    if (name !== p.name) {
      warnings.push({
        code: 'PROJECT_RENAMED',
        message: `A project named "${p.name}" already exists; the new one is "${name}".`,
      });
    }
    if (limits.tasksPerProject !== null && tasks > limits.tasksPerProject) {
      blockers.push({
        code: 'TASK_LIMIT',
        message: `"${name}" would have ${tasks} tasks; your plan allows ${limits.tasksPerProject} per project.`,
        suggestions: [
          'Turn off optional parts of the template (modules).',
          'Upgrade your plan.',
        ],
      });
    }
    return {
      nodeKey: p.nodeKey,
      name,
      ...(name !== p.name ? { renamedFrom: p.name } : {}),
      tasks,
    };
  });
  if (
    limits.projectsRemaining !== null &&
    projects.length > limits.projectsRemaining
  ) {
    blockers.push({
      code: 'PROJECT_LIMIT',
      message: `This adds ${projects.length} project(s); your plan has room for ${limits.projectsRemaining} more.`,
      suggestions: [
        'Turn off optional parts of the template (modules).',
        'Archive or delete a project.',
        'Upgrade your plan.',
      ],
    });
  }

  // ---- values that cannot be kept, comments, dependencies
  let dropped = 0;
  let comments = 0;
  let tasks = 0;
  for (const p of resolved.projects) {
    for (const t of flattenTasks(p.tasks)) {
      tasks += 1;
      comments += t.comments.length;
      for (const [key, value] of Object.entries(t.customValues)) {
        const f = fieldByKey.get(key);
        if (!f || f.action === 'SKIP') {
          dropped += 1;
          continue;
        }
        if (f.action === 'REUSE' && f.existingOptions) {
          const values = Array.isArray(value) ? value : [value];
          if (
            (f.dataType === 'SELECT' || f.dataType === 'MULTI_SELECT') &&
            values.some((v) => !f.existingOptions!.includes(v as string))
          )
            dropped += 1;
        }
      }
    }
  }
  if (dropped > 0) {
    warnings.push({
      code: 'VALUES_DROPPED',
      message: `${dropped} custom value(s) cannot be kept (their field was skipped or lacks the option).`,
    });
  }
  const invites = resolved.roles.filter(
    (r) => r.assignment.type === 'INVITE',
  ).length;
  if (invites > 0) {
    warnings.push({
      code: 'INVITES_NOT_SENT',
      message: `${invites} invitation(s) were chosen but are not sent by an apply; those people can be added to the workspace separately.`,
    });
  }
  // ---- reference files (step 3.7): every task attachment is its OWN copy, so it is its own bytes
  const assetByKey = new Map(resolved.assets.map((a) => [a.key, a]));
  let copies = 0;
  let copyBytes = 0;
  for (const p of resolved.projects) {
    for (const t of flattenTasks(p.tasks)) {
      for (const k of t.attachments) {
        const a = assetByKey.get(k);
        if (!a) continue;
        copies += 1;
        copyBytes += a.sizeBytes;
      }
    }
  }
  const missing = new Set(limits.missingAssetShas ?? []);
  const lost = resolved.assets.filter((a) => missing.has(a.sha256));
  if (lost.length > 0) {
    blockers.push({
      code: 'ASSET_MISSING',
      message: `${lost.length} reference file(s) of this template are no longer stored; the template needs to be re-exported or repaired.`,
    });
  }
  if (
    limits.maxFileBytes != null &&
    resolved.assets.some((a) => a.sizeBytes > limits.maxFileBytes!)
  ) {
    blockers.push({
      code: 'FILE_TOO_LARGE',
      message: `A reference file exceeds your plan's ${Math.floor(limits.maxFileBytes / (1024 * 1024))} MB per-file limit.`,
      suggestions: [
        'Turn off optional parts of the template (modules).',
        'Upgrade your plan.',
      ],
    });
  }
  if (
    limits.storageRemainingBytes != null &&
    copyBytes > limits.storageRemainingBytes
  ) {
    blockers.push({
      code: 'STORAGE_LIMIT',
      message: `Copying the template's reference files needs ${copyBytes} bytes; your plan has ${Math.max(0, limits.storageRemainingBytes)} left.`,
      suggestions: [
        'Turn off optional parts of the template (modules).',
        'Delete files you no longer need.',
        'Upgrade your plan.',
      ],
    });
  }
  // ---- automations and saved views (step 5.5): bound against what this apply will leave in the workspace
  const portable = planPortable(
    resolved,
    { tags, customFields, issueTypes },
    state,
  );
  warnings.push(...portable.warnings);
  blockers.push(...portable.blockers);

  const count = (xs: Array<{ action: string }>, a: string) =>
    xs.filter((x) => x.action === a).length;
  return {
    mode: target.mode,
    tags,
    customFields,
    issueTypes,
    iterations: resolved.workspace.iterations.length,
    projects,
    automations: portable.automations,
    views: portable.views,
    counts: {
      tasks,
      comments,
      dependencies: resolved.projects.reduce(
        (n, p) => n + p.dependencies.length,
        0,
      ),
      tags: { create: count(tags, 'CREATE'), reuse: count(tags, 'REUSE') },
      customFields: {
        create: count(customFields, 'CREATE'),
        reuse: count(customFields, 'REUSE'),
        skip: count(customFields, 'SKIP'),
      },
      issueTypes: { create: typeCreates, reuse: count(issueTypes, 'REUSE') },
      droppedCustomValues: dropped,
      automations: portable.counts.automations,
      savedViews: portable.counts.savedViews,
      assets: { copies, bytes: copyBytes },
    },
    warnings,
    blockers,
  };
}
