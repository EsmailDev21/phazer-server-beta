import { BlueprintTask, BlueprintV1 } from '../blueprint';
import { expandModules } from './resolve.modules';
import { Issues } from './resolve.types';

const task = (nodeKey: string, children: BlueprintTask[] = [], extra: Partial<BlueprintTask> = {}): BlueprintTask =>
  ({ nodeKey, title: nodeKey, ...(children.length ? { children } : {}), ...extra });

const bp = (): BlueprintV1 => ({
  schemaVersion: 1,
  meta: { name: 'm', kind: 'WORKSPACE' },
  modules: [
    { key: 'a', label: 'A', includes: ['t2'] },
    { key: 'b', label: 'B', defaultEnabled: false, includes: ['t3', 'p2'] },
    { key: 'c', label: 'C', includes: ['t3'] },
  ],
  workspace: {
    iterations: [
      { nodeKey: 'i-all', kind: 'SPRINT', name: 'all' },
      { nodeKey: 'i-p2', kind: 'SPRINT', name: 'p2', project: 'p2' },
    ],
  },
  projects: [
    {
      nodeKey: 'p1', name: 'p1',
      tasks: [task('t1'), task('t2', [task('t2a', [task('t2a1')]), task('t2b')]), task('t3', [task('t3a')])],
      dependencies: [{ from: 't1', to: 't2' }, { from: 't2a', to: 't3' }, { from: 't1', to: 't3a' }, { from: 't2b', to: 't2a1', type: 'RELATES_TO' }],
    },
    { nodeKey: 'p2', name: 'p2', tasks: [task('u1', [], { attachments: ['f1'] })] },
  ],
  assets: [
    { key: 'f1', fileName: 'f', mimeType: 'text/plain', sizeBytes: 1, sha256: 'a'.repeat(64) },
    { key: 'f2', fileName: 'g', mimeType: 'text/plain', sizeBytes: 1, sha256: 'b'.repeat(64) },
  ],
});

const keys = (tasks: BlueprintTask[]): string[] => tasks.flatMap((t) => [t.nodeKey, ...keys(t.children ?? [])]);
const run = (choices: unknown, doc = bp()) => {
  const issues = new Issues();
  const r = expandModules(doc, choices, issues);
  return { ...r, issues: issues.items, tasks: r.blueprint.projects.flatMap((p) => keys(p.tasks)), projects: r.blueprint.projects.map((p) => p.nodeKey) };
};

