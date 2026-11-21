import { DependencyType, FieldType, IterationKind } from '@prisma/client';
import { createHash } from 'node:crypto';
import type {
  CanonicalAttachment,
  CanonicalBundle,
  CanonicalComment,
  CanonicalHistoryEntry,
  CanonicalCustomField,
  CanonicalDependency,
  CanonicalIteration,
  CanonicalProject,
  CanonicalStatus,
  CanonicalTag,
  CanonicalTask,
  CanonicalUser,
  SourceStatusCategory,
} from '../../../imports/canonical';
import {
  LinearComment,
  LinearCycle,
  LinearHistoryNode,
  LinearIssue,
  LinearLabel,
  LinearLinkAttachment,
  LinearOrganization,
  LinearState,
  LinearTeam,
  LinearUser,
} from './linear.types';

/**
 * Step 4.5. Linear's data -> CanonicalBundle vocabulary. PURE: no I/O, no clock. Nothing here repairs or limits anything: the
 * executor runs every page through validateBundle, which is the gate (repair > skip > fatal). These functions only translate.
 */

export const LINEAR_SYSTEM = { system: 'linear', displayName: 'Linear' } as const;

/** The one custom field the adapter defines: which Linear PROJECT (the grouping inside a team) an issue belonged to. */
export const PROJECT_FIELD_ID = 'linear-project';
export const PROJECT_FIELD_NAME = 'Linear project';
/** The Blueprint / canonical option ceiling (100). Over it, the field is left out rather than cut at random. */
export const MAX_PROJECT_OPTIONS = 100;

/** Linear workflow-state types (documented: triage, backlog, unstarted, started, completed, canceled). */
export function stateCategory(type: string): SourceStatusCategory {
  switch (String(type).toLowerCase()) {
    case 'triage':
    case 'backlog':
      return 'BACKLOG';
    case 'unstarted':
      return 'TODO';
    case 'started':
      return 'IN_PROGRESS';
    case 'completed':
      return 'DONE';
    case 'canceled':
      return 'CANCELED';
    default:
      return 'UNKNOWN';
  }
}

/** A Linear state id is only meaningful inside its team: the composed id is globally unique and stable. */
export const statusExternalId = (teamId: string, stateId: string): string => `${teamId}:${stateId}`;

export function toUser(u: LinearUser): CanonicalUser {
  const out: CanonicalUser = { externalId: u.id, name: (u.name || u.displayName || u.email || u.id).toString() };
  if (u.email) out.email = u.email;
  if (u.avatarUrl) out.avatarUrl = u.avatarUrl;
  if (u.app === true) out.isBot = true;
  return out;
}

export function toStatus(teamId: string, s: LinearState): CanonicalStatus {
  const out: CanonicalStatus = { externalId: statusExternalId(teamId, s.id), name: s.name, category: stateCategory(s.type) };
  if (s.color) out.color = s.color;
  if (typeof s.position === 'number' && Number.isFinite(s.position)) out.position = s.position;
  return out;
}

export function toProject(org: LinearOrganization, team: LinearTeam, states: LinearState[]): CanonicalProject {
  const out: CanonicalProject = {
    externalId: team.id,
    key: team.key,
    name: team.name,
    url: `https://linear.app/${encodeURIComponent(org.urlKey)}/team/${encodeURIComponent(team.key)}/all`,
    statuses: states.map((s) => toStatus(team.id, s)),
  };
  if (team.description) out.description = team.description;
  return out;
}

export function toIteration(teamId: string, c: LinearCycle): CanonicalIteration {
  const out: CanonicalIteration = {
    externalId: c.id,
    kind: IterationKind.CYCLE,
    name: (c.name && c.name.trim()) || `Cycle ${c.number ?? ''}`.trim(),
    projectExternalId: teamId,
  };
  if (c.description) out.goal = c.description;
  if (c.startsAt) out.startDate = c.startsAt;
  if (c.endsAt) out.endDate = c.endsAt;
  return out;
}

export function toTag(l: LinearLabel): CanonicalTag {
  const out: CanonicalTag = { name: l.name };
  if (l.color) out.color = l.color;
  return out;
}

