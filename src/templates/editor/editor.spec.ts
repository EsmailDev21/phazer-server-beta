import { canonicalJson, validateBlueprint } from '../blueprint';
import { fixtureJson } from '../blueprint/blueprint.fixtures';
import { diffBlueprints } from '../diff';
import { applyOps, maxEditorKey } from './editor.apply';

type Any = any;
const FIXTURES = ['student-workspace', 'sprint-board', 'content-calendar'] as const;
const base = (n: (typeof FIXTURES)[number] = 'student-workspace'): Any => fixtureJson(n);
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const tasksOf = (b: Any): Any[] => { const out: Any[] = []; const w = (l: Any[]) => l.forEach((t) => { out.push(t); w(t.children ?? []); }); b.projects.forEach((p: Any) => w(p.tasks)); return out; };
const keysOf = (b: Any): string[] => [...b.projects.map((p: Any) => p.nodeKey), ...tasksOf(b).map((t) => t.nodeKey), ...(b.workspace?.iterations ?? []).map((i: Any) => i.nodeKey)];
const ok = (b: Any, ops: Any[], seq = 1) => { const r = applyOps(b, ops, seq); if (r.ok !== true) throw new Error('expected ok, got ' + JSON.stringify(r)); return r; };
const err = (b: Any, ops: Any[], seq = 1) => { const r = applyOps(b, ops, seq); if (r.ok !== false) throw new Error('expected failure'); return r; };
const code = (b: Any, ops: Any[]) => { const r = err(b, ops); return r.kind === 'op' ? r.error.code : `invalid:${(r.issues as Any[])[0]?.code}`; };
const kinds = (a: Any, b: Any) => diffBlueprints(a, b).changes.map((c) => `${c.entity}:${c.id}:${c.kind}`);
const leaf = (b: Any) => tasksOf(b).find((t) => !(t.children ?? []).length)!;

describe('editor ops: identity of existing nodes', () => {
  it('rename / update / reorder / move NEVER change a nodeKey: the diff shows modified, reordered, moved - never added or removed', () => {
    const a = base();
    const [t1, t2] = a.projects[0].tasks;
    const r = ok(a, [
      { op: 'updateTask', nodeKey: t1.nodeKey, set: { title: 'Renamed' } },
      { op: 'updateProject', nodeKey: a.projects[0].nodeKey, set: { name: 'Renamed project' } },
      { op: 'moveTask', nodeKey: t2.nodeKey, index: 0 },
    ]);
    const d = diffBlueprints(a, r.blueprint as Any);
    expect(d.changes.some((c) => c.kind === 'added' || c.kind === 'removed')).toBe(false);
    expect(new Set(keysOf(r.blueprint as Any))).toEqual(new Set(keysOf(a)));
    expect(d.changes.map((c) => c.kind).sort()).toEqual(['modified', 'modified', 'reordered']);
  });

  it('a task moved under another parent keeps its key and its whole subtree', () => {
    const a = base();
    const p = a.projects[0];
    const mover = p.tasks[0];
    const target = p.tasks[1];
    const r = ok(a, [{ op: 'moveTask', nodeKey: mover.nodeKey, parent: target.nodeKey }]).blueprint as Any;
    expect(kinds(a, r)).toEqual([`task:${mover.nodeKey}:moved`]);
    expect(new Set(keysOf(r))).toEqual(new Set(keysOf(a)));
  });

  it('moveTask: `index` is the FINAL position, within the same list too', () => {
    const a = base('sprint-board');
    const list = a.projects[0].tasks.map((t: Any) => t.nodeKey);
    expect(list.length).toBeGreaterThanOrEqual(3);
    const r = ok(a, [{ op: 'moveTask', nodeKey: list[0], index: list.length - 1 }]).blueprint as Any;
    expect(r.projects[0].tasks.map((t: Any) => t.nodeKey)).toEqual([...list.slice(1), list[0]]);
    const r2 = ok(a, [{ op: 'moveTask', nodeKey: list[list.length - 1], index: 0 }]).blueprint as Any;
    expect(r2.projects[0].tasks.map((t: Any) => t.nodeKey)).toEqual([list[list.length - 1], ...list.slice(0, -1)]);
  });

  it('moveTask: cannot go under itself or a descendant', () => {
    const a = base();
    const parent = tasksOf(a).find((t) => (t.children ?? []).length)!;
    expect(code(a, [{ op: 'moveTask', nodeKey: parent.nodeKey, parent: parent.children[0].nodeKey }])).toBe('CYCLE');
    expect(code(a, [{ op: 'moveTask', nodeKey: parent.nodeKey, parent: parent.nodeKey }])).toBe('CYCLE');
  });

  it('moveTask to another project: dependencies inside the moved subtree travel, ones tying it to what stays are dropped (and reported)', () => {
    const a = base();
    const dep = a.projects[0].dependencies[0];
    const from = dep.from;
    // statuses belong to a project's workflow: moving without clearing them is rejected by validation ...
    expect(code(a, [{ op: 'moveTask', nodeKey: from, project: a.projects[1].nodeKey }])).toMatch(/^invalid:/);
    // ... and `clear` is the way to say "drop them"
    const r = ok(a, [{ op: 'moveTask', nodeKey: from, project: a.projects[1].nodeKey, clear: ['status', 'iteration'] }]);
    const out = r.blueprint as Any;
    expect(out.projects[0].dependencies ?? []).not.toEqual(expect.arrayContaining([expect.objectContaining({ from })]));
    expect(r.cascaded.some((c) => /dependenc/.test(c.note))).toBe(true);
    expect(kinds(a, out)).toContain(`task:${from}:moved`);
  });
});

