import { relationsFooter } from './linear.normalize';
import { DependencyType, FieldType, IterationKind } from '@prisma/client';
import {
  MAX_PROJECT_OPTIONS,
  PROJECT_FIELD_ID,
  priorityText,
  projectField,
  projectOptionLabels,
  stateCategory,
  statusExternalId,
  toDependencies,
  toIteration,
  toProject,
  toTask,
  toUser,
} from './linear.normalize';
import { ORG } from './fixtures/linear-responses';
import { LinearIssue } from './linear.types';

const cx = (o: Partial<Parameters<typeof toTask>[1]> = {}) => ({ teamId: 'T', withProjectField: true, selectedTeamIds: new Set(['T']), ...o });
const issue = (o: Partial<LinearIssue> = {}): LinearIssue => ({ id: 'i1', title: 'A', ...o });

describe('Linear -> canonical translation (step 4.5)', () => {
  it.each([
    ['triage', 'BACKLOG'], ['backlog', 'BACKLOG'], ['unstarted', 'TODO'], ['started', 'IN_PROGRESS'],
    ['completed', 'DONE'], ['canceled', 'CANCELED'], ['STARTED', 'IN_PROGRESS'], ['something-new', 'UNKNOWN'], ['', 'UNKNOWN'],
  ])('state type %p -> %p', (t, c) => expect(stateCategory(t)).toBe(c));

  it('status ids are composed with the team (a Linear state id only means something inside its team)', () => {
    expect(statusExternalId('team-a', 's1')).toBe('team-a:s1');
  });

  describe('priority', () => {
    it.each([
      [1, 'Urgent', 'Urgent'], [2, 'High', 'High'], [3, 'Medium', 'Medium'], [4, 'Low', 'Low'],
      [1, undefined, 'Urgent'], [4, null, 'Low'], [2, '  High  ', 'High'],
    ])('priority %p / label %p -> %p', (p, l, out) => expect(priorityText({ priority: p, priorityLabel: l })).toBe(out));
    it.each([[0, 'No priority'], [null, null], [undefined, undefined], [5, 'x'], [-1, 'x']])('%p (%p) is "no value"', (p, l) =>
      expect(priorityText({ priority: p as number, priorityLabel: l as string })).toBeUndefined());
  });

  describe('toUser', () => {
    it('keeps e-mail and avatar; app users are bots; a missing name falls back to display name, e-mail, id', () => {
      expect(toUser({ id: 'u', name: 'Ana', email: 'a@x.io', avatarUrl: 'https://c/a.png', app: false })).toEqual({ externalId: 'u', name: 'Ana', email: 'a@x.io', avatarUrl: 'https://c/a.png' });
      expect(toUser({ id: 'b', name: 'Bot', app: true }).isBot).toBe(true);
      expect(toUser({ id: 'u', name: '', displayName: 'ana' }).name).toBe('ana');
      expect(toUser({ id: 'u', email: 'a@x.io' }).name).toBe('a@x.io');
      expect(toUser({ id: 'u' }).name).toBe('u');
    });
    it('a null e-mail is absent, not the string "null"', () => {
      expect(toUser({ id: 'u', name: 'N', email: null })).not.toHaveProperty('email');
    });
  });

  it('a team becomes a project: key, name, url from the org key, statuses with composed ids', () => {
    const p = toProject(ORG, { id: 'T', key: 'ENG', name: 'Engineering', description: 'd' }, [{ id: 's1', name: 'Todo', type: 'unstarted', color: '#fff', position: 2 }]);
    expect(p).toEqual({
      externalId: 'T', key: 'ENG', name: 'Engineering', description: 'd', url: 'https://linear.app/acme/team/ENG/all',
      statuses: [{ externalId: 'T:s1', name: 'Todo', category: 'TODO', color: '#fff', position: 2 }],
    });
  });

  it('url parts are encoded', () => {
    expect(toProject({ ...ORG, urlKey: 'a b' }, { id: 'T', key: 'E/N', name: 'x' }, []).url).toBe('https://linear.app/a%20b/team/E%2FN/all');
  });

  describe('cycles -> iterations', () => {
    it('kind CYCLE, scoped to the team, dates and goal carried', () => {
      expect(toIteration('T', { id: 'c', number: 4, name: 'Push', description: 'goal', startsAt: '2026-03-02T00:00:00.000Z', endsAt: '2026-03-16T00:00:00.000Z' })).toEqual({
        externalId: 'c', kind: IterationKind.CYCLE, name: 'Push', projectExternalId: 'T', goal: 'goal', startDate: '2026-03-02T00:00:00.000Z', endDate: '2026-03-16T00:00:00.000Z',
      });
    });
    it('an unnamed cycle is "Cycle <number>"', () => {
      expect(toIteration('T', { id: 'c', number: 7, name: null }).name).toBe('Cycle 7');
      expect(toIteration('T', { id: 'c', number: 7, name: '  ' }).name).toBe('Cycle 7');
    });
  });

  describe('the "Linear project" field', () => {
    it('option labels are distinct case-insensitively, first spelling kept, blanks dropped', () => {
      expect(projectOptionLabels(['Web app', 'web APP', ' Public API ', '', '  '])).toEqual(['Web app', 'Public API']);
    });
    it('is a SELECT field with those options', () => {
      expect(projectField(['A', 'B'])).toEqual({ externalId: PROJECT_FIELD_ID, name: 'Linear project', dataType: FieldType.SELECT, options: [{ label: 'A' }, { label: 'B' }] });
    });
    it('no projects -> no field; over the option ceiling -> no field (never a random cut)', () => {
      expect(projectField([])).toBeNull();
      expect(projectField(Array.from({ length: MAX_PROJECT_OPTIONS }, (_, i) => `p${i}`))).not.toBeNull();
      expect(projectField(Array.from({ length: MAX_PROJECT_OPTIONS + 1 }, (_, i) => `p${i}`))).toBeNull();
    });
  });

  describe('toTask', () => {
    it('a bare issue: only what Linear has', () => {
      expect(toTask(issue(), cx())).toEqual({ externalId: 'i1', projectExternalId: 'T', title: 'A' });
    });
    it('a full issue', () => {
      const t = toTask(issue({
        identifier: 'ENG-1', url: 'https://l/x', description: 'md', state: { id: 's1' }, priority: 2, priorityLabel: 'High', parent: { id: 'p' }, cycle: { id: 'c' },
        assignee: { id: 'a' }, creator: { id: 'b' }, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', dueDate: '2026-02-03', estimate: 5,
        labels: { nodes: [{ name: 'Bug' }, { name: 'Bug' }, { name: 'UI' }] }, project: { id: 'pr', name: ' Web ' },
      }), cx());
      expect(t).toEqual({
        externalId: 'i1', projectExternalId: 'T', title: 'A', key: 'ENG-1', url: 'https://l/x', description: 'md', statusExternalId: 'T:s1', priority: 'High',
        parentExternalId: 'p', iterationExternalId: 'c', assigneeExternalIds: ['a'], creatorExternalId: 'b', createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z', dueDate: '2026-02-03', estimate: 5, tags: ['Bug', 'UI'], customValues: [{ fieldExternalId: PROJECT_FIELD_ID, value: 'Web' }],
      });
    });
    it('estimate 0 is kept (a real value); archivedAt -> archived', () => {
      expect(toTask(issue({ estimate: 0 }), cx()).estimate).toBe(0);
      expect(toTask(issue({ archivedAt: '2026-01-01T00:00:00.000Z' }), cx()).archived).toBe(true);
      expect(toTask(issue({ archivedAt: null }), cx())).not.toHaveProperty('archived');
    });
    it('the project value is left out when the field does not exist', () => {
      expect(toTask(issue({ project: { id: 'p', name: 'Web' } }), cx({ withProjectField: false }))).not.toHaveProperty('customValues');
    });
    it('labels beyond the first page are merged in, de-duplicated', () => {
      const t = toTask(issue({ labels: { nodes: [{ name: 'a' }] } }), cx({ extraLabels: new Map([['i1', ['b', 'a']]]) }));
      expect(t.tags).toEqual(['a', 'b']);
    });
    it('a blank title is passed through (the validator repairs it; the adapter does not second-guess it)', () => {
      expect(toTask(issue({ title: '  ' }), cx()).title).toBe('  ');
    });
  });

  describe('relations -> dependencies', () => {
    const rel = (id: string, type: string, other: string, team: string | null = 'T') => ({ id, type, relatedIssue: { id: other, team: team ? { id: team } : null } });
    it('blocks -> BLOCKS (this issue is the blocker); related / similar / duplicate -> RELATES_TO; an unknown kind is not a dependency', () => {
      const deps = toDependencies(issue({ relations: { nodes: [rel('r1', 'blocks', 'x'), rel('r2', 'related', 'y'), rel('r3', 'duplicate', 'z'), rel('r4', 'similar', 'w'), rel('r5', 'mystery', 'v')] } }), cx());
      expect(deps.map((d) => [d.externalId, d.toExternalId, d.type])).toEqual([['r1', 'x', DependencyType.BLOCKS], ['r2', 'y', DependencyType.RELATES_TO], ['r3', 'z', DependencyType.RELATES_TO], ['r4', 'w', DependencyType.RELATES_TO]]);
      expect(deps.every((d) => d.fromExternalId === 'i1')).toBe(true);
    });
    it('a partner in a team that is not part of the import is no dependency (it would wait for ever) - for every relation kind', () => {
      expect(toDependencies(issue({ relations: { nodes: [rel('r1', 'blocks', 'x', 'OUT'), rel('r2', 'blocks', 'y', 'T'), rel('r3', 'related', 'z', 'OUT')] } }), cx()).map((d) => d.externalId)).toEqual(['r2']);
    });
    it('an unknown partner team is kept (the executor sorts it out), a missing partner is dropped', () => {
      expect(toDependencies(issue({ relations: { nodes: [rel('r1', 'blocks', 'x', null), { id: 'r2', type: 'blocks', relatedIssue: null }] } }), cx()).map((d) => d.externalId)).toEqual(['r1']);
    });
    it('relations from the follow-up query are added; the same relation is never listed twice', () => {
      const deps = toDependencies(
        issue({ relations: { nodes: [rel('r1', 'blocks', 'x')] } }),
        cx({ extraRelations: new Map([['i1', [rel('r1', 'blocks', 'x'), rel('r2', 'blocks', 'y')]]]) }),
      );
      expect(deps.map((d) => d.externalId)).toEqual(['r1', 'r2']);
    });
    it('type matching is case-insensitive', () => {
      expect(toDependencies(issue({ relations: { nodes: [rel('r1', 'BLOCKS', 'x')] } }), cx())).toHaveLength(1);
    });
  });
});


