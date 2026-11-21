import Ajv from 'ajv';
import { FieldType, IssueTypeLevel, Priority, TaskStatus } from '@prisma/client';
import { foldName } from '../../templates/blueprint/blueprint.names';
import { suggest } from './mapping.suggest';
import { priorityKey } from './mapping.tables';
import {
  ConfigProblem,
  EMPTY_CONFIG,
  MappingConfigV1,
  MappingContext,
  MappingInventory,
} from './mapping.types';

/**
 * Step 4.3. The persisted overrides (`ImportJob.mappingConfig`): strict parse, then checks against what the job
 * actually contains (inventory) and who may be targeted (context). Pure. Strict on purpose: a typo'd row that is silently
 * ignored is an import that did something other than what the person chose.
 */
export const CONFIG_LIMITS = { maxRows: 5000, id: 200, name: 200, raw: 200 } as const;

const id = { type: 'string', minLength: 1, maxLength: CONFIG_LIMITS.id };
const obj = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', additionalProperties: false, required, properties });
const rows = (item: unknown) => ({ type: 'array', maxItems: CONFIG_LIMITS.maxRows, items: item });

const userTarget = {
  oneOf: [
    obj({ kind: { const: 'user' }, userId: id }, ['kind', 'userId']),
    obj({ kind: { const: 'importer' } }, ['kind']),
  ],
};
const entityTarget = {
  oneOf: [
    obj({ kind: { const: 'existing' }, id }, ['kind', 'id']),
    obj({ kind: { const: 'create' } }, ['kind']),
    obj({ kind: { const: 'skip' } }, ['kind']),
  ],
};

const SCHEMA = {
  $id: 'import-mapping-config-v1',
  ...obj(
    {
      version: { const: 1 },
      matchByEmail: { type: 'boolean' },
      projects: rows(obj({ externalId: id, name: { type: 'string', minLength: 1, maxLength: CONFIG_LIMITS.name } }, ['externalId', 'name'])),
      statuses: rows(
        obj(
          {
            statusExternalId: id,
            category: { type: 'string', enum: Object.values(TaskStatus) },
            excludeFromProgress: { type: 'boolean' },
            name: { type: 'string', minLength: 1, maxLength: CONFIG_LIMITS.name },
            mergeInto: id,
          },
          ['statusExternalId'],
        ),
      ),
      priorities: rows(
        obj(
          { raw: { type: 'string', maxLength: CONFIG_LIMITS.raw }, priority: { type: ['string', 'null'], enum: [...Object.values(Priority), null] } },
          ['raw', 'priority'],
        ),
      ),
      users: rows(obj({ externalId: id, target: userTarget }, ['externalId', 'target'])),
      issueTypes: rows(obj({ externalId: id, target: entityTarget, level: { type: 'string', enum: Object.values(IssueTypeLevel) } }, ['externalId', 'target'])),
      customFields: rows(obj({ externalId: id, target: entityTarget, name: { type: 'string', minLength: 1, maxLength: CONFIG_LIMITS.name } }, ['externalId', 'target'])),
    },
    ['version'],
  ),
};

const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true });
const validateShape = ajv.compile<MappingConfigV1>(SCHEMA);

const clean = (s: string): string => s.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');

/**
 * `{}` / null / undefined = no overrides. Anything else must match the schema exactly. Returns a NORMALISED copy
 * (control characters removed from names and raw priority keys), never the input object.
 */