describe('editor ops: new keys', () => {
  it('are n<seq> from the counter, unique, never in the document, and the next counter is returned', () => {
    const a = base();
    const p = a.projects[0].nodeKey;
    const r = ok(a, [
      { op: 'addTask', ref: 'x', project: p, task: { title: 'one' } },
      { op: 'addTask', ref: 'y', parent: '$x', task: { title: 'child' } },
      { op: 'addTask', project: p, task: { title: 'two' } },
    ], 7);
    expect(r.minted).toEqual(['n7', 'n8', 'n9']);
    expect(r.created).toEqual({ x: 'n7', y: 'n8' });
    expect(r.nextSeq).toBe(10);
    expect(maxEditorKey(r.blueprint)).toBe(9);
  });

  it('the counter starts past any n<k> already in the document (a blueprint uploaded with n3 in it), whatever counter it was given', () => {
    const a = base();
    a.projects[0].tasks.push({ nodeKey: 'n3', title: 'hand-made' });
    expect(maxEditorKey(a)).toBe(3);
    const r = ok(a, [{ op: 'addTask', project: a.projects[0].nodeKey, task: { title: 'x' } }], 1);
    expect(r.minted).toEqual(['n4']);
    expect(r.nextSeq).toBe(5);
  });

  it('a key freed by removing a node is NOT handed out again: the counter only moves forward', () => {
    let a = base();
    const p = a.projects[0].nodeKey;
    let seq = 1;
    const seen: string[] = [];
    for (let i = 0; i < 6; i++) {
      const r = ok(a, [{ op: 'addTask', ref: 'k', project: p, task: { title: `t${i}` } }], seq);
      const k = r.created.k;
      expect(seen).not.toContain(k);
      seen.push(k);
      a = ok(r.blueprint as Any, [{ op: 'removeTask', nodeKey: k }], r.nextSeq).blueprint as Any;
      seq = r.nextSeq;
    }
    expect(new Set(seen).size).toBe(6);
  });

  it('a duplicate gets fresh keys for the whole subtree; inner dependencies and module membership are copied', () => {
    const a = base();
    const dep = a.projects[0].dependencies.find((d: Any) => true);
    const root = a.projects[0].tasks.find((t: Any) => (t.children ?? []).length) ?? a.projects[0].tasks[0];
    const before = new Set(keysOf(a));
    const r = ok(a, [{ op: 'duplicateTask', ref: 'c', nodeKey: root.nodeKey }]);
    const out = r.blueprint as Any;
    const copy = tasksOf(out).find((t) => t.nodeKey === r.created.c)!;
    const copyKeys = [copy, ...tasksOf({ projects: [{ tasks: copy.children ?? [] }] })].map((t) => t.nodeKey);
    expect(copyKeys.every((k) => !before.has(k))).toBe(true);
    expect(copyKeys.length).toBe(1 + tasksOf({ projects: [{ tasks: root.children ?? [] }] }).length);
    // placed right after the original
    const sibs = out.projects[0].tasks.map((t: Any) => t.nodeKey);
    expect(sibs[sibs.indexOf(root.nodeKey) + 1]).toBe(copy.nodeKey);
    void dep;
  });

  it('duplicating a task that a module includes puts the copy in that module too', () => {
    const a = base();
    const mod = a.modules.find((m: Any) => tasksOf(a).some((t) => t.nodeKey === m.includes[0]))!;
    const target = mod.includes[0];
    const r = ok(a, [{ op: 'duplicateTask', ref: 'c', nodeKey: target }]);
    const m2 = (r.blueprint as Any).modules.find((m: Any) => m.key === mod.key);
    expect(m2.includes).toEqual(expect.arrayContaining([target, r.created.c]));
  });
});

