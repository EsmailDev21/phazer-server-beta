import { DependencyType, FieldType, IssueTypeLevel, IterationKind } from '@prisma/client';
import type {
  CanonicalAttachment,
  CanonicalBundle,
  CanonicalComment,
  CanonicalCustomField,
  CanonicalCustomValue,
  CanonicalDependency,
  CanonicalHistoryEntry,
  CanonicalIssueType,
  CanonicalIteration,
  CanonicalProject,
  CanonicalStatus,
  CanonicalTask,
  CanonicalUser,
  SourceStatusCategory,
} from '../../../imports/canonical';
import { CANONICAL_SCHEMA_VERSION } from '../../../imports/canonical';
import { adfToMarkdown } from '../../../imports/canonical/normalize';
import {
  JiraAttachment, JiraComment, JiraFieldDef, JiraHistory, JiraIssue, JiraIssueType, JiraLink, JiraProject, JiraSprint, JiraStatus, JiraUser, JiraVersion,
} from './jira.types';

export const JIRA_SYSTEM = { system: 'jira', displayName: 'Jira' } as const;
export const emptyPage = (): CanonicalBundle => ({ schemaVersion: CANONICAL_SCHEMA_VERSION, source: { ...JIRA_SYSTEM } });

/** Jira writes "2026-01-01T10:00:00.000+0000" (no colon in the offset) and plain "2026-01-01" for due dates. */
export function iso(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;
  const fixed = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00.000Z` : raw.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const t = Date.parse(fixed);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

/** ADF (or, defensively, plain text) -> markdown. */
export function text(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  return adfToMarkdown(value).markdown;
}

// ------------------------------------------------------------------------------------------------ people / structure

export function toUser(u: JiraUser): CanonicalUser | null {
  if (!u?.accountId) return null;
  const out: CanonicalUser = { externalId: u.accountId, name: (u.displayName || u.emailAddress || u.accountId).toString() };
  if (u.emailAddress) out.email = u.emailAddress;
  return out;
}

/** diagram 07: Jira's own status category decides: new -> TODO (BACKLOG by name), indeterminate -> IN_PROGRESS, done -> DONE. */
export function statusCategory(s: JiraStatus): SourceStatusCategory {
  switch ((s.statusCategory?.key ?? '').toLowerCase()) {
    case 'new':
      return /backlog/i.test(s.name) ? 'BACKLOG' : 'TODO';
    case 'indeterminate':
      return 'IN_PROGRESS';
    case 'done':
      return 'DONE';
    default:
      return 'UNKNOWN';
  }
}

/** Jira statuses are site-wide and shared by projects; the id carries the project so two projects never collide. */
export const statusId = (projectId: string, id: string): string => `${projectId}:${id}`;

export function toProject(p: JiraProject, statuses: JiraStatus[], baseUrl?: string): CanonicalProject {
  const seen = new Set<string>();
  const unique = statuses.filter((s) => (s?.id && !seen.has(s.id) ? (seen.add(s.id), true) : false));
  const rank = (s: JiraStatus) => ({ new: 0, indeterminate: 1, done: 2 })[(s.statusCategory?.key ?? '') as 'new'] ?? 3;
  unique.sort((a, b) => rank(a) - rank(b)); // to do -> in progress -> done: the order a board shows them in
  const out: CanonicalProject = {
    externalId: p.id,
    key: p.key,
    name: (p.name ?? '').toString() || p.key,
    statuses: unique.map<CanonicalStatus>((s, i) => ({ externalId: statusId(p.id, s.id), name: s.name, category: statusCategory(s), position: i })),
  };
  if (baseUrl) out.url = `${baseUrl}/browse/${p.key}`;
  if (p.description) out.description = p.description;
  if (p.archived === true) out.archived = true;
  return out;
}

export function toIssueType(t: JiraIssueType): CanonicalIssueType {
  const level = t.subtask ? IssueTypeLevel.SUBTASK : (t.hierarchyLevel ?? 0) >= 1 ? IssueTypeLevel.EPIC : IssueTypeLevel.STANDARD;
  return { externalId: t.id, name: t.name, level };
}

export function toSprint(s: JiraSprint, projectId: string): CanonicalIteration {
  const out: CanonicalIteration = { externalId: `s:${s.id}`, kind: IterationKind.SPRINT, name: (s.name ?? '').toString() || `Sprint ${s.id}`, projectExternalId: projectId };
  if (s.goal) out.goal = s.goal;
  const start = iso(s.startDate);
  if (start) out.startDate = start;
  const end = iso(s.completeDate ?? s.endDate);
  if (end) out.endDate = end;
  return out;
}

/** A release (fix version) is a milestone: a point the work is aimed at. */
export function toVersion(v: JiraVersion, projectId: string): CanonicalIteration {
  const out: CanonicalIteration = { externalId: `v:${v.id}`, kind: IterationKind.MILESTONE, name: (v.name ?? '').toString() || `Version ${v.id}`, projectExternalId: projectId };
  if (v.description) out.goal = v.description;
  const start = iso(v.startDate);
  if (start) out.startDate = start;
  const end = iso(v.releaseDate);
  if (end) out.endDate = end;
  return out;
}

// ------------------------------------------------------------------------------------------------ custom fields

export type FieldKind = 'sprint' | 'points' | 'text' | 'number' | 'date' | 'url' | 'single' | 'multi' | 'user' | 'labels' | 'skip';

const KIND_BY_CUSTOM: Record<string, FieldKind> = {
  'com.pyxis.greenhopper.jira:gh-sprint': 'sprint',
  'com.pyxis.greenhopper.jira:jsw-story-points': 'points',
  'com.atlassian.jira.plugin.system.customfieldtypes:float': 'number',
  'com.atlassian.jira.plugin.system.customfieldtypes:textfield': 'text',
  'com.atlassian.jira.plugin.system.customfieldtypes:textarea': 'text',
  'com.atlassian.jira.plugin.system.customfieldtypes:url': 'url',
  'com.atlassian.jira.plugin.system.customfieldtypes:datepicker': 'date',
  'com.atlassian.jira.plugin.system.customfieldtypes:datetime': 'date',
  'com.atlassian.jira.plugin.system.customfieldtypes:select': 'single',
  'com.atlassian.jira.plugin.system.customfieldtypes:radiobuttons': 'single',
  'com.atlassian.jira.plugin.system.customfieldtypes:cascadingselect': 'single',
  'com.atlassian.jira.plugin.system.customfieldtypes:project': 'single',
  'com.atlassian.jira.plugin.system.customfieldtypes:version': 'single',
  'com.atlassian.jira.plugin.system.customfieldtypes:multiselect': 'multi',
  'com.atlassian.jira.plugin.system.customfieldtypes:multicheckboxes': 'multi',
  'com.atlassian.jira.plugin.system.customfieldtypes:multiversion': 'multi',
  'com.atlassian.jira.plugin.system.customfieldtypes:grouppicker': 'single',
  'com.atlassian.jira.plugin.system.customfieldtypes:userpicker': 'user',
  'com.atlassian.jira.plugin.system.customfieldtypes:multiuserpicker': 'user',
  'com.atlassian.jira.plugin.system.customfieldtypes:labels': 'labels',
};

export function fieldKind(def: JiraFieldDef): FieldKind {
  if (!def.custom) return 'skip';
  const c = def.schema?.custom;
  if (c && c in KIND_BY_CUSTOM) return KIND_BY_CUSTOM[c];
  return 'skip';
}

const DATA_TYPE: Partial<Record<FieldKind, FieldType>> = {
  text: FieldType.TEXT, single: FieldType.TEXT, multi: FieldType.TEXT, number: FieldType.NUMBER, date: FieldType.DATE, url: FieldType.URL, user: FieldType.USER,
};

/** The two time-tracking numbers (hours) every Jira site has on its issues. */
export const TIME_FIELDS = {
  estimate: { externalId: 'jira:timeoriginalestimate', name: 'Original estimate (hours)' },
  spent: { externalId: 'jira:timespent', name: 'Time spent (hours)' },
} as const;

export function toCustomField(def: JiraFieldDef): CanonicalCustomField | null {
  const dataType = DATA_TYPE[fieldKind(def)];
  return dataType ? { externalId: def.id, name: def.name, dataType } : null;
}

const optionText = (o: unknown): string => {
  if (o === null || o === undefined) return '';
  if (typeof o === 'string' || typeof o === 'number') return String(o);
  const x = o as { value?: unknown; name?: unknown; child?: unknown; displayName?: unknown };
  const base = String(x.value ?? x.name ?? x.displayName ?? '');
  return x.child ? `${base} / ${optionText(x.child)}` : base;
};

/** The value of one custom field on one issue as a canonical value, a tag list (labels), or null (unset / not representable). */
export function customValue(def: JiraFieldDef, raw: unknown): { value?: CanonicalCustomValue; tags?: string[] } {
  if (raw === null || raw === undefined || raw === '' || (Array.isArray(raw) && raw.length === 0)) return {};
  const kind = fieldKind(def);
  const id = def.id;
  switch (kind) {
    case 'text': {
      const t = typeof raw === 'object' ? text(raw) : String(raw);
      return t ? { value: { fieldExternalId: id, value: t } } : {};
    }
    case 'url':
      return { value: { fieldExternalId: id, value: String(raw) } };
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(raw);
      return Number.isFinite(n) ? { value: { fieldExternalId: id, value: n } } : {};
    }
    case 'date': {
      const d = iso(raw);
      return d ? { value: { fieldExternalId: id, value: d } } : {};
    }
    case 'single': {
      const t = optionText(raw);
      return t ? { value: { fieldExternalId: id, value: t } } : {};
    }
    case 'multi': {
      const t = (Array.isArray(raw) ? raw : [raw]).map(optionText).filter(Boolean).join(', ');
      return t ? { value: { fieldExternalId: id, value: t } } : {};
    }
    case 'user': {
      const first = Array.isArray(raw) ? raw[0] : raw;
      const acc = (first as { accountId?: string } | null)?.accountId;
      return acc ? { value: { fieldExternalId: id, value: acc } } : {};
    }
    case 'labels': {
      const tags = (Array.isArray(raw) ? raw : [raw]).map(String).filter(Boolean);
      return tags.length ? { tags } : {};
    }
    default:
      return {};
  }
}

// ------------------------------------------------------------------------------------------------ issue

export interface IssueContext {
  projectId: string;
  cloudId: string;
  baseUrl?: string;
  /** Field catalog of the site, by id. */
  fields: ReadonlyMap<string, JiraFieldDef>;
  /** What the person asked to bring along. */
  content: { comments: boolean; history: boolean; attachments: boolean };
  /** Builds an attachment's content address. */
  contentUrl: (attachmentId: string) => string;
  /** Comments / history beyond what the search page carried. */
  extraComments?: ReadonlyMap<string, JiraComment[]>;
  extraHistory?: ReadonlyMap<string, JiraHistory[]>;
  /** key -> id of the SELECTED projects: a link to any other key points outside the import. */
  projectIdByKey: ReadonlyMap<string, string>;
}

export function pickSprint(raw: unknown): string | undefined {
  const list = (Array.isArray(raw) ? raw : []) as JiraSprint[];
  if (list.length === 0) return undefined;
  const active = list.find((s) => (s.state ?? '').toLowerCase() === 'active');
  const chosen = active ?? list[list.length - 1];
  return chosen?.id !== undefined ? `s:${chosen.id}` : undefined;
}

export function toComments(list: JiraComment[]): CanonicalComment[] {
  const out: CanonicalComment[] = [];
  const seen = new Set<string>();
  for (const c of list) {
    if (!c?.id || seen.has(c.id)) continue;
    seen.add(c.id);
    const e: CanonicalComment = { externalId: c.id, body: text(c.body) };
    if (c.author?.accountId) e.authorExternalId = c.author.accountId;
    if (c.author?.displayName) e.authorName = c.author.displayName;
    const created = iso(c.created);
    if (created) e.createdAt = created;
    const updated = iso(c.updated);
    if (updated && updated !== created) e.editedAt = updated;
    out.push(e);
  }
  return out;
}

export function toAttachments(issueId: string, list: JiraAttachment[], contentUrl: (id: string) => string): CanonicalAttachment[] {
  const out: CanonicalAttachment[] = [];
  const seen = new Set<string>();
  for (const a of list) {
    if (!a?.id || seen.has(String(a.id))) continue;
    seen.add(String(a.id));
    const e: CanonicalAttachment = { externalId: `${issueId}:${a.id}`, fileName: ((a.filename ?? '').toString().replace(/[\u0000-\u001f\u007f]/g, '').split(/[\\/]/).pop() || `attachment-${a.id}`).slice(0, 200), providerRef: contentUrl(String(a.id)) };
    if (a.mimeType) e.mimeType = a.mimeType;
    if (typeof a.size === 'number' && a.size >= 0) e.sizeBytes = a.size;
    if (a.author?.accountId) e.uploaderExternalId = a.author.accountId;
    const at = iso(a.created);
    if (at) e.createdAt = at;
    out.push(e);
  }
  return out;
}

/**
 * The ADF converter leaves `[name](attachment:<mediaId>)` for an embedded file; Jira's media id is not an attachment id, but the
 * node's name is the file's name. Where a name matches exactly ONE attachment of the issue, the placeholder becomes that
 * attachment's content address (an image when it is one), which is exactly what the file copy re-points once the file is ours.
 */
export function relinkMedia(markdown: string, attachments: CanonicalAttachment[]): string {
  if (!markdown.includes('attachment:')) return markdown;
  return markdown.replace(/(!?)\[([^\]]*)\]\(attachment:[^)\s]+\)/g, (whole, _bang: string, name: string) => {
    const hits = attachments.filter((a) => a.fileName === name);
    if (hits.length !== 1) return whole;
    const image = (hits[0].mimeType ?? '').startsWith('image/');
    return `${image ? '!' : ''}[${name}](${hits[0].providerRef})`;
  });
}

const escLabel = (t: string): string => t.replace(/[\\[\]]/g, '\\$&').replace(/\s+/g, ' ').trim();

/** Jira's plain "Relates" link: RELATES_TO says all of it. */
const isRelates = (l: JiraLink): boolean => /^relates?( to)?$/i.test(l.type?.name ?? '');

const isBlocks = (l: JiraLink): boolean => /^blocks?$/i.test(l.type?.name ?? '') || /block/i.test(l.type?.outward ?? '');

/**
 * Issue links -> dependencies. A link is listed on BOTH issues with one link id: "Blocks" becomes BLOCKS (the blocker is the issue on
 * the "outward" side), every other type RELATES_TO. One edge per link id, whichever side lists it.
 */
export type InSelection = (issue: { id: string; key?: string }) => boolean;

export const inSelectionOf = (byKey: ReadonlyMap<string, string>): InSelection => (o) => !!o.key && byKey.has(o.key.replace(/-\d+$/, ''));

export function toDependencies(i: JiraIssue, inSel: InSelection): CanonicalDependency[] {
  const out: CanonicalDependency[] = [];
  const seen = new Set<string>();
  for (const l of i.fields.issuelinks ?? []) {
    const other = l.outwardIssue ?? l.inwardIssue;
    if (!l?.id || !other?.id || seen.has(l.id) || other.id === i.id) continue;
    if (!inSel(other)) continue; // the other end is not imported: kept as text (linksFooter)
    seen.add(l.id);
    const iBlocks = !!l.outwardIssue;
    if (isBlocks(l)) {
      out.push({ externalId: `l:${l.id}`, fromExternalId: iBlocks ? i.id : other.id, toExternalId: iBlocks ? other.id : i.id, type: DependencyType.BLOCKS });
    } else {
      const [a, b] = [i.id, other.id].sort();
      out.push({ externalId: `l:${l.id}`, fromExternalId: a, toExternalId: b, type: DependencyType.RELATES_TO });
    }
  }
  return out;
}

/** What a dependency cannot say: the kind of every non-"blocks" link, and every link to an issue that is not imported. */
export function linksFooter(i: JiraIssue, inSel: InSelection): string | null {
  const lines: string[] = [];
  for (const l of i.fields.issuelinks ?? []) {
    const other = l.outwardIssue ?? l.inwardIssue;
    if (!l?.id || !other?.id) continue;
    const outside = !inSel(other);
    if ((isBlocks(l) || isRelates(l)) && !outside) continue; // BLOCKS / RELATES_TO say it all; every other kind (duplicates, clones, custom) keeps its name as text
    const phrase = (l.outwardIssue ? l.type?.outward : l.type?.inward) || l.type?.name || 'is linked to';
    const title = other.fields?.summary ? ` - ${escLabel(other.fields.summary)}` : '';
    lines.push(`- ${escLabel(phrase)} ${escLabel(other.key ?? other.id)}${title}${outside ? ' (not imported)' : ''}`);
  }
  return lines.length ? `---\n\n**Links in Jira**\n\n${[...new Set(lines)].join('\n')}` : null;
}

/** One history entry per changed field of every changelog record; Jira's own field name is the field. */
export function toHistory(histories: JiraHistory[]): CanonicalHistoryEntry[] {
  const out: CanonicalHistoryEntry[] = [];
  const sorted = [...histories].sort((a, b) => (iso(a.created) ?? '').localeCompare(iso(b.created) ?? ''));
  for (const h of sorted) {
    const at = iso(h.created);
    if (!h?.id || !at) continue;
    (h.items ?? []).forEach((it, n) => {
      if (!it?.field) return;
      const e: CanonicalHistoryEntry = { externalId: `${h.id}:${n}:${it.fieldId ?? it.field}`.slice(0, 200), at, field: it.field.toLowerCase().slice(0, 60) };
      if (h.author?.accountId) e.actorExternalId = h.author.accountId;
      // `toString` is also an Object method: only an OWN string value counts (an item without it would otherwise yield the function)
      const own = (k: 'fromString' | 'toString'): string | undefined => (Object.prototype.hasOwnProperty.call(it, k) && typeof it[k] === 'string' ? (it[k] as string) : undefined);
      const from = own('fromString');
      const to = own('toString');
      if (from !== undefined) e.from = from;
      if (to !== undefined) e.to = to;
      out.push(e);
    });
  }
  return out;
}

const HOURS = (seconds: number): number => Math.round((seconds / 3600) * 100) / 100;

export function toTask(i: JiraIssue, cx: IssueContext): { task: CanonicalTask; customFields: CanonicalCustomField[] } {
  const f = i.fields;
  const task: CanonicalTask = { externalId: i.id, key: i.key, projectExternalId: cx.projectId, title: (f.summary ?? '').toString() };
  if (cx.baseUrl) task.url = `${cx.baseUrl}/browse/${i.key}`;

  const attachments = cx.content.attachments ? toAttachments(i.id, f.attachment ?? [], cx.contentUrl) : [];
  let description = relinkMedia(text(f.description), attachments);
  const env = text(f.environment);
  if (env) description = `${description}${description ? '\n\n' : ''}**Environment**\n\n${env}`;
  const links = linksFooter(i, inSelectionOf(cx.projectIdByKey));
  if (links) description = `${description}${description ? '\n\n' : ''}${links}`;
  if (description) task.description = description;

  if (f.status?.id) task.statusExternalId = statusId(cx.projectId, f.status.id);
  if (f.priority?.name) task.priority = f.priority.name;
  if (f.issuetype?.id) task.issueTypeExternalId = f.issuetype.id;
  if (f.parent?.id) task.parentExternalId = f.parent.id;
  if (f.assignee?.accountId) task.assigneeExternalIds = [f.assignee.accountId];
  const reporter = f.reporter?.accountId ?? f.creator?.accountId;
  if (reporter) task.creatorExternalId = reporter;
  const created = iso(f.created);
  if (created) task.createdAt = created;
  const updated = iso(f.updated);
  if (updated) task.updatedAt = updated;
  const due = iso(f.duedate);
  if (due) task.dueDate = due;

  const tags = new Set<string>([...(f.labels ?? []), ...(f.components ?? []).map((c) => c?.name ?? '')].filter(Boolean));
  const versions = (f.fixVersions ?? []).filter((v) => v?.id);

  const used: CanonicalCustomField[] = [];
  const values: CanonicalCustomValue[] = [];
  let sprint: string | undefined;
  for (const [id, def] of cx.fields) {
    const raw = f[id];
    const kind = fieldKind(def);
    if (kind === 'sprint') sprint = pickSprint(raw);
    else if (kind === 'points') {
      if (typeof raw === 'number' && raw >= 0 && raw <= 1000) task.estimate = raw;
    } else {
      const r = customValue(def, raw);
      if (r.tags) r.tags.forEach((t) => tags.add(t));
      if (r.value) {
        values.push(r.value);
        const decl = toCustomField(def);
        if (decl) used.push(decl);
      }
    }
  }
  if (typeof f.timeoriginalestimate === 'number') {
    values.push({ fieldExternalId: TIME_FIELDS.estimate.externalId, value: HOURS(f.timeoriginalestimate) });
    used.push({ externalId: TIME_FIELDS.estimate.externalId, name: TIME_FIELDS.estimate.name, dataType: FieldType.NUMBER });
  }
  if (typeof f.timespent === 'number') {
    values.push({ fieldExternalId: TIME_FIELDS.spent.externalId, value: HOURS(f.timespent) });
    used.push({ externalId: TIME_FIELDS.spent.externalId, name: TIME_FIELDS.spent.name, dataType: FieldType.NUMBER });
  }
  // a task has ONE iteration: its sprint; else its first release. The other releases stay visible as tags.
  if (sprint) {
    task.iterationExternalId = sprint;
    versions.forEach((v) => tags.add(`version: ${v.name}`));
  } else if (versions.length) {
    task.iterationExternalId = `v:${versions[0].id}`;
    versions.slice(1).forEach((v) => tags.add(`version: ${v.name}`));
  }
  if (tags.size) task.tags = [...tags];
  if (values.length) task.customValues = values;

  if (cx.content.comments) {
    const all = [...(f.comment?.comments ?? []), ...(cx.extraComments?.get(i.id) ?? [])];
    const c = toComments(all).map((x) => ({ ...x, body: relinkMedia(x.body, attachments) })); // files embedded in a comment, like those in the description
    if (c.length) task.comments = c;
  }
  if (attachments.length) task.attachments = attachments;
  if (cx.content.history) {
    const h = toHistory([...(i.changelog?.histories ?? []), ...(cx.extraHistory?.get(i.id) ?? [])]);
    if (h.length) task.history = h;
  }
  return { task, customFields: used };
}

