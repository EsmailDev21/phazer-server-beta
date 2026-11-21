import { DependencyType, FieldType } from '@prisma/client';
import type {
  CanonicalAttachment,
  CanonicalBundle,
  CanonicalComment,
  CanonicalCustomField,
  CanonicalCustomValue,
  CanonicalDependency,
  CanonicalProject,
  CanonicalStatus,
  CanonicalTask,
  CanonicalUser,
} from '../../../imports/canonical';
import { CANONICAL_SCHEMA_VERSION, htmlToMarkdown } from '../../../imports/canonical';
import { AsAttachment, AsCustomField, AsProject, AsSection, AsStory, AsTask, AsUser } from './asana.types';

export const ASANA_SYSTEM = { system: 'asana', displayName: 'Asana' } as const;

export const emptyPage = (): CanonicalBundle => ({ schemaVersion: CANONICAL_SCHEMA_VERSION, source: { ...ASANA_SYSTEM } });

// ------------------------------------------------------------------------------------------------ time

/** Asana datetimes are ISO-8601 strings. Anything that is not a parseable instant is "no value" (range checks belong to the validator). */
export function isoInstant(raw: string | null | undefined): string | undefined {
  if (typeof raw !== 'string' || raw === '') return undefined;
  const n = Date.parse(raw);
  return Number.isFinite(n) ? new Date(n).toISOString() : undefined;
}

/** Asana "dates" are `YYYY-MM-DD` (no zone): they become that day at 00:00 UTC. */
export function isoDate(raw: string | null | undefined): string | undefined {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return undefined;
  return isoInstant(`${raw}T00:00:00.000Z`);
}

/** The precise instant when Asana has one, else the day. */
export const instantOrDate = (at: string | null | undefined, on: string | null | undefined): string | undefined => isoInstant(at) ?? isoDate(on);

// ------------------------------------------------------------------------------------------------ users

export function toUser(u: AsUser): CanonicalUser {
  const out: CanonicalUser = { externalId: u.gid, name: (u.name || u.email || u.gid).toString() };
  if (u.email) out.email = u.email;
  if (u.photo?.image_128x128) out.avatarUrl = u.photo.image_128x128;
  return out;
}

// ------------------------------------------------------------------------------------------------ projects / statuses

/**
 * Asana has NO workflow statuses: a project has SECTIONS (board columns) and a task has a `completed` flag. So (diagram 07):
 *   - every section is a status, category UNKNOWN on purpose: the mapping step then judges the NAME ("Done" -> DONE, "In progress" ->
 *     IN_PROGRESS) and flags it as a guess instead of pretending we know;
 *   - one synthetic status "Completed" (DONE) holds every task with completed = true, whatever section it sits in;
 *   - a project WITHOUT sections gets a synthetic "To do" (TODO) so open tasks have somewhere to go.
 * Ids are scoped to the project (the same section name can mean different things in two projects).
 */
export const sectionStatusId = (projectId: string, sectionGid: string): string => `${projectId}:${sectionGid}`;
export const completedStatusId = (projectId: string): string => `${projectId}:__completed`;
export const todoStatusId = (projectId: string): string => `${projectId}:__todo`;

export const sectionName = (s: AsSection): string => ((s.name ?? '').toString().trim() || 'Untitled section');

export function toProject(p: AsProject, sections: AsSection[]): CanonicalProject {
  const statuses: CanonicalStatus[] = sections.map((s, i) => ({ externalId: sectionStatusId(p.gid, s.gid), name: sectionName(s), category: 'UNKNOWN', position: i }));
  if (sections.length === 0) statuses.push({ externalId: todoStatusId(p.gid), name: 'To do', category: 'TODO', position: 0 });
  statuses.push({ externalId: completedStatusId(p.gid), name: 'Completed', category: 'DONE', position: statuses.length });
  const out: CanonicalProject = { externalId: p.gid, name: (p.name ?? '').toString() || `Project ${p.gid}`, statuses };
  if (p.permalink_url) out.url = p.permalink_url;
  if (p.notes) out.description = p.notes;
  if (p.archived === true) out.archived = true;
  const created = isoInstant(p.created_at);
  if (created) out.createdAt = created;
  return out;
}