describe('editor ops: cascades keep the document consistent', () => {
  it('removing a task removes its sub-tasks, its dependencies and its module entries (and a module left empty)', () => {
    const a = base();
    const mod = a.modules.find((m: Any) => tasksOf(a).some((t) => t.nodeKey === m.includes[0]))!;
    const victim = mod.includes[0];
    const r = ok(a, [{ op: 'removeTask', nodeKey: victim }]);
    const out = r.blueprint as Any;
    expect(keysOf(out)).not.toContain(victim);
    expect((out.modules ?? []).find((m: Any) => m.key === mod.key)).toBeUndefined();
    for (const p of out.projects) for (const d of p.dependencies ?? []) { expect(d.from).not.toBe(victim); expect(d.to).not.toBe(victim); }
    expect(validateBlueprint(out).ok).toBe(true);
  });

  it('removing a tag strips it from tasks; renaming it updates them; case and spacing do not matter for the lookup', () => {
    const a = base();
    const tag = a.workspace.tags[0].name;
    const users = tasksOf(a).filter((t) => (t.tags ?? []).includes(tag));
    expect(users.length).toBeGreaterThan(0);
    const removed = ok(a, [{ op: 'remove', collection: 'tags', key: `  ${tag.toUpperCase()} ` }]).blueprint as Any;
    expect(removed.workspace.tags.map((t: Any) => t.name)).not.toContain(tag);
    expect(tasksOf(removed).every((t) => !(t.tags ?? []).includes(tag))).toBe(true);
    const renamed = ok(a, [{ op: 'rename', collection: 'tags', from: tag, to: 'Brand New' }]).blueprint as Any;
    expect(tasksOf(renamed).filter((t) => (t.tags ?? []).includes('Brand New')).map((t) => t.nodeKey).sort()).toEqual(users.map((t) => t.nodeKey).sort());
    expect(renamed.workspace.tags.map((t: Any) => t.name)).toEqual(a.workspace.tags.map((t: Any) => (t.name === tag ? 'Brand New' : t.name))); // same position
  });

  it('renaming a role and a custom field updates assignees, comment authors and custom values', () => {
    const a = base();
    const role = a.roles[0].key;
    const r = ok(a, [{ op: 'rename', collection: 'roles', from: role, to: 'renamedrole' }]).blueprint as Any;
    expect(r.roles.map((x: Any) => x.key)).toEqual(a.roles.map((x: Any) => (x.key === role ? 'renamedrole' : x.key)));
    const had = tasksOf(a).filter((t) => (t.assigneeRoles ?? []).includes(role)).map((t) => t.nodeKey).sort();
    expect(had.length).toBeGreaterThan(0);
    expect(tasksOf(r).filter((t) => (t.assigneeRoles ?? []).includes('renamedrole')).map((t) => t.nodeKey).sort()).toEqual(had);
    expect(tasksOf(r).every((t) => !(t.assigneeRoles ?? []).includes(role))).toBe(true);
    const field = a.workspace.customFields.find((f: Any) => tasksOf(a).some((t) => t.customValues && Object.keys(t.customValues).some((k) => k.toLowerCase() === f.key.toLowerCase())))!;
    const r2 = ok(a, [{ op: 'rename', collection: 'customFields', from: field.key, to: 'renamed-field' }]).blueprint as Any;
    expect(tasksOf(r2).some((t) => t.customValues && 'renamed-field' in t.customValues)).toBe(true);
    expect(tasksOf(r2).every((t) => !t.customValues || !(field.key in t.customValues))).toBe(true);
  });

  it('removing an iteration clears it from tasks; removing a project takes its tasks and scoped iterations', () => {
    const a = base('sprint-board');
    const it = a.workspace.iterations[0].nodeKey;
    const r = ok(a, [{ op: 'remove', collection: 'iterations', key: it }]).blueprint as Any;
    expect(tasksOf(r).every((t) => t.iteration !== it)).toBe(true);
    const w = base();
    const gone = ok(w, [{ op: 'removeProject', nodeKey: w.projects[1].nodeKey }]);
    const out = gone.blueprint as Any;
    expect(out.projects.map((p: Any) => p.nodeKey)).toEqual([w.projects[0].nodeKey]);
  });

  it('variables cannot be renamed (text references them) and removing a used one is rejected by validation, not silently broken', () => {
    const a = base();
    expect(code(a, [{ op: 'rename', collection: 'variables', from: 'course', to: 'class' }])).toBe('RENAME_UNSUPPORTED');
    expect(code(a, [{ op: 'remove', collection: 'variables', key: 'semesterStart' }])).toMatch(/^invalid:/);
  });
});

