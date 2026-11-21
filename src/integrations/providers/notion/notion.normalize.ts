import { createHash } from 'node:crypto';
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
import { CANONICAL_SCHEMA_VERSION } from '../../../imports/canonical';
import { escapeText } from '../../../imports/canonical/normalize/md-render';
import type { ResolvedRoles } from '../../../imports/field-roles';
import type { FieldRole, SourceField } from '../../../imports/imports.types';
import { NtComment, NtDataSource, NtFileItem, NtOption, NtPage, NtPropertySchema, NtPropertyValue, NtRichText, NtUser } from './notion.types';

export const NOTION_SYSTEM = { system: 'notion', displayName: 'Notion' } as const;
export const emptyPage = (): CanonicalBundle => ({ schemaVersion: CANONICAL_SCHEMA_VERSION, source: { ...NOTION_SYSTEM } });

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const fold = (s: string): string => s.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
const sha = (s: string, n: number): string => createHash('sha1').update(s).digest('hex').slice(0, n);

// ------------------------------------------------------------------------------------------------ time

export function isoInstant(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw === '') return undefined;
  const n = Date.parse(raw);
  return Number.isFinite(n) ? new Date(n).toISOString() : undefined;
}

/** A Notion date is `YYYY-MM-DD` (a day: 00:00 UTC) or a full datetime with an offset (the instant). */
export function dateInstant(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? isoInstant(`${raw}T00:00:00.000Z`) : isoInstant(raw);
}

// ------------------------------------------------------------------------------------------------ rich text

export const plain = (rt: NtRichText[] | null | undefined): string => (rt ?? []).map((r) => str(r?.plain_text ?? r?.text?.content)).join('');

