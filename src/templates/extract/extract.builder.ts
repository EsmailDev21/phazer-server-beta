import { BLUEPRINT_LIMITS as L, BlueprintWorkflow } from '../blueprint';
import {
  EntityModel,
  RULE_TOKENS,
  RefWalker,
  VIEW_TOKENS,
  reverseMapper,
} from '../portable';
import { byFolded, fieldKey, statusKey, uniqueKey } from './extract.keys';
import {
  ExtractError,
  ExtractionReport,
  ExtractOptions,
  RawAsset,
  RawBlueprint,
  RawComment,
  RawIteration,
  RawProject,
  RawTask,
  WorkspaceSnapshot,
} from './extract.types';

type SnapTask = WorkspaceSnapshot['tasks'][number];

const isoDate = (d: Date | null): string | undefined =>
  d ? d.toISOString().slice(0, 10) : undefined;
const cmp = (a: string | number, b: string | number) =>
  a < b ? -1 : a > b ? 1 : 0;

/**
 * Step 3.3. Snapshot -> RAW blueprint. Pure and deterministic: the same data in any row order
 * gives the same output, and nothing reads a clock, a random source or an id for naming.
 */
export function buildRawBlueprint(
  snap: WorkspaceSnapshot,
  options: ExtractOptions = {},
): { raw: RawBlueprint; report: ExtractionReport } {
  const report: ExtractionReport = {
    tasks: {
      included: 0,
      archivedSkipped: 0,
      inboxSkipped: 0,
      orphanedSkipped: 0,
      tooDeepSkipped: 0,
    },
    dependencies: {
      included: 0,
      droppedOutsideProject: 0,
      droppedMissingEnd: 0,
    },
    comments: { included: 0, repliesFlattened: 0 },
    attachments: { included: 0, unconfirmedSkipped: 0 },
    customFieldKeyChanges: [],
    iterationsOutOfScope: 0,
    automations: { included: 0, raw: 0, skipped: [] },
    views: { included: 0, skipped: [] },
    exceedsNodeLimit: false,
  };

  // ------------------------------------------------------------ which projects --------
  const orderedProjects = [...snap.projects].sort(
    (a, b) =>
      cmp(a.createdAt.getTime(), b.createdAt.getTime()) || cmp(a.id, b.id),
  );
  const single = options.projectId !== undefined;
  const projects = single
    ? orderedProjects.filter((p) => p.id === options.projectId)
    : orderedProjects;
  if (single && projects.length === 0) {
    throw new ExtractError(
      'PROJECT_NOT_FOUND',
      'The project is not in this workspace',
    );
  }
  const projectIds = new Set(projects.map((p) => p.id));

  const takenProjectKeys = new Set<string>();
  const projectKey = new Map(
    projects.map((p) => [p.id, uniqueKey('p-', p.name, takenProjectKeys)]),
  );

  // ------------------------------------------------------------ which tasks ----------
  const inScope = snap.tasks.filter((t) => {
    if (t.projectId === null) {
      if (!single) report.tasks.inboxSkipped += 1;
      return false;
    }
    if (!projectIds.has(t.projectId)) return false;
    if (t.isArchived && !options.includeArchived) {
      report.tasks.archivedSkipped += 1;
      return false;
    }
    return true;
  });
  const childrenOf = new Map<string, SnapTask[]>();
  const roots = new Map<string, SnapTask[]>();
  const present = new Set(inScope.map((t) => t.id));
  for (const t of inScope) {
    if (t.parentId === null) {
      roots.set(t.projectId!, [...(roots.get(t.projectId!) ?? []), t]);
    } else if (present.has(t.parentId)) {
      childrenOf.set(t.parentId, [...(childrenOf.get(t.parentId) ?? []), t]);
    }
  }
  const byNumber = (a: SnapTask, b: SnapTask) => cmp(a.number, b.number);

  // Walk once to decide exactly which tasks survive. Anything not reached is either a subtask
  // whose parent was archived / out of scope (orphaned) or deeper than a blueprint allows.
  const kept = new Set<string>();
  const subtreeSize = (t: SnapTask): number =>
    1 + (childrenOf.get(t.id) ?? []).reduce((n, c) => n + subtreeSize(c), 0);
  const walkKeep = (t: SnapTask, level: number) => {
    if (level > L.maxTaskLevels) {
      report.tasks.tooDeepSkipped += subtreeSize(t);
      return;
    }
    kept.add(t.id);
    for (const c of childrenOf.get(t.id) ?? []) walkKeep(c, level + 1);
  };
  for (const list of roots.values()) list.forEach((t) => walkKeep(t, 1));
  report.tasks.orphanedSkipped =
    inScope.length - kept.size - report.tasks.tooDeepSkipped;
  report.tasks.included = kept.size;
  report.exceedsNodeLimit = kept.size + projects.length > L.maxNodes;
  const keptTasks = snap.tasks.filter((t) => kept.has(t.id));

  // ------------------------------------------------------------ definitions ----------
  const usedTagIds = new Set(keptTasks.flatMap((t) => t.tagIds));
  const usedFieldIds = new Set(
    keptTasks.flatMap((t) => t.customValues.map((v) => v.fieldId)),
  );
  const usedTypeIds = new Set(
    keptTasks.map((t) => t.issueTypeId).filter((x): x is string => !!x),
  );
  const usedIterationIds = new Set(
    keptTasks.map((t) => t.iterationId).filter((x): x is string => !!x),
  );

  const tags = snap.tags
    .filter((t) => !single || usedTagIds.has(t.id))
    .sort(byFolded((t) => t.name));
  const tagName = new Map(tags.map((t) => [t.id, t.name]));

  const takenFieldKeys = new Set<string>();
  const fields = snap.customFields
    .filter((f) => !single || usedFieldIds.has(f.id))
    .sort(
      (a, b) => cmp(a.order, b.order) || cmp(a.key, b.key) || cmp(a.id, b.id),
    );
  const fieldKeyById = new Map<string, string>();
  const fieldTypeById = new Map(fields.map((f) => [f.id, f.dataType]));
  for (const f of fields) {
    const k = fieldKey(f.key, takenFieldKeys);
    fieldKeyById.set(f.id, k);
    if (k !== f.key) report.customFieldKeyChanges.push({ from: f.key, to: k });
  }

  const types = snap.issueTypes
    .filter((t) => !single || usedTypeIds.has(t.id))
    .sort(byFolded((t) => t.name));
  const typeName = new Map(types.map((t) => [t.id, t.name]));

  const keptIterations = snap.iterations
    .filter((it) => {
      const ok = single
        ? it.projectId === options.projectId ||
          (it.projectId === null && usedIterationIds.has(it.id))
        : it.projectId === null || projectIds.has(it.projectId);
      if (!ok) report.iterationsOutOfScope += 1;
      return ok;
    })
    .sort(
      (a, b) =>
        cmp(
          a.startDate?.getTime() ?? Number.MAX_SAFE_INTEGER,
          b.startDate?.getTime() ?? Number.MAX_SAFE_INTEGER,
        ) ||
        cmp(a.name.toLowerCase(), b.name.toLowerCase()) ||
        cmp(a.createdAt.getTime(), b.createdAt.getTime()) ||
        cmp(a.id, b.id),
    );
  const takenIterationKeys = new Set<string>();
  const iterationKey = new Map(
    keptIterations.map((it) => [
      it.id,
      uniqueKey('i-', it.name, takenIterationKeys),
    ]),
  );
  const iterations: RawIteration[] = keptIterations.map((it) => ({
    nodeKey: iterationKey.get(it.id)!,
    kind: it.kind,
    name: it.name,
    ...(it.goal ? { goal: it.goal } : {}),
    ...(it.startDate ? { startDate: isoDate(it.startDate) } : {}),
    ...(it.endDate ? { endDate: isoDate(it.endDate) } : {}),
    ...(it.projectId ? { project: projectKey.get(it.projectId) } : {}),
  }));

  // ------------------------------------------------------------ comments/assets -------
  const commentsByTask = new Map<
    string,
    NonNullable<WorkspaceSnapshot['comments']>
  >();
  if (options.includeComments) {
    for (const c of snap.comments ?? []) {
      if (!kept.has(c.taskId)) continue;
      commentsByTask.set(c.taskId, [
        ...(commentsByTask.get(c.taskId) ?? []),
        c,
      ]);
    }
  }
  const attachmentsByTask = new Map<
    string,
    NonNullable<WorkspaceSnapshot['attachments']>
  >();
  if (options.includeAttachments) {
    for (const a of snap.attachments ?? []) {
      if (!kept.has(a.taskId)) continue;
      if (!a.confirmed) {
        report.attachments.unconfirmedSkipped += 1;
        continue;
      }
      attachmentsByTask.set(a.taskId, [
        ...(attachmentsByTask.get(a.taskId) ?? []),
        a,
      ]);
    }
  }
  const assets: RawAsset[] = [];

  // ------------------------------------------------------------ projects -------------
  const rawProjects: RawProject[] = projects.map((p) => {
    const pKey = projectKey.get(p.id)!;

    const statuses = snap.statuses
      .filter((s) => s.projectId === p.id)
      .sort((a, b) => cmp(a.position, b.position) || cmp(a.id, b.id));
    const takenStatusKeys = new Set<string>();
    const statusKeyById = new Map(
      statuses.map((s) => [s.id, statusKey(s.name, takenStatusKeys)]),
    );
    let workflow: BlueprintWorkflow | undefined;
    if (statuses.length > 0) {
      const transitions = snap.transitions
        .filter(
          (t) =>
            t.projectId === p.id &&
            statusKeyById.has(t.fromStatusId) &&
            statusKeyById.has(t.toStatusId),
        )
        .map((t) => ({
          from: statusKeyById.get(t.fromStatusId)!,
          to: statusKeyById.get(t.toStatusId)!,
        }))
        .sort((a, b) => cmp(a.from, b.from) || cmp(a.to, b.to));
      workflow = {
        statuses: statuses.map((s) => ({
          key: statusKeyById.get(s.id)!,
          name: s.name,
          category: s.category,
          color: s.color,
          ...(s.excludeFromProgress ? { excludeFromProgress: true } : {}),
          ...(s.isDefault ? { isDefault: true } : {}),
        })),
        ...(transitions.length ? { transitions } : {}),
        ...(p.enforceTransitions ? { enforceTransitions: true } : {}),
      };
    }

    const keyOf = (t: SnapTask) => `t${t.number}`;
    const buildTask = (t: SnapTask): RawTask => {
      const customValues: Record<string, unknown> = {};
      for (const v of [...t.customValues].sort((a, b) =>
        cmp(
          fieldKeyById.get(a.fieldId) ?? '',
          fieldKeyById.get(b.fieldId) ?? '',
        ),
      )) {
        const k = fieldKeyById.get(v.fieldId);
        if (k !== undefined && fieldTypeById.has(v.fieldId))
          customValues[k] = v.value;
      }
      const comments: RawComment[] = [];
      for (const c of [...(commentsByTask.get(t.id) ?? [])].sort(
        (a, b) =>
          cmp(a.createdAt.getTime(), b.createdAt.getTime()) || cmp(a.id, b.id),
      )) {
        if (c.parentCommentId) report.comments.repliesFlattened += 1;
        comments.push({
          body: c.content,
          authorUserId: c.authorId,
          createdAt: c.createdAt.toISOString(),
        });
      }
      report.comments.included += comments.length;
      const attachments: string[] = [];
      for (const a of [...(attachmentsByTask.get(t.id) ?? [])].sort(
        (x, y) =>
          cmp(x.createdAt.getTime(), y.createdAt.getTime()) || cmp(x.id, y.id),
      )) {
        const key = `a${assets.length + 1}`;
        assets.push({
          key,
          fileName: a.filename,
          mimeType: a.mimeType,
          sizeBytes: a.sizeBytes,
          sourceAttachmentId: a.id,
        });
        attachments.push(key);
      }
      report.attachments.included += attachments.length;
      return {
        nodeKey: keyOf(t),
        title: t.title,
        ...(t.description ? { description: t.description } : {}),
        ...(t.issueTypeId && typeName.has(t.issueTypeId)
          ? { issueType: typeName.get(t.issueTypeId) }
          : {}),
        ...(t.workflowStatusId && statusKeyById.has(t.workflowStatusId)
          ? { status: statusKeyById.get(t.workflowStatusId) }
          : {}),
        ...(t.priority ? { priority: t.priority } : {}),
        tags: t.tagIds
          .map((id) => tagName.get(id))
          .filter((n): n is string => n !== undefined)
          .sort(byFolded((n) => n)),
        customValues,
        assigneeUserIds: [...t.assigneeIds].sort(),
        ...(t.startDate ? { startDate: isoDate(t.startDate) } : {}),
        ...(t.dueDate ? { dueDate: isoDate(t.dueDate) } : {}),
        ...(t.estimate !== null ? { estimate: t.estimate } : {}),
        ...(t.iterationId && iterationKey.has(t.iterationId)
          ? { iteration: iterationKey.get(t.iterationId) }
          : {}),
        children: (childrenOf.get(t.id) ?? [])
          .filter((c) => kept.has(c.id))
          .sort(byNumber)
          .map(buildTask),
        comments,
        attachments,
      };
    };
    const tasks = (roots.get(p.id) ?? [])
      .filter((t) => kept.has(t.id))
      .sort(byNumber)
      .map(buildTask);

    // dependencies: same project, both ends kept
    const inProject = new Map(
      keptTasks.filter((t) => t.projectId === p.id).map((t) => [t.id, t]),
    );
    const dependencies: RawProject['dependencies'] = [];
    for (const d of snap.dependencies) {
      const from = inProject.get(d.blockingTaskId);
      const to = inProject.get(d.blockedTaskId);
      if (from && to)
        dependencies.push({ from: keyOf(from), to: keyOf(to), type: d.type });
    }
    dependencies.sort((a, b) => cmp(a.from, b.from) || cmp(a.to, b.to));
    report.dependencies.included += dependencies.length;

    // ---- automations and shared views scoped to this project (step 5.5): ids become names ---------
    const model: EntityModel = {
      tags: tags.map((t) => ({ name: t.name, id: t.id })),
      issueTypes: types.map((t) => ({ name: t.name, id: t.id })),
      customFields: fields.map((f) => ({
        key: fieldKeyById.get(f.id)!,
        id: f.id,
        dataType: f.dataType,
        options: Array.isArray(f.options) ? (f.options as string[]) : null,
      })),
      iterations: keptIterations.map((it) => ({
        nodeKey: iterationKey.get(it.id)!,
        id: it.id,
      })),
      projects: projects.map((pp) => ({
        nodeKey: projectKey.get(pp.id)!,
        id: pp.id,
      })),
      statuses: statuses.map((s) => ({
        projectKey: pKey,
        key: statusKeyById.get(s.id)!,
        id: s.id,
        category: s.category,
      })),
    };
    const portable = portableItemsOf(snap, p.id, model, pKey, report);

    return {
      nodeKey: pKey,
      name: p.name,
      ...(p.description ? { description: p.description } : {}),
      ...(workflow ? { workflow } : {}),
      tasks,
      dependencies,
      ...(portable.automations.length > 0
        ? { automations: portable.automations }
        : {}),
      ...(portable.views.length > 0 ? { views: portable.views } : {}),
    };
  });

  // dependencies that did not make it, counted once for the whole extraction
  const keptById = new Map(keptTasks.map((t) => [t.id, t]));
  for (const d of snap.dependencies) {
    const a = keptById.get(d.blockingTaskId);
    const b = keptById.get(d.blockedTaskId);
    if (a && b) {
      if (a.projectId !== b.projectId)
        report.dependencies.droppedOutsideProject += 1;
    } else if (a || b) {
      report.dependencies.droppedMissingEnd += 1;
    }
  }

  const ws = snap.workspace;
  const project = single ? projects[0] : undefined;
  const raw: RawBlueprint = {
    schemaVersion: 1,
    meta: {
      name: options.name ?? (project ? project.name : ws.name),
      ...((options.description ??
      (project ? project.description : ws.description))
        ? {
            description: (options.description ??
              (project ? project.description : ws.description))!,
          }
        : {}),
      kind: single ? 'PROJECT' : 'WORKSPACE',
      ...(options.category ? { category: options.category } : {}),
      ...(options.locale ? { locale: options.locale } : {}),
    },
    workspace: {
      ...(single
        ? {}
        : {
            name: ws.name,
            key: ws.key,
            ...(ws.icon ? { icon: ws.icon } : {}),
            ...(ws.description ? { description: ws.description } : {}),
          }),
      tags: tags.map((t) => ({ name: t.name })),
      customFields: fields.map((f) => ({
        key: fieldKeyById.get(f.id)!,
        name: f.name,
        dataType: f.dataType,
        ...(Array.isArray(f.options) && f.options.length
          ? { options: f.options as string[] }
          : {}),
        order: f.order,
      })),
      issueTypes: types.map((t) => ({
        name: t.name,
        ...(t.icon ? { icon: t.icon } : {}),
        color: t.color,
        level: t.level,
      })),
      iterations,
    },
    projects: rawProjects,
    assets,
    source: {
      workspaceId: ws.id,
      ...(single ? { projectId: options.projectId } : {}),
    },
  };
  return { raw, report };
}