export function parseConfig(raw: unknown): { ok: true; config: MappingConfigV1 } | { ok: false; problems: ConfigProblem[] } {
  if (raw === undefined || raw === null) return { ok: true, config: { ...EMPTY_CONFIG } };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, problems: [{ path: '', code: 'INVALID_SHAPE', message: 'The mapping must be an object' }] };
  }
  const input = Object.keys(raw as object).length === 0 ? { version: 1 } : (raw as Record<string, unknown>);
  let copy: unknown;
  try {
    copy = JSON.parse(JSON.stringify(input));
  } catch {
    return { ok: false, problems: [{ path: '', code: 'INVALID_SHAPE', message: 'The mapping is not JSON' }] };
  }
  if (!validateShape(copy)) {
    const problems = (validateShape.errors ?? []).slice(0, 20).map<ConfigProblem>((e) => ({
      path: e.instancePath || '/',
      code: 'INVALID_SHAPE',
      message: `${e.message ?? 'invalid'}${e.params && 'additionalProperty' in e.params ? ` "${String((e.params as { additionalProperty: unknown }).additionalProperty)}"` : ''}`,
    }));
    return { ok: false, problems };
  }
  const c = copy as MappingConfigV1;
  if (c.projects) c.projects = c.projects.map((p) => ({ ...p, name: clean(p.name).trim() }));
  if (c.statuses) c.statuses = c.statuses.map((s) => (s.name === undefined ? s : { ...s, name: clean(s.name).trim() }));
  if (c.priorities) c.priorities = c.priorities.map((p) => ({ ...p, raw: clean(p.raw).trim() }));
  if (c.customFields) c.customFields = c.customFields.map((f) => (f.name === undefined ? f : { ...f, name: clean(f.name).trim() }));
  return { ok: true, config: c };
}

function dupes<T>(rowsIn: readonly T[] | undefined, key: (r: T) => string, path: string, out: ConfigProblem[]): void {
  const seen = new Set<string>();
  (rowsIn ?? []).forEach((r, i) => {
    const k = key(r);
    if (seen.has(k)) out.push({ path: `/${path}/${i}`, code: 'DUPLICATE_KEY', message: `"${k}" appears more than once` });
    seen.add(k);
  });
}

/**
 * Everything that can be wrong with a parsed config, given what the job contains. `inventory` null = nothing to check
 * against yet (only shape + duplicates). `context` null = membership / existing-entity checks are skipped (the service
 * always passes it).
 */
