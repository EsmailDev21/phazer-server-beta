import { FieldType, ImportIssueSeverity as Sev, Priority, TaskStatus } from '@prisma/client';
import {
  CANONICAL_LIMITS,
  CanonicalBundle,
  CanonicalComment,
  CanonicalProject,
  CanonicalTask,
  contentHash,
  truncateMarkdown,
} from '../canonical';
import { escapeText } from '../canonical/normalize/md-render';
import { foldName } from '../../templates/blueprint/blueprint.names';
import { CATEGORY_COLOR, lookupPriority, priorityKey } from './mapping.tables';
import { CATEGORY_LABEL, MAX_WORKFLOW_STATUSES, REQUIRED_CATEGORIES } from '../../projects-tasks/workflow/workflow-rules';
import {
  Author,
  MappedComment,
  MappedCustomField,
  MappedCustomValue,
  MappedHistoryEntry,
  MappedIssueType,
  MappedPage,
  MappedProject,
  MappedStatus,
  MappedTask,
  MappingIssue,
  MappingIssueCode,
  ResolvedMapping,
} from './mapping.types';

/**
 * Step 4.3. A validated CanonicalBundle page + a ResolvedMapping -> a MappedPage: the records the executor (4.4) writes.
 * PURE: no database, no clock. References to other pages stay as source external ids (the executor resolves them through
 * ExternalRef); references to the WORKSPACE (people, existing issue types / fields) are already local ids.
 *
 * Nothing is silently dropped: whatever the mapping leaves out (an unmapped assignee, an unknown priority, a field set to
 * "skip") is either by an explicit choice or reported once per entity per page.
 */
class Issues {
  readonly items: MappingIssue[] = [];
  private readonly seen = new Set<string>();
  /** Once per (code, ref) per page: a person who owns 400 tasks is one line, not 400. */
  once(severity: Sev, code: MappingIssueCode, ref: string, message: string): void {
    const k = `${code}|${ref}`;
    if (this.seen.has(k)) return;
    this.seen.add(k);
    this.items.push({ severity, code, externalRef: ref, message });
  }
}

const via = (r: ResolvedMapping): string => `via ${r.displayName}`;

function author(r: ResolvedMapping, externalId: string | undefined, fallbackName?: string): Author {
  if (externalId !== undefined) {
    const u = r.users.get(externalId);
    if (u?.target.kind === 'user') return { kind: 'user', userId: u.target.userId };
    return { kind: 'importer', label: `${u?.name ?? fallbackName ?? 'Someone'} (${via(r)})` };
  }
  return { kind: 'importer', label: `${fallbackName ?? 'Someone'} (${via(r)})` };
}

/**
 * A project's workflow must keep a status in To Do, In Progress and Done (ADR-0006 decision 4; the database write refuses
 * anything else). A source that has fewer (GitHub: open / closed; a board with no "doing" column) gets the missing ones as
 * SYNTHETIC statuses (no source status maps to them). A source that has too many (> 30 once those are added) has the
 * overflow folded into the first status of its most crowded category, so nothing is dropped. Positions are renumbered.
 */
function completeWorkflow(projectExternalId: string, input: MappedStatus[]): MappedStatus[] {
  const out = input.map((s) => ({ ...s, sourceExternalIds: [...s.sourceExternalIds] }));
  const missing = REQUIRED_CATEGORIES.filter((c) => !out.some((s) => s.category === c));
  while (out.length + missing.length > MAX_WORKFLOW_STATUSES) {
    const counts = new Map<TaskStatus, number>();
    for (const s of out) counts.set(s.category, (counts.get(s.category) ?? 0) + 1);
    const [crowded] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    const mine = out.filter((s) => s.category === crowded);
    const last = mine[mine.length - 1];
    const first = mine[0];
    first.sourceExternalIds.push(...last.sourceExternalIds);
    out.splice(out.indexOf(last), 1);
  }
  const names = new Set(out.map((s) => foldName(s.name)));
  for (const category of missing) {
    let name: string = CATEGORY_LABEL[category];
    for (let n = 2; names.has(foldName(name)); n++) name = `${CATEGORY_LABEL[category]} (${n})`;
    names.add(foldName(name));
    const synthetic: MappedStatus = {
      externalId: `synthetic:${projectExternalId}:${category}`,
      sourceExternalIds: [],
      name,
      category,
      excludeFromProgress: false,
      color: CATEGORY_COLOR[category as keyof typeof CATEGORY_COLOR] ?? CATEGORY_COLOR.TODO,
      position: 0,
    };
    // To Do leads, Done closes, In Progress sits just before the first Done (else last)
    if (category === TaskStatus.TODO) out.unshift(synthetic);
    else if (category === TaskStatus.DONE) out.push(synthetic);
    else {
      const at = out.findIndex((s) => s.category === TaskStatus.DONE);
      out.splice(at < 0 ? out.length : at, 0, synthetic);
    }
  }
  return out.map((s, position) => ({ ...s, position }));
}