/** Distinct project names of a team set, folded the way option labels are compared (case-insensitive, trimmed). */
export function projectOptionLabels(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of names) {
    const label = (n ?? '').trim();
    const key = label.toLowerCase();
    if (!label || seen.has(key)) continue;
    seen.add(key);
    out.push(label);
  }
  return out;
}

/** `null` when the field would exceed the option ceiling (the caller reports that) or there is nothing to choose from. */
export function projectField(names: string[]): CanonicalCustomField | null {
  const labels = projectOptionLabels(names);
  if (labels.length === 0 || labels.length > MAX_PROJECT_OPTIONS) return null;
  return { externalId: PROJECT_FIELD_ID, name: PROJECT_FIELD_NAME, dataType: FieldType.SELECT, options: labels.map((label) => ({ label })) };
}

export interface IssueContext {
  teamId: string;
  /** Include the Linear-project custom value (false when the field was left out). */
  withProjectField: boolean;
  /** Team ids that are part of this import: a relation to an issue outside them is dropped (its partner would never arrive). */
  selectedTeamIds: ReadonlySet<string>;
  /** Labels / relations fetched beyond the first NESTED_FIRST, by issue id. */
  extraLabels?: ReadonlyMap<string, string[]>;
  extraRelations?: ReadonlyMap<string, NonNullable<NonNullable<LinearIssue['relations']>['nodes']>>;
  /** Step 4.6: which content the person asked for (the query only fetched what it needs; this keeps the mapping honest too). */
  content?: { comments: boolean; history: boolean; attachments: boolean };
  /** Comments / history / link attachments beyond the first page of one issue, by issue id. */
  extraComments?: ReadonlyMap<string, LinearComment[]>;
  extraHistory?: ReadonlyMap<string, LinearHistoryNode[]>;
  extraLinks?: ReadonlyMap<string, LinearLinkAttachment[]>;
}

export function toTask(i: LinearIssue, cx: IssueContext): CanonicalTask {
  const t: CanonicalTask = { externalId: i.id, projectExternalId: cx.teamId, title: i.title };
  if (i.identifier) t.key = i.identifier;
  if (i.url) t.url = i.url;
  if (i.description) t.description = i.description;
  if (i.state?.id) t.statusExternalId = statusExternalId(cx.teamId, i.state.id);
  const prio = priorityText(i);
  if (prio) t.priority = prio;
  if (i.parent?.id) t.parentExternalId = i.parent.id;
  if (i.cycle?.id) t.iterationExternalId = i.cycle.id;
  if (i.assignee?.id) t.assigneeExternalIds = [i.assignee.id];
  if (i.creator?.id) t.creatorExternalId = i.creator.id;
  if (i.createdAt) t.createdAt = i.createdAt;
  if (i.updatedAt) t.updatedAt = i.updatedAt;
  if (i.dueDate) t.dueDate = i.dueDate;
  if (typeof i.estimate === 'number') t.estimate = i.estimate;
  if (i.archivedAt) t.archived = true;

  const labels = [...(i.labels?.nodes ?? []).map((l) => l.name), ...(cx.extraLabels?.get(i.id) ?? [])].filter((n) => typeof n === 'string' && n);
  if (labels.length) t.tags = [...new Set(labels)];

  const relations = relationsFooter(i, cx);
  if (relations) t.description = `${t.description ?? ''}${t.description ? '\n\n' : ''}${relations}`;

  const wants = cx.content;
  const comments = wants?.comments ? [...(i.comments?.nodes ?? []), ...(cx.extraComments?.get(i.id) ?? [])] : [];
  if (comments.length) t.comments = toComments(comments);
  const history = wants?.history ? [...(i.history?.nodes ?? []), ...(cx.extraHistory?.get(i.id) ?? [])] : [];
  if (history.length) {
    const h = toHistory(history);
    if (h.length) t.history = h;
  }
  if (wants?.attachments) {
    const links = [...(i.attachments?.nodes ?? []), ...(cx.extraLinks?.get(i.id) ?? [])];
    const footer = linksFooter(links);
    if (footer) t.description = `${t.description ?? ''}${t.description ? '\n\n' : ''}${footer}`;
    const files = fileAttachments(i, comments);
    if (files.length) t.attachments = files;
  }
  if (cx.withProjectField && i.project?.name) t.customValues = [{ fieldExternalId: PROJECT_FIELD_ID, value: i.project.name.trim() }];
  return t;
}