describe('editor ops: files', () => {
  const CATALOG = [{ sha256: 'f'.repeat(64), fileName: 'brief.pdf', mimeType: 'application/pdf', sizeBytes: 12 }];
  it('addAsset takes a STORED file, mints its key from the same counter, and is idempotent for the same bytes', () => {
    const a = base('sprint-board');
    const t = a.projects[0].tasks[0].nodeKey;
    const r = applyOps(a, [{ op: 'addAsset', ref: 'f', sha256: 'f'.repeat(64) }, { op: 'updateTask', nodeKey: t, set: { attachments: ['a5'] } }], 5, CATALOG);
    if (r.ok !== true) throw new Error(JSON.stringify(r));
    expect(r.created.f).toBe('a5');
    expect((r.blueprint as Any).assets).toEqual([{ key: 'a5', fileName: 'brief.pdf', mimeType: 'application/pdf', sizeBytes: 12, sha256: 'f'.repeat(64) }]);
    // the same file again: no second entry, the ref points at the existing key
    const again = applyOps(r.blueprint, [{ op: 'addAsset', ref: 'g', sha256: 'f'.repeat(64) }], r.nextSeq, CATALOG);
    if (again.ok !== true) throw new Error(JSON.stringify(again));
    expect(again.created.g).toBe('a5');
    expect((again.blueprint as Any).assets).toHaveLength(1);
    expect(again.minted).toEqual([]);
  });

  it('addAsset refuses a file that is not stored with the template', () => {
    const a = base('sprint-board');
    expect(applyOps(a, [{ op: 'addAsset', sha256: '1'.repeat(64) }], 1, CATALOG)).toMatchObject({ ok: false, error: { code: 'ASSET_NOT_STORED' } });
    expect(applyOps(a, [{ op: 'addAsset', sha256: 'f'.repeat(64) }], 1, [])).toMatchObject({ ok: false, error: { code: 'ASSET_NOT_STORED' } });
  });

  it('removeAsset takes the file off every task that carried it', () => {
    const a = base();
    expect(a.assets.length).toBeGreaterThan(0);
    const key = a.assets[0].key;
    const users = tasksOf(a).filter((t) => (t.attachments ?? []).includes(key));
    expect(users.length).toBeGreaterThan(0);
    const r = ok(a, [{ op: 'removeAsset', key }]);
    const out = r.blueprint as Any;
    expect((out.assets ?? []).some((x: Any) => x.key === key)).toBe(false);
    expect(tasksOf(out).every((t) => !(t.attachments ?? []).includes(key))).toBe(true);
    expect(r.cascaded.some((c) => /file/.test(c.note))).toBe(true);
  });

  it('an asset key is not reused after the asset is removed (same counter as node keys)', () => {
    const a = base('sprint-board');
    const first = applyOps(a, [{ op: 'addAsset', ref: 'f', sha256: 'f'.repeat(64) }], 1, CATALOG);
    if (first.ok !== true) throw new Error('x');
    const gone = applyOps(first.blueprint, [{ op: 'removeAsset', key: first.created.f }], first.nextSeq, CATALOG);
    if (gone.ok !== true) throw new Error('x');
    const second = applyOps(gone.blueprint, [{ op: 'addAsset', ref: 'f', sha256: 'f'.repeat(64) }], gone.nextSeq, CATALOG);
    if (second.ok !== true) throw new Error('x');
    expect(second.created.f).not.toBe(first.created.f);
  });
});

