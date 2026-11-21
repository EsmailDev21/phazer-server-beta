import { createHash } from 'node:crypto';
import { FieldType, IssueTypeLevel } from '@prisma/client';
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
  SourceStatusCategory,
} from '../../../imports/canonical';
import { CANONICAL_SCHEMA_VERSION } from '../../../imports/canonical';
import { DependencyType } from '@prisma/client';
import { CuAttachment, CuComment, CuCustomField, CuFieldOption, CuList, CuStatus, CuTask, CuUser } from './clickup.types';

export const CLICKUP_SYSTEM = { system: 'clickup', displayName: 'ClickUp' } as const;

export const emptyPage = (): CanonicalBundle => ({ schemaVersion: CANONICAL_SCHEMA_VERSION, source: { ...CLICKUP_SYSTEM } });

/** ClickUp timestamps are epoch MILLISECONDS, usually as a string. Anything that is not a plausible instant is "no value". */
export function iso(raw: string | number | null | undefined): string | undefined {
  if (raw === null || raw === undefined || raw === '') return undefined;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 8.64e15) return undefined;
  return new Date(n).toISOString();
}

// ------------------------------------------------------------------------------------------------ users / statuses / projects

export function toUser(u: CuUser): CanonicalUser {
  const out: CanonicalUser = { externalId: String(u.id), name: (u.username || u.email || String(u.id)).toString() };
  if (u.email) out.email = u.email;
  if (u.profilePicture) out.avatarUrl = u.profilePicture;
  return out;
}

/** diagram 07: open -> TODO (BACKLOG when it is called that), custom -> IN_PROGRESS, done / closed -> DONE. ClickUp has no "canceled". */
export function statusCategory(s: CuStatus): SourceStatusCategory {
  switch ((s.type ?? '').toLowerCase()) {
    case 'open':
      return /backlog/i.test(s.status) ? 'BACKLOG' : 'TODO';
    case 'custom':
      return 'IN_PROGRESS';
    case 'done':
    case 'closed':
      return 'DONE';
    default:
      return 'UNKNOWN';
  }
}

/** Statuses belong to a LIST in ClickUp, and the same name can mean different things in two lists: the id carries the list. */
export const statusId = (listId: string, name: string): string => `${listId}:${name}`;

export function toStatus(listId: string, s: CuStatus, index: number): CanonicalStatus {
  const out: CanonicalStatus = { externalId: statusId(listId, s.status), name: s.status, category: statusCategory(s), position: typeof s.orderindex === 'number' ? s.orderindex : index };
  if (s.color) out.color = s.color;
  return out;
}

export function toProject(l: CuList, statuses: CuStatus[]): CanonicalProject {
  const seen = new Set<string>();
  const unique = statuses.filter((s) => (seen.has(s.status) ? false : (seen.add(s.status), true)));
  const out: CanonicalProject = {
    externalId: l.id,
    name: (l.name ?? '').toString() || `List ${l.id}`,
    url: `https://app.clickup.com/v/l/${encodeURIComponent(l.id)}`,
    statuses: unique.map((s, i) => toStatus(l.id, s, i)),
  };
  if (l.content) out.description = l.content;
  if (l.archived === true) out.archived = true;
  return out;
}

// ------------------------------------------------------------------------------------------------ custom fields

const FIELD_TYPES: Record<string, FieldType> = {
  short_text: FieldType.TEXT, text: FieldType.TEXT, email: FieldType.TEXT, phone: FieldType.TEXT,
  url: FieldType.URL,
  number: FieldType.NUMBER, currency: FieldType.NUMBER, emoji: FieldType.NUMBER,
  date: FieldType.DATE,
  checkbox: FieldType.CHECKBOX,
  drop_down: FieldType.SELECT,
  labels: FieldType.MULTI_SELECT,
  users: FieldType.USER,
};

export const isSupportedField = (type: string | null | undefined): boolean => !!type && type in FIELD_TYPES;

const optionLabel = (o: CuFieldOption): string => (o.name ?? o.label ?? '').toString();

/** Custom fields are Workspace-wide in our model: a ClickUp field is identified by its id, whichever list shows it. */
export function toCustomField(f: CuCustomField): CanonicalCustomField | null {
  const dataType = f.type ? FIELD_TYPES[f.type] : undefined;
  if (!dataType) return null;
  const out: CanonicalCustomField = {
    externalId: f.id,
    name: (f.name ?? '').toString() || f.id,
    dataType,
  };
  if (dataType === FieldType.SELECT || dataType === FieldType.MULTI_SELECT) {
    out.options = (f.type_config?.options ?? []).map(optionLabel).filter(Boolean).map((label) => ({ label }));
  }
  return out;
}