/** Rich text -> markdown (bold, italic, strike, code, links, mentions as their text). Plain pieces are escaped so source text never turns into formatting. */
export function richTextToMarkdown(rt: NtRichText[] | null | undefined): string {
  let out = '';
  for (const r of rt ?? []) {
    const text = str(r?.plain_text ?? r?.text?.content);
    if (text === '') continue;
    const a = r.annotations ?? {};
    let s = a.code ? `\`${text.replace(/`/g, "'")}\`` : escapeText(text);
    if (!a.code) {
      if (a.strikethrough) s = `~~${s}~~`;
      if (a.italic) s = `*${s}*`;
      if (a.bold) s = `**${s}**`;
    }
    const href = r.href ?? r.text?.link?.url;
    if (href && /^https?:\/\//i.test(href)) s = `[${s}](${href})`;
    out += s;
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ people

export function toUser(u: NtUser): CanonicalUser | null {
  if (!u?.id || (u.type && u.type !== 'person')) return null; // bots are not people
  const out: CanonicalUser = { externalId: u.id, name: str(u.name).trim() || str(u.person?.email) || u.id };
  if (u.person?.email) out.email = str(u.person.email);
  return out;
}

// ------------------------------------------------------------------------------------------------ fields (for the picker)

type RawField = Omit<SourceField, 'suggested'>;

const props = (ds: NtDataSource): NtPropertySchema[] => Object.values(ds.properties ?? {}).filter((p) => p?.id);
const propName = (p: NtPropertySchema): string => str(p.name).trim() || p.id;
export const endFieldId = (propId: string): string => `${propId}:end`;
export const splitEndId = (id: string): string | null => (id.endsWith(':end') ? id.slice(0, -4) : null);

/**
 * What the person can pick for each role. Status-like properties first, then selects, the checkbox last (a "Done" checkbox is the
 * workflow only when nothing better exists). A date can be a due date or a start date; a RANGE's end is offered separately as a due date.
 */
export function fieldsOfDataSource(ds: NtDataSource): RawField[] {
  const out: RawField[] = [];
  const by = (type: string) => props(ds).filter((p) => p.type === type);
  for (const p of by('status')) out.push({ id: p.id, name: propName(p), type: 'status', roles: ['status', 'priority'] });
  for (const p of by('select')) out.push({ id: p.id, name: propName(p), type: 'select', roles: ['status', 'priority'] });
  for (const p of by('multi_select')) out.push({ id: p.id, name: propName(p), type: 'multi_select', roles: ['priority'] });
  for (const p of by('people')) out.push({ id: p.id, name: propName(p), type: 'people', roles: ['assignee'] });
  for (const p of by('date')) {
    out.push({ id: p.id, name: propName(p), type: 'date', roles: ['due', 'start'] });
    out.push({ id: endFieldId(p.id), name: `${propName(p)} (end)`, type: 'date', roles: ['due'] });
  }
  for (const p of by('checkbox')) out.push({ id: p.id, name: propName(p), type: 'checkbox', roles: ['status'] });
  return out;
}

// ------------------------------------------------------------------------------------------------ statuses / project

export const statusId = (ds: string, option: string): string => `${ds}:s:${option}`;
export const checkboxStatusId = (ds: string, done: boolean): string => `${ds}:c:${done ? 1 : 0}`;
export const noStatusId = (ds: string): string => `${ds}:__none`;

/** What the next pages need to know about one data source; plain JSON because it lives in the job's cursor. */
export interface NtPlan {
  id: string;
  titleId: string;
  roles: Partial<Record<FieldRole, string>>;
  kind: 'status' | 'select' | 'checkbox' | 'none';
  /** every status id of this project */
  sv: string[];
  /** folded option name -> status id (an option that was renamed or re-created still finds its status) */
  lbl: Record<string, string>;
  /** property id -> custom field external id (`cf:<hash>:<TYPE>`) */
  cm: Record<string, string>;
  /** structural relations, by property id */
  rel: { parent?: string; blockedBy?: string; blocking?: string };
}

const GROUP_CATEGORY: Record<string, CanonicalStatus['category']> = { 'to-do': 'TODO', todo: 'TODO', 'in progress': 'IN_PROGRESS', complete: 'DONE', completed: 'DONE' };

const optionList = (p: NtPropertySchema): NtOption[] => (p.type === 'status' ? p.status?.options : p.type === 'select' ? p.select?.options : p.multi_select?.options) ?? [];

const SIMPLE_TYPES: Record<string, FieldType> = {
  rich_text: FieldType.TEXT, number: FieldType.NUMBER, select: FieldType.SELECT, multi_select: FieldType.MULTI_SELECT, status: FieldType.SELECT,
  date: FieldType.DATE, people: FieldType.USER, checkbox: FieldType.CHECKBOX, url: FieldType.URL, email: FieldType.TEXT, phone_number: FieldType.TEXT, unique_id: FieldType.TEXT,
};
/** Carried elsewhere (title, timestamps, files -> attachments) or deliberately silent. */
const SILENT = new Set(['title', 'files', 'created_time', 'last_edited_time', 'created_by', 'last_edited_by']);

export const customFieldId = (name: string, t: FieldType): string => `cf:${sha(fold(name), 12)}:${t}`;
export const fieldTypeOf = (externalId: string): FieldType | null => {
  const t = externalId.split(':').pop() as FieldType;
  return Object.values(FieldType).includes(t) ? t : null;
};

export interface BuiltSource {
  plan: NtPlan;
  project: CanonicalProject;
  customFields: CanonicalCustomField[];
  skipped: Array<{ type: string }>;
}

const SELF_PARENT = /^(parent( item| task)?|parent-item)$/i;
const SELF_BLOCKED_BY = /^(blocked by|depends on|dependencies|predecessors?)$/i;
const SELF_BLOCKING = /^(blocking|blocks|successors?)$/i;

export function buildSource(ds: NtDataSource, resolved: ResolvedRoles): BuiltSource {
  const id = ds.id;
  const all = props(ds);
  const byId = new Map(all.map((p) => [p.id, p]));
  const roles: NtPlan['roles'] = {};
  for (const [role, f] of Object.entries(resolved.byRole)) if (f) roles[role as FieldRole] = f.id;

  const statusProp = roles.status ? byId.get(roles.status) : undefined;
  const kind: NtPlan['kind'] = statusProp?.type === 'status' ? 'status' : statusProp?.type === 'select' ? 'select' : statusProp?.type === 'checkbox' ? 'checkbox' : 'none';

  const statuses: CanonicalStatus[] = [];
  const lbl: Record<string, string> = {};
  const add = (externalId: string, name: string, category: CanonicalStatus['category']) => {
    statuses.push({ externalId, name, category, position: statuses.length });
  };
  if (kind === 'status' && statusProp) {
    // Notion's status groups ARE a category source: To-do / In progress / Complete (certain, unlike a select's names)
    const options = new Map(optionList(statusProp).filter((o) => o?.id).map((o) => [str(o.id), o]));
    const placed = new Set<string>();
    for (const g of statusProp.status?.groups ?? []) {
      const category = GROUP_CATEGORY[fold(str(g.name))] ?? 'UNKNOWN';
      for (const oid of g.option_ids ?? []) {
        const o = options.get(oid);
        if (!o || placed.has(oid)) continue;
        placed.add(oid);
        add(statusId(id, oid), str(o.name).trim() || oid, category);
        lbl[fold(str(o.name))] = statusId(id, oid);
      }
    }
    for (const [oid, o] of options) {
      if (placed.has(oid)) continue;
      add(statusId(id, oid), str(o.name).trim() || oid, 'UNKNOWN');
      lbl[fold(str(o.name))] = statusId(id, oid);
    }
    add(noStatusId(id), 'No status', 'TODO');
  } else if (kind === 'select' && statusProp) {
    for (const o of optionList(statusProp)) {
      if (!o?.id) continue;
      add(statusId(id, str(o.id)), str(o.name).trim() || str(o.id), 'UNKNOWN');
      lbl[fold(str(o.name))] = statusId(id, str(o.id));
    }
    add(noStatusId(id), 'No status', 'TODO');
  } else if (kind === 'checkbox') {
    add(checkboxStatusId(id, false), 'To do', 'TODO');
    add(checkboxStatusId(id, true), 'Done', 'DONE');
  } else {
    add(noStatusId(id), 'To do', 'TODO');
  }

  const usedIds = new Set(Object.values(roles).map((fid) => splitEndId(fid) ?? fid));
  const titleProp = all.find((p) => p.type === 'title');
  const customFields = new Map<string, CanonicalCustomField>();
  const cm: Record<string, string> = {};
  const rel: NtPlan['rel'] = {};
  const skipped: Array<{ type: string }> = [];
  for (const p of all) {
    const type = str(p.type);
    if (type === 'relation') {
      const self = p.relation?.data_source_id === id;
      const name = propName(p);
      if (self && SELF_PARENT.test(name) && !rel.parent) rel.parent = p.id;
      else if (self && SELF_BLOCKED_BY.test(name) && !rel.blockedBy) rel.blockedBy = p.id;
      else if (self && SELF_BLOCKING.test(name) && !rel.blocking) rel.blocking = p.id;
      else skipped.push({ type: 'relation' });
      continue;
    }
    if (usedIds.has(p.id) || SILENT.has(type)) continue;
    const dataType = SIMPLE_TYPES[type];
    if (!dataType) {
      skipped.push({ type: type || 'unknown' });
      continue;
    }
    const name = propName(p);
    const def: CanonicalCustomField = { externalId: customFieldId(name, dataType), name, dataType };
    if (dataType === FieldType.SELECT || dataType === FieldType.MULTI_SELECT) def.options = [...new Set(optionList(p).map((o) => str(o?.name).trim()).filter(Boolean))].map((label) => ({ label }));
    cm[p.id] = def.externalId;
    const have = customFields.get(def.externalId);
    if (!have) customFields.set(def.externalId, def);
    else if (def.options?.length) {
      const seen = new Set((have.options ?? []).map((o) => o.label));
      have.options = [...(have.options ?? []), ...def.options.filter((o) => !seen.has(o.label))];
    }
  }

  const project: CanonicalProject = { externalId: id, name: plain(ds.title).trim() || `Data source ${id}`, statuses };
  if (ds.in_trash === true || ds.archived === true) project.archived = true;
  return { plan: { id, titleId: titleProp?.id ?? '', roles, kind, sv: statuses.map((s) => s.externalId), lbl, cm, rel }, project, customFields: [...customFields.values()], skipped };
}

// ------------------------------------------------------------------------------------------------ tasks

const valuesById = (page: NtPage): Map<string, NtPropertyValue> => new Map(Object.values(page.properties ?? {}).filter((v) => v?.id).map((v) => [v.id, v]));
const optionNames = (v: NtPropertyValue | undefined): string[] => (v?.multi_select ?? []).map((o) => str(o?.name).trim()).filter(Boolean);

function statusOfPage(vals: Map<string, NtPropertyValue>, plan: NtPlan): string {
  const none = noStatusId(plan.id);
  if (plan.kind === 'checkbox') return checkboxStatusId(plan.id, vals.get(plan.roles.status!)?.checkbox === true);
  if (plan.kind === 'status' || plan.kind === 'select') {
    const v = vals.get(plan.roles.status!);
    const o = plan.kind === 'status' ? v?.status : v?.select;
    if (o?.id && plan.sv.includes(statusId(plan.id, o.id))) return statusId(plan.id, o.id);
    return plan.lbl[fold(str(o?.name))] ?? none;
  }
  return none;
}

function dateRole(vals: Map<string, NtPropertyValue>, fieldId: string | undefined, role: 'due' | 'start'): string | undefined {
  if (!fieldId) return undefined;
  const end = splitEndId(fieldId);
  const d = vals.get(end ?? fieldId)?.date;
  if (!d) return undefined;
  if (end !== null) return dateInstant(d.end);
  return role === 'due' ? dateInstant(d.end) ?? dateInstant(d.start) : dateInstant(d.start);
}

export function customValueOf(v: NtPropertyValue, externalId: string): CanonicalCustomValue | null {
  const t = fieldTypeOf(externalId);
  switch (t) {
    case FieldType.TEXT: {
      const text = v.type === 'unique_id' ? (v.unique_id?.number !== null && v.unique_id?.number !== undefined ? `${v.unique_id.prefix ? `${v.unique_id.prefix}-` : ''}${v.unique_id.number}` : '') : v.type === 'email' ? str(v.email) : v.type === 'phone_number' ? str(v.phone_number) : plain(v.rich_text);
      return text.trim() ? { fieldExternalId: externalId, value: text.trim() } : null;
    }
    case FieldType.NUMBER:
      return typeof v.number === 'number' && Number.isFinite(v.number) ? { fieldExternalId: externalId, value: v.number } : null;
    case FieldType.DATE: {
      const d = dateInstant(v.date?.start);
      return d ? { fieldExternalId: externalId, value: d } : null;
    }
    case FieldType.SELECT: {
      const name = str((v.type === 'status' ? v.status : v.select)?.name).trim();
      return name ? { fieldExternalId: externalId, value: name } : null;
    }
    case FieldType.MULTI_SELECT: {
      const names = optionNames(v);
      return names.length ? { fieldExternalId: externalId, value: names } : null;
    }
    case FieldType.USER: {
      const first = (v.people ?? []).find((u) => u?.id && (!u.type || u.type === 'person'));
      return first ? { fieldExternalId: externalId, value: first.id } : null;
    }
    case FieldType.URL:
      return /^https?:\/\//i.test(str(v.url)) ? { fieldExternalId: externalId, value: str(v.url) } : null;
    case FieldType.CHECKBOX:
      return v.checkbox === true ? { fieldExternalId: externalId, value: true } : null;
    default:
      return null;
  }
}

/** Trashed pages are not rows (the flag is `in_trash` since 2026-03-11, `archived` before). */
export const isTrashed = (p: NtPage): boolean => p.in_trash === true || p.archived === true;

export function toTask(page: NtPage, plan: NtPlan, description: string): CanonicalTask {
  const vals = valuesById(page);
  const out: CanonicalTask = { externalId: page.id, projectExternalId: plan.id, title: plain(vals.get(plan.titleId)?.title).trim(), statusExternalId: statusOfPage(vals, plan) };
  if (page.url) out.url = str(page.url);
  if (description) out.description = description;

  if (plan.roles.priority) {
    const v = vals.get(plan.roles.priority);
    const label = str(v?.status?.name ?? v?.select?.name).trim() || optionNames(v)[0] || '';
    if (label) out.priority = label;
  }
  const people = plan.roles.assignee ? (vals.get(plan.roles.assignee)?.people ?? []).filter((u) => u?.id && (!u.type || u.type === 'person')).map((u) => u.id) : [];
  if (people.length) out.assigneeExternalIds = [...new Set(people)].slice(0, 20);
  if (page.created_by?.id) out.creatorExternalId = page.created_by.id;
  const created = isoInstant(page.created_time);
  if (created) out.createdAt = created;
  const updated = isoInstant(page.last_edited_time);
  if (updated) out.updatedAt = updated;
  const start = dateRole(vals, plan.roles.start, 'start');
  if (start) out.startDate = start;
  const due = dateRole(vals, plan.roles.due, 'due');
  if (due) out.dueDate = due;

  const parent = plan.rel.parent ? vals.get(plan.rel.parent)?.relation?.[0]?.id : undefined;
  if (parent && parent !== page.id) out.parentExternalId = parent;

  const cvs: CanonicalCustomValue[] = [];
  for (const [propId, fid] of Object.entries(plan.cm)) {
    const v = vals.get(propId);
    const cv = v ? customValueOf(v, fid) : null;
    if (cv) cvs.push(cv);
  }
  if (cvs.length) out.customValues = cvs.slice(0, 100);
  return out;
}

/** "Blocked by" lists the blockers of THIS page (blocker -> this); "Blocking" the pages THIS one blocks. A relation holds at most 25 references in a page answer: the rest are not read. */
export function toDependencies(page: NtPage, plan: NtPlan): CanonicalDependency[] {
  const vals = valuesById(page);
  const out = new Map<string, CanonicalDependency>();
  const edge = (from: string, to: string) => {
    if (from === to) return;
    const id = `dep:${from}>${to}`;
    out.set(id, { externalId: id, fromExternalId: from, toExternalId: to, type: DependencyType.BLOCKS });
  };
  for (const r of plan.rel.blockedBy ? vals.get(plan.rel.blockedBy)?.relation ?? [] : []) if (r?.id) edge(r.id, page.id);
  for (const r of plan.rel.blocking ? vals.get(plan.rel.blocking)?.relation ?? [] : []) if (r?.id) edge(page.id, r.id);
  return [...out.values()];
}

// ------------------------------------------------------------------------------------------------ comments

/** A discussion is a thread: its first comment is the comment, the later ones are replies to it (one level, as the canonical model has it). */
export function toComments(list: NtComment[]): CanonicalComment[] {
  const sorted = [...list].filter((c) => c?.id).sort((a, b) => Date.parse(a.created_time ?? '') - Date.parse(b.created_time ?? ''));
  const first = new Map<string, string>();
  const out: CanonicalComment[] = [];
  const seen = new Set<string>();
  for (const c of sorted) {
    if (seen.has(c.id)) continue;
    const body = richTextToMarkdown(c.rich_text).trim();
    if (!body) continue;
    seen.add(c.id);
    const row: CanonicalComment = { externalId: c.id, body };
    if (c.created_by?.id) row.authorExternalId = c.created_by.id;
    const at = isoInstant(c.created_time);
    if (at) row.createdAt = at;
    const d = c.discussion_id ?? '';
    if (d) {
      const head = first.get(d);
      if (head) row.parentExternalId = head;
      else first.set(d, c.id);
    }
    out.push(row);
  }
  return out.slice(0, 1000);
}

// ------------------------------------------------------------------------------------------------ files

export const FILE_REF_PREFIX = 'notion-file:';
export type FileSource = 'm' | 'p';
/** Notion's file URLs are signed and expire (about an hour), but their PATH (without the query) is stable: that is the identity of a file. */
export function pathKey(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return null;
  }
}
export const fileHash = (url: string): string | null => {
  const k = pathKey(url);
  return k ? sha(k, 16) : null;
};
export const fileRef = (pageId: string, source: FileSource, hash: string): string => `${FILE_REF_PREFIX}${pageId}:${source}:${hash}`;
export function parseFileRef(ref: string): { pageId: string; source: FileSource; hash: string } | null {
  const m = /^notion-file:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([mp]):([0-9a-f]{16})$/.exec(typeof ref === 'string' ? ref : '');
  return m ? { pageId: m[1], source: m[2] as FileSource, hash: m[3] } : null;
}

