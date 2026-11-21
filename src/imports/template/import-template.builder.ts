import { DependencyType, FieldType, IterationKind } from '@prisma/client';
import { BLUEPRINT_LIMITS, BlueprintCustomField, BlueprintIssueType, BlueprintTag, BlueprintWorkflowStatus, foldName } from '../../templates/blueprint';
import { RawBlueprint, RawComment, RawIteration, RawProject, RawTask, fieldKey, slug, statusKey, uniqueKey } from '../../templates/extract';
import { MappedPage, MappedTask } from '../mapping';

/** The pseudo user ids the template path uses: real people never enter a template, only "somebody" (the sanitizer turns ids into roles). */
export const SRC_USER_PREFIX = 'src:';
export const ANONYMOUS_USER = `${SRC_USER_PREFIX}anonymous`;

export interface ImportTemplateOptions {
  name: string;
  description?: string;
  category?: string;
  locale?: string;
  /** Carry the comments (as role-attributed reference comments). Default false. */
  includeComments?: boolean;
  /** The job id, only for `source` (the sanitizer strips it). */
  sourceId: string;
}

/** What did not make it into the template, and why: shown to the person, never silent. */
export interface ImportTemplateReport {
  projects: number;
  tasks: { included: number; archivedSkipped: number; orphanedParent: number; parentCycle: number; flattenedTooDeep: number };
  dependencies: { included: number; droppedOutsideProject: number; droppedMissingEnd: number };
  comments: { included: number; repliesFlattened: number; droppedByLimit: number };
  /** Counted and dropped: a template carries no files (they would have to be copied and hashed) and no history. */
  attachmentsDropped: number;
  historyDropped: number;
  customFieldKeyChanges: Array<{ from: string; to: string }>;
  /** Statuses added because a blueprint workflow needs a To Do, an In Progress and a Done status ("Project: Name"). */
  workflowCompleted: string[];
  exceedsNodeLimit: boolean;
}

export class ImportTemplateError extends Error {
  constructor(readonly code: 'NOTHING_TO_EXPORT' | 'TOO_LARGE', message: string) {
    super(message);
    this.name = 'ImportTemplateError';
  }
}

const day = (iso: string | undefined): string | undefined => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : undefined);

/**
 * Step 4.9 (import-as-template). The importer's MAPPED pages -> the blueprint's RAW form, which the existing sanitizer (3.4) turns into
 * a valid blueprint and the template service (3.5) stores. "One portable format, two front doors": nothing about importing is
 * re-implemented here, this only re-shapes entities the importer already resolved.
 *
 * Pure: no database, no provider. Deterministic (sorted by external id where the source gave no order), so the same import builds
 * the same document.
 */