function mapStatuses(project: CanonicalProject, r: ResolvedMapping): { statuses: MappedStatus[]; initialStatusExternalId?: string } {
  const list = project.statuses ?? [];
  if (list.length === 0) return { statuses: [] };
  const rootsInOrder: string[] = [];
  const members = new Map<string, string[]>();
  for (const s of list) {
    const res = r.statuses.get(s.externalId);
    const root = res?.rootExternalId ?? s.externalId;
    if (!members.has(root)) { members.set(root, []); rootsInOrder.push(root); }
    (members.get(root) as string[]).push(s.externalId);
  }
  // A root defined on another page of the same project (merge target) is not here: its members fold into themselves.
  const rootDef = (id: string) => r.statuses.get(id);
  const sorted = [...rootsInOrder].sort((a, b) => (rootDef(a)?.position ?? 0) - (rootDef(b)?.position ?? 0) || rootsInOrder.indexOf(a) - rootsInOrder.indexOf(b));
  const names = new Set<string>();
  const out: MappedStatus[] = sorted.map((id, position) => {
    const def = rootDef(id);
    const category = def?.category ?? TaskStatus.TODO;
    let name = def?.name ?? list.find((s) => s.externalId === id)?.name ?? id;
    // renames can make two statuses collide; the database would refuse the second: keep them distinct
    let n = 2;
    const base = name;
    while (names.has(foldName(name))) name = `${base.slice(0, CANONICAL_LIMITS.statusName - 6)} (${n++})`;
    names.add(foldName(name));
    return {
      externalId: id,
      sourceExternalIds: members.get(id) as string[],
      name,
      category,
      excludeFromProgress: def?.excludeFromProgress ?? false,
      color: def?.color ?? CATEGORY_COLOR[category],
      position,
    };
  });
  const complete = completeWorkflow(project.externalId, out);
  const initial = complete.find((s) => s.category === TaskStatus.TODO) ?? complete[0];
  return { statuses: complete, initialStatusExternalId: initial?.externalId };
}

function mapProject(p: CanonicalProject, r: ResolvedMapping): MappedProject {
  const { statuses, initialStatusExternalId } = mapStatuses(p, r);
  const out: MappedProject = { externalId: p.externalId, name: r.projects.get(p.externalId)?.name ?? p.name, statuses };
  if (p.key) out.key = p.key;
  if (p.description) out.description = p.description;
  if (p.url) out.url = p.url;
  if (p.archived !== undefined) out.archived = p.archived;
  if (p.createdAt) out.createdAt = p.createdAt;
  if (initialStatusExternalId) out.initialStatusExternalId = initialStatusExternalId;
  return out;
}

function mapComment(c: CanonicalComment, r: ResolvedMapping, issues: Issues): MappedComment {
  const a = author(r, c.authorExternalId, c.authorName);
  let body = c.body;
  if (a.kind === 'importer') {
    // Credit the real author in the text, in bold on its own line: the comment belongs to the importer account.
    body = `**${escapeText(a.label)}**\n\n${c.body}`;
    if (body.length > CANONICAL_LIMITS.commentBody) {
      body = truncateMarkdown(body, CANONICAL_LIMITS.commentBody);
      issues.once(Sev.WARN, 'COMMENT_TRUNCATED', `comment:${c.externalId}`, 'The comment was cut to make room for its author\'s name');
    }
  }
  const out: MappedComment = { externalId: c.externalId, author: a, body };
  if (c.createdAt) out.createdAt = c.createdAt;
  if (c.editedAt) out.editedAt = c.editedAt;
  if (c.parentExternalId) out.parentExternalId = c.parentExternalId;
  return out;
}