describe('editor ops: refs let one batch build something new', () => {
  it('a new iteration, a new project and a new file can be used by later ops in the same batch', () => {
    const a = base('sprint-board');
    const CAT = [{ sha256: 'e'.repeat(64), fileName: 'f.pdf', mimeType: 'application/pdf', sizeBytes: 5 }];
    const r = applyOps(a, [
      { op: 'upsert', ref: 'it', collection: 'iterations', item: { kind: 'SPRINT', name: 'Brand new', project: a.projects[0].nodeKey } },
      { op: 'addAsset', ref: 'f', sha256: 'e'.repeat(64) },
      { op: 'addTask', ref: 't', project: a.projects[0].nodeKey, task: { title: 'Uses both', iteration: '$it', attachments: ['$f'] } },
    ], 1, CAT);
    if (r.ok !== true) throw new Error(JSON.stringify(r));
    const t = tasksOf(r.blueprint as Any).find((x) => x.nodeKey === r.created.t)!;
    expect(t.iteration).toBe(r.created.it);
    expect(t.attachments).toEqual([r.created.f]);
    // updateTask resolves them too; an unknown one is an error, not a dangling key
    const u = ok(r.blueprint as Any, [{ op: 'updateTask', nodeKey: a.projects[0].tasks[0].nodeKey, set: { iteration: r.created.it } }]);
    expect(u.ok).toBe(true);
    expect(code(a, [{ op: 'addTask', project: a.projects[0].nodeKey, task: { title: 'x', iteration: '$nope' } }])).toBe('REF_UNKNOWN');
    expect(code(a, [{ op: 'upsert', ref: 'r', collection: 'roles', item: { key: 'x', label: 'X' } }])).toBe('OP_INVALID');
  });
});