/** Linear priority is 0 (none) .. 4 (low). The label ("Urgent") is what the person sees in Linear, so that is the raw value; 0 = no value. */
export function priorityText(i: Pick<LinearIssue, 'priority' | 'priorityLabel'>): string | undefined {
  const p = i.priority;
  if (typeof p !== 'number' || p < 1 || p > 4) return undefined;
  return i.priorityLabel?.trim() || (['', 'Urgent', 'High', 'Medium', 'Low'][p] as string);
}

const RELATION_DEPENDENCY: Record<string, DependencyType> = {
  blocks: DependencyType.BLOCKS,
  related: DependencyType.RELATES_TO,
  similar: DependencyType.RELATES_TO,
  duplicate: DependencyType.RELATES_TO, // we have no "duplicate" type: the link is kept, the meaning goes into the description (relationsFooter)
};

/**
 * Linear relations -> dependencies: `blocks` -> BLOCKS, `related` / `similar` / `duplicate` -> RELATES_TO. A relation to an issue of a
 * team that is not part of this import cannot be a dependency: relationsFooter keeps it as text instead.
 */
export function toDependencies(i: LinearIssue, cx: IssueContext): CanonicalDependency[] {
  const rels = [...(i.relations?.nodes ?? []), ...(cx.extraRelations?.get(i.id) ?? [])];
  const seen = new Set<string>();
  const out: CanonicalDependency[] = [];
  for (const r of rels) {
    const type = RELATION_DEPENDENCY[String(r?.type).toLowerCase()];
    if (!r || !type || !r.id || seen.has(r.id)) continue;
    const other = r.relatedIssue;
    if (!other?.id) continue;
    if (other.team?.id && !cx.selectedTeamIds.has(other.team.id)) continue;
    seen.add(r.id);
    // `relations` lists relations this issue is the SOURCE of: "this issue blocks `relatedIssue`".
    out.push({ externalId: r.id, fromExternalId: i.id, toExternalId: other.id, type });
  }
  return out;
}

const RELATION_WORDS: Record<string, string> = { blocks: 'Blocks', related: 'Related to', similar: 'Similar to', duplicate: 'Marked as a duplicate of' };

/**
 * The relations a dependency cannot carry, kept as readable text at the end of the description: every `duplicate` (the meaning is
 * lost in RELATES_TO) and every relation to an issue of a team that is not imported (nothing to link to). Nothing is dropped
 * silently. Relations where ANOTHER issue is the source (Linear's inverse side) are not visible from here: when that issue is
 * imported they arrive as a dependency from its side; when it is not, they are not known.
 */
export function relationsFooter(i: LinearIssue, cx: Pick<IssueContext, 'selectedTeamIds' | 'extraRelations'>): string | null {
  const rels = [...(i.relations?.nodes ?? []), ...(cx.extraRelations?.get(i.id) ?? [])];
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const r of rels) {
    const kind = String(r?.type).toLowerCase();
    const other = r?.relatedIssue;
    if (!r?.id || !other?.id || !(kind in RELATION_WORDS) || seen.has(r.id)) continue;
    const outside = !!other.team?.id && !cx.selectedTeamIds.has(other.team.id);
    if (kind !== 'duplicate' && !outside) continue;
    seen.add(r.id);
    const name = escLabel(other.identifier || other.id);
    const title = other.title ? ` - ${escLabel(other.title)}` : '';
    lines.push(`- ${RELATION_WORDS[kind]} ${name}${title}${outside ? ' (not imported)' : ''}`);
  }
  return lines.length ? `---\n\n**Relations in Linear**\n\n${lines.join('\n')}` : null;
}

export function emptyPage(): CanonicalBundle {
  return { schemaVersion: 1, source: { ...LINEAR_SYSTEM } };
}

// ================================================================================================ step 4.6