// ------------------------------------------------------------------------------------------------ custom fields

const FIELD_TYPES: Record<string, FieldType> = {
  text: FieldType.TEXT,
  number: FieldType.NUMBER,
  enum: FieldType.SELECT,
  multi_enum: FieldType.MULTI_SELECT,
  date: FieldType.DATE,
  people: FieldType.USER,
};

const subtypeOf = (f: AsCustomField): string => (f.resource_subtype ?? f.type ?? '').toString().toLowerCase();

export const isSupportedField = (f: AsCustomField): boolean => f.is_formula_field !== true && subtypeOf(f) in FIELD_TYPES;

/** Asana has no priority; teams model it as an enum custom field. This is the SUGGESTION (a field called exactly "Priority"); the person can map another. */
export const isPriorityField = (f: AsCustomField): boolean => subtypeOf(f) === 'enum' && /^priority$/i.test((f.name ?? '').toString().trim());

const optionNames = (f: AsCustomField): string[] => (f.enum_options ?? []).filter((o) => o?.enabled !== false).map((o) => (o?.name ?? '').toString()).filter(Boolean);

/** Custom fields are Workspace-wide in our model: an Asana field is identified by its gid, whichever project shows it. The priority field is NOT one of them: it becomes the task priority. */
export function toCustomField(f: AsCustomField): CanonicalCustomField | null {
  if (!isSupportedField(f) || isPriorityField(f)) return null;
  const dataType = FIELD_TYPES[subtypeOf(f)];
  const out: CanonicalCustomField = { externalId: f.gid, name: (f.name ?? '').toString() || f.gid, dataType };
  if (dataType === FieldType.SELECT || dataType === FieldType.MULTI_SELECT) out.options = optionNames(f).map((label) => ({ label }));
  return out;
}

/** The value of one custom field on one task, in the canonical shape of its type; null = not set / not representable. */
export function toCustomValue(f: AsCustomField): CanonicalCustomValue | null {
  if (!isSupportedField(f) || isPriorityField(f)) return null;
  const fieldExternalId = f.gid;
  switch (FIELD_TYPES[subtypeOf(f)]) {
    case FieldType.TEXT:
      return typeof f.text_value === 'string' && f.text_value !== '' ? { fieldExternalId, value: f.text_value } : null;
    case FieldType.NUMBER:
      return typeof f.number_value === 'number' && Number.isFinite(f.number_value) ? { fieldExternalId, value: f.number_value } : null;
    case FieldType.DATE: {
      const d = instantOrDate(f.date_value?.date_time, f.date_value?.date);
      return d ? { fieldExternalId, value: d } : null;
    }
    case FieldType.SELECT: {
      const label = (f.enum_value?.name ?? '').toString();
      return label ? { fieldExternalId, value: label } : null;
    }
    case FieldType.MULTI_SELECT: {
      const labels = (f.multi_enum_values ?? []).map((o) => (o?.name ?? '').toString()).filter(Boolean);
      return labels.length ? { fieldExternalId, value: labels } : null;
    }
    case FieldType.USER: {
      const first = f.people_value?.[0]?.gid;
      return first ? { fieldExternalId, value: String(first) } : null;
    }
    default:
      return null;
  }
}

/** The raw priority label of a task: the enum value of its "Priority" custom field. */
export function priorityOf(fields: AsCustomField[] | null | undefined): string | undefined {
  for (const f of fields ?? []) if (isPriorityField(f) && f.enum_value?.name) return String(f.enum_value.name);
  return undefined;
}

// ------------------------------------------------------------------------------------------------ tasks

/** Where a task copy lives. `projectId` is the project being read; copies of one task in several selected projects are distinct tasks. */
export const taskId = (projectId: string, gid: string): string => `${projectId}:${gid}`;

