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
import { CANONICAL_SCHEMA_VERSION, htmlToMarkdown } from '../../../imports/canonical';
import type { FieldRole, SourceField } from '../../../imports/imports.types';
import type { ResolvedRoles } from '../../../imports/field-roles';
import { MnAsset, MnBoard, MnColumn, MnColumnValue, MnItem, MnReply, MnSubitem, MnUpdate, MnUser } from './monday.types';

export const MONDAY_SYSTEM = { system: 'monday', displayName: 'monday.com' } as const;
export const emptyPage = (): CanonicalBundle => ({ schemaVersion: CANONICAL_SCHEMA_VERSION, source: { ...MONDAY_SYSTEM } });

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

// ------------------------------------------------------------------------------------------------ time

export function isoInstant(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw === '') return undefined;
  const n = Date.parse(raw);
  return Number.isFinite(n) ? new Date(n).toISOString() : undefined;
}

const isoDay = (day: unknown): string | undefined => (typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) ? isoInstant(`${day}T00:00:00.000Z`) : undefined);

/** A date column: `{ date: "2026-03-01", time: "13:30:00" | null }` (time is UTC). */
export function dateInstant(date: unknown, time?: unknown): string | undefined {
  if (typeof date !== 'string') return undefined;
  if (typeof time === 'string' && /^\d{2}:\d{2}(:\d{2})?$/.test(time)) return isoInstant(`${date}T${time.length === 5 ? `${time}:00` : time}Z`) ?? isoDay(date);
  return isoDay(date);
}

// ------------------------------------------------------------------------------------------------ people

export function toUser(u: MnUser): CanonicalUser {
  const out: CanonicalUser = { externalId: str(u.id), name: str(u.name) || str(u.email) || str(u.id) };
  if (u.email) out.email = str(u.email);
  return out;
}

// ------------------------------------------------------------------------------------------------ column values