describe('expandModules', () => {
  it('defaults: modules are on unless defaultEnabled is false', () => {
    const r = run(undefined);
    expect(r.enabled).toEqual({ a: true, b: false, c: true });
    // t3 is governed by b (off) and c (on): union -> kept. p2 is governed only by b (off): dropped.
    expect(r.projects).toEqual(['p1']);
    expect(r.tasks).toEqual(['t1', 't2', 't2a', 't2a1', 't2b', 't3', 't3a']);
    expect(r.dropped).toEqual({ projects: ['p2'], tasks: ['u1'], iterations: ['i-p2'], assets: ['f1'], dependencies: 0 });
  });

  it('a task takes its whole subtree with it', () => {
    const r = run({ a: false });
    expect(r.tasks).toEqual(['t1', 't3', 't3a']);
    expect(r.dropped.tasks.sort()).toEqual(['t2', 't2a', 't2a1', 't2b', 'u1'].sort());
  });

  it('dependencies with a dropped end go; the others stay', () => {
    const r = run({ a: false });
    expect(r.blueprint.projects[0].dependencies).toEqual([{ from: 't1', to: 't3a' }]);
    expect(r.dropped.dependencies).toBe(3);
  });

  it('union: a node governed by several modules stays while ANY is on', () => {
    expect(run({ b: false, c: false }).tasks).not.toContain('t3');
    expect(run({ b: true, c: false }).tasks).toContain('t3');
    expect(run({ b: false, c: true }).tasks).toContain('t3a');
  });

  it('an ancestor that is dropped wins over a child\'s own enabled module', () => {
    const doc = bp();
    doc.modules!.push({ key: 'd', label: 'D', includes: ['t2a'] });
    const r = run({ a: false, d: true }, doc);
    expect(r.tasks).not.toContain('t2a');
  });

  it('union also counts what a child inherits: own module off, parent\'s module on => kept', () => {
    const doc = bp();
    doc.modules!.push({ key: 'x', label: 'X', defaultEnabled: false, includes: ['t2a'] });
    const r = run({ a: true, x: false }, doc);
    expect(r.tasks).toContain('t2a');
    expect(r.tasks).toContain('t2a1');
    expect(run({ a: true, x: true }, doc).tasks).toContain('t2a');
  });

  it('project-scoped iterations follow their project; whole-workspace ones stay', () => {
    expect(run({ b: true }).blueprint.workspace!.iterations!.map((i) => i.nodeKey)).toEqual(['i-all', 'i-p2']);
    expect(run({}).blueprint.workspace!.iterations!.map((i) => i.nodeKey)).toEqual(['i-all']);
  });

  it('an asset only a dropped task used goes; one nobody used is left alone and not reported', () => {
    const r = run({});
    expect(r.blueprint.assets!.map((a) => a.key)).toEqual([]);
    expect(r.dropped.assets).toEqual(['f1']);
    const on = run({ b: true });
    expect(on.blueprint.assets!.map((a) => a.key)).toEqual(['f1']);
  });

  it('the result has no modules and the input is untouched', () => {
    const doc = bp();
    const before = JSON.stringify(doc);
    const r = run({ a: false }, doc);
    expect(r.blueprint.modules).toBeUndefined();
    expect(JSON.stringify(doc)).toBe(before);
  });

  it('a template without modules comes back whole', () => {
    const doc = bp();
    delete doc.modules;
    const r = run(undefined, doc);
    expect(r.tasks).toHaveLength(8);
    expect(r.dropped).toEqual({ projects: [], tasks: [], iterations: [], assets: [], dependencies: 0 });
  });

  it('validates the choices', () => {
    expect(run({ nope: true }).issues.map((i) => i.code)).toEqual(['MODULE_UNKNOWN']);
    expect(run({ a: 'yes' }).issues.map((i) => i.code)).toEqual(['MODULE_INVALID']);
    expect(run('x').issues.map((i) => i.code)).toEqual(['MODULE_INVALID']);
    expect(run(JSON.parse('{"__proto__":{"a":false}}')).issues.map((i) => i.code)).toEqual(['MODULE_UNKNOWN']);
  });

  describe('property: agrees with an independent oracle on random trees and modules', () => {
    let seed = 777;
    const rnd = (n: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;

    // oracle: path-based, no recursion shared with the implementation
    const oracle = (doc: BlueprintV1, enabled: Record<string, boolean>): Set<string> => {
      const keep = new Set<string>();
      const walk = (t: BlueprintTask, ancestors: string[]) => {
        const chain = [...ancestors, t.nodeKey];
        const governing = doc.modules!.filter((m) => m.includes.some((k) => chain.includes(k)));
        const ok = governing.length === 0 || governing.some((m) => enabled[m.key]);
        // dropped if any node on the chain is itself dropped
        const chainOk = chain.every((_, i) => {
          const sub = chain.slice(0, i + 1);
          const g = doc.modules!.filter((m) => m.includes.some((k) => sub.includes(k)));
          return g.length === 0 || g.some((m) => enabled[m.key]);
        });
        if (ok && chainOk) {
          keep.add(t.nodeKey);
          (t.children ?? []).forEach((c) => walk(c, chain));
        }
      };
      doc.projects.forEach((p) => p.tasks.forEach((t) => walk(t, [p.nodeKey])));
      return keep;
    };

    it('300 random documents', () => {
      for (let n = 0; n < 300; n++) {
        let id = 0;
        const make = (depth: number): BlueprintTask[] =>
          Array.from({ length: 1 + rnd(3) }, () => task(`n${id++}`, depth < 2 && rnd(2) ? make(depth + 1) : []));
        const doc: BlueprintV1 = {
          schemaVersion: 1, meta: { name: 'm', kind: 'WORKSPACE' },
          projects: [{ nodeKey: 'P', name: 'P', tasks: make(0) }],
        };
        const all: string[] = keys(doc.projects[0].tasks);
        doc.modules = Array.from({ length: 1 + rnd(4) }, (_, i) => ({
          key: `m${i}`, label: 'm', includes: Array.from(new Set(Array.from({ length: 1 + rnd(3) }, () => all[rnd(all.length)]))),
        }));
        const enabled = Object.fromEntries(doc.modules.map((m) => [m.key, rnd(2) === 1]));
        const r = run(enabled, doc);
        const expected = oracle(doc, enabled);
        expect(new Set(r.tasks)).toEqual(expected);
        expect(r.dropped.tasks.length + r.tasks.length).toBe(all.length);
      }
    });
  });
});
