import { canonicalJson } from '../blueprint';
import type { BlueprintV1 } from '../blueprint';
import { Ent, flattenBlueprint, Json } from './diff.flatten';
import { BlueprintDiff, DiffChange, DiffCounts, DiffEntity, DiffField, DiffKind, DiffOptions } from './diff.types';

const RANK: Record<DiffEntity, number> = {
  document: 0, meta: 1, dateAnchor: 2, variable: 3, role: 4, module: 5, workspace: 6, tag: 7, customField: 8,
  issueType: 9, iteration: 10, asset: 11, project: 12, workflow: 13, status: 14, transition: 15, task: 16,
  dependency: 17, comment: 18, automation: 19, view: 20,
};
const KIND_RANK: Record<DiffKind, number> = { added: 0, removed: 1, modified: 2, moved: 3, reordered: 4 };
const MOVE_FIELDS = new Set(['project', 'parent']);
const MAX_VALUE_CHARS = 2000;

const same = (a: unknown, b: unknown) => canonicalJson(a === undefined ? null : a) === canonicalJson(b === undefined ? null : b) && (a === undefined) === (b === undefined);
const isScalar = (v: unknown) => v === null || ['string', 'number', 'boolean'].includes(typeof v);

/** A value for the output: unchanged when small, else a marker saying how big it was. */
function carry(v: Json | undefined): { value: unknown; clipped: boolean } {
  if (v === undefined) return { value: undefined, clipped: false };
  const s = canonicalJson(v);
  if (s.length <= MAX_VALUE_CHARS) return { value: v, clipped: false };
  return { value: `<${s.length} characters>`, clipped: true };
}

function fieldChange(field: string, before: Json | undefined, after: Json | undefined): DiffField {
  const b = carry(before);
  const a = carry(after);
  const out: DiffField = { field };
  if (before !== undefined) out.before = b.value;
  if (after !== undefined) out.after = a.value;
  if (b.clipped || a.clipped) out.clipped = true;
  if (Array.isArray(before) && Array.isArray(after) && before.every(isScalar) && after.every(isScalar)) {
    const sb = before.map((x) => canonicalJson(x));
    const sa = after.map((x) => canonicalJson(x));
    const added = after.filter((x) => !sb.includes(canonicalJson(x)));
    const removed = before.filter((x) => !sa.includes(canonicalJson(x)));
    if (added.length) out.added = added;
    if (removed.length) out.removed = removed;
    if (!added.length && !removed.length) out.reordered = true; // same members (or same members with repeats), other order
  }
  return out;
}

const allFields = (e: Ent, side: 'before' | 'after'): DiffField[] =>
  Object.keys(e.fields).sort().map((f) => {
    const c = carry(e.fields[f]);
    return { field: f, [side]: c.value, ...(c.clipped ? { clipped: true as const } : {}) } as DiffField;
  });

const zero = (): DiffCounts => ({ added: 0, removed: 0, modified: 0, moved: 0, reordered: 0 });

/**
 * Compares two blueprints. Pure and deterministic. Entities are matched by key, so:
 *  - a rename is `modified` (the key did not change), a move to another parent/project is `moved`,
 *    a different order among siblings is `reordered` on the container;
 *  - every leaf of both documents takes part in the comparison (see `flattenFields`), so
 *    `identical` is true exactly when the canonical JSON is equal.
 */
export function diffBlueprints(a: BlueprintV1, b: BlueprintV1, opts: DiffOptions = {}): BlueprintDiff {
  const maxChanges = opts.maxChanges ?? 1000;
  const fa = flattenBlueprint(a);
  const fb = flattenBlueprint(b);
  const changes: DiffChange[] = [];

  const ids = [...new Set([...fa.ents.keys(), ...fb.ents.keys()])];
  for (const id of ids) {
    const ea = fa.ents.get(id);
    const eb = fb.ents.get(id);
    const head = (e: Ent) => ({ entity: e.entity, id: e.key, ...(e.scope !== undefined ? { scope: e.scope } : {}), label: e.label });
    if (!ea && eb) { changes.push({ ...head(eb), kind: 'added', fields: allFields(eb, 'after') }); continue; }
    if (ea && !eb) { changes.push({ ...head(ea), kind: 'removed', fields: allFields(ea, 'before') }); continue; }
    if (!ea || !eb) continue;
    const names = [...new Set([...Object.keys(ea.fields), ...Object.keys(eb.fields)])].sort();
    const moved: DiffField[] = [];
    const other: DiffField[] = [];
    for (const f of names) {
      const x = ea.fields[f];
      const y = eb.fields[f];
      if ((x === undefined) !== (y === undefined) || !same(x, y)) (MOVE_FIELDS.has(f) && ea.entity === 'task' ? moved : other).push(fieldChange(f, x, y));
    }
    if (moved.length) changes.push({ ...head(eb), kind: 'moved', fields: moved });
    if (other.length) changes.push({ ...head(eb), kind: 'modified', fields: other });
  }

  // order inside a container, over the members both sides have in that container
  for (const key of new Set([...fa.orders.keys(), ...fb.orders.keys()])) {
    const oa = fa.orders.get(key);
    const ob = fb.orders.get(key);
    if (!oa || !ob) continue; // all members added / removed: those are changes of their own
    const inB = new Set(ob.ids);
    const inA = new Set(oa.ids);
    const left = oa.ids.filter((x) => inB.has(x));
    const right = ob.ids.filter((x) => inA.has(x));
    if (left.length < 2 || left.every((x, i) => x === right[i])) continue;
    const keyOf = (x: string) => (fb.ents.get(x) ?? fa.ents.get(x))!.key;
    const label = ob.container.entity === 'document' ? 'Template' : (fb.ents.get(`${ob.container.entity}:${ob.container.id}`) ?? fa.ents.get(`${ob.container.entity}:${ob.container.id}`))?.label ?? ob.container.id;
    changes.push({
      entity: ob.container.entity, id: ob.container.id, label, kind: 'reordered',
      container: ob.container, before: left.map(keyOf), after: right.map(keyOf),
      ...(oa.minor && ob.minor ? { minor: true as const } : {}),
    });
  }

  changes.sort((x, y) =>
    RANK[x.entity] - RANK[y.entity] || (x.scope ?? '').localeCompare(y.scope ?? '') || x.id.localeCompare(y.id) ||
    KIND_RANK[x.kind] - KIND_RANK[y.kind] || (x.container?.field ?? '').localeCompare(y.container?.field ?? ''));

  const byEntity: BlueprintDiff['summary']['byEntity'] = {};
  const total = zero();
  for (const c of changes) {
    (byEntity[c.entity] ??= zero())[c.kind] += 1;
    total[c.kind] += 1;
  }
  return {
    identical: changes.length === 0,
    summary: { ...total, total: changes.length, byEntity },
    changes: changes.length > maxChanges ? changes.slice(0, maxChanges) : changes,
    truncated: changes.length > maxChanges,
  };
}
