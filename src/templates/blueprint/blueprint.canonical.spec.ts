import { blueprintChecksum, canonicalJson } from './blueprint.canonical';
import { fixtureJson, GOLDEN_FIXTURES } from './blueprint.fixtures';

describe('canonicalJson / blueprintChecksum', () => {
  it('sorts keys at every depth, keeps array order, writes no whitespace', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(
      '{"a":[2,{"c":2,"d":1}],"b":1}',
    );
    expect(canonicalJson([{ y: 1, x: 2 }, 3])).toBe('[{"x":2,"y":1},3]');
  });

  it('is independent of the order keys were written in', () => {
    const a = {
      schemaVersion: 1,
      meta: { name: 'n', kind: 'WORKSPACE' },
      projects: [],
    };
    const b = {
      projects: [],
      meta: { kind: 'WORKSPACE', name: 'n' },
      schemaVersion: 1,
    };
    expect(blueprintChecksum(a)).toBe(blueprintChecksum(b));
  });

  it('is sensitive to array order and to any value change', () => {
    expect(blueprintChecksum({ a: [1, 2] })).not.toBe(
      blueprintChecksum({ a: [2, 1] }),
    );
    expect(blueprintChecksum({ a: 'x' })).not.toBe(
      blueprintChecksum({ a: 'y' }),
    );
    expect(blueprintChecksum({ a: 1 })).not.toBe(blueprintChecksum({ a: '1' }));
  });

  it('has a fixed, recognisable format', () => {
    expect(blueprintChecksum({})).toMatch(/^sha256:[0-9a-f]{64}$/);
    // sha256("{}") - a known vector
    expect(blueprintChecksum({})).toBe(
      'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
    );
  });

  it('keeps a "__proto__" key as data instead of running the setter', () => {
    const hostile = JSON.parse('{"b":1,"__proto__":{"polluted":true},"a":2}');
    const text = canonicalJson(hostile);
    expect(text).toBe('{"__proto__":{"polluted":true},"a":2,"b":1}');
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it.each(GOLDEN_FIXTURES)(
    'the %s fixture checksums the same after a key shuffle',
    (name) => {
      const doc = fixtureJson(name);
      const shuffle = (v: unknown): unknown =>
        Array.isArray(v)
          ? v.map(shuffle)
          : v && typeof v === 'object'
            ? Object.fromEntries(
                Object.entries(v)
                  .reverse()
                  .map(([k, x]) => [k, shuffle(x)]),
              )
            : v;
      expect(blueprintChecksum(shuffle(doc))).toBe(blueprintChecksum(doc));
    },
  );
});