export function toComments(list: LinearComment[]): CanonicalComment[] {
  const out: CanonicalComment[] = [];
  const seen = new Set<string>();
  for (const c of list) {
    if (!c?.id || seen.has(c.id)) continue;
    seen.add(c.id);
    const e: CanonicalComment = { externalId: c.id, body: (c.body ?? '').toString() };
    if (c.user?.id) e.authorExternalId = c.user.id;
    const name = c.user?.name || c.botActor?.name || c.externalUser?.name;
    if (name) e.authorName = name;
    if (c.createdAt) e.createdAt = c.createdAt;
    if (c.editedAt) e.editedAt = c.editedAt;
    if (c.parent?.id) e.parentExternalId = c.parent.id;
    out.push(e);
  }
  return out;
}

const PRIORITY_NAME = ['No priority', 'Urgent', 'High', 'Medium', 'Low'];

/**
 * One Linear history record can hold several changes (state AND assignee in one edit). Each becomes one generic field diff,
 * its external id "<recordId>:<field>". A side is a plain display string; an unchanged pair (both sides null) is no entry.
 * A record without a timestamp cannot be placed in time and is skipped.
 */
export function toHistory(nodes: LinearHistoryNode[]): CanonicalHistoryEntry[] {
  const out: CanonicalHistoryEntry[] = [];
  for (const n of nodes) {
    if (!n?.id || !n.createdAt) continue;
    const push = (field: string, from: string | null | undefined, to: string | null | undefined): void => {
      if ((from === null || from === undefined) && (to === null || to === undefined)) return;
      const e: CanonicalHistoryEntry = { externalId: `${n.id}:${field}`, at: n.createdAt as string, field };
      if (n.actor?.id) e.actorExternalId = n.actor.id;
      if (from !== undefined) e.from = from;
      if (to !== undefined) e.to = to;
      out.push(e);
    };
    const name = (o: { name?: string | null } | null | undefined) => (o ? (o.name ?? null) : null);
    const prio = (p: number | null | undefined) => (typeof p === 'number' ? (PRIORITY_NAME[p] ?? String(p)) : null);
    const num = (p: number | null | undefined) => (typeof p === 'number' ? String(p) : null);
    const cycle = (c: { name?: string | null; number?: number | null } | null | undefined) => (c ? (c.name || (c.number !== undefined && c.number !== null ? `Cycle ${c.number}` : null)) : null);
    push('status', name(n.fromState), name(n.toState));
    push('assignee', name(n.fromAssignee), name(n.toAssignee));
    push('priority', prio(n.fromPriority), prio(n.toPriority));
    push('estimate', num(n.fromEstimate), num(n.toEstimate));
    push('cycle', cycle(n.fromCycle), cycle(n.toCycle));
    push('project', name(n.fromProject), name(n.toProject));
    push('parent', n.fromParent?.identifier ?? null, n.toParent?.identifier ?? null);
    push('title', n.fromTitle ?? null, n.toTitle ?? null);
    push('due date', n.fromDueDate ?? null, n.toDueDate ?? null);
    const added = (n.addedLabels ?? []).map((l) => l?.name).filter((x): x is string => !!x);
    const removed = (n.removedLabels ?? []).map((l) => l?.name).filter((x): x is string => !!x);
    if (added.length) push('label added', null, added.join(', '));
    if (removed.length) push('label removed', removed.join(', '), null);
    if (n.archived === true) push('archived', 'no', 'yes');
    if (n.archived === false) push('archived', 'yes', 'no');
    if (n.updatedDescription === true) push('description', undefined, 'edited');
  }
  return out;
}

// ---- files

/** The ONLY host the adapter will ever fetch a file from, and the only one it puts in a providerRef (SSRF guard, see fetchAttachment). */
export const LINEAR_FILE_HOST = 'uploads.linear.app';

export function isLinearFileUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && u.hostname === LINEAR_FILE_HOST && u.port === '' && u.username === '' && u.password === '';
  } catch {
    return false;
  }
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', zip: 'application/zip',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mp3: 'audio/mpeg',
};