export interface TaskContext {
  projectId: string;
  /** Status id of the first section (or the synthetic "To do"): where a task with no section of this project goes. */
  fallbackStatusId: string;
  /** A subtask: its parent's copy id, and the section status it inherits while open (subtasks have no section of their own). */
  parent?: { id: string; statusId: string };
  /** Section names become tags when the sections endpoint was not readable (no scope), so the column is not lost. */
  sectionsAsTags?: boolean;
}

const SUBTYPE_TYPE: Record<string, string> = { milestone: 'milestone', approval: 'approval' };

/** The status of an OPEN task: its section in this project, else the project's fallback. (A completed task goes to "Completed" whatever its section.) */
export function openStatusOf(t: AsTask, projectId: string, fallbackStatusId: string, sectionsUnreadable = false): string {
  // Sections that could not be read have no status on the structure page: pointing a task at one would leave it dangling.
  if (sectionsUnreadable) return fallbackStatusId;
  const sectionGid = (t.memberships ?? []).find((m) => m?.project?.gid === projectId)?.section?.gid;
  return sectionGid ? sectionStatusId(projectId, sectionGid) : fallbackStatusId;
}

export function toTask(t: AsTask, cx: TaskContext): CanonicalTask {
  const out: CanonicalTask = { externalId: taskId(cx.projectId, t.gid), projectExternalId: cx.projectId, title: (t.name ?? '').toString() };
  if (t.permalink_url) out.url = t.permalink_url;

  const html = t.html_notes ? htmlToMarkdown(t.html_notes).markdown : '';
  const description = html || (t.notes ?? '');
  if (description) out.description = description;

  const membership = (t.memberships ?? []).find((m) => m?.project?.gid === cx.projectId);
  if (t.completed === true) out.statusExternalId = completedStatusId(cx.projectId);
  else if (cx.parent) out.statusExternalId = cx.parent.statusId;
  else out.statusExternalId = openStatusOf(t, cx.projectId, cx.fallbackStatusId, cx.sectionsAsTags === true);

  const prio = priorityOf(t.custom_fields);
  if (prio) out.priority = prio;
  if (cx.parent) out.parentExternalId = cx.parent.id;

  const tags = (t.tags ?? []).map((g) => (g?.name ?? '').toString()).filter(Boolean);
  if (cx.sectionsAsTags && membership?.section?.name) tags.unshift(membership.section.name.toString());
  if (tags.length) out.tags = [...new Set(tags)];

  if (t.assignee?.gid) out.assigneeExternalIds = [t.assignee.gid];
  if (t.created_by?.gid) out.creatorExternalId = t.created_by.gid;
  const created = isoInstant(t.created_at);
  if (created) out.createdAt = created;
  const updated = isoInstant(t.modified_at);
  if (updated) out.updatedAt = updated;
  const start = instantOrDate(t.start_at, t.start_on);
  if (start) out.startDate = start;
  const due = instantOrDate(t.due_at, t.due_on);
  if (due) out.dueDate = due;
  const type = SUBTYPE_TYPE[(t.resource_subtype ?? '').toLowerCase()];
  if (type) out.issueTypeExternalId = type;

  const values = (t.custom_fields ?? []).map((f) => toCustomValue(f)).filter((v): v is CanonicalCustomValue => !!v);
  if (values.length) out.customValues = values;
  return out;
}

/**
 * `task.dependencies` lists the tasks THIS task depends on, i.e. its blockers: blocker -> this. The other end is assumed to live in
 * the SAME project copy (the overwhelmingly common case); an edge whose other end is not part of the import stays pending in the
 * writer and is dropped (a dependency into an unselected project, or into a different project than this copy's).
 */