/**
 * Step 5.5. The portable form of one project's automations and SHARED views: ids turned into the names
 * the rest of the blueprint uses, people reduced to tokens. What cannot be named (a deleted tag, a person,
 * a chat channel, another project's status) is left out and reported, never guessed. A raw (imported,
 * untranslated) automation is carried as it was received. Personal views are never read.
 */
function portableItemsOf(
  snap: WorkspaceSnapshot,
  projectId: string,
  model: EntityModel,
  projectKeyOf: string,
  report: ExtractionReport,
): {
  automations: Array<Record<string, unknown>>;
  views: Array<Record<string, unknown>>;
} {
  const automations: Array<Record<string, unknown>> = [];
  const views: Array<Record<string, unknown>> = [];
  const byName = <T extends { name: string; id: string }>(a: T, b: T) =>
    cmp(a.name.toLowerCase(), b.name.toLowerCase()) || cmp(a.id, b.id);
  const isObj = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

  for (const a of (snap.automations ?? [])
    .filter((x) => x.projectId === projectId)
    .sort(byName)) {
    if (automations.length >= L.maxAutomationsPerProject) {
      report.automations.skipped.push({
        name: a.name,
        reason: `a template carries at most ${L.maxAutomationsPerProject} automations per project`,
      });
      continue;
    }
    if (a.ruleVersion === 0) {
      if (isObj(a.sourceDefinition)) {
        automations.push(a.sourceDefinition);
        report.automations.raw += 1;
      } else
        report.automations.skipped.push({
          name: a.name,
          reason: 'an imported rule without its source',
        });
      continue;
    }
    const walker = new RefWalker(
      reverseMapper(model, projectKeyOf, RULE_TOKENS),
    );
    const named = walker.rule({
      trigger: a.trigger,
      conditions: a.conditions,
      actions: a.actions,
    });
    if (walker.issues.length > 0) {
      report.automations.skipped.push({
        name: a.name,
        reason: `${walker.issues[0].code} at ${walker.issues[0].path}`,
      });
      continue;
    }
    const hasConditions =
      isObj(named.conditions) && Object.keys(named.conditions).length > 0;
    automations.push({
      kind: 'rule.v1',
      name: a.name,
      trigger: named.trigger,
      ...(hasConditions ? { conditions: named.conditions } : {}),
      actions: named.actions,
    });
    report.automations.included += 1;
  }

  for (const v of (snap.views ?? [])
    .filter((x) => x.projectId === projectId)
    .sort(byName)) {
    if (views.length >= L.maxViewsPerProject) {
      report.views.skipped.push({
        name: v.name,
        reason: `a template carries at most ${L.maxViewsPerProject} views per project`,
      });
      continue;
    }
    const walker = new RefWalker(
      reverseMapper(model, projectKeyOf, VIEW_TOKENS),
    );
    const named = walker.viewConfig(v.config);
    if (walker.issues.length > 0) {
      report.views.skipped.push({
        name: v.name,
        reason: `${walker.issues[0].code} at ${walker.issues[0].path}`,
      });
      continue;
    }
    views.push({
      kind: 'view.v1',
      name: v.name,
      layout: v.layout,
      shared: true,
      config: named,
    });
    report.views.included += 1;
  }
  return { automations, views };
}