const HOST = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

/**
 * Where a file URL may point: https, no port or userinfo, never an IP literal, and a Notion host (`notion.so`, `*.notion.so`,
 * `*.notion-static.com`, the `prod-files-secure` S3 bucket, or `s3.*.amazonaws.com/secure.notion-static.com/...`). The real hosts are
 * only described loosely in the docs, so `extra` (NOTION_FILE_HOSTS: exact host or ".suffix") lets an operator add one after a refusal in
 * the logs. The access token is NEVER sent: these URLs are pre-signed.
 */
export function isAllowedFileUrl(raw: string, extra: readonly string[] = []): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || u.port !== '' || u.username !== '' || u.password !== '') return false;
    const h = u.hostname.toLowerCase();
    if (!HOST.test(h) || /^\d+(\.\d+){3}$/.test(h) || h.includes(':')) return false;
    if (h === 'notion.so' || h.endsWith('.notion.so') || h === 'notion-static.com' || h.endsWith('.notion-static.com') || h === 'notionusercontent.com' || h.endsWith('.notionusercontent.com')) return true;
    if (/^prod-files-secure\.s3([.-][a-z0-9-]+)?\.amazonaws\.com$/.test(h)) return true;
    if (/^s3([.-][a-z0-9-]+)?\.amazonaws\.com$/.test(h) && u.pathname.startsWith('/secure.notion-static.com/')) return true;
    return extra.some((e) => (e.startsWith('.') ? h.endsWith(e) && h.length > e.length : h === e));
  } catch {
    return false;
  }
}

