import { canonicalJson } from '../blueprint';
import { fixtureJson } from '../blueprint/blueprint.fixtures';
import { diffBlueprints } from './diff';
import { BlueprintDiff, DiffChange } from './diff.types';

const FIXTURES = ['student-workspace', 'sprint-board', 'content-calendar'] as const;
const bp = (n: (typeof FIXTURES)[number]): any => fixtureJson(n);
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const find = (o: any, key: string): any => {
  if (!o || typeof o !== 'object') return undefined;
  if (o.nodeKey === key) return o;
  for (const v of Object.values(o)) { const r = find(v, key); if (r) return r; }
  return undefined;
};
const tasksOf = (b: any): any[] => { const out: any[] = []; const w = (l: any[]) => l.forEach((t) => { out.push(t); w(t.children ?? []); }); b.projects.forEach((p: any) => w(p.tasks)); return out; };
const kinds = (d: BlueprintDiff) => d.changes.map((c) => `${c.entity}:${c.id}:${c.kind}`);

function mulberry(seed: number) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

describe('diffBlueprints: what it reports', () => {
  it('identical documents: nothing, whatever the key order inside objects (JSONB does not keep it)', () => {
    const a = bp('sprint-board');
    const shuffled = JSON.parse(JSON.stringify(a), (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).reverse()) : v));
    const d = diffBlueprints(a, shuffled);
    expect(d).toMatchObject({ identical: true, changes: [], truncated: false, summary: { total: 0 } });
  });

  it('a rename is ONE modified task with the title field, not a delete plus an add', () => {
    const a = bp('sprint-board'); const b = clone(a);
    const t = tasksOf(b)[0]; const was = t.title; t.title = 'Totally new title';
    const d = diffBlueprints(a, b);
    expect(kinds(d)).toEqual([`task:${t.nodeKey}:modified`]);
    expect(d.changes[0].fields).toEqual([{ field: 'title', before: was, after: 'Totally new title' }]);
    expect(d.changes[0].label).toBe('Totally new title');
  });

  it('reordering siblings is ONE reordered change on the container, naming the keys in both orders', () => {
    const a = bp('sprint-board'); const b = clone(a);
    const list = b.projects[0].tasks; [list[0], list[1]] = [list[1], list[0]];
    const d = diffBlueprints(a, b);
    expect(d.changes).toHaveLength(1);
    expect(d.changes[0]).toMatchObject({ kind: 'reordered', entity: 'project', id: a.projects[0].nodeKey, container: { field: 'tasks' }, before: a.projects[0].tasks.map((t: any) => t.nodeKey), after: b.projects[0].tasks.map((t: any) => t.nodeKey) });
  });

  it('moving a task under another parent is `moved` (project + parent), with NO reorder noise in either container', () => {
    const a = bp('student-workspace'); const b = clone(a);
    const p = b.projects.find((x: any) => x.tasks.length >= 2 && x.tasks.some((t: any) => (t.children ?? []).length === 0))!;
    const [first, second] = p.tasks;
    p.tasks = p.tasks.slice(1); // `first` leaves the root ...
    second.children = [...(second.children ?? []), first]; // ... and becomes a child of `second`
    const d = diffBlueprints(a, b);
    const mv = d.changes.filter((c) => c.kind === 'moved');
    expect(mv).toHaveLength(1);
    expect(mv[0]).toMatchObject({ entity: 'task', id: first.nodeKey, fields: [{ field: 'parent', before: null, after: second.nodeKey }] });
    expect(d.changes.filter((c) => c.kind === 'reordered')).toEqual([]);
  });

  it('moving a task to ANOTHER project reports project and parent, and keeps its identity', () => {
    const a = bp('student-workspace'); const b = clone(a);
    expect(b.projects.length).toBeGreaterThanOrEqual(2);
    const t = b.projects[0].tasks.pop()!; b.projects[1].tasks.push(t);
    const d = diffBlueprints(a, b);
    const mv = d.changes.find((c) => c.kind === 'moved')!;
    expect(mv.id).toBe(t.nodeKey);
    expect(mv.fields!.map((f) => f.field)).toEqual(['project']);
    expect(d.changes.some((c) => c.kind === 'added' || c.kind === 'removed')).toBe(false);
  });

  it('adding and removing a subtree lists every task in it', () => {
    const a = bp('student-workspace'); const b = clone(a);
    const withKids = tasksOf(b).find((t) => (t.children ?? []).length > 0)!;
    const gone = [withKids, ...tasksOf({ projects: [{ tasks: withKids.children }] })].map((t) => t.nodeKey);
    const parentList = (function find(l: any[]): any[] | null { for (const t of l) { if (l.includes(withKids)) return l; const r = find(t.children ?? []); if (r) return r; } return null; })(b.projects.flatMap((p: any) => p.tasks).length ? b.projects[0].tasks : []);
    void parentList;
    // drop it by removing the key from wherever it sits
    const strip = (l: any[]) => { const i = l.findIndex((t) => t.nodeKey === withKids.nodeKey); if (i >= 0) l.splice(i, 1); l.forEach((t) => strip(t.children ?? [])); };
    b.projects.forEach((p: any) => strip(p.tasks));
    const removed = diffBlueprints(a, b).changes.filter((c) => c.entity === 'task' && c.kind === 'removed').map((c) => c.id).sort();
    expect(removed).toEqual(gone.sort());
    // and the reverse is the same set, added
    const added = diffBlueprints(b, a).changes.filter((c) => c.entity === 'task' && c.kind === 'added').map((c) => c.id).sort();
    expect(added).toEqual(gone.sort());
  });

  it('scalar sets say WHAT changed (tags added/removed) and flag a pure reorder', () => {
    const a = bp('sprint-board');
    const t = tasksOf(a).find((x) => (x.tags ?? []).length >= 2)!;
    const b = clone(a); const tb = find(b, t.nodeKey);
    tb.tags = [...t.tags].reverse();
    expect(diffBlueprints(a, b).changes[0].fields).toEqual([expect.objectContaining({ field: 'tags', reordered: true })]);
    tb.tags = [t.tags[0], 'brand-new'];
    const f = diffBlueprints(a, b).changes[0].fields![0];
    expect(f).toMatchObject({ field: 'tags', added: ['brand-new'], removed: t.tags.slice(1) });
  });

  it('custom values are compared per field key', () => {
    const a = bp('student-workspace');
    const t = tasksOf(a).find((x) => x.customValues && Object.keys(x.customValues).length)!;
    const k = Object.keys(t.customValues)[0];
    const b = clone(a); find(b, t.nodeKey).customValues[k] = 'changed';
    const f = diffBlueprints(a, b).changes[0].fields![0];
    expect(f.field).toBe(`customValues.${k}`);
  });

  it('comments have no identity: a changed comment is one removed + one added, a new one is just added', () => {
    const a = bp('student-workspace');
    const t = tasksOf(a).find((x) => (x.comments ?? []).length > 0)!;
    const b = clone(a); const tb = find(b, t.nodeKey);
    tb.comments[0] = { ...tb.comments[0], body: 'rewritten' };
    expect(diffBlueprints(a, b).changes.filter((c) => c.entity === 'comment').map((c) => c.kind).sort()).toEqual(['added', 'removed']);
    const c = clone(a); find(c, t.nodeKey).comments.push({ body: 'one more' });
    expect(diffBlueprints(a, c).changes.map((x) => `${x.entity}:${x.kind}`)).toEqual(['comment:added']);
  });

  it('an empty object and an absent one are different documents and the diff says so', () => {
    const a = bp('sprint-board'); const b = clone(a);
    tasksOf(b)[0].customValues = {};
    const d = diffBlueprints(a, b);
    expect(d.identical).toBe(false);
  });

  it('huge values are replaced by a marker, flagged, and the summary still counts everything; the list is capped', () => {
    const a = bp('sprint-board'); const b = clone(a);
    tasksOf(b)[0].description = 'x'.repeat(5000);
    const f = diffBlueprints(a, b).changes[0].fields![0];
    expect(f.clipped).toBe(true);
    expect(String(f.after)).toMatch(/characters/);
    const c = clone(a); tasksOf(c).forEach((t) => (t.title = t.title + '!'));
    const d = diffBlueprints(a, c, { maxChanges: 2 });
    expect(d.changes).toHaveLength(2);
    expect(d.truncated).toBe(true);
    expect(d.summary.modified).toBe(tasksOf(a).length);
  });

  it('does not crash on an INVALID document with repeated keys (every occurrence is kept)', () => {
    const a = bp('sprint-board'); const b = clone(a);
    const leaf = tasksOf(b).find((t) => (t.children ?? []).length === 0)!;
    b.projects[0].tasks.push(clone(leaf));
    const d = diffBlueprints(a, b);
    expect(d.changes.filter((c) => c.kind === 'added')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
// The properties that make the diff trustworthy
// ---------------------------------------------------------------------------------------------

/** All places a JSON document can be changed in one small step: [description, mutated copy]. */
function allMutations(doc: any): Array<[string, any]> {
  const out: Array<[string, any]> = [];
  const visit = (path: Array<string | number>) => {
    const node = path.reduce((o, k) => o[k], doc);
    const edit = (what: string, fn: (copy: any, parent: any, key: string | number) => void) => {
      const copy = clone(doc);
      const parent = path.slice(0, -1).reduce((o, k) => o[k], copy);
      fn(copy, path.length ? parent : copy, path[path.length - 1]);
      out.push([`${what} ${path.join('.')}`, copy]);
    };
    if (Array.isArray(node)) {
      if (path.length) edit('empty array', (_c, p, k) => { p[k] = []; });
      node.forEach((_x, i) => {
        const copy = clone(doc); const arr = path.reduce((o, k) => o[k], copy); arr.splice(i, 1); out.push([`remove [${i}] of ${path.join('.')}`, copy]);
      });
      if (node.length >= 2 && canonicalJson(node[0]) !== canonicalJson(node[node.length - 1])) {
        const copy = clone(doc); const arr = path.reduce((o, k) => o[k], copy); [arr[0], arr[arr.length - 1]] = [arr[arr.length - 1], arr[0]]; out.push([`swap ends of ${path.join('.')}`, copy]);
      }
      node.forEach((_x, i) => visit([...path, i]));
    } else if (node && typeof node === 'object') {
      for (const k of Object.keys(node)) {
        const copy = clone(doc); const o = path.reduce((x, kk) => x[kk], copy); delete o[k]; out.push([`delete ${[...path, k].join('.')}`, copy]);
        visit([...path, k]);
      }
    } else if (typeof node === 'string') edit('change string', (_c, p, k) => { p[k] = node + '~'; });
    else if (typeof node === 'number') edit('change number', (_c, p, k) => { p[k] = node + 1; });
    else if (typeof node === 'boolean') edit('flip boolean', (_c, p, k) => { p[k] = !node; });
  };
  visit([]);
  return out;
}

describe('diffBlueprints: properties', () => {
  it.each(FIXTURES)('COMPLETE: every single-step change anywhere in %s shows up in the diff', (name) => {
    const a = bp(name);
    const muts = allMutations(a);
    expect(muts.length).toBeGreaterThan(200); // the fixture is big enough for this to mean something
    const missed = muts.filter(([, b]) => canonicalJson(a) !== canonicalJson(b) && diffBlueprints(a, b).identical).map(([d]) => d);
    expect(missed).toEqual([]);
  });

  it.each(FIXTURES)('identical <=> canonical JSON equal, over random multi-step edits of %s', (name) => {
    const rnd = mulberry(7);
    const a = bp(name);
    const muts = allMutations(a);
    for (let i = 0; i < 150; i++) {
      let b = clone(a);
      const steps = 1 + Math.floor(rnd() * 3);
      for (let s = 0; s < steps; s++) b = clone(muts[Math.floor(rnd() * muts.length)][1]);
      expect(diffBlueprints(a, b).identical).toBe(canonicalJson(a) === canonicalJson(b));
    }
  });

  it.each(FIXTURES)('SYMMETRIC: diff(B,A) is diff(A,B) turned around, over all single-step edits of %s', (name) => {
    const a = bp(name);
    const turn = (c: DiffChange): DiffChange => {
      const inv: Record<string, string> = { added: 'removed', removed: 'added', modified: 'modified', moved: 'moved', reordered: 'reordered' };
      const out: any = { ...c, kind: inv[c.kind] };
      delete out.label;
      if (c.fields) out.fields = c.fields.map((f) => { const g: any = { field: f.field }; if ('after' in f) g.before = f.after; if ('before' in f) g.after = f.before; if (f.added) g.removed = f.added; if (f.removed) g.added = f.removed; if (f.reordered) g.reordered = true; if (f.clipped) g.clipped = true; return g; });
      if (c.kind === 'reordered') { out.before = c.after; out.after = c.before; }
      return out;
    };
    const norm = (c: DiffChange) => { const o: any = { ...c }; delete o.label; return canonicalJson(o); };
    for (const [desc, b] of allMutations(a)) {
      const fwd = diffBlueprints(a, b).changes.map(turn).map(norm).sort();
      const back = diffBlueprints(b, a).changes.map(norm).sort();
      if (canonicalJson(fwd) !== canonicalJson(back)) throw new Error(`not symmetric for: ${desc}`);
    }
  });

  it('the summary always adds up to the list (and to the per-entity counts)', () => {
    const a = bp('student-workspace');
    for (const [, b] of allMutations(a).slice(0, 120)) {
      const d = diffBlueprints(a, b, { maxChanges: 100000 });
      expect(d.summary.total).toBe(d.changes.length);
      expect(d.summary.added + d.summary.removed + d.summary.modified + d.summary.moved + d.summary.reordered).toBe(d.summary.total);
      const per = Object.values(d.summary.byEntity).reduce((n, c) => n + c!.added + c!.removed + c!.modified + c!.moved + c!.reordered, 0);
      expect(per).toBe(d.summary.total);
    }
  });

  it('deterministic output: same two inputs, same bytes', () => {
    const a = bp('sprint-board'); const b = clone(a); tasksOf(b).forEach((t, i) => i % 2 && (t.title += '?'));
    expect(canonicalJson(diffBlueprints(a, b))).toBe(canonicalJson(diffBlueprints(clone(a), clone(b))));
  });
});
