import { BadRequestException } from '@nestjs/common';
import { guessedRolesWarning, missingRolesWarning, resolveFieldRoles, suggestFieldRoles } from './field-roles';
import { assertSelectionInTree, parseSelection } from './imports.validation';
import { FIELD_ROLES, SourceField, SourceTree } from './imports.types';

const f = (id: string, name: string, type: string, roles: SourceField['roles']): Omit<SourceField, 'suggested'> => ({ id, name, type, roles });
const STATUSLIKE: SourceField['roles'] = ['status', 'priority'];
/** A realistic Monday board: two status columns, one of them Priority, a people column, two dates. */
const BOARD = [
  f('name', 'Name', 'name', []),
  f('prio', 'Priority', 'status', STATUSLIKE),
  f('stat', 'Status', 'status', STATUSLIKE),
  f('own', 'Owner', 'people', ['assignee']),
  f('due', 'Due date', 'date', ['due', 'start']),
  f('start', 'Start', 'date', ['due', 'start']),
  f('txt', 'Notes', 'text', []),
];
const byId = (l: SourceField[]) => Object.fromEntries(l.map((x) => [x.id, x.suggested ?? []]));

describe('suggestFieldRoles', () => {
  it('a board with several status columns: the one called Status is the workflow, the one called Priority is the priority (not the other way round)', () => {
    expect(byId(suggestFieldRoles(BOARD))).toEqual({ name: [], prio: ['priority'], stat: ['status'], own: ['assignee'], due: ['due'], start: ['start'], txt: [] });
  });

  it('the order of the columns does not change the answer', () => {
    expect(byId(suggestFieldRoles([...BOARD].reverse()))).toEqual(byId(suggestFieldRoles(BOARD)));
  });

  it('a field never serves two roles, even when it fits both (two date columns, one called "Deadline")', () => {
    const r = suggestFieldRoles([f('a', 'Start date', 'date', ['due', 'start']), f('b', 'Deadline', 'date', ['due', 'start'])]);
    expect(byId(r)).toEqual({ a: ['start'], b: ['due'] });
    for (const x of r) expect(new Set(x.suggested ?? []).size).toBe((x.suggested ?? []).length);
    const used = r.flatMap((x) => x.suggested ?? []);
    expect(new Set(used).size).toBe(used.length);
  });

  it('status falls back to the FIRST status-typed field when none is named like one (a board must have a workflow)', () => {
    expect(byId(suggestFieldRoles([f('x', 'Progress bar', 'status', ['status']), f('y', 'Colour', 'status', ['status'])]))).toEqual({ x: ['status'], y: [] });
    expect(byId(suggestFieldRoles([f('x', 'Phase', 'status', ['status']), f('y', 'Task status', 'status', ['status'])]))).toEqual({ x: [], y: ['status'] }); // loose name beats position
  });

  it('priority and start are NEVER guessed from type alone (a second status column is not a priority)', () => {
    const r = suggestFieldRoles([f('s', 'Status', 'status', STATUSLIKE), f('c', 'Customer tier', 'status', STATUSLIKE), f('d', 'When', 'date', ['due', 'start'])]);
    expect(byId(r)).toEqual({ s: ['status'], c: [], d: ['due'] }); // the lone date is the due date, never also the start
  });

  it('assignee / due: a single candidate is taken even with an odd name; several unnamed candidates are not guessed', () => {
    expect(byId(suggestFieldRoles([f('p', 'Team', 'people', ['assignee'])]))).toEqual({ p: ['assignee'] });
    expect(byId(suggestFieldRoles([f('p', 'Team', 'people', ['assignee']), f('q', 'Reviewers', 'people', ['assignee'])]))).toEqual({ p: [], q: [] });
  });

  it('nothing choosable -> nothing suggested; the input is not mutated', () => {
    const input = [f('a', 'Name', 'name', [])];
    const copy = JSON.stringify(input);
    expect(suggestFieldRoles(input)).toEqual([{ id: 'a', name: 'Name', type: 'name', roles: [] }]);
    expect(JSON.stringify(input)).toBe(copy);
    expect(suggestFieldRoles([])).toEqual([]);
  });
});

