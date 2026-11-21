import { BadRequestException } from '@nestjs/common';
import {
  DEFAULT_IMPORT_OPTIONS,
  FIELD_ROLES,
  FieldRole,
  FieldRoleChoice,
  ImportOptions,
  ImportSelection,
  SourceTree,
} from './imports.types';

/** Hard caps on stored JSON. An import job row is user-controlled input that lives forever. */
export const IMPORT_LIMITS = {
  maxSelectedSources: 500,
  maxIdLength: 200,
  maxTypeLength: 40,
  /** Issues kept per job; the one after the last is a single TRUNCATED marker. */
  maxIssuesPerJob: 5000,
} as const;

const OPTION_KEYS = Object.keys(DEFAULT_IMPORT_OPTIONS) as Array<keyof ImportOptions>;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Missing keys take the default; unknown keys and non-booleans are a 400 (a typo must not silently import less). */
export function parseOptions(raw: unknown): ImportOptions {
  if (raw === undefined || raw === null) return { ...DEFAULT_IMPORT_OPTIONS };
  if (!isPlainObject(raw)) throw new BadRequestException('options must be an object');
  const out: ImportOptions = { ...DEFAULT_IMPORT_OPTIONS };
  for (const [k, v] of Object.entries(raw)) {
    if (!(OPTION_KEYS as string[]).includes(k)) {
      throw new BadRequestException(`Unknown import option "${k}"`);
    }
    if (typeof v !== 'boolean') {
      throw new BadRequestException(`Import option "${k}" must be true or false`);
    }
    (out as unknown as Record<string, boolean>)[k] = v; // OPTION_KEYS are the four booleans; `target` / `template` are never accepted here
  }
  return out;
}

/** Step 4.10. `{ status: "col1", priority: null }`: unknown roles and non-string ids are a 400 (a typo must not silently map less). */
function parseFieldRoles(raw: unknown, where: string): FieldRoleChoice | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isPlainObject(raw)) throw new BadRequestException(`${where}: fieldRoles must be an object`);
  const out: FieldRoleChoice = {};
  for (const [role, id] of Object.entries(raw)) {
    if (!(FIELD_ROLES as readonly string[]).includes(role)) throw new BadRequestException(`${where}: unknown field role "${role.slice(0, 40)}"`);
    if (id === null) {
      out[role as FieldRole] = null;
    } else if (typeof id === 'string' && id.length > 0 && id.length <= IMPORT_LIMITS.maxIdLength) {
      out[role as FieldRole] = id;
    } else {
      throw new BadRequestException(`${where}: the field for "${role}" must be a field id or null`);
    }
  }
  const chosen = Object.values(out).filter((v): v is string => typeof v === 'string');
  if (new Set(chosen).size !== chosen.length) throw new BadRequestException(`${where}: one field cannot play two roles`);
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Structure only. Whether the ids exist at the provider is checked against discover() by the service. */
export function parseSelection(raw: unknown): ImportSelection {
  if (!isPlainObject(raw) || !Array.isArray(raw.sources)) {
    throw new BadRequestException('selection must be { sources: [{ id, type }] }');
  }
  const { sources } = raw as { sources: unknown[] };
  if (sources.length === 0) throw new BadRequestException('Select at least one source');
  if (sources.length > IMPORT_LIMITS.maxSelectedSources) {
    throw new BadRequestException(
      `At most ${IMPORT_LIMITS.maxSelectedSources} sources per import`,
    );
  }
  const seen = new Set<string>();
  const out: ImportSelection['sources'] = [];
  for (const s of sources) {
    if (!isPlainObject(s) || typeof s.id !== 'string' || typeof s.type !== 'string') {
      throw new BadRequestException('Each source must be { id: string, type: string }');
    }
    if (
      s.id.length === 0 ||
      s.id.length > IMPORT_LIMITS.maxIdLength ||
      s.type.length === 0 ||
      s.type.length > IMPORT_LIMITS.maxTypeLength
    ) {
      throw new BadRequestException('Source id / type has an invalid length');
    }
    const key = `${s.type}:${s.id}`;
    if (seen.has(key)) continue; // duplicates are harmless, collapse them (the first entry wins)
    seen.add(key);
    const fieldRoles = parseFieldRoles(s.fieldRoles, `${s.type}:${s.id.slice(0, 40)}`);
    out.push(fieldRoles ? { id: s.id, type: s.type, fieldRoles } : { id: s.id, type: s.type });
  }
  return { sources: out };
}

/** Every selected source must be a selectable node of the tree the provider just reported. */
export function assertSelectionInTree(sel: ImportSelection, tree: SourceTree): void {
  const byKey = new Map(tree.nodes.map((n) => [`${n.type}:${n.id}`, n]));
  const bad: string[] = [];
  for (const s of sel.sources) {
    const node = byKey.get(`${s.type}:${s.id}`);
    if (!node || !node.selectable) bad.push(`${s.type}:${s.id}`);
  }
  if (bad.length > 0) {
    throw new BadRequestException(
      `Not selectable at the provider: ${bad.slice(0, 5).join(', ')}${bad.length > 5 ? ` (+${bad.length - 5} more)` : ''}`,
    );
  }
  // Step 4.10: a chosen field must be a field of THAT source that can play THAT role (the tree is the provider's own answer)
  const badRoles: string[] = [];
  for (const s of sel.sources) {
    if (!s.fieldRoles) continue;
    const node = byKey.get(`${s.type}:${s.id}`);
    if (!node) continue; // already reported above
    for (const [role, id] of Object.entries(s.fieldRoles)) {
      if (id === null || id === undefined) continue;
      const f = node.fields?.find((x) => x.id === id);
      if (!f || !f.roles.includes(role as FieldRole)) badRoles.push(`${node.name}: ${role}`);
    }
  }
  if (badRoles.length > 0) {
    throw new BadRequestException(
      `A chosen field is not available for its role: ${badRoles.slice(0, 5).join(', ')}${badRoles.length > 5 ? ` (+${badRoles.length - 5} more)` : ''}`,
    );
  }
}