function mapTask(t: CanonicalTask, r: ResolvedMapping, issues: Issues): MappedTask {
  // status: the (root) source status's WorkflowStatus, and its category on the task
  let status: TaskStatus = TaskStatus.TODO;
  let workflowStatusExternalId: string | undefined;
  if (t.statusExternalId !== undefined) {
    const st = r.statuses.get(t.statusExternalId);
    if (st) { status = st.category; workflowStatusExternalId = st.rootExternalId; }
    else issues.once(Sev.INFO, 'STATUS_UNKNOWN', `status:${t.statusExternalId}`, `Status ${t.statusExternalId} is not part of this import; its tasks start in the project's first status`);
  }

  // priority: the person's / suggested table, then the provider's table for values that appeared late
  let priority: Priority | null = null;
  if (t.priority !== undefined) {
    const k = priorityKey(t.priority);
    if (r.priorities.has(k)) priority = r.priorities.get(k) ?? null;
    else {
      const l = lookupPriority(r.system, t.priority);
      priority = l.priority;
      if (l.reason === 'NONE') issues.once(Sev.INFO, 'PRIORITY_UNMATCHED', `priority:${k}`, `Priority "${t.priority}" is not recognised; its tasks have no priority`);
    }
  }

  const assigneeUserIds: string[] = [];
  for (const ext of t.assigneeExternalIds ?? []) {
    const u = r.users.get(ext);
    if (u?.target.kind === 'user') { if (!assigneeUserIds.includes(u.target.userId)) assigneeUserIds.push(u.target.userId); continue; }
    issues.once(Sev.WARN, 'USER_UNMAPPED', `user:${ext}`, `${u?.name ?? ext} is not matched to a workspace member: their tasks are left unassigned and their comments are credited to you`);
  }

  const customValues: MappedCustomValue[] = [];
  for (const cv of t.customValues ?? []) {
    const f = r.customFields.get(cv.fieldExternalId);
    if (!f || f.target.kind === 'skip') continue;
    let value = cv.value;
    if (f.dataType === FieldType.USER && typeof value === 'string') {
      const u = r.users.get(value);
      if (u?.target.kind !== 'user') {
        issues.once(Sev.INFO, 'CUSTOM_VALUE_USER_UNMAPPED', `user:${value}`, `${u?.name ?? value} is not a workspace member; a person field they were set in was left empty`);
        continue;
      }
      value = u.target.userId;
    }
    customValues.push({ fieldExternalId: cv.fieldExternalId, target: f.target, value });
  }

  const m: MappedTask = {
    externalId: t.externalId,
    title: t.title,
    status,
    priority,
    tags: t.tags ?? [],
    customValues,
    assigneeUserIds,
    creator: author(r, t.creatorExternalId),
    comments: (t.comments ?? []).map((c) => mapComment(c, r, issues)),
    attachments: (t.attachments ?? []).map((a) => {
      const { uploaderExternalId, ...rest } = a;
      return { ...rest, uploader: author(r, uploaderExternalId) };
    }),
    history: (t.history ?? []).map<MappedHistoryEntry>((h) => {
      const e: MappedHistoryEntry = { externalId: h.externalId, actor: h.actorExternalId ? author(r, h.actorExternalId) : null, at: h.at, field: h.field };
      if (h.from !== undefined) e.from = h.from;
      if (h.to !== undefined) e.to = h.to;
      return e;
    }),
  };
  if (workflowStatusExternalId) m.workflowStatusExternalId = workflowStatusExternalId;
  for (const k of ['key', 'url', 'projectExternalId', 'parentExternalId', 'description', 'createdAt', 'updatedAt', 'startDate', 'dueDate', 'estimate', 'iterationExternalId', 'archived'] as const) {
    if (t[k] !== undefined) (m as unknown as Record<string, unknown>)[k] = t[k];
  }
  if (t.issueTypeExternalId !== undefined) {
    const it = r.issueTypes.get(t.issueTypeExternalId);
    if (it?.target.kind === 'existing') m.issueType = { kind: 'existing', id: it.target.id, externalId: t.issueTypeExternalId };
    else if (it?.target.kind === 'create') m.issueType = { kind: 'create', externalId: t.issueTypeExternalId };
  }
  return m;
}

export function applyMapping(page: CanonicalBundle, r: ResolvedMapping): MappedPage {
  const issues = new Issues();

  const issueTypes: MappedIssueType[] = [];
  for (const t of page.issueTypes ?? []) {
    const e = r.issueTypes.get(t.externalId);
    if (e?.target.kind !== 'create') continue;
    const m: MappedIssueType = { externalId: t.externalId, name: e.name, level: e.level };
    if (t.color) m.color = t.color;
    issueTypes.push(m);
  }
  const customFields: MappedCustomField[] = [];
  for (const f of page.customFields ?? []) {
    const e = r.customFields.get(f.externalId);
    if (e?.target.kind !== 'create') continue;
    const m: MappedCustomField = { externalId: f.externalId, name: e.name, dataType: e.dataType };
    if (f.options?.length) m.options = f.options.map((o) => o.label);
    customFields.push(m);
  }

  return {
    projects: (page.projects ?? []).map((p) => mapProject(p, r)),
    issueTypes,
    customFields,
    iterations: (page.iterations ?? []).map((i) => ({ ...i })),
    tags: (page.tags ?? []).map((t) => ({ ...t })),
    tasks: (page.tasks ?? []).map((t) => mapTask(t, r, issues)),
    dependencies: (page.dependencies ?? []).map((d) => ({ ...d })),
    issues: issues.items,
  };
}

/**
 * Hash of what will be WRITTEN for a task (not of the source): changing the mapping then re-running updates the tasks it
 * affects, while an unchanged re-run is a no-op. Same exclusions as taskContentHash (comments / attachments / history have
 * their own refs; `updatedAt` is volatile).
 */
export function mappedTaskHash(t: MappedTask): string {
  return contentHash(t, ['comments', 'attachments', 'history', 'updatedAt']);
}