export function buildRawFromImport(pages: MappedPage[], options: ImportTemplateOptions): { raw: RawBlueprint; report: ImportTemplateReport } {
  const report: ImportTemplateReport = {
    projects: 0,
    tasks: { included: 0, archivedSkipped: 0, orphanedParent: 0, parentCycle: 0, flattenedTooDeep: 0 },
    dependencies: { included: 0, droppedOutsideProject: 0, droppedMissingEnd: 0 },
    comments: { included: 0, repliesFlattened: 0, droppedByLimit: 0 },
    attachmentsDropped: 0,
    historyDropped: 0,
    customFieldKeyChanges: [],
    workflowCompleted: [],
    exceedsNodeLimit: false,
  };

  // ---------------------------------------------------------------- collect (pages are only a transport)
  const projectsById = new Map<string, MappedPage['projects'][number]>();
  const fieldsById = new Map<string, MappedPage['customFields'][number]>();
  const typesById = new Map<string, MappedPage['issueTypes'][number]>();
  const itersById = new Map<string, MappedPage['iterations'][number]>();
  const tagNames = new Map<string, BlueprintTag>();
  const tasks: MappedTask[] = [];
  const seenTask = new Set<string>();
  const deps: MappedPage['dependencies'] = [];
  for (const pg of pages) {
    for (const p of pg.projects) if (!projectsById.has(p.externalId)) projectsById.set(p.externalId, p);
    for (const f of pg.customFields) if (!fieldsById.has(f.externalId)) fieldsById.set(f.externalId, f);
    for (const t of pg.issueTypes) if (!typesById.has(t.externalId)) typesById.set(t.externalId, t);
    for (const i of pg.iterations) if (!itersById.has(i.externalId)) itersById.set(i.externalId, i);
    for (const g of pg.tags) if (g.name && !tagNames.has(foldName(g.name))) tagNames.set(foldName(g.name), { name: g.name });
    for (const t of pg.tasks) if (!seenTask.has(t.externalId)) (seenTask.add(t.externalId), tasks.push(t));
    deps.push(...pg.dependencies);
  }
  if (projectsById.size === 0) throw new ImportTemplateError('NOTHING_TO_EXPORT', 'The import has no projects to make a template from');

  // ---------------------------------------------------------------- workspace-level pieces
  const projectList = [...projectsById.values()];
  const takenProjectKeys = new Set<string>();
  const projectKey = new Map(projectList.map((p) => [p.externalId, uniqueKey('p-', p.name, takenProjectKeys)]));

  const takenFieldKeys = new Set<string>();
  const customFields: BlueprintCustomField[] = [];
  const fieldKeyOf = new Map<string, string>();
  [...fieldsById.values()].forEach((f, order) => {
    const key = fieldKey(f.name, takenFieldKeys);
    if (key !== f.name) report.customFieldKeyChanges.push({ from: f.name, to: key });
    fieldKeyOf.set(f.externalId, key);
    const needsOptions = f.dataType === FieldType.SELECT || f.dataType === FieldType.MULTI_SELECT;
    customFields.push({ key, name: f.name, dataType: f.dataType, ...(needsOptions ? { options: f.options ?? [] } : {}), order });
  });
  const fieldType = new Map([...fieldsById.values()].map((f) => [f.externalId, f.dataType]));

  const issueTypes: BlueprintIssueType[] = [...typesById.values()].map((t) => ({ name: t.name, level: t.level, ...(t.color ? { color: t.color } : {}) }));
  const typeName = new Map([...typesById.values()].map((t) => [t.externalId, t.name]));

  const takenIterKeys = new Set<string>();
  const iterKey = new Map<string, string>();
  const iterations: RawIteration[] = [...itersById.values()].map((i) => {
    const nodeKey = uniqueKey('i-', i.name, takenIterKeys);
    iterKey.set(i.externalId, nodeKey);
    return {
      nodeKey, kind: i.kind, name: i.name, ...(i.goal ? { goal: i.goal } : {}),
      ...(day(i.startDate) ? { startDate: day(i.startDate) } : {}), ...(day(i.endDate) ? { endDate: day(i.endDate) } : {}),
      ...(i.projectExternalId && projectKey.has(i.projectExternalId) ? { project: projectKey.get(i.projectExternalId) } : {}),
    };
  });

  // ---------------------------------------------------------------- per project: workflow + task tree
  const rawProjects: RawProject[] = [];
  let taskSeq = 0;
  const tasksOf = new Map<string, MappedTask[]>();
  for (const t of tasks) {
    if (t.archived) { report.tasks.archivedSkipped += 1; continue; }
    if (!t.projectExternalId || !projectsById.has(t.projectExternalId)) continue; // an inbox task belongs to no project: nothing to template
    (tasksOf.get(t.projectExternalId) ?? tasksOf.set(t.projectExternalId, []).get(t.projectExternalId)!).push(t);
  }
  const nodeKeyOf = new Map<string, string>(); // task external id -> t<n>

  for (const p of projectList) {
    const taken = new Set<string>();
    const statusKeyOf = new Map<string, string>(); // any folded source status id -> workflow status key
    const statuses: BlueprintWorkflowStatus[] = [];
    const byName = new Map<string, string>(); // folded name -> key (a blueprint refuses two statuses of one name)
    for (const s of p.statuses) {
      const folded = foldName(s.name);
      let key = byName.get(folded);
      if (!key) {
        key = statusKey(s.name, taken);
        byName.set(folded, key);
        statuses.push({ key, name: s.name, category: s.category, ...(s.color ? { color: s.color } : {}), ...(s.excludeFromProgress && s.category === 'DONE' ? { excludeFromProgress: true } : {}), ...(p.initialStatusExternalId === s.externalId ? { isDefault: true } : {}) });
      }
      for (const src of s.sourceExternalIds) statusKeyOf.set(src, key);
      statusKeyOf.set(s.externalId, key);
    }
    // A workflow needs a To Do, an In Progress and a Done status (a rule of the blueprint, not of the source): a source that has no
    // "in progress" at all (a board of just To Do / Done) gets the standard one added, and it is said so.
    if (statuses.length > 0) {
      for (const [category, label] of [['TODO', 'To Do'], ['IN_PROGRESS', 'In Progress'], ['DONE', 'Done']] as const) {
        if (statuses.some((x) => x.category === category)) continue;
        let name: string = label;
        while (byName.has(foldName(name))) name = `${label} (added)`;
        const key = statusKey(name, taken);
        byName.set(foldName(name), key);
        statuses.push({ key, name, category });
        report.workflowCompleted.push(`${p.name}: ${name}`);
      }
      // at most one default per category: the importer's initial status is the only one marked
    }

    const mine = (tasksOf.get(p.externalId) ?? []).slice().sort((a, b) => a.externalId.localeCompare(b.externalId, 'en', { numeric: true }));
    const byId = new Map(mine.map((t) => [t.externalId, t]));
    // parents: only within the project; a missing parent makes a root; a cycle is broken at its first member
    const parentOf = new Map<string, string>();
    for (const t of mine) {
      if (!t.parentExternalId) continue;
      if (byId.has(t.parentExternalId) && t.parentExternalId !== t.externalId) parentOf.set(t.externalId, t.parentExternalId);
      else report.tasks.orphanedParent += 1;
    }
    for (const t of mine) {
      const seen = new Set<string>([t.externalId]);
      for (let cur = parentOf.get(t.externalId); cur; cur = parentOf.get(cur)) {
        if (seen.has(cur)) { parentOf.delete(t.externalId); report.tasks.parentCycle += 1; break; }
        seen.add(cur);
      }
    }
    const depth = (id: string): number => { let n = 0; for (let c = parentOf.get(id); c; c = parentOf.get(c)) n += 1; return n; };
    // too deep: re-attach to the ancestor at the last allowed level (ADR-0005: importers flatten the excess)
    const maxDepth = BLUEPRINT_LIMITS.maxTaskLevels - 1;
    for (const t of mine) {
      if (depth(t.externalId) <= maxDepth) continue;
      let anc = parentOf.get(t.externalId)!;
      while (depth(anc) >= maxDepth) anc = parentOf.get(anc)!;
      parentOf.set(t.externalId, anc);
      report.tasks.flattenedTooDeep += 1;
    }

    const raws = new Map<string, RawTask>();
    for (const t of mine) {
      taskSeq += 1;
      const nodeKey = `t${taskSeq}`;
      nodeKeyOf.set(t.externalId, nodeKey);
      const customValues: Record<string, unknown> = {};
      for (const v of t.customValues) {
        const k = fieldKeyOf.get(v.fieldExternalId);
        if (k && v.value !== null && v.value !== undefined) customValues[k] = v.value;
      }
      const comments: RawComment[] = [];
      if (options.includeComments) {
        for (const c of t.comments) {
          if (comments.length >= BLUEPRINT_LIMITS.maxCommentsPerTask) { report.comments.droppedByLimit += 1; continue; }
          if (c.parentExternalId) report.comments.repliesFlattened += 1;
          comments.push({ body: c.body, authorUserId: c.author.kind === 'user' ? c.author.userId : ANONYMOUS_USER, createdAt: c.createdAt ?? new Date(0).toISOString() });
        }
        report.comments.included += comments.length;
      }
      report.attachmentsDropped += t.attachments.length;
      report.historyDropped += t.history.length;
      const status = t.workflowStatusExternalId ? statusKeyOf.get(t.workflowStatusExternalId) : undefined;
      const raw: RawTask = {
        nodeKey, title: t.title,
        ...(t.description ? { description: t.description } : {}),
        ...(t.issueType && typeName.has(t.issueType.externalId) ? { issueType: typeName.get(t.issueType.externalId) } : {}),
        ...(status ? { status } : {}),
        ...(t.priority ? { priority: t.priority } : {}),
        tags: [...new Set(t.tags)].slice(0, BLUEPRINT_LIMITS.maxTagsPerTask),
        customValues,
        assigneeUserIds: [...new Set(t.assigneeUserIds)].slice(0, BLUEPRINT_LIMITS.maxAssigneeRolesPerTask),
        ...(day(t.startDate) ? { startDate: day(t.startDate) } : {}), ...(day(t.dueDate) ? { dueDate: day(t.dueDate) } : {}),
        ...(typeof t.estimate === 'number' ? { estimate: t.estimate } : {}),
        ...(t.iterationExternalId && iterKey.has(t.iterationExternalId) ? { iteration: iterKey.get(t.iterationExternalId) } : {}),
        children: [], comments, attachments: [],
      };
      for (const g of raw.tags) if (!tagNames.has(foldName(g))) tagNames.set(foldName(g), { name: g });
      raws.set(t.externalId, raw);
    }
    const roots: RawTask[] = [];
    for (const t of mine) {
      const parent = parentOf.get(t.externalId);
      (parent ? raws.get(parent)!.children : roots).push(raws.get(t.externalId)!);
    }
    report.tasks.included += mine.length;

    rawProjects.push({
      nodeKey: projectKey.get(p.externalId)!, name: p.name, ...(p.description ? { description: p.description } : {}),
      ...(statuses.length ? { workflow: { statuses } } : {}), tasks: roots, dependencies: [],
    });
  }

  // ---------------------------------------------------------------- dependencies: both ends in the SAME project
  const projectOfTask = new Map<string, string>();
  for (const [pid, list] of tasksOf) for (const t of list) projectOfTask.set(t.externalId, pid);
  const seenDep = new Set<string>();
  for (const d of deps) {
    const a = nodeKeyOf.get(d.fromExternalId);
    const b = nodeKeyOf.get(d.toExternalId);
    if (!a || !b) { report.dependencies.droppedMissingEnd += 1; continue; }
    const pa = projectOfTask.get(d.fromExternalId);
    if (pa !== projectOfTask.get(d.toExternalId)) { report.dependencies.droppedOutsideProject += 1; continue; }
    const k = `${a}>${b}:${d.type}`;
    if (seenDep.has(k)) continue;
    seenDep.add(k);
    const rp = rawProjects.find((x) => x.nodeKey === projectKey.get(pa!));
    rp?.dependencies.push({ from: a, to: b, type: d.type as DependencyType });
    report.dependencies.included += 1;
  }

  report.projects = rawProjects.length;
  const nodeCount = rawProjects.length + report.tasks.included + iterations.length;
  report.exceedsNodeLimit = nodeCount > BLUEPRINT_LIMITS.maxNodes;
  if (report.exceedsNodeLimit) {
    throw new ImportTemplateError('TOO_LARGE', `A template holds at most ${BLUEPRINT_LIMITS.maxNodes} items (projects, tasks and iterations); this import has ${nodeCount}. Select fewer projects.`);
  }

  const single = rawProjects.length === 1;
  const raw: RawBlueprint = {
    schemaVersion: 1,
    meta: { name: options.name, ...(options.description ? { description: options.description } : {}), kind: single ? 'PROJECT' : 'WORKSPACE', ...(options.category ? { category: options.category } : {}), ...(options.locale ? { locale: options.locale } : {}) },
    workspace: { tags: [...tagNames.values()].slice(0, BLUEPRINT_LIMITS.maxTags), customFields, issueTypes, iterations },
    projects: rawProjects,
    assets: [],
    source: { workspaceId: `import:${options.sourceId}` },
  };
  void slug; void IterationKind;
  return { raw, report };
}
