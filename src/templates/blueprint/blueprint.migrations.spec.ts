import {
  migrateToCurrent,
  MIGRATIONS,
  MigrationRegistry,
} from './blueprint.migrations';

describe('migrateToCurrent', () => {
  const v1 = () => ({ schemaVersion: 1, meta: { name: 'x' }, projects: [] });

  it('the shipped registry is empty: v1 is the first version', () => {
    expect(Object.keys(MIGRATIONS)).toEqual([]);
  });

  it('a current document passes through untouched, same object, zero steps', () => {
    const doc = v1();
    const r = migrateToCurrent(doc);
    expect(r).toEqual({ ok: true, doc, fromVersion: 1, steps: 0 });
    if (r.ok === true) expect(r.doc).toBe(doc);
  });

  describe('with a registry (the hook, exercised before v2 exists)', () => {
    const registry: MigrationRegistry = {
      1: (d) => ({ ...d, schemaVersion: 2, addedIn2: true }),
      2: (d) => ({ ...d, schemaVersion: 3, addedIn3: true }),
    };

    it('runs the chain one version at a time, in order', () => {
      const order: number[] = [];
      const logged: MigrationRegistry = {
        1: (d) => (order.push(1), registry[1](d)),
        2: (d) => (order.push(2), registry[2](d)),
      };
      const r = migrateToCurrent(v1(), {
        migrations: logged,
        currentVersion: 3,
      });
      expect(order).toEqual([1, 2]);
      expect(r).toMatchObject({ ok: true, fromVersion: 1, steps: 2 });
      if (r.ok === true)
        expect(r.doc).toMatchObject({
          schemaVersion: 3,
          addedIn2: true,
          addedIn3: true,
        });
    });

    it("starts at the document's own version", () => {
      const r = migrateToCurrent(
        { ...v1(), schemaVersion: 2 },
        { migrations: registry, currentVersion: 3 },
      );
      expect(r).toMatchObject({ ok: true, fromVersion: 2, steps: 1 });
    });

    it('never mutates what it was given', () => {
      const doc = v1();
      const before = JSON.stringify(doc);
      migrateToCurrent(doc, { migrations: registry, currentVersion: 3 });
      expect(JSON.stringify(doc)).toBe(before);
    });

    it('a missing step is an error, not a skip', () => {
      const r = migrateToCurrent(v1(), {
        migrations: { 2: registry[2] },
        currentVersion: 3,
      });
      expect(r).toMatchObject({ ok: false, code: 'MIGRATION_MISSING' });
    });

    it('a migration must return a NEW object at the next version', () => {
      const cases: MigrationRegistry[] = [
        { 1: (d) => d }, // same object
        { 1: (d) => ({ ...d }) }, // forgot to bump
        { 1: (d) => ({ ...d, schemaVersion: 5 }) }, // jumped
        { 1: () => null as never },
        { 1: () => [] as never },
      ];
      for (const migrations of cases) {
        expect(
          migrateToCurrent(v1(), { migrations, currentVersion: 2 }),
        ).toMatchObject({
          ok: false,
          code: 'MIGRATION_BROKEN',
        });
      }
    });

    it('a migration that throws is reported, not propagated', () => {
      const r = migrateToCurrent(v1(), {
        migrations: {
          1: () => {
            throw new Error('boom');
          },
        },
        currentVersion: 2,
      });
      expect(r).toMatchObject({ ok: false, code: 'MIGRATION_BROKEN' });
      if (r.ok === false) expect(r.message).toContain('boom');
    });

    it('does not look up inherited keys of the registry', () => {
      const r = migrateToCurrent(
        { ...v1() },
        { migrations: Object.create({ 1: registry[1] }), currentVersion: 2 },
      );
      expect(r).toMatchObject({ ok: false, code: 'MIGRATION_MISSING' });
    });
  });

  it('refuses a document newer than this build understands', () => {
    expect(migrateToCurrent({ ...v1(), schemaVersion: 2 })).toMatchObject({
      ok: false,
      code: 'VERSION_TOO_NEW',
    });
  });

  it.each([[0], [-1], [1.5], ['1'], [null], [true], [[1]], [{}]])(
    'rejects schemaVersion %p',
    (schemaVersion) => {
      expect(migrateToCurrent({ ...v1(), schemaVersion })).toMatchObject({
        ok: false,
        code: 'VERSION_INVALID',
      });
    },
  );

  it('rejects a missing schemaVersion, and inherited ones do not count', () => {
    expect(migrateToCurrent({ meta: {}, projects: [] })).toMatchObject({
      ok: false,
      code: 'VERSION_MISSING',
    });
    const inherited = Object.create({ schemaVersion: 1 });
    expect(migrateToCurrent(inherited)).toMatchObject({
      ok: false,
      code: 'VERSION_MISSING',
    });
  });

  it.each([[null], [undefined], [[]], ['text'], [7]])(
    'rejects non-objects: %p',
    (input) => {
      expect(migrateToCurrent(input)).toMatchObject({
        ok: false,
        code: 'NOT_AN_OBJECT',
      });
    },
  );
});