describe('resolveFieldRoles', () => {
  const fields = suggestFieldRoles(BOARD);

  it('nothing chosen -> the suggestions, reported as guessed', () => {
    const r = resolveFieldRoles(fields, undefined);
    expect(Object.fromEntries(Object.entries(r.byRole).map(([k, v]) => [k, v.id]))).toEqual({ status: 'stat', priority: 'prio', assignee: 'own', due: 'due', start: 'start' });
    expect(r.guessed).toEqual([...FIELD_ROLES]);
    expect(r.missing).toEqual([]);
  });

  it('a choice wins over the suggestion and is not "guessed"; roles not mentioned still use the suggestion', () => {
    const r = resolveFieldRoles(fields, { status: 'prio', priority: 'stat' }); // the person swapped them
    expect(r.byRole.status!.id).toBe('prio');
    expect(r.byRole.priority!.id).toBe('stat');
    expect(r.guessed).toEqual(['assignee', 'due', 'start']);
  });

  it('a field the person chose for one role is NOT also suggested for another (priority chosen = the suggested status column -> status is unmapped, not doubled)', () => {
    const r = resolveFieldRoles(fields, { priority: 'stat' }); // 'stat' was the suggested STATUS
    expect(r.byRole.priority!.id).toBe('stat');
    expect(r.byRole.status).toBeUndefined();
    expect(r.guessed).not.toContain('status');
    const ids = Object.values(r.byRole).map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('null means NONE (not mapped, not guessed) - the person said "this board has no priority"', () => {
    const r = resolveFieldRoles(fields, { priority: null });
    expect(r.byRole.priority).toBeUndefined();
    expect(r.guessed).not.toContain('priority');
    expect(r.missing).toEqual([]);
  });

  it('a chosen field that no longer exists (or cannot play the role) is MISSING, not silently replaced by the guess', () => {
    const r = resolveFieldRoles(fields, { due: 'deleted-column', assignee: 'stat' });
    expect(r.byRole.due).toBeUndefined();
    expect(r.byRole.assignee).toBeUndefined(); // 'stat' exists but is a status column: cannot be an assignee
    expect(r.missing).toEqual([{ role: 'assignee', fieldId: 'stat' }, { role: 'due', fieldId: 'deleted-column' }].sort((a, b) => FIELD_ROLES.indexOf(a.role as never) - FIELD_ROLES.indexOf(b.role as never)));
  });

  it('a source with no fields resolves to nothing (and does not throw)', () => {
    expect(resolveFieldRoles(undefined, undefined)).toEqual({ byRole: {}, guessed: [], missing: [] });
    expect(resolveFieldRoles([], { status: 'x' }).missing).toEqual([{ role: 'status', fieldId: 'x' }]);
  });

  it('prototype keys cannot be smuggled in as a choice', () => {
    const r = resolveFieldRoles(fields, JSON.parse('{"__proto__": "stat", "constructor": "x"}'));
    expect(r.missing).toEqual([]);
    expect(Object.keys(r.byRole).sort()).toEqual([...FIELD_ROLES].sort());
  });
});

describe('preview warnings', () => {
  const fields = suggestFieldRoles(BOARD);
  it('say which fields were guessed, by NAME, and are silent when the person chose everything', () => {
    const w = guessedRolesWarning('Sprint board', resolveFieldRoles(fields, undefined))!;
    expect(w.code).toBe('FIELD_ROLES_GUESSED');
    expect(w.message).toContain('status: "Status"');
    expect(w.message).toContain('priority: "Priority"');
    expect(w.message).toContain('due date: "Due date"');
    const all = Object.fromEntries(FIELD_ROLES.map((r) => [r, null]));
    expect(guessedRolesWarning('Sprint board', resolveFieldRoles(fields, all))).toBeNull();
    expect(guessedRolesWarning('Empty', resolveFieldRoles([], undefined))).toBeNull();
  });
  it('a chosen field that disappeared is reported', () => {
    expect(missingRolesWarning('B', resolveFieldRoles(fields, { status: 'gone' }))!.message).toContain('1 chosen field(s) no longer exist (status)');
    expect(missingRolesWarning('B', resolveFieldRoles(fields, {}))).toBeNull();
  });
});

describe('selection parsing (fieldRoles)', () => {
  const src = (fieldRoles: unknown) => ({ sources: [{ id: 'b1', type: 'board', fieldRoles }] });

  it('accepts ids and null; drops an empty object; plain selections are unchanged', () => {
    expect(parseSelection(src({ status: 'stat', priority: null }))).toEqual({ sources: [{ id: 'b1', type: 'board', fieldRoles: { status: 'stat', priority: null } }] });
    expect(parseSelection(src({}))).toEqual({ sources: [{ id: 'b1', type: 'board' }] });
    expect(parseSelection(src(undefined))).toEqual({ sources: [{ id: 'b1', type: 'board' }] });
    expect(parseSelection({ sources: [{ id: 'a', type: 'team' }] })).toEqual({ sources: [{ id: 'a', type: 'team' }] });
  });

  it.each([
    ['an unknown role', { color: 'x' }], ['a number', { status: 5 }], ['an empty id', { status: '' }], ['an over-long id', { status: 'x'.repeat(201) }],
    ['an array', ['status']], ['a string', 'status'], ['an object id', { status: { id: 'x' } }], ['one field for two roles', { status: 'x', priority: 'x' }],
  ])('refuses %s with a 400', (_n, bad) => {
    expect(() => parseSelection(src(bad))).toThrow(BadRequestException);
  });

  it('two nulls are fine (not "the same field")', () => {
    expect(parseSelection(src({ status: null, priority: null })).sources[0].fieldRoles).toEqual({ status: null, priority: null });
  });

  it('a duplicate source keeps the FIRST entry\'s roles', () => {
    const r = parseSelection({ sources: [{ id: 'b', type: 'board', fieldRoles: { status: 'a' } }, { id: 'b', type: 'board', fieldRoles: { status: 'z' } }] });
    expect(r.sources).toEqual([{ id: 'b', type: 'board', fieldRoles: { status: 'a' } }]);
  });

  it('does not let prototype keys through', () => {
    expect(() => parseSelection(src(JSON.parse('{"__proto__": "x"}')))).toThrow(BadRequestException);
  });
});

describe('selection against the provider\'s tree (fieldRoles)', () => {
  const tree: SourceTree = {
    nodes: [
      { id: 'w', type: 'workspace', name: 'WS', selectable: false },
      { id: 'b1', type: 'board', name: 'Sprint', parentId: 'w', selectable: true, fields: suggestFieldRoles(BOARD) },
      { id: 'b2', type: 'board', name: 'Plain', parentId: 'w', selectable: true },
    ],
  };
  const check = (s: unknown) => assertSelectionInTree(parseSelection(s), tree);

  it('accepts a field of that board that can play that role', () => {
    expect(() => check({ sources: [{ id: 'b1', type: 'board', fieldRoles: { status: 'stat', priority: 'prio', assignee: 'own', due: 'due', start: 'start' } }] })).not.toThrow();
    expect(() => check({ sources: [{ id: 'b1', type: 'board', fieldRoles: { status: 'prio' } }] })).not.toThrow(); // a Priority column may be the workflow
    expect(() => check({ sources: [{ id: 'b2', type: 'board' }, { id: 'b1', type: 'board', fieldRoles: { due: null } }] })).not.toThrow();
  });

  it.each([
    ['a field that does not exist', { status: 'nope' }], ['a field that cannot play the role (a people column as status)', { status: 'own' }],
    ['a status column as the due date', { due: 'stat' }], ['a field of ANOTHER board', { status: 'other-board-col' }],
  ])('refuses %s', (_n, roles) => {
    expect(() => check({ sources: [{ id: 'b1', type: 'board', fieldRoles: roles }] })).toThrow(/not available for its role/);
  });

  it('a source with no choosable fields refuses any choice', () => {
    expect(() => check({ sources: [{ id: 'b2', type: 'board', fieldRoles: { status: 'stat' } }] })).toThrow(/not available for its role/);
  });

  it('"not selectable" is reported before role problems', () => {
    expect(() => check({ sources: [{ id: 'w', type: 'workspace', fieldRoles: { status: 'x' } }] })).toThrow(/Not selectable/);
  });
});