/** The value of one custom field on one task, in the canonical shape of its type; null = not set / not representable. */
export function toCustomValue(f: CuCustomField): CanonicalCustomValue | null {
  const dataType = f.type ? FIELD_TYPES[f.type] : undefined;
  const v = f.value;
  if (!dataType || v === undefined || v === null || v === '') return null;
  const fieldExternalId = f.id;
  const opts = f.type_config?.options ?? [];
  const byRef = (ref: unknown): string | null => {
    const o = opts.find((x) => (x.id !== undefined && x.id === ref) || (typeof ref === 'number' && x.orderindex === ref) || (typeof ref === 'string' && ref !== '' && String(x.orderindex) === ref));
    const label = o ? optionLabel(o) : '';
    return label || null;
  };
  switch (dataType) {
    case FieldType.TEXT:
    case FieldType.URL:
      return typeof v === 'string' || typeof v === 'number' ? { fieldExternalId, value: String(v) } : null;
    case FieldType.NUMBER: {
      const n = typeof v === 'number' ? v : Number(v);
      return Number.isFinite(n) ? { fieldExternalId, value: n } : null;
    }
    case FieldType.DATE: {
      const d = iso(v as string | number);
      return d ? { fieldExternalId, value: d } : null;
    }
    case FieldType.CHECKBOX:
      return { fieldExternalId, value: v === true || v === 'true' };
    case FieldType.SELECT: {
      const label = byRef(v);
      return label ? { fieldExternalId, value: label } : null;
    }
    case FieldType.MULTI_SELECT: {
      const labels = (Array.isArray(v) ? v : [v]).map(byRef).filter((x): x is string => !!x);
      return labels.length ? { fieldExternalId, value: labels } : null;
    }
    case FieldType.USER: {
      const first = Array.isArray(v) ? v[0] : v;
      const id = first && typeof first === 'object' ? (first as { id?: unknown }).id : first;
      return id !== undefined && id !== null && id !== '' ? { fieldExternalId, value: String(id) } : null;
    }
    default:
      return null;
  }
}

// ------------------------------------------------------------------------------------------------ tasks

const PRIORITY: Record<string, string> = { urgent: 'Urgent', high: 'High', normal: 'Normal', low: 'Low' };

export interface TaskContext {
  listId: string;
  /** The folder the list lives in becomes a tag on every task of it (diagram 06). */
  folderName?: string;
  /** custom_item_id values that are declared as issue types. */
  issueTypeIds: ReadonlySet<string>;
}

export function toTask(t: CuTask, cx: TaskContext): CanonicalTask {
  const out: CanonicalTask = {
    externalId: t.id,
    projectExternalId: cx.listId,
    title: (t.name ?? '').toString(),
  };
  if (t.custom_id) out.key = t.custom_id;
  if (t.url) out.url = t.url;
  const description = t.markdown_description ?? t.text_content ?? t.description;
  if (description) out.description = description;
  if (t.status?.status) out.statusExternalId = statusId(cx.listId, t.status.status);
  const prio = t.priority?.priority ? PRIORITY[t.priority.priority.toLowerCase()] ?? t.priority.priority : undefined;
  if (prio) out.priority = prio;
  if (t.parent) out.parentExternalId = t.parent;
  const tags = [...(cx.folderName ? [cx.folderName] : []), ...(t.tags ?? []).map((g) => g?.name).filter((n): n is string => !!n)];
  if (tags.length) out.tags = [...new Set(tags)];
  const assignees = (t.assignees ?? []).map((u) => u?.id).filter((id) => id !== undefined && id !== null).map(String);
  if (assignees.length) out.assigneeExternalIds = [...new Set(assignees)];
  if (t.creator?.id !== undefined && t.creator?.id !== null) out.creatorExternalId = String(t.creator.id);
  const created = iso(t.date_created);
  if (created) out.createdAt = created;
  const updated = iso(t.date_updated);
  if (updated) out.updatedAt = updated;
  const start = iso(t.start_date);
  if (start) out.startDate = start;
  const due = iso(t.due_date);
  if (due) out.dueDate = due;
  if (typeof t.points === 'number' && t.points >= 0 && t.points <= 1000) out.estimate = t.points;
  if (t.archived === true) out.archived = true;
  if (t.custom_item_id && cx.issueTypeIds.has(String(t.custom_item_id))) out.issueTypeExternalId = String(t.custom_item_id);
  const values = (t.custom_fields ?? []).map((f) => toCustomValue(f)).filter((v): v is CanonicalCustomValue => !!v);
  if (values.length) out.customValues = values;
  return out;
}