describe('relationsFooter (step 4.7b): what a dependency cannot carry stays as text', () => {
  const sel = new Set(['T']);
  const mk = (relations: unknown[]) => ({ id: 'i1', relations: { nodes: relations } }) as never;
  const r = (id: string, type: string, other: Record<string, unknown>) => ({ id, type, relatedIssue: other });

  it('a duplicate is a RELATES_TO link AND a line of text (the meaning would be lost otherwise)', () => {
    expect(relationsFooter(mk([r('a', 'duplicate', { id: 'x', identifier: 'ENG-4', title: 'Same bug', team: { id: 'T' } })]), { selectedTeamIds: sel })).toBe('---\n\n**Relations in Linear**\n\n- Marked as a duplicate of ENG-4 - Same bug');
  });

  it('every relation to a team that is not imported is kept as text, flagged as not imported', () => {
    const f = relationsFooter(mk([r('a', 'blocks', { id: 'x', identifier: 'OTH-1', title: 'A [b]', team: { id: 'OUT' } }), r('b', 'related', { id: 'y', identifier: 'OTH-2', team: { id: 'OUT' } }), r('c', 'similar', { id: 'z', team: { id: 'OUT' } })]), { selectedTeamIds: sel });
    expect(f).toContain('- Blocks OTH-1 - A \\[b\\] (not imported)');
    expect(f).toContain('- Related to OTH-2 (not imported)');
    expect(f).toContain('- Similar to z (not imported)'); // no identifier: the id, never nothing
  });

  it('relations that DID become dependencies are not repeated in the text; nothing to say -> null', () => {
    expect(relationsFooter(mk([r('a', 'blocks', { id: 'x', team: { id: 'T' } }), r('b', 'related', { id: 'y', team: { id: 'T' } })]), { selectedTeamIds: sel })).toBeNull();
    expect(relationsFooter(mk([]), { selectedTeamIds: sel })).toBeNull();
  });

  it('the same relation is listed once, also when the follow-up query repeats it; follow-up relations count', () => {
    const rel = r('a', 'duplicate', { id: 'x', identifier: 'ENG-4', team: { id: 'T' } });
    const f = relationsFooter(mk([rel]), { selectedTeamIds: sel, extraRelations: new Map([['i1', [rel as never, r('b', 'duplicate', { id: 'y', identifier: 'ENG-5', team: { id: 'T' } }) as never]]]) });
    expect(f!.match(/Marked as a duplicate/g)).toHaveLength(2);
  });
});