export function safeFileName(raw: string | null | undefined, fallback: string): string {
  const base = (raw ?? '').split(/[\\/]/).pop() ?? '';
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200);
  return clean || fallback;
}

const nameFromUrl = (url: string): string => {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop() ?? '';
    return decodeURIComponent(last);
  } catch {
    return '';
  }
};

export interface FoundFile {
  hash: string;
  name: string;
  url: string;
}

/** `files` property values: Notion-hosted files are copied (their ref re-reads the PAGE); external links are not files of ours. */
export function propertyFiles(page: NtPage): FoundFile[] {
  const out: FoundFile[] = [];
  for (const v of Object.values(page.properties ?? {})) {
    if (v?.type !== 'files') continue;
    for (const f of (v.files ?? []) as NtFileItem[]) {
      const url = str(f?.file?.url);
      const hash = url ? fileHash(url) : null;
      if (f?.type === 'file' && hash) out.push({ hash, name: safeFileName(f.name, safeFileName(nameFromUrl(url), 'file')), url });
    }
  }
  return out;
}

export function toAttachments(pageId: string, files: Array<FoundFile & { source: FileSource }>): CanonicalAttachment[] {
  const out: CanonicalAttachment[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    if (seen.has(f.hash)) continue;
    seen.add(f.hash);
    out.push({ externalId: `${pageId}:${f.hash}`, fileName: safeFileName(f.name, 'file'), providerRef: fileRef(pageId, f.source, f.hash) });
  }
  return out.slice(0, 100);
}