export function checkConfig(config: MappingConfigV1, inventory: MappingInventory | null, context: MappingContext | null): ConfigProblem[] {
  const out: ConfigProblem[] = [];
  dupes(config.projects, (r) => r.externalId, 'projects', out);
  dupes(config.statuses, (r) => r.statusExternalId, 'statuses', out);
  // the SAME key resolve() matches on: "High" and "high (2)" are one row, so two of them would silently collide
  dupes(config.priorities, (r) => priorityKey(r.raw), 'priorities', out);
  dupes(config.users, (r) => r.externalId, 'users', out);
  dupes(config.issueTypes, (r) => r.externalId, 'issueTypes', out);
  dupes(config.customFields, (r) => r.externalId, 'customFields', out);

  if (context) {
    const members = new Set(context.members.map((m) => m.userId));
    (config.users ?? []).forEach((r, i) => {
      if (r.target.kind === 'user' && !members.has(r.target.userId)) {
        out.push({ path: `/users/${i}/target/userId`, code: 'NOT_A_MEMBER', message: 'That person is not a member of this workspace' });
      }
    });
    const typeIds = new Set(context.issueTypes.map((t) => t.id));
    (config.issueTypes ?? []).forEach((r, i) => {
      if (r.target.kind === 'existing' && !typeIds.has(r.target.id)) {
        out.push({ path: `/issueTypes/${i}/target/id`, code: 'UNKNOWN_TARGET', message: 'That issue type does not exist in this workspace' });
      }
    });
    const fieldById = new Map(context.customFields.map((f) => [f.id, f]));
    (config.customFields ?? []).forEach((r, i) => {
      if (r.target.kind !== 'existing') return;
      const f = fieldById.get(r.target.id);
      if (!f) out.push({ path: `/customFields/${i}/target/id`, code: 'UNKNOWN_TARGET', message: 'That custom field does not exist in this workspace' });
      else {
        const src = inventory?.customFields.find((x) => x.externalId === r.externalId);
        if (src && src.dataType !== (f.dataType as FieldType)) {
          out.push({ path: `/customFields/${i}/target/id`, code: 'TYPE_MISMATCH', message: `The source field is ${src.dataType} but the workspace field is ${f.dataType}` });
        }
      }
    });
  }

  if (!inventory) return out;

  const projectIds = new Set(inventory.projects.map((p) => p.externalId));
  const statusProject = new Map<string, string>();
  const statusName = new Map<string, string>();
  for (const p of inventory.projects) for (const s of p.statuses) { statusProject.set(s.externalId, p.externalId); statusName.set(s.externalId, s.name); }
  const unknown = (rowsIn: ReadonlyArray<{ k: string }> | undefined, known: Set<string>, path: string) =>
    (rowsIn ?? []).forEach((r, i) => {
      if (!known.has(r.k)) out.push({ path: `/${path}/${i}`, code: 'UNKNOWN_SOURCE_ENTITY', message: `"${r.k}" is not part of this import` });
    });
  unknown(config.projects?.map((r) => ({ k: r.externalId })), projectIds, 'projects');
  unknown(config.statuses?.map((r) => ({ k: r.statusExternalId })), new Set(statusProject.keys()), 'statuses');
  unknown(config.users?.map((r) => ({ k: r.externalId })), new Set(inventory.users.map((u) => u.externalId)), 'users');
  unknown(config.issueTypes?.map((r) => ({ k: r.externalId })), new Set(inventory.issueTypes.map((t) => t.externalId)), 'issueTypes');
  unknown(config.customFields?.map((r) => ({ k: r.externalId })), new Set(inventory.customFields.map((f) => f.externalId)), 'customFields');

  // status merges: same project, target is a real status that is not itself merged, never self
  const merge = new Map((config.statuses ?? []).filter((s) => s.mergeInto !== undefined).map((s) => [s.statusExternalId, s.mergeInto as string]));
  (config.statuses ?? []).forEach((s, i) => {
    if (s.mergeInto === undefined) return;
    const path = `/statuses/${i}/mergeInto`;
    if (s.mergeInto === s.statusExternalId) out.push({ path, code: 'MERGE_INVALID', message: 'A status cannot be merged into itself' });
    else if (!statusProject.has(s.mergeInto)) { if (statusProject.has(s.statusExternalId)) out.push({ path, code: 'UNKNOWN_SOURCE_ENTITY', message: `"${s.mergeInto}" is not a status of this import` }); }
    else if (statusProject.get(s.mergeInto) !== statusProject.get(s.statusExternalId)) out.push({ path, code: 'MERGE_INVALID', message: 'Statuses can only be merged within one project' });
    else if (merge.has(s.mergeInto)) out.push({ path, code: 'MERGE_INVALID', message: 'The target status is itself merged into another; merge into the final one' });
    else if (s.category !== undefined || s.name !== undefined || s.excludeFromProgress !== undefined) {
      out.push({ path, code: 'MERGE_INVALID', message: 'A merged status takes its target\'s name and category; remove the other fields from this row' });
    }
  });

  // final names of surviving (non-merged) statuses must stay distinct inside a project; excludeFromProgress needs DONE
  const sug = suggest(inventory, context ?? EMPTY_CONTEXT, { matchByEmail: config.matchByEmail !== false });
  const sugByStatus = new Map(sug.statuses.map((s) => [s.statusExternalId, s]));
  const override = new Map((config.statuses ?? []).map((s) => [s.statusExternalId, s]));
  for (const p of inventory.projects) {
    const names = new Map<string, string>();
    for (const s of p.statuses) {
      if (merge.has(s.externalId)) continue;
      const o = override.get(s.externalId);
      const name = o?.name ?? s.name;
      const k = foldName(name);
      const prev = names.get(k);
      if (prev) out.push({ path: `/statuses`, code: 'NAME_COLLISION', message: `Two statuses of "${p.name}" would both be called "${name}" (${prev}, ${s.externalId}); rename or merge one` });
      names.set(k, s.externalId);
      const finalCategory = o?.category ?? sugByStatus.get(s.externalId)?.category;
      const exclude = o?.excludeFromProgress ?? sugByStatus.get(s.externalId)?.excludeFromProgress;
      if (o?.excludeFromProgress === true && finalCategory !== TaskStatus.DONE) {
        out.push({ path: '/statuses', code: 'CATEGORY_INVALID', message: `"${name}" is excluded from progress, which only makes sense for a DONE status` });
      }
      void exclude;
    }
  }
  return out;
}

const EMPTY_CONTEXT: MappingContext = { importerUserId: '', members: [], identityLinks: [], issueTypes: [], customFields: [] };