export function toDependencies(t: AsTask, projectId: string): CanonicalDependency[] {
  const out: CanonicalDependency[] = [];
  for (const d of (t.dependencies ?? []).slice(0, 50)) {
    if (!d?.gid || d.gid === t.gid) continue;
    out.push({ externalId: `dep:${projectId}:${d.gid}>${t.gid}`, fromExternalId: taskId(projectId, d.gid), toExternalId: taskId(projectId, t.gid), type: DependencyType.BLOCKS });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ comments / files

/** Only real comments: Asana's `stories` also carry system events ("X marked this complete"), which are not content. */
export const isComment = (s: AsStory): boolean => s?.resource_subtype === 'comment_added' || s?.type === 'comment';

export function toComments(stories: AsStory[]): CanonicalComment[] {
  const out: CanonicalComment[] = [];
  const seen = new Set<string>();
  for (const s of [...stories].filter(isComment).sort((a, b) => Date.parse(a.created_at ?? '') - Date.parse(b.created_at ?? ''))) {
    if (!s?.gid || seen.has(s.gid)) continue;
    seen.add(s.gid);
    const body = (s.html_text ? htmlToMarkdown(s.html_text).markdown : '') || (s.text ?? '').toString();
    const c: CanonicalComment = { externalId: s.gid, body };
    if (s.created_by?.gid) c.authorExternalId = s.created_by.gid;
    if (s.created_by?.name) c.authorName = s.created_by.name.toString();
    const at = isoInstant(s.created_at);
    if (at) c.createdAt = at;
    out.push(c);
  }
  return out;
}

/** The opaque reference stored on a CanonicalAttachment. It is NOT a URL: Asana's download addresses are short-lived, so the real one is asked for right before the copy. */
export const ATTACHMENT_REF_PREFIX = 'asana-attachment:';
export const attachmentRef = (gid: string): string => `${ATTACHMENT_REF_PREFIX}${gid}`;

export function parseAttachmentRef(ref: string): string | null {
  if (typeof ref !== 'string' || !ref.startsWith(ATTACHMENT_REF_PREFIX)) return null;
  const gid = ref.slice(ATTACHMENT_REF_PREFIX.length);
  return /^\d{1,30}$/.test(gid) ? gid : null;
}

/**
 * Where a download address may point. Asana's docs show `download_url` both as an app.asana.com address that redirects to storage
 * ('asana': the access token is sent) and as a direct signed storage address ('storage': an `asana*` S3 bucket; the token is NEVER sent,
 * a signed URL carries its own authority and S3 refuses a second one). Anything else is refused: the address comes from provider data.
 */
export type DownloadTarget = 'asana' | 'storage';

export function downloadTarget(raw: string): DownloadTarget | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || u.port !== '' || u.username !== '' || u.password !== '') return null;
    const h = u.hostname.toLowerCase();
    if (h === 'asana.com' || h.endsWith('.asana.com')) return 'asana';
    if (/^asana[a-z0-9-]*\.s3([.-][a-z0-9-]+)?\.amazonaws\.com$/.test(h)) return 'storage';
    return null;
  } catch {
    return null;
  }
}

export function safeFileName(raw: string | null | undefined, fallback: string): string {
  const base = (raw ?? '').split(/[\\/]/).pop() ?? '';
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200);
  return clean || fallback;
}

/** Only files Asana itself stores can be copied; links to Drive / Dropbox / Box / ... are not files of ours to fetch. */
export const isAsanaHosted = (a: AsAttachment): boolean => (a.host ?? a.resource_subtype) === 'asana';

export function toAttachments(copyId: string, list: AsAttachment[]): CanonicalAttachment[] {
  const out: CanonicalAttachment[] = [];
  const seen = new Set<string>();
  for (const a of list) {
    if (!a?.gid || !isAsanaHosted(a) || seen.has(a.gid) || parseAttachmentRef(attachmentRef(a.gid)) === null) continue;
    seen.add(a.gid);
    const id = `${copyId}:${a.gid}`;
    const e: CanonicalAttachment = { externalId: id.length <= 190 ? id : a.gid, fileName: safeFileName(a.name, `attachment-${a.gid}`), providerRef: attachmentRef(a.gid) };
    if (typeof a.size === 'number' && Number.isFinite(a.size) && a.size >= 0) e.sizeBytes = Math.floor(a.size);
    const at = isoInstant(a.created_at);
    if (at) e.createdAt = at;
    out.push(e);
  }
  return out;
}