const MD_FILE = /(!?)\[([^\]]*)\]\((https:\/\/uploads\.linear\.app\/[^\s)]+)(?:\s+"[^"]*")?\)/g;
const BARE_FILE = /https:\/\/uploads\.linear\.app\/[^\s)\]>"'<]+/g;

/** The file uploads referenced by a piece of Linear markdown: [{url, name?}], in order of appearance, one per URL. */
export function uploadsIn(markdown: string | null | undefined): Array<{ url: string; name?: string }> {
  const text = markdown ?? '';
  const found = new Map<string, { url: string; name?: string }>();
  for (const m of text.matchAll(MD_FILE)) {
    const url = m[3];
    if (!isLinearFileUrl(url) || found.has(url)) continue;
    const label = m[2].trim();
    found.set(url, label ? { url, name: label } : { url });
  }
  for (const m of text.matchAll(BARE_FILE)) {
    const url = m[0].replace(/[.,;:!?]+$/, '');
    if (isLinearFileUrl(url) && !found.has(url)) found.set(url, { url });
  }
  return [...found.values()];
}

/** A file name safe to show and store: no path, no control characters, bounded; the extension is kept. */
export function safeFileName(raw: string | undefined, fallback: string): string {
  const base = (raw ?? '').split(/[\\/]/).pop() ?? '';
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200);
  return clean || fallback;
}

/**
 * The files an issue holds, taken from its description and its comments (Linear stores uploads as links in the markdown;
 * its own "attachments" are links to other systems and are handled by linksFooter). Every providerRef is a Linear file URL:
 * the only kind fetchAttachment will open. The external id is per ISSUE (the same upload pasted in two issues is two
 * attachments; identical bytes are deduplicated by storage, not here).
 */
export function fileAttachments(i: Pick<LinearIssue, 'id' | 'createdAt'>, comments: LinearComment[]): CanonicalAttachment[] {
  const sources: Array<{ md: string | null | undefined; at?: string | null; who?: string }> = [
    { md: (i as LinearIssue).description, at: i.createdAt },
    ...comments.map((c) => ({ md: c.body, at: c.createdAt, who: c.user?.id })),
  ];
  const out: CanonicalAttachment[] = [];
  const seen = new Set<string>();
  for (const src of sources) {
    for (const f of uploadsIn(src.md)) {
      if (seen.has(f.url)) continue;
      seen.add(f.url);
      const lastSegment = decodeURIComponent(new URL(f.url).pathname.split('/').pop() ?? '');
      const fileName = safeFileName(f.name, safeFileName(lastSegment, 'file'));
      const ext = (/\.([a-z0-9]{1,5})$/i.exec(fileName)?.[1] ?? '').toLowerCase();
      const a: CanonicalAttachment = {
        externalId: `${i.id}:${createHash('sha1').update(f.url).digest('hex').slice(0, 20)}`,
        fileName,
        providerRef: f.url,
      };
      if (MIME_BY_EXT[ext]) a.mimeType = MIME_BY_EXT[ext];
      if (src.who) a.uploaderExternalId = src.who;
      if (src.at) a.createdAt = src.at;
      out.push(a);
    }
  }
  return out;
}

const escLabel = (t: string): string => t.replace(/[\\\[\]]/g, '\\$&').replace(/\s+/g, ' ').trim();

/**
 * Linear's own attachments are LINKS (a pull request, a Slack thread, a Figma file): there is no file to copy, and our task has
 * no generic link slot (ExternalLink is typed PR / ISSUE / ... and owned by the webhook adapters). They are kept, readable, as a
 * short list at the end of the description. Only http(s) addresses are kept.
 */
export function linksFooter(links: LinearLinkAttachment[]): string | null {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const l of links) {
    const url = (l?.url ?? '').trim();
    if (!/^https?:\/\//i.test(url) || seen.has(url) || /[\s<>]/.test(url)) continue;
    seen.add(url);
    const title = escLabel(l.title || url);
    const sub = l.subtitle ? ` - ${escLabel(l.subtitle)}` : '';
    lines.push(`- [${title}](${url})${sub}`);
  }
  return lines.length ? `---\n\n**Linked in Linear**\n\n${lines.join('\n')}` : null;
}
