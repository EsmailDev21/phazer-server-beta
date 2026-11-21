import { IssueTypeLevel, TaskStatus } from '@prisma/client';
import { foldName } from '../../templates/blueprint/blueprint.names';
import { CanonicalStatus } from '../canonical';
import { foldEmail } from './mapping.inventory';
import { lookupPriority, NAME_BLOCKED, NAME_CANCELED, NAME_DONE, NAME_IN_PROGRESS } from './mapping.tables';
import {
  CustomFieldSuggestion,
  IssueTypeSuggestion,
  MappingContext,
  MappingInventory,
  MappingSuggestions,
  PrioritySuggestion,
  StatusSuggestion,
  UserSuggestion,
} from './mapping.types';

/**
 * Step 4.3. What the engine would do with no overrides. PURE and total: every source entity gets exactly one
 * suggestion, however odd (unknown category, empty names, hostile text). The person overrides rows; nothing here is
 * ever "the final word" except through `resolve`.
 */
export interface SuggestOptions {
  matchByEmail: boolean;
}

export function suggestStatus(projectExternalId: string, s: CanonicalStatus): StatusSuggestion {
  const base = { projectExternalId, statusExternalId: s.externalId, name: s.name };
  const blockedGuess = (): StatusSuggestion => ({ ...base, category: TaskStatus.BLOCKED, excludeFromProgress: false, confidence: 'LOW', reason: 'NAME_BLOCKED' });

  switch (s.category) {
    case 'DONE':
      return { ...base, category: TaskStatus.DONE, excludeFromProgress: false, confidence: 'HIGH', reason: 'SOURCE_CATEGORY' };
    case 'CANCELED':
      // "Won't do": finished, but it must not count toward progress (diagram 07)
      return { ...base, category: TaskStatus.DONE, excludeFromProgress: true, confidence: 'HIGH', reason: 'SOURCE_CATEGORY' };
    case 'IN_PROGRESS':
      return NAME_BLOCKED.test(s.name)
        ? blockedGuess()
        : { ...base, category: TaskStatus.IN_PROGRESS, excludeFromProgress: false, confidence: 'HIGH', reason: 'SOURCE_CATEGORY' };
    case 'BACKLOG':
    case 'TODO':
      return NAME_BLOCKED.test(s.name)
        ? blockedGuess()
        : { ...base, category: TaskStatus.TODO, excludeFromProgress: false, confidence: 'HIGH', reason: 'SOURCE_CATEGORY' };
    default: {
      // UNKNOWN: the source gave no category (GitHub open/closed has one; some custom workflows do not). Judge the name.
      if (NAME_BLOCKED.test(s.name)) return blockedGuess();
      if (NAME_CANCELED.test(s.name)) return { ...base, category: TaskStatus.DONE, excludeFromProgress: true, confidence: 'MEDIUM', reason: 'NAME_CANCELED' };
      if (NAME_DONE.test(s.name.trim())) return { ...base, category: TaskStatus.DONE, excludeFromProgress: false, confidence: 'MEDIUM', reason: 'NAME_DONE' };
      if (NAME_IN_PROGRESS.test(s.name)) return { ...base, category: TaskStatus.IN_PROGRESS, excludeFromProgress: false, confidence: 'MEDIUM', reason: 'NAME_IN_PROGRESS' };
      return { ...base, category: TaskStatus.TODO, excludeFromProgress: false, confidence: 'LOW', reason: 'DEFAULT' };
    }
  }
}

function guessLevel(name: string): IssueTypeLevel {
  const k = foldName(name);
  if (k === 'epic') return IssueTypeLevel.EPIC;
  if (k === 'sub-task' || k === 'subtask' || k === 'sub task' || k === 'sub-issue') return IssueTypeLevel.SUBTASK;
  return IssueTypeLevel.STANDARD;
}

export function suggest(inventory: MappingInventory, ctx: MappingContext, opts: SuggestOptions): MappingSuggestions {
  const statuses: StatusSuggestion[] = [];
  for (const p of inventory.projects) for (const s of p.statuses) statuses.push(suggestStatus(p.externalId, s));

  const priorities: PrioritySuggestion[] = inventory.priorities.map((raw) => ({ raw, ...lookupPriority(inventory.system, raw) }));

  // People. A match is only ever to a MEMBER of the target workspace, and by e-mail only a VERIFIED local address counts.
  const memberIds = new Set(ctx.members.map((m) => m.userId));
  const links = new Map(ctx.identityLinks.filter((l) => memberIds.has(l.userId)).map((l) => [l.externalUserId, l.userId]));
  const byEmail = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const m of ctx.members) {
    const e = m.emailVerified ? foldEmail(m.email) : null;
    if (!e) continue;
    if (byEmail.has(e) && byEmail.get(e) !== m.userId) ambiguous.add(e);
    byEmail.set(e, m.userId);
  }
  const users: UserSuggestion[] = inventory.users.map((u) => {
    const base = { externalId: u.externalId, name: u.name, ...(u.email ? { email: u.email } : {}) };
    if (u.isBot) return { ...base, target: { kind: 'importer' as const }, confidence: 'HIGH' as const, reason: 'BOT' as const };
    const linked = links.get(u.externalId);
    if (linked) return { ...base, target: { kind: 'user' as const, userId: linked }, confidence: 'HIGH' as const, reason: 'IDENTITY_LINK' as const };
    const e = opts.matchByEmail ? foldEmail(u.email) : null;
    const hit = e && !ambiguous.has(e) ? byEmail.get(e) : undefined;
    if (hit) return { ...base, target: { kind: 'user' as const, userId: hit }, confidence: 'MEDIUM' as const, reason: 'VERIFIED_EMAIL' as const };
    return { ...base, target: { kind: 'importer' as const }, confidence: 'LOW' as const, reason: 'NONE' as const };
  });

  const localTypes = new Map(ctx.issueTypes.map((t) => [foldName(t.name), t]));
  const issueTypes: IssueTypeSuggestion[] = inventory.issueTypes.map((t) => {
    const local = localTypes.get(foldName(t.name));
    if (local) return { externalId: t.externalId, name: t.name, target: { kind: 'existing' as const, id: local.id }, level: local.level, reason: 'NAME_MATCH' as const };
    return { externalId: t.externalId, name: t.name, target: { kind: 'create' as const }, level: t.level ?? guessLevel(t.name), reason: 'NEW' as const };
  });

  const localFields = new Map<string, MappingContext['customFields']>();
  for (const f of ctx.customFields) {
    const k = foldName(f.name);
    localFields.set(k, [...(localFields.get(k) ?? []), f]);
  }
  const customFields: CustomFieldSuggestion[] = inventory.customFields.map((f) => {
    const same = localFields.get(foldName(f.name)) ?? [];
    const match = same.find((x) => x.dataType === f.dataType);
    if (match) return { externalId: f.externalId, name: f.name, dataType: f.dataType, target: { kind: 'existing' as const, id: match.id }, createName: f.name, reason: 'NAME_AND_TYPE_MATCH' as const };
    if (same.length > 0) {
      return { externalId: f.externalId, name: f.name, dataType: f.dataType, target: { kind: 'create' as const }, createName: `${f.name} (${inventory.displayName})`.slice(0, 200), reason: 'NAME_CONFLICT' as const };
    }
    return { externalId: f.externalId, name: f.name, dataType: f.dataType, target: { kind: 'create' as const }, createName: f.name, reason: 'NEW' as const };
  });

  return { statuses, priorities, users, issueTypes, customFields };
}