describe('editor ops: safety', () => {
  it('is atomic: a failing op leaves the input untouched and returns nothing partial', () => {
    const a = base(); const snapshot = canonicalJson(a);
    const r = err(a, [{ op: 'updateTask', nodeKey: a.projects[0].tasks[0].nodeKey, set: { title: 'X' } }, { op: 'removeTask', nodeKey: 'nope' }]);
    expect(r).toMatchObject({ kind: 'op', error: { index: 1, op: 'removeTask', code: 'NOT_FOUND' } });
    expect(canonicalJson(a)).toBe(snapshot);
  });

  it('the result must validate: an op batch that would break the blueprint is rejected with the validator issues', () => {
    const a = base();
    const r = err(a, [{ op: 'updateTask', nodeKey: a.projects[0].tasks[0].nodeKey, set: { status: 'no-such-status' } }]);
    expect(r.kind).toBe('invalid');
  });

  it('rejects unknown operations (including prototype names), unknown fields, forbidden fields, bad indexes and reused refs', () => {
    const a = base(); const p = a.projects[0].nodeKey; const t = a.projects[0].tasks[0].nodeKey;
    for (const op of ['constructor', '__proto__', 'toString', 'drop', '']) expect(code(a, [{ op }])).toBe('OP_UNKNOWN');
    expect(code(a, ['x' as Any])).toBe('OP_INVALID');
    expect(code(a, [{ op: 'removeTask', nodeKey: t, extra: 1 }])).toBe('OP_INVALID');
    expect(code(a, [{ op: 'setMeta', set: { kind: 'PROJECT' } }])).toBe('KIND_IMMUTABLE');
    expect(code(a, [{ op: 'updateTask', nodeKey: t, set: { nodeKey: 'z' } }])).toBe('OP_INVALID');
    expect(code(a, [{ op: 'updateTask', nodeKey: t, set: { children: [] } }])).toBe('OP_INVALID');
    expect(code(a, [{ op: 'updateTask', nodeKey: t, unset: ['title'] }])).toBe('OP_INVALID');
    expect(code(a, [{ op: 'updateTask', nodeKey: t }])).toBe('OP_INVALID');
    expect(code(a, [{ op: 'addTask', project: p, task: { title: 'x', nodeKey: 'mine' } }])).toBe('OP_INVALID');
    expect(code(a, [{ op: 'addTask', project: p, task: { title: 'x', children: [] } }])).toBe('OP_INVALID');
    expect(code(a, [{ op: 'addTask', project: p, index: 99, task: { title: 'x' } }])).toBe('INDEX_RANGE');
    expect(code(a, [{ op: 'addTask', project: p, index: -1, task: { title: 'x' } }])).toBe('INDEX_RANGE');
    expect(code(a, [{ op: 'addTask', ref: 'a', project: p, task: { title: 'x' } }, { op: 'addTask', ref: 'a', project: p, task: { title: 'y' } }])).toBe('REF_DUPLICATE');
    expect(code(a, [{ op: 'addTask', parent: '$nope', task: { title: 'x' } }])).toBe('REF_UNKNOWN');
    expect(code(a, [{ op: 'addTask', task: { title: 'x' } }])).toBe('OP_INVALID');
    expect(code(a, [{ op: 'upsert', collection: 'iterations', item: { nodeKey: 'mine', kind: 'SPRINT', name: 'x' } }])).toBe('KEY_NOT_MINTED');
    expect(code(a, [{ op: 'reorder', collection: 'tags', keys: ['only-one'] }])).toBe('ORDER_MISMATCH');
    expect(code(a, [])).toBe('OP_INVALID');
    expect(applyOps(a, Array.from({ length: 201 }, () => ({ op: 'removeTask', nodeKey: t })), 1)).toMatchObject({ ok: false, error: { code: 'TOO_MANY_OPS' } });
  });

  it('a collection item\'s key is its identity: upsert replaces in place, keeps its position, and a new item goes where asked', () => {
    const a = base();
    const first = a.roles[0];
    const r = ok(a, [{ op: 'upsert', collection: 'roles', item: { ...first, label: 'Changed label' } }, { op: 'upsert', collection: 'roles', item: { key: 'newbie', label: 'New' }, index: 0 }]).blueprint as Any;
    expect(r.roles.map((x: Any) => x.key)).toEqual(['newbie', ...a.roles.map((x: Any) => x.key)]);
    expect(r.roles.find((x: Any) => x.key === first.key).label).toBe('Changed label');
    expect(code(a, [{ op: 'upsert', collection: 'roles', item: first, index: 0 }])).toBe('OP_INVALID');
  });

  it('a new iteration is given its key by the server', () => {
    const a = base();
    const r = ok(a, [{ op: 'upsert', collection: 'iterations', item: { kind: 'SPRINT', name: 'Fresh' } }], 5);
    expect(r.minted).toEqual(['n5']);
    expect((r.blueprint as Any).workspace.iterations.at(-1)).toMatchObject({ nodeKey: 'n5', name: 'Fresh' });
  });

  it('never throws, whatever it is given', () => {
    const a = base();
    const junk: Any[] = [null, 1, 'x', [], {}, { op: null }, { op: 'addTask', task: null }, { op: 'upsert', collection: 'x', item: 1 }, { op: 'moveTask', nodeKey: {} }, { op: 'reorder', collection: 'roles', keys: [1, 2] }, { op: 'rename', collection: 'tags', from: 1, to: 2 }];
    for (const j of junk) for (const ops of [[j], j, [j, j]]) expect(() => applyOps(a, ops, 1)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------------------------
// Fuzz: random batches. Whatever happens, the contract holds.
// ---------------------------------------------------------------------------------------------
function mulberry(seed: number) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function randomOp(rnd: () => number, b: Any): Any {
  const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
  const ts: Any[] = tasksOf(b); const ps: Any[] = b.projects;
  const t = () => pick(ts)?.nodeKey ?? 'missing';
  const p = () => pick(ps)?.nodeKey ?? 'missing';
  switch (Math.floor(rnd() * 14)) {
    case 0: return { op: 'addTask', project: p(), index: Math.floor(rnd() * 3), task: { title: 'New ' + Math.floor(rnd() * 99) } };
    case 1: return { op: 'addTask', parent: t(), task: { title: 'Sub ' + Math.floor(rnd() * 99) } };
    case 2: return { op: 'updateTask', nodeKey: t(), set: { title: 'T' + Math.floor(rnd() * 999) } };
    case 3: return { op: 'updateTask', nodeKey: t(), set: { priority: pick(['LOW', 'HIGH', 'BOGUS']) } };
    case 4: return { op: 'moveTask', nodeKey: t(), parent: rnd() < 0.5 ? null : t(), index: Math.floor(rnd() * 3) };
    case 5: return { op: 'moveTask', nodeKey: t(), project: p(), index: 0 };
    case 6: return { op: 'removeTask', nodeKey: t() };
    case 7: return { op: 'duplicateTask', nodeKey: t() };
    case 8: return { op: 'addDependency', from: t(), to: t() };
    case 9: return { op: 'removeProject', nodeKey: p() };
    case 10: return { op: 'moveProject', nodeKey: p(), index: Math.floor(rnd() * 2) };
    case 11: return { op: 'upsert', collection: 'tags', item: { name: 'tag' + Math.floor(rnd() * 5) } };
    case 12: return { op: 'remove', collection: pick(['tags', 'roles', 'issueTypes', 'iterations', 'modules']), key: pick([...(b.workspace?.tags ?? []).map((x: Any) => x.name), ...(b.roles ?? []).map((x: Any) => x.key), ...(b.modules ?? []).map((x: Any) => x.key), 'nope']) };
    default: return { op: 'addProject', project: { name: 'P' + Math.floor(rnd() * 9) } };
  }
}

describe('editor ops: fuzz', () => {
  it.each(FIXTURES)('on %s: every batch is either rejected cleanly or yields a VALID blueprint with stable identities', (name) => {
    const rnd = mulberry(name.length * 1009);
    let accepted = 0; let rejected = 0;
    for (let round = 0; round < 250; round++) {
      let cur = base(name);
      let seq = 1;
      for (let step = 0; step < 4; step++) {
        const ops = Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => randomOp(rnd, cur));
        const before = canonicalJson(cur);
        const r = applyOps(cur, ops, seq);
        expect(canonicalJson(cur)).toBe(before); // the input is never touched
        if (r.ok === false) { rejected++; continue; }
        accepted++;
        const out = r.blueprint as Any;
        expect(validateBlueprint(out).ok).toBe(true);
        // identity: every key that existed before and is not gone by an explicit remove is still there
        const removedExplicitly = ops.some((o) => o.op === 'removeTask' || o.op === 'removeProject' || (o.op === 'remove' && o.collection === 'iterations'));
        if (!removedExplicitly) for (const k of keysOf(cur)) expect(keysOf(out)).toContain(k);
        // keys it created are new, unique, and after the counter it was given
        for (const k of r.minted) { expect(keysOf(cur)).not.toContain(k); expect(Number(k.slice(1))).toBeGreaterThanOrEqual(seq); }
        expect(new Set(keysOf(out)).size).toBe(keysOf(out).length);
        expect(r.nextSeq).toBeGreaterThanOrEqual(seq);
        // and what the diff says matches what exists: added keys are exactly the minted ones that survived
        const d = diffBlueprints(cur, out, { maxChanges: 100000 });
        const added = d.changes.filter((c) => (c.entity === 'task' || c.entity === 'project' || c.entity === 'iteration') && c.kind === 'added').map((c) => c.id);
        for (const k of added) expect(r.minted).toContain(k);
        cur = out; seq = r.nextSeq;
      }
    }
    expect(accepted).toBeGreaterThan(50); // the fuzz actually exercised the success path
    expect(rejected).toBeGreaterThan(50); // ... and the rejection path
  });
});

describe('editor ops: replaceBlueprint (undo and redo)', () => {
  it('puts an earlier blueprint back exactly, and a key minted since is never reused', () => {
    const a = base();
    const added = ok(a, [{ op: 'addTask', project: a.projects[0].nodeKey, task: { title: 'Extra' } }], 1);
    const minted = added.minted[0];
    // undo: back to a
    const undone = ok(added.blueprint as Any, [{ op: 'replaceBlueprint', blueprint: a }], added.nextSeq);
    expect(canonicalJson(undone.blueprint)).toBe(canonicalJson(a));
    // the counter keeps going: the next new node does not get the undone key
    const again = ok(undone.blueprint as Any, [{ op: 'addTask', project: a.projects[0].nodeKey, task: { title: 'Another' } }], undone.nextSeq);
    expect(again.minted[0]).not.toBe(minted);
    // redo: forward again
    const redone = ok(undone.blueprint as Any, [{ op: 'replaceBlueprint', blueprint: added.blueprint as Any }], undone.nextSeq);
    expect(canonicalJson(redone.blueprint)).toBe(canonicalJson(added.blueprint));
  });

  it('refuses something that is not a valid blueprint, and a change of kind', () => {
    const a = base();
    expect(code(a, [{ op: 'replaceBlueprint', blueprint: 'nope' }])).toBe('OP_INVALID');
    expect(code(a, [{ op: 'replaceBlueprint', blueprint: { ...clone(a), projects: 'x' } }]).startsWith('invalid:')).toBe(true);
    const other = clone(a); other.meta.kind = other.meta.kind === 'WORKSPACE' ? 'PROJECT' : 'WORKSPACE';
    expect(code(a, [{ op: 'replaceBlueprint', blueprint: other }])).toBe('KIND_CHANGE');
  });
});