/**
 * ClickUp's two kinds of relation between tasks. A dependency entry {task_id, depends_on} reads "task_id waits for depends_on"
 * (the API's own words for the write side: `depends_on` is "the task that must be completed before" the path task), so the
 * blocker is depends_on. A plain link is symmetrical. Both tasks list the same relation; each pair gets ONE deterministic external
 * id, so listing it twice (or on two pages) writes it once.
 */
export function toDependencies(t: CuTask): CanonicalDependency[] {
  const out: CanonicalDependency[] = [];
  for (const d of t.dependencies ?? []) {
    if (!d?.task_id || !d.depends_on || d.task_id === d.depends_on) continue;
    out.push({ externalId: `dep:${d.depends_on}>${d.task_id}`, fromExternalId: d.depends_on, toExternalId: d.task_id, type: DependencyType.BLOCKS });
  }
  for (const l of t.linked_tasks ?? []) {
    if (!l?.task_id || !l.link_id || l.task_id === l.link_id) continue;
    const [a, b] = [l.task_id, l.link_id].sort();
    out.push({ externalId: `link:${a}~${b}`, fromExternalId: a, toExternalId: b, type: DependencyType.RELATES_TO });
  }
  return out;
}

export function issueTypeLevel(): IssueTypeLevel {
  return IssueTypeLevel.STANDARD;
}

// ------------------------------------------------------------------------------------------------ comments / files

const commentText = (c: CuComment): string => (c.comment_text ?? '').toString();

/** Comments (and their replies) in the canonical shape, oldest first. `replies` maps a root comment id to its replies. */
export function toComments(roots: CuComment[], replies: ReadonlyMap<string, CuComment[]>): CanonicalComment[] {
  const out: CanonicalComment[] = [];
  const seen = new Set<string>();
  const add = (c: CuComment, parent?: string) => {
    const id = String(c.id);
    if (!c?.id || seen.has(id)) return;
    seen.add(id);
    const e: CanonicalComment = { externalId: id, body: commentText(c) };
    if (c.user?.id !== undefined && c.user.id !== null) e.authorExternalId = String(c.user.id);
    if (c.user?.username) e.authorName = c.user.username;
    const at = iso(c.date);
    if (at) e.createdAt = at;
    if (parent) e.parentExternalId = parent;
    out.push(e);
  };
  const byDate = (a: CuComment, b: CuComment) => Number(a.date ?? 0) - Number(b.date ?? 0);
  for (const r of [...roots].sort(byDate)) {
    add(r);
    for (const rep of [...(replies.get(String(r.id)) ?? [])].sort(byDate)) add(rep, String(r.id));
  }
  return out;
}

/** ClickUp-owned file hosts only: the address comes from ClickUp's API, but it is still checked before a token is ever sent to it. */
export function isClickUpFileUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || u.port !== '' || u.username !== '' || u.password !== '') return false;
    const h = u.hostname.toLowerCase();
    return h === 'clickup.com' || h.endsWith('.clickup.com') || h === 'clickup-attachments.com' || h.endsWith('.clickup-attachments.com');
  } catch {
    return false;
  }
}

export function safeFileName(raw: string | undefined, fallback: string): string {
  const base = (raw ?? '').split(/[\\/]/).pop() ?? '';
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200);
  return clean || fallback;
}

export function toAttachments(taskId: string, list: CuAttachment[]): CanonicalAttachment[] {
  const out: CanonicalAttachment[] = [];
  const seen = new Set<string>();
  for (const a of list) {
    if (!a?.id || !a.url || !isClickUpFileUrl(a.url) || seen.has(String(a.id))) continue;
    seen.add(String(a.id));
    const ext = (a.extension ?? '').replace(/^\./, '');
    let fileName = safeFileName(a.title ?? undefined, `attachment-${a.id}`);
    if (ext && !fileName.toLowerCase().endsWith(`.${ext.toLowerCase()}`)) fileName = `${fileName}.${ext}`;
    const id = `${taskId}:${a.id}`;
    const e: CanonicalAttachment = { externalId: id.length <= 190 ? id : `${taskId}:${createHash('sha1').update(String(a.id)).digest('hex').slice(0, 20)}`, fileName, providerRef: a.url };
    if (a.mimetype) e.mimeType = a.mimetype;
    const size = typeof a.size === 'number' ? a.size : Number(a.size);
    if (Number.isFinite(size) && size >= 0) e.sizeBytes = Math.floor(size);
    if (a.user?.id !== undefined && a.user.id !== null) e.uploaderExternalId = String(a.user.id);
    const at = iso(a.date);
    if (at) e.createdAt = at;
    out.push(e);
  }
  return out;
}
