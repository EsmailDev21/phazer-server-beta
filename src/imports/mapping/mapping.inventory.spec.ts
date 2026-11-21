import { CanonicalBundle } from '../canonical';
import { buildInventory, emptyInventory, foldEmail, InventoryError, parseInventory } from './mapping.inventory';
import { INVENTORY_LIMITS } from './mapping.types';
import { JIRA } from './fixtures/provider-fixtures';

const page = (extra: Record<string, unknown>): CanonicalBundle => ({ schemaVersion: 1, source: { system: 'jira', displayName: 'Jira' }, ...extra }) as CanonicalBundle;

describe('mapping inventory (step 4.3)', () => {
  describe('buildInventory: folds validated pages together', () => {
    it('merges projects (and their statuses), people, types, fields and priorities across pages; first definition wins', () => {
      const inv = buildInventory([
        page({ projects: [{ externalId: 'P', name: 'First', statuses: [{ externalId: 's1', name: 'A', category: 'TODO' }] }], users: [{ externalId: 'u1', name: 'One' }], tasks: [{ externalId: 't1', title: 'x', priority: 'High' }] }),
        page({ projects: [{ externalId: 'P', name: 'Second', statuses: [{ externalId: 's1', name: 'DUP', category: 'DONE' }, { externalId: 's2', name: 'B', category: 'DONE' }] }, { externalId: 'Q', name: 'Q' }], users: [{ externalId: 'u1', name: 'Again' }, { externalId: 'u2', name: 'Two' }], tasks: [{ externalId: 't2', title: 'y', priority: 'high (2)' }, { externalId: 't3', title: 'z', priority: 'Low' }, { externalId: 't4', title: 'n' }] }),
      ]);
      expect(inv.projects).toEqual([
        { externalId: 'P', name: 'First', statuses: [{ externalId: 's1', name: 'A', category: 'TODO' }, { externalId: 's2', name: 'B', category: 'DONE' }] },
        { externalId: 'Q', name: 'Q', statuses: [] },
      ]);
      expect(inv.users.map((u) => [u.externalId, u.name])).toEqual([['u1', 'One'], ['u2', 'Two']]);
      expect(inv.priorities).toEqual(['High', 'Low']); // "high (2)" is the same value as "High"; tasks without one add nothing
      expect(inv.system).toBe('jira');
    });
    it('can continue an existing inventory (page by page) without duplicating', () => {
      const p1 = page({ users: [{ externalId: 'u1', name: 'One' }] });
      const p2 = page({ users: [{ externalId: 'u1', name: 'One' }, { externalId: 'u2', name: 'Two' }] });
      const once = buildInventory([p1, p2]);
      expect(buildInventory([p2], buildInventory([p1])).users).toEqual(once.users);
    });
    it('no pages = an empty inventory', () => {
      expect(buildInventory([])).toEqual(emptyInventory('unknown', 'Unknown'));
    });
  });

  describe('parseInventory: stored / adapter data is re-checked', () => {
    it('a valid inventory round-trips (e-mail addresses are lower-cased, like all imported data)', () => {
      const expected = { ...JIRA, users: JIRA.users.map((u) => (u.email ? { ...u, email: u.email.toLowerCase() } : u)) };
      expect(parseInventory(JIRA)).toEqual(expected);
      expect(parseInventory(expected)).toEqual(expected); // and it is stable
    });
    it('is repaired like imported data: control characters removed, over-long names cut, bad e-mails dropped', () => {
      const inv = parseInventory({ ...JIRA, users: [{ externalId: 'u', name: 'A\u0000na', email: 'not-an-email' }], projects: [{ externalId: 'p', name: 'x'.repeat(500), statuses: [] }] });
      expect(inv.users).toEqual([{ externalId: 'u', name: 'Ana' }]);
      expect(inv.projects[0].name.length).toBeLessThan(500);
    });
    it('priorities: one-line, bounded, de-duplicated by the engine\'s key, non-strings ignored', () => {
      const inv = parseInventory({ ...JIRA, priorities: ['High', ' high (2) ', 'Lo\u0000w', 5, '', null, 'x'.repeat(300)] });
      expect(inv.priorities).toEqual(['High', 'Low', 'x'.repeat(100)]);
    });
    it.each([
      ['not an object', 'x'], ['array', []], ['null', null],
      ['a list that is not a list', { ...JIRA, users: {} }],
      ['too many users', { ...JIRA, users: Array.from({ length: INVENTORY_LIMITS.maxUsers + 1 }, (_, i) => ({ externalId: `u${i}`, name: 'n' })) }],
      ['too many priorities', { ...JIRA, priorities: Array.from({ length: INVENTORY_LIMITS.maxPriorities + 1 }, (_, i) => `p${i}`) }],
      ['too many statuses in a project', { ...JIRA, projects: [{ externalId: 'p', name: 'P', statuses: Array.from({ length: INVENTORY_LIMITS.maxStatusesPerProject + 1 }, (_, i) => ({ externalId: `s${i}`, name: `S${i}`, category: 'TODO' })) }] }],
      ['a bad source', { ...JIRA, system: 'Not A Slug!' }],
      ['an unknown field on an entity (adapter bug)', { ...JIRA, users: [{ externalId: 'u', name: 'n', nickname: 'x' }] }],
    ])('refuses %s', (_n, raw) => {
      expect(() => parseInventory(raw)).toThrow(InventoryError);
    });
  });

  it('foldEmail trims and lower-cases; empty is null', () => {
    expect(foldEmail('  Ana@Example.COM ')).toBe('ana@example.com');
    for (const v of ['', '   ', null, undefined]) expect(foldEmail(v)).toBeNull();
  });
});
