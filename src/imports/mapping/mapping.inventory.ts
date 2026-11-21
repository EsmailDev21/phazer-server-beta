import { foldName } from '../../templates/blueprint/blueprint.names';
import { CanonicalBundle, CanonicalCustomField, CanonicalIssueType, CanonicalUser, validateBundle } from '../canonical';
import { priorityKey } from './mapping.tables';
import { INVENTORY_LIMITS, MappingInventory } from './mapping.types';

/**
 * Step 4.3. The inventory: everything in the source the person may need to map, de-duplicated across pages.
 * Adapters build one from their STRUCTURE pages (`buildInventory`) and return it from `estimate()`; the service stores it
 * on the job (`parseInventory` re-checks it: it is persisted and shown, so it is treated as input).
 */

export class InventoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InventoryError';
  }
}

export function emptyInventory(system: string, displayName: string): MappingInventory {
  return { system, displayName, projects: [], priorities: [], users: [], issueTypes: [], customFields: [] };
}

/** Folds validated bundle pages into `into` (or a new inventory). First spelling / first definition wins. */
export function buildInventory(pages: readonly CanonicalBundle[], into?: MappingInventory): MappingInventory {
  const first = pages[0];
  const inv = into ?? emptyInventory(first?.source.system ?? 'unknown', first?.source.displayName ?? 'Unknown');
  const projects = new Map(inv.projects.map((p) => [p.externalId, p]));
  const users = new Set(inv.users.map((u) => u.externalId));
  const types = new Set(inv.issueTypes.map((t) => t.externalId));
  const fields = new Set(inv.customFields.map((f) => f.externalId));
  const prios = new Set(inv.priorities.map(priorityKey));

  for (const page of pages) {
    for (const p of page.projects ?? []) {
      const have = projects.get(p.externalId);
      if (!have) {
        const entry = { externalId: p.externalId, name: p.name, statuses: [...(p.statuses ?? [])] };
        projects.set(p.externalId, entry);
        inv.projects.push(entry);
      } else {
        const ids = new Set(have.statuses.map((s) => s.externalId));
        for (const s of p.statuses ?? []) if (!ids.has(s.externalId)) { have.statuses.push(s); ids.add(s.externalId); }
      }
    }
    for (const u of page.users ?? []) if (!users.has(u.externalId)) { users.add(u.externalId); inv.users.push(u); }
    for (const t of page.issueTypes ?? []) if (!types.has(t.externalId)) { types.add(t.externalId); inv.issueTypes.push(t); }
    for (const f of page.customFields ?? []) if (!fields.has(f.externalId)) { fields.add(f.externalId); inv.customFields.push(f); }
    for (const t of page.tasks ?? []) {
      if (t.priority === undefined) continue;
      const k = priorityKey(t.priority);
      if (!prios.has(k)) { prios.add(k); inv.priorities.push(t.priority); }
    }
  }
  return inv;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Re-validates an inventory that came from an adapter or from storage. Entities go through the CanonicalBundle
 * validator (so they are repaired exactly like imported data), counts are bounded, priorities are cleaned.
 * Throws InventoryError when it cannot be used.
 */
export function parseInventory(raw: unknown): MappingInventory {
  if (!isObj(raw)) throw new InventoryError('The inventory must be an object');
  const { system, displayName } = raw;
  const L = INVENTORY_LIMITS;
  const list = (k: string, max: number): unknown[] => {
    const v = raw[k];
    if (v === undefined) return [];
    if (!Array.isArray(v)) throw new InventoryError(`"${k}" must be a list`);
    if (v.length > max) throw new InventoryError(`Too many ${k} to map (${v.length}; at most ${max})`);
    return v;
  };
  const projects = list('projects', L.maxProjects);
  for (const p of projects) {
    if (isObj(p) && Array.isArray(p.statuses) && p.statuses.length > L.maxStatusesPerProject) {
      throw new InventoryError(`A project has too many statuses to map (at most ${L.maxStatusesPerProject})`);
    }
  }
  const prios = list('priorities', L.maxPriorities);
  const page = {
    schemaVersion: 1,
    source: { system, displayName },
    projects,
    users: list('users', L.maxUsers),
    issueTypes: list('issueTypes', L.maxIssueTypes),
    customFields: list('customFields', L.maxCustomFields),
  };
  const r = validateBundle(page);
  if ('fatal' in r) throw new InventoryError(`The inventory is not valid: ${r.fatal.message}${r.fatal.details ? ` (${r.fatal.details.slice(0, 3).join('; ')})` : ''}`);

  const seen = new Set<string>();
  const priorities: string[] = [];
  for (const p of prios) {
    if (typeof p !== 'string') continue;
    const clean = p.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 100);
    const k = priorityKey(clean);
    if (clean === '' || seen.has(k)) continue;
    seen.add(k);
    priorities.push(clean);
  }
  const b = r.bundle;
  return {
    system: b.source.system,
    displayName: b.source.displayName,
    projects: (b.projects ?? []).map((p) => ({ externalId: p.externalId, name: p.name, statuses: p.statuses ?? [] })),
    priorities,
    users: (b.users ?? []) as CanonicalUser[],
    issueTypes: (b.issueTypes ?? []) as CanonicalIssueType[],
    customFields: (b.customFields ?? []) as CanonicalCustomField[],
  };
}

/** Case-folded e-mail, or null. */
export function foldEmail(email: string | null | undefined): string | null {
  const e = email ? foldName(email) : '';
  return e === '' ? null : e;
}
