import { TaskStatus } from '@prisma/client';
import { foldName } from '../../templates/blueprint/blueprint.names';
import { suggest } from './mapping.suggest';
import { CATEGORY_COLOR, priorityKey } from './mapping.tables';
import {
  AttentionItem,
  MappingConfigV1,
  MappingContext,
  MappingInventory,
  MappingSuggestions,
  ResolvedMapping,
  ResolvedStatus,
} from './mapping.types';

/**
 * Step 4.3. Suggestions + the person's overrides = what the import will actually do. PURE.
 *
 * Tolerant by design: a row that points at something no longer in the job (the selection changed after the mapping was
 * saved) is IGNORED and reported as attention, never an exception: the strict check happens when the config is SAVED
 * (checkConfig), not every time it is used.
 */
export interface Resolution {
  resolved: ResolvedMapping;
  suggestions: MappingSuggestions;
  attention: AttentionItem[];
}

export function resolve(inventory: MappingInventory, ctx: MappingContext, config: MappingConfigV1): Resolution {
  const matchByEmail = config.matchByEmail !== false;
  const suggestions = suggest(inventory, ctx, { matchByEmail });
  const attention: AttentionItem[] = [];
  const ignore = (key: string, what: string) =>
    attention.push({ kind: 'CONFIG', key, code: 'CONFIG_ROW_IGNORED', message: `A saved choice for ${what} no longer applies to this import and was ignored` });

  // ---- projects
  const projects = new Map(inventory.projects.map((p) => [p.externalId, { name: p.name }]));
  for (const row of config.projects ?? []) {
    if (!projects.has(row.externalId)) { ignore(row.externalId, `project "${row.externalId}"`); continue; }
    projects.set(row.externalId, { name: row.name });
  }

  // ---- statuses: suggestion, override, then merges (roots first, so a merged status takes its root's final values)
  const sugByStatus = new Map(suggestions.statuses.map((s) => [s.statusExternalId, s]));
  const rows = new Map((config.statuses ?? []).map((r) => [r.statusExternalId, r]));
  const statusMeta = new Map<string, { projectExternalId: string; index: number; color?: string; position?: number }>();
  for (const p of inventory.projects) p.statuses.forEach((s, index) => statusMeta.set(s.externalId, { projectExternalId: p.externalId, index, color: s.color, position: s.position }));
  for (const key of rows.keys()) if (!statusMeta.has(key)) ignore(key, `status "${key}"`);

  const validMergeTarget = (from: string, to: string | undefined): string | undefined => {
    if (to === undefined || to === from) return undefined;
    const a = statusMeta.get(from);
    const b = statusMeta.get(to);
    if (!a || !b || a.projectExternalId !== b.projectExternalId) return undefined;
    if (rows.get(to)?.mergeInto !== undefined) return undefined; // chains are refused: merge into the final one
    return to;
  };

  const own = new Map<string, ResolvedStatus>();
  for (const sug of suggestions.statuses) {
    const row = rows.get(sug.statusExternalId);
    const meta = statusMeta.get(sug.statusExternalId)!;
    const category = row?.category ?? sug.category;
    own.set(sug.statusExternalId, {
      projectExternalId: sug.projectExternalId,
      statusExternalId: sug.statusExternalId,
      rootExternalId: sug.statusExternalId,
      name: row?.name ?? sug.name,
      category,
      // "excluded from progress" only means something on DONE; moving a status off DONE clears it
      excludeFromProgress: category === TaskStatus.DONE ? (row?.excludeFromProgress ?? sug.excludeFromProgress) : false,
      color: meta.color ?? CATEGORY_COLOR[category],
      position: meta.position ?? meta.index,
      overridden: row !== undefined,
    });
  }
  const statuses = new Map<string, ResolvedStatus>();
  for (const [id, st] of own) {
    const row = rows.get(id);
    const target = validMergeTarget(id, row?.mergeInto);
    if (row?.mergeInto !== undefined && target === undefined) ignore(id, `the merge of status "${id}"`);
    if (target) {
      const root = own.get(target)!;
      statuses.set(id, { ...root, statusExternalId: id, rootExternalId: target, overridden: true });
    } else {
      statuses.set(id, st);
    }
  }
  for (const sug of suggestions.statuses) {
    const final = statuses.get(sug.statusExternalId)!;
    if (final.overridden) continue;
    if (sug.reason === 'NAME_BLOCKED') attention.push({ kind: 'STATUS', key: sug.statusExternalId, code: 'STATUS_BLOCKED_GUESS', message: `"${sug.name}" looks like a Blocked status (guessed from its name); confirm or change it` });
    else if (sug.reason === 'DEFAULT') attention.push({ kind: 'STATUS', key: sug.statusExternalId, code: 'STATUS_DEFAULTED', message: `"${sug.name}" has no category in the source; it was treated as To do` });
  }

  // ---- priorities (keys normalised: "High (2)" and "high" are one row)
  const priorities = new Map<string, import('@prisma/client').Priority | null>();
  for (const s of suggestions.priorities) priorities.set(priorityKey(s.raw), s.priority);
  const prioRows = new Set<string>();
  for (const row of config.priorities ?? []) {
    const k = priorityKey(row.raw);
    prioRows.add(k);
    priorities.set(k, row.priority);
  }
  for (const s of suggestions.priorities) {
    if (s.reason === 'NONE' && !prioRows.has(priorityKey(s.raw))) {
      attention.push({ kind: 'PRIORITY', key: s.raw, code: 'PRIORITY_UNMATCHED', message: `Priority "${s.raw}" is not recognised; its tasks get no priority unless you choose one` });
    }
  }

  // ---- people
  const memberIds = new Set(ctx.members.map((m) => m.userId));
  const users = new Map(suggestions.users.map((u) => [u.externalId, { target: u.target, name: u.name, isBot: inventory.users.find((x) => x.externalId === u.externalId)?.isBot === true, decided: false }]));
  for (const row of config.users ?? []) {
    const cur = users.get(row.externalId);
    if (!cur) { ignore(row.externalId, `person "${row.externalId}"`); continue; }
    if (row.target.kind === 'user' && !memberIds.has(row.target.userId)) { ignore(row.externalId, `person "${cur.name}" (no longer a member)`); continue; }
    users.set(row.externalId, { ...cur, target: row.target, decided: true });
  }
  const unmapped = [...users.values()].filter((u) => u.target.kind === 'importer' && !u.isBot && !u.decided);
  if (unmapped.length > 0) {
    attention.push({ kind: 'USER', key: 'users', code: 'USERS_UNMAPPED', message: `${unmapped.length} ${unmapped.length === 1 ? 'person' : 'people'} could not be matched to a workspace member: their tasks stay unassigned and their comments are credited to you` });
  }

  // ---- issue types
  const issueTypes = new Map(suggestions.issueTypes.map((t) => [t.externalId, { target: t.target, level: t.level, name: t.name }]));
  for (const row of config.issueTypes ?? []) {
    const cur = issueTypes.get(row.externalId);
    if (!cur) { ignore(row.externalId, `issue type "${row.externalId}"`); continue; }
    issueTypes.set(row.externalId, { ...cur, target: row.target, level: row.target.kind === 'create' ? (row.level ?? cur.level) : cur.level });
  }

  // ---- custom fields
  const customFields = new Map(suggestions.customFields.map((f) => [f.externalId, { target: f.target, name: f.target.kind === 'create' ? f.createName : f.name, dataType: f.dataType }]));
  const overriddenFields = new Set<string>();
  for (const row of config.customFields ?? []) {
    const cur = customFields.get(row.externalId);
    if (!cur) { ignore(row.externalId, `custom field "${row.externalId}"`); continue; }
    customFields.set(row.externalId, { ...cur, target: row.target, name: row.target.kind === 'create' ? (row.name ?? cur.name) : cur.name });
    overriddenFields.add(row.externalId);
  }
  for (const f of suggestions.customFields) {
    if (f.reason === 'NAME_CONFLICT' && !overriddenFields.has(f.externalId)) {
      attention.push({ kind: 'CUSTOM_FIELD', key: f.externalId, code: 'CUSTOM_FIELD_NAME_CONFLICT', message: `"${f.name}" already exists here with a different type; a new field "${f.createName}" will be created` });
    }
  }

  return {
    resolved: { system: inventory.system, displayName: inventory.displayName, importerUserId: ctx.importerUserId, matchByEmail, projects, statuses, priorities, users, issueTypes, customFields },
    suggestions,
    attention,
  };
}

/** Folded name, exported for callers that need to compare labels the way the engine does. */
export const nameKey = foldName;