// ------------------------------------------------------------------------------------------------ markdown

export interface ConvertedMarkdown {
  markdown: string;
  files: Array<FoundFile & { source: 'm' }>;
  /** `<unknown .../>` blocks left in the text (truncated or not readable). */
  unknown: number;
}

const WRAPPERS = 'columns|column|synced_block|synced-block|table_of_contents|empty-block|meeting-notes|mention-user|mention-page|mention-database|mention-date|mention-agent|span|colgroup|col|tbody|thead|tfoot';

function convertTable(attrs: string, inner: string): string {
  const rows = [...inner.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => [...m[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => c[1].replace(/<[^>]+>/g, '').replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|').trim()));
  if (rows.length === 0) return '';
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r: string[]) => `| ${[...r, ...Array(width - r.length).fill('')].join(' | ')} |`;
  const header = /header-row\s*=\s*"?true/i.test(attrs) ? rows[0] : Array(width).fill('');
  const body = /header-row\s*=\s*"?true/i.test(attrs) ? rows.slice(1) : rows;
  return [pad(header), `| ${Array(width).fill('---').join(' | ')} |`, ...body.map(pad)].join('\n');
}

/**
 * Notion's "enhanced markdown" -> the markdown our description understands. Fenced code is never touched. File blocks (and any link to a
 * Notion file host) are registered as files and written as `[name](<providerRef>)`: the signed URL would be dead in an hour, and the file
 * copier re-points that exact reference to our own copy afterwards. Notion-only tags (callouts, toggles, columns, tables, mentions,
 * unknown blocks) become plain markdown. The tag syntax is described loosely in the docs: see ADR-0042 "Unverified".
 */
export function convertMarkdown(raw: string, pageId: string, extraHosts: readonly string[] = []): ConvertedMarkdown {
  const files = new Map<string, FoundFile & { source: 'm' }>();
  let unknown = 0;
  const register = (url: string, name: string): string | null => {
    if (!/^https:\/\//i.test(url) || !isAllowedFileUrl(url, extraHosts)) return null;
    const hash = fileHash(url);
    if (!hash) return null;
    // the file's own name (`design.png`) beats the caption ("Design mock"): the attachment is named like the file
    if (!files.has(hash)) files.set(hash, { hash, name: safeFileName(nameFromUrl(url), safeFileName(name, 'file')), url, source: 'm' });
    return fileRef(pageId, 'm', hash);
  };
  const attr = (attrs: string, n: string): string => new RegExp(`\\b${n}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attrs)?.slice(1).find((x) => x !== undefined) ?? '';

  const text = (seg: string): string => {
    let s = seg;
    s = s.replace(/<(image|file|pdf|video|audio)\b([^<>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/g, (_m, kind: string, attrs: string, caption: string | undefined) => {
      const src = attr(attrs, 'src') || attr(attrs, 'url');
      const label = (caption ?? '').replace(/<[^>]+>/g, '').trim() || attr(attrs, 'alt') || attr(attrs, 'name') || nameFromUrl(src) || kind;
      const ref = register(src, label);
      if (!ref) return label ? `[${label}]` : '';
      return kind === 'image' ? `![${label}](${ref})` : `[${label}](${ref})`;
    });
    s = s.replace(/(!?)\[([^\]]*)\]\((https:\/\/[^)\s]+)\)/g, (m, bang: string, label: string, url: string) => {
      const ref = register(url, label);
      return ref ? `${bang}[${label}](${ref})` : m;
    });
    s = s.replace(/<unknown\b[^>]*\/>/g, () => {
      unknown++;
      return '';
    });
    s = s.replace(/<callout\b[^>]*>([\s\S]*?)<\/callout>/g, (_m, body: string) => body.trim().split('\n').map((l) => `> ${l}`.trimEnd()).join('\n'));
    s = s.replace(/<details\b[^>]*>\s*<summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/g, (_m, sum: string, body: string) => `**${sum.replace(/<[^>]+>/g, '').trim()}**\n\n${body.trim()}`);
    s = s.replace(/<table\b([^>]*)>([\s\S]*?)<\/table>/g, (_m, attrs: string, inner: string) => convertTable(attrs, inner));
    s = s.replace(new RegExp(`<\\/?(?:${WRAPPERS})\\b[^>]*\\/?>`, 'g'), '');
    s = s.replace(/<br\s*\/?>/gi, '\n');
    return s;
  };

  // never touch fenced code
  const out: string[] = [];
  let buf: string[] = [];
  let fence: string | null = null;
  const flush = () => {
    if (buf.length) out.push(text(buf.join('\n')));
    buf = [];
  };
  for (const line of raw.replace(/\r\n?/g, '\n').split('\n')) {
    const m = /^\s*(```+|~~~+)/.exec(line);
    if (fence === null && m) {
      flush();
      fence = m[1];
      out.push(line);
    } else if (fence !== null) {
      out.push(line);
      if (m && m[1].startsWith(fence[0]) && m[1].length >= fence.length) fence = null;
    } else buf.push(line);
  }
  flush();
  return { markdown: out.join('\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(), files: [...files.values()], unknown };
}