/** A column's `value` is a JSON STRING whose shape depends on the type; anything unparseable is "no value". */
export function parseValue(cv: MnColumnValue | undefined): Record<string, unknown> | null {
  if (!cv || typeof cv.value !== 'string' || cv.value === '') return null;
  try {
    const v: unknown = JSON.parse(cv.value);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Status: `{"index": 1}` (the label id); the label itself is the column's `text`. */
export function statusIndex(cv: MnColumnValue | undefined): string | null {
  const v = parseValue(cv);
  const i = v?.index;
  return typeof i === 'number' && Number.isInteger(i) ? String(i) : null;
}

/** People: `{"personsAndTeams": [{"id": 1, "kind": "person" | "team"}]}`. Teams are not people we can assign. */
export function personIds(cv: MnColumnValue | undefined): string[] {
  const list = parseValue(cv)?.personsAndTeams;
  if (!Array.isArray(list)) return [];
  const ids = list.filter((p) => p && typeof p === 'object' && (p as { kind?: string }).kind === 'person').map((p) => str((p as { id?: unknown }).id)).filter((x) => /^\d+$/.test(x));
  return [...new Set(ids)];
}

export function dateOf(cv: MnColumnValue | undefined): string | undefined {
  const v = parseValue(cv);
  return v ? dateInstant(v.date, v.time) : undefined;
}

export function timelineOf(cv: MnColumnValue | undefined): { from?: string; to?: string } {
  const v = parseValue(cv);
  if (!v) return {};
  const out: { from?: string; to?: string } = {};
  const from = isoDay(v.from);
  const to = isoDay(v.to);
  if (from) out.from = from;
  if (to) out.to = to;
  return out;
}

/** Dependency column: `{"linkedPulseIds": [{"linkedPulseId": 123}]}`: the items THIS item depends on. */
export function linkedItemIds(cv: MnColumnValue | undefined): string[] {
  const list = parseValue(cv)?.linkedPulseIds;
  if (!Array.isArray(list)) return [];
  return [...new Set(list.map((x) => str((x as { linkedPulseId?: unknown })?.linkedPulseId)).filter((x) => /^\d+$/.test(x)))];
}

// ------------------------------------------------------------------------------------------------ fields (for the picker)

export const GROUP_FIELD_ID = '__group__';
type RawField = Omit<SourceField, 'suggested'>;

/** A timeline column is a start AND an end: two virtual fields, so each can play its own role (one field never plays two). */
export const timelineHalfId = (colId: string, half: 'from' | 'to'): string => `${colId}:${half}`;
export function splitTimelineId(id: string): { col: string; half: 'from' | 'to' } | null {
  const m = /^(.+):(from|to)$/.exec(id);
  return m ? { col: m[1], half: m[2] as 'from' | 'to' } : null;
}

const ROLES_BY_TYPE: Record<string, FieldRole[]> = {
  status: ['status', 'priority'],
  dropdown: ['priority'],
  people: ['assignee'],
  'multiple-person': ['assignee'],
  date: ['due', 'start'],
};

const colTitle = (c: MnColumn): string => str(c.title).trim() || c.id;

/**
 * What the person can pick for each role on this board. Real columns first, the group LAST: a board without a status column then falls
 * back to its groups as the workflow (the suggestion's "first status-typed field"), and one with a status column keeps the column.
 */
export function fieldsOfBoard(board: MnBoard): RawField[] {
  const out: RawField[] = [];
  for (const c of board.columns ?? []) {
    if (!c?.id || c.archived === true) continue;
    const type = str(c.type).toLowerCase();
    if (type === 'timeline') {
      out.push({ id: timelineHalfId(c.id, 'from'), name: `${colTitle(c)} (start)`, type: 'timeline', roles: ['start'] });
      out.push({ id: timelineHalfId(c.id, 'to'), name: `${colTitle(c)} (end)`, type: 'timeline', roles: ['due'] });
    } else if (ROLES_BY_TYPE[type]) {
      out.push({ id: c.id, name: colTitle(c), type, roles: [...ROLES_BY_TYPE[type]] });
    }
  }
  if ((board.groups ?? []).some((g) => g?.id)) out.push({ id: GROUP_FIELD_ID, name: 'Group', type: 'group', roles: ['status'] });
  return out;
}

// ------------------------------------------------------------------------------------------------ statuses / project

const fold = (s: string): string => s.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
const hash12 = (s: string): string => createHash('sha1').update(s).digest('hex').slice(0, 12);

interface LabelInfo {
  index: string;
  name: string;
  position: number;
}

function settingsOf(c: MnColumn): Record<string, unknown> {
  if (typeof c.settings_str !== 'string' || c.settings_str === '') return {};
  try {
    const v: unknown = JSON.parse(c.settings_str);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** A status column's labels: settings `{ labels: { "0": "Working on it", ... }, labels_positions_v2: { "0": 3 } }`. Blank labels are not choices. */
export function statusLabels(c: MnColumn): LabelInfo[] {
  const s = settingsOf(c);
  const labels = s.labels && typeof s.labels === 'object' && !Array.isArray(s.labels) ? (s.labels as Record<string, unknown>) : {};
  const positions = s.labels_positions_v2 && typeof s.labels_positions_v2 === 'object' ? (s.labels_positions_v2 as Record<string, unknown>) : {};
  const out: LabelInfo[] = [];
  for (const [index, raw] of Object.entries(labels)) {
    const name = str(raw).trim();
    if (!name || !/^\d+$/.test(index)) continue;
    const p = positions[index];
    out.push({ index, name, position: typeof p === 'number' ? p : Number(index) });
  }
  return out.sort((a, b) => a.position - b.position || Number(a.index) - Number(b.index));
}

/** A dropdown's options: settings `{ labels: [{ id: 1, name: "a" }] }`. */
function dropdownOptions(c: MnColumn): string[] {
  const l = settingsOf(c).labels;
  if (!Array.isArray(l)) return [];
  return l.map((x) => str((x as { name?: unknown })?.name).trim()).filter(Boolean);
}

export const statusId = (board: string, index: string): string => `${board}:s:${index}`;
export const groupStatusId = (board: string, group: string): string => `${board}:g:${group}`;
export const noStatusId = (board: string): string => `${board}:__none`;

/** What the next pages need to know about one board; plain JSON because it lives in the job's cursor. */
export interface BoardPlan {
  id: string;
  /** role -> the field id the person (or the suggestion) settled on. A role absent here is not mapped. */
  roles: Partial<Record<FieldRole, string>>;
  /** Where an item's status comes from: a status column, the group, or nowhere. */
  kind: 'column' | 'group' | 'none';
  /** Every status id of this project: an item whose label/group is not among them falls back instead of dangling. */
  sv: string[];
  /** folded label -> status id (column kind): how a SUBITEM's label finds its status. */
  lbl: Record<string, string>;
  /** column id -> custom field external id (`cf:<hash>:<TYPE>`), for the columns that become custom fields. */
  cm: Record<string, string>;
  /** dependency columns. */
  dep: string[];
}

const SILENT = new Set(['name', 'subtasks', 'dependency', 'file', 'creation_log', 'last_updated', 'item_id', 'auto_number', 'item_assignees']);

const SIMPLE_TYPES: Record<string, FieldType> = {
  text: FieldType.TEXT, long_text: FieldType.TEXT, email: FieldType.TEXT, phone: FieldType.TEXT,
  numbers: FieldType.NUMBER, rating: FieldType.NUMBER, date: FieldType.DATE, people: FieldType.USER, 'multiple-person': FieldType.USER,
  link: FieldType.URL, checkbox: FieldType.CHECKBOX, status: FieldType.SELECT, dropdown: FieldType.MULTI_SELECT,
};

export const customFieldId = (title: string, t: FieldType): string => `cf:${hash12(fold(title))}:${t}`;
export const fieldTypeOf = (externalId: string): FieldType | null => {
  const t = externalId.split(':').pop() as FieldType;
  return Object.values(FieldType).includes(t) ? t : null;
};

export interface BuiltBoard {
  plan: BoardPlan;
  project: CanonicalProject;
  customFields: CanonicalCustomField[];
  skipped: Array<{ type: string }>;
}

/** The roles chosen for the board -> the project with its statuses, the custom fields, and the plan the task pages follow. */
export function buildBoard(board: MnBoard, resolved: ResolvedRoles): BuiltBoard {
  const id = str(board.id);
  const roles: BoardPlan['roles'] = {};
  for (const [role, f] of Object.entries(resolved.byRole)) if (f) roles[role as FieldRole] = f.id;

  const cols = (board.columns ?? []).filter((c) => c?.id && c.archived !== true);
  const colById = new Map(cols.map((c) => [c.id, c]));
  const statusField = roles.status;
  const kind: BoardPlan['kind'] = statusField === GROUP_FIELD_ID ? 'group' : statusField && colById.get(statusField)?.type === 'status' ? 'column' : 'none';

  const statuses: CanonicalStatus[] = [];
  const lbl: Record<string, string> = {};
  if (kind === 'column') {
    for (const l of statusLabels(colById.get(statusField!)!)) {
      const sid = statusId(id, l.index);
      statuses.push({ externalId: sid, name: l.name, category: 'UNKNOWN', position: statuses.length });
      if (!(fold(l.name) in lbl)) lbl[fold(l.name)] = sid;
    }
    statuses.push({ externalId: noStatusId(id), name: 'No status', category: 'TODO', position: statuses.length });
  } else if (kind === 'group') {
    for (const g of board.groups ?? []) {
      if (!g?.id) continue;
      statuses.push({ externalId: groupStatusId(id, g.id), name: str(g.title).trim() || g.id, category: 'UNKNOWN', position: statuses.length });
    }
    if (statuses.length === 0) statuses.push({ externalId: noStatusId(id), name: 'To do', category: 'TODO', position: 0 });
  } else {
    statuses.push({ externalId: noStatusId(id), name: 'To do', category: 'TODO', position: 0 });
  }

  // columns that already play a role are not ALSO custom fields; a timeline's two halves are tracked separately (only the half that plays
  // a role is spent: the other half becomes a date field instead of vanishing)
  const usedIds = new Set<string>(Object.values(roles));

  const customFields = new Map<string, CanonicalCustomField>();
  const cm: Record<string, string> = {};
  const dep: string[] = [];
  const skipped: Array<{ type: string }> = [];
  const addField = (key: string, def: CanonicalCustomField): void => {
    cm[key] = def.externalId;
    const have = customFields.get(def.externalId);
    if (!have) customFields.set(def.externalId, def);
    else if (def.options?.length) {
      const seen = new Set((have.options ?? []).map((o) => o.label));
      have.options = [...(have.options ?? []), ...def.options.filter((o) => !seen.has(o.label))];
    }
  };
  for (const c of cols) {
    const type = str(c.type).toLowerCase();
    if (type === 'dependency') dep.push(c.id);
    if (type === 'timeline') {
      for (const half of ['from', 'to'] as const) {
        const hid = timelineHalfId(c.id, half);
        if (usedIds.has(hid)) continue;
        const title = `${colTitle(c)} (${half === 'from' ? 'start' : 'end'})`;
        addField(hid, { externalId: customFieldId(title, FieldType.DATE), name: title, dataType: FieldType.DATE });
      }
      continue;
    }
    if (usedIds.has(c.id) || SILENT.has(type)) continue;
    const dataType = SIMPLE_TYPES[type];
    if (!dataType) {
      skipped.push({ type: type || 'unknown' });
      continue;
    }
    const title = colTitle(c);
    const def: CanonicalCustomField = { externalId: customFieldId(title, dataType), name: title, dataType };
    if (dataType === FieldType.SELECT || dataType === FieldType.MULTI_SELECT) {
      const names = type === 'status' ? statusLabels(c).map((l) => l.name) : dropdownOptions(c);
      def.options = [...new Set(names)].map((label) => ({ label }));
    }
    addField(c.id, def);
  }

  const project: CanonicalProject = { externalId: id, name: str(board.name).trim() || `Board ${id}`, statuses };
  if (board.url) project.url = str(board.url);
  if (board.description) project.description = str(board.description);
  if (board.state === 'archived') project.archived = true;
  return { plan: { id, roles, kind, sv: statuses.map((s) => s.externalId), lbl, cm, dep }, project, customFields: [...customFields.values()], skipped };
}

// ------------------------------------------------------------------------------------------------ tasks

const byId = (list: MnColumnValue[] | null | undefined): Map<string, MnColumnValue> => new Map((list ?? []).filter((c) => c?.id).map((c) => [c.id, c]));
const firstLabel = (text: string | null | undefined): string => str(text).split(',')[0].trim();

function fallbackStatus(plan: BoardPlan): string {
  return plan.kind === 'group' ? plan.sv[0] : noStatusId(plan.id);
}

function statusOfItem(item: MnItem, values: Map<string, MnColumnValue>, plan: BoardPlan): string {
  const fb = fallbackStatus(plan);
  if (plan.kind === 'group') {
    const sid = item.group?.id ? groupStatusId(plan.id, item.group.id) : '';
    return plan.sv.includes(sid) ? sid : fb;
  }
  if (plan.kind === 'column') {
    const cv = values.get(plan.roles.status!);
    const idx = statusIndex(cv);
    if (idx !== null && plan.sv.includes(statusId(plan.id, idx))) return statusId(plan.id, idx);
    const byLabel = plan.lbl[fold(str(cv?.text))];
    if (byLabel) return byLabel;
  }
  return fb;
}

/** The start / end of a task from the role fields (a date column, or one half of a timeline). */
function dateRole(values: Map<string, MnColumnValue>, fieldId: string | undefined): string | undefined {
  if (!fieldId) return undefined;
  const half = splitTimelineId(fieldId);
  if (half) return timelineOf(values.get(half.col))[half.half];
  return dateOf(values.get(fieldId));
}

export function customValueOf(cv: MnColumnValue, externalId: string): CanonicalCustomValue | null {
  const t = fieldTypeOf(externalId);
  const text = str(cv.text).trim();
  const v = parseValue(cv);
  switch (t) {
    case FieldType.TEXT:
      return text ? { fieldExternalId: externalId, value: text } : null;
    case FieldType.NUMBER: {
      const n = Number(text.replace(/,/g, ''));
      return text !== '' && Number.isFinite(n) ? { fieldExternalId: externalId, value: n } : null;
    }
    case FieldType.DATE: {
      const d = dateOf(cv);
      return d ? { fieldExternalId: externalId, value: d } : null;
    }
    case FieldType.SELECT:
      return text ? { fieldExternalId: externalId, value: text } : null;
    case FieldType.MULTI_SELECT: {
      const labels = text.split(',').map((x) => x.trim()).filter(Boolean);
      return labels.length ? { fieldExternalId: externalId, value: labels } : null;
    }
    case FieldType.USER: {
      const first = personIds(cv)[0];
      return first ? { fieldExternalId: externalId, value: first } : null;
    }
    case FieldType.URL: {
      const url = str(v?.url).trim();
      return /^https?:\/\//i.test(url) ? { fieldExternalId: externalId, value: url } : null;
    }
    case FieldType.CHECKBOX:
      return v && (v.checked === 'true' || v.checked === true) ? { fieldExternalId: externalId, value: true } : null;
    default:
      return null;
  }
}

export function toTask(item: MnItem, plan: BoardPlan, tagGroup: boolean): CanonicalTask {
  const values = byId(item.column_values);
  const out: CanonicalTask = { externalId: str(item.id), projectExternalId: plan.id, title: str(item.name), statusExternalId: statusOfItem(item, values, plan) };
  if (item.url) out.url = str(item.url);

  const prio = plan.roles.priority ? firstLabel(values.get(plan.roles.priority)?.text) : '';
  if (prio) out.priority = prio;
  const assignees = plan.roles.assignee ? personIds(values.get(plan.roles.assignee)).slice(0, 20) : [];
  if (assignees.length) out.assigneeExternalIds = assignees;
  if (item.creator?.id !== undefined && item.creator?.id !== null) out.creatorExternalId = str(item.creator.id);
  const created = isoInstant(item.created_at);
  if (created) out.createdAt = created;
  const updated = isoInstant(item.updated_at);
  if (updated) out.updatedAt = updated;
  const start = dateRole(values, plan.roles.start);
  if (start) out.startDate = start;
  const due = dateRole(values, plan.roles.due);
  if (due) out.dueDate = due;

  if (tagGroup && plan.kind !== 'group' && item.group?.title) {
    const g = str(item.group.title).trim();
    if (g) out.tags = [`Group: ${g}`];
  }
  const cvs: CanonicalCustomValue[] = [];
  for (const [key, fid] of Object.entries(plan.cm)) {
    const half = splitTimelineId(key);
    if (half) {
      const d = timelineOf(values.get(half.col))[half.half];
      if (d) cvs.push({ fieldExternalId: fid, value: d });
      continue;
    }
    const cv = values.get(key);
    const v = cv ? customValueOf(cv, fid) : null;
    if (v) cvs.push(v);
  }
  if (cvs.length) out.customValues = cvs.slice(0, 100);
  return out;
}

/**
 * A subitem lives on its own hidden board with its own columns, so it is read by TYPE: its status label finds the parent board's status
 * of the same name (default labels match), the first people column is the assignee, a date or a timeline gives due (and start).
 */
export function toSubitem(sub: MnSubitem, parentId: string, plan: BoardPlan): CanonicalTask {
  const cols = sub.column_values ?? [];
  const status = cols.find((c) => c.type === 'status');
  const people = cols.find((c) => c.type === 'people' || c.type === 'multiple-person');
  const date = cols.find((c) => c.type === 'date');
  const timeline = cols.find((c) => c.type === 'timeline');
  const label = status ? fold(str(status.text)) : '';
  const out: CanonicalTask = {
    externalId: str(sub.id),
    projectExternalId: plan.id,
    title: str(sub.name),
    parentExternalId: parentId,
    statusExternalId: (label && plan.lbl[label]) || fallbackStatus(plan),
  };
  const assignees = people ? personIds(people).slice(0, 20) : [];
  if (assignees.length) out.assigneeExternalIds = assignees;
  if (sub.creator?.id !== undefined && sub.creator?.id !== null) out.creatorExternalId = str(sub.creator.id);
  const created = isoInstant(sub.created_at);
  if (created) out.createdAt = created;
  const updated = isoInstant(sub.updated_at);
  if (updated) out.updatedAt = updated;
  const tl = timeline ? timelineOf(timeline) : {};
  const due = tl.to ?? (date ? dateOf(date) : undefined);
  if (due) out.dueDate = due;
  if (tl.from) out.startDate = tl.from;
  return out;
}

/** `dependency` columns list the items THIS item depends on: blocker -> this item. The other end may be on another page; if it is not part of the import the writer drops the edge. */
export function toDependencies(item: MnItem, plan: BoardPlan): CanonicalDependency[] {
  const values = byId(item.column_values);
  const out = new Map<string, CanonicalDependency>();
  for (const colId of plan.dep) {
    for (const linked of linkedItemIds(values.get(colId)).slice(0, 50)) {
      if (linked === str(item.id)) continue;
      const id = `dep:${linked}>${str(item.id)}`;
      out.set(id, { externalId: id, fromExternalId: linked, toExternalId: str(item.id), type: DependencyType.BLOCKS });
    }
  }
  return [...out.values()];
}

// ------------------------------------------------------------------------------------------------ comments / files

const bodyOf = (r: MnReply): string => (r.body ? htmlToMarkdown(r.body).markdown : '') || str(r.text_body);

function toComment(r: MnReply, parent?: string): CanonicalComment | null {
  const body = bodyOf(r).trim();
  if (!body || r.id === undefined || r.id === null) return null;
  const c: CanonicalComment = { externalId: str(r.id), body };
  const author = r.creator?.id ?? r.creator_id;
  if (author !== undefined && author !== null && str(author) !== '') c.authorExternalId = str(author);
  if (r.creator?.name) c.authorName = str(r.creator.name);
  const at = isoInstant(r.created_at);
  if (at) c.createdAt = at;
  if (parent) c.parentExternalId = parent;
  return c;
}

const byCreated = (a: MnReply, b: MnReply): number => Date.parse(a.created_at ?? '') - Date.parse(b.created_at ?? '') || 0;

/** Updates are the item's comments and their replies one level of replies (monday has no deeper threads): each reply points at its update. */
export function toComments(updates: MnUpdate[]): CanonicalComment[] {
  const out: CanonicalComment[] = [];
  const seen = new Set<string>();
  for (const u of [...updates].sort(byCreated)) {
    const c = toComment(u);
    if (!c || seen.has(c.externalId)) continue;
    seen.add(c.externalId);
    out.push(c);
    for (const r of [...(u.replies ?? [])].sort(byCreated)) {
      const rc = toComment(r, c.externalId);
      if (!rc || seen.has(rc.externalId)) continue;
      seen.add(rc.externalId);
      out.push(rc);
    }
  }
  return out.slice(0, 1000);
}

/** The opaque reference stored on a CanonicalAttachment. NOT an address: a `public_url` is valid for one hour and different every time. */
export const ASSET_REF_PREFIX = 'monday-asset:';
export const assetRef = (id: string | number): string => `${ASSET_REF_PREFIX}${str(id)}`;
export function parseAssetRef(ref: string): string | null {
  if (typeof ref !== 'string' || !ref.startsWith(ASSET_REF_PREFIX)) return null;
  const id = ref.slice(ASSET_REF_PREFIX.length);
  return /^\d{1,30}$/.test(id) ? id : null;
}

const HOST = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

/**
 * Where a `public_url` may point: https, no port or userinfo, never an IP literal, and a monday.com host or an `monday*` S3 bucket. The
 * real storage hosts are NOT documented, so `extra` (MONDAY_FILE_HOSTS: exact host or ".suffix") lets an operator add one after seeing a
 * refusal in the logs. The access token is never sent: a public_url is public by design.
 */
export function isAllowedDownloadUrl(raw: string, extra: readonly string[] = []): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || u.port !== '' || u.username !== '' || u.password !== '') return false;
    const h = u.hostname.toLowerCase();
    if (!HOST.test(h) || /^\d+(\.\d+){3}$/.test(h) || h.includes(':')) return false;
    if (h === 'monday.com' || h.endsWith('.monday.com')) return true;
    if (/^monday[a-z0-9-]*\.s3([.-][a-z0-9-]+)?\.amazonaws\.com$/.test(h) || /^[a-z0-9-]*monday[a-z0-9-]*\.s3([.-][a-z0-9-]+)?\.amazonaws\.com$/.test(h)) return true;
    return extra.some((e) => (e.startsWith('.') ? h.endsWith(e) && h.length > e.length : h === e));
  } catch {
    return false;
  }
}

export function safeFileName(raw: string | null | undefined, ext: string | null | undefined, fallback: string): string {
  const base = (raw ?? '').split(/[\\/]/).pop() ?? '';
  let clean = base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200);
  if (!clean) clean = fallback;
  const e = (ext ?? '').replace(/^\./, '').replace(/[^A-Za-z0-9]/g, '').slice(0, 10);
  return e && !clean.includes('.') ? `${clean}.${e}` : clean;
}

export function toAttachments(taskId: string, assets: MnAsset[]): CanonicalAttachment[] {
  const out: CanonicalAttachment[] = [];
  const seen = new Set<string>();
  for (const a of assets) {
    const id = str(a?.id);
    if (!/^\d{1,30}$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    const ext = `${taskId}:${id}`;
    const e: CanonicalAttachment = { externalId: ext.length <= 190 ? ext : id, fileName: safeFileName(a.name, a.file_extension, `file-${id}`), providerRef: assetRef(id) };
    if (typeof a.file_size === 'number' && Number.isFinite(a.file_size) && a.file_size >= 0) e.sizeBytes = Math.floor(a.file_size);
    const at = isoInstant(a.created_at);
    if (at) e.createdAt = at;
    out.push(e);
  }
  return out.slice(0, 100);
}
