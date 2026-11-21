import { FieldType, IssueTypeLevel, Priority, TaskStatus } from '@prisma/client';
import { CLICKUP, CONTEXT, GITHUB, IMPORTER, JIRA, LINEAR } from './fixtures/provider-fixtures';
import { suggest, suggestStatus } from './mapping.suggest';
import { MappingContext, MappingInventory } from './mapping.types';

const T = TaskStatus, P = Priority;
const run = (inv: MappingInventory, ctx: MappingContext = CONTEXT, matchByEmail = true) => suggest(inv, ctx, { matchByEmail });
const statusRows = (inv: MappingInventory) => run(inv).statuses.map((s) => [s.statusExternalId, s.category, s.excludeFromProgress, s.confidence, s.reason] as const);
const prioRows = (inv: MappingInventory) => run(inv).priorities.map((p) => [p.raw, p.priority, p.reason] as const);

describe('mapping suggestions, table-driven from provider fixtures (step 4.3)', () => {
  describe('statuses (diagram 07)', () => {
    it('Jira: categories roll up, a Blocked status is a LOW-confidence name guess, "Won\'t Do" is DONE but excluded from progress', () => {
      expect(statusRows(JIRA)).toEqual([
        ['10000', T.TODO, false, 'HIGH', 'SOURCE_CATEGORY'],
        ['10001', T.TODO, false, 'HIGH', 'SOURCE_CATEGORY'],
        ['10002', T.IN_PROGRESS, false, 'HIGH', 'SOURCE_CATEGORY'],
        ['10003', T.IN_PROGRESS, false, 'HIGH', 'SOURCE_CATEGORY'],
        ['10004', T.BLOCKED, false, 'LOW', 'NAME_BLOCKED'],
        ['10005', T.DONE, false, 'HIGH', 'SOURCE_CATEGORY'],
        ['10006', T.DONE, true, 'HIGH', 'SOURCE_CATEGORY'],
      ]);
    });
    it('ClickUp: "custom" statuses (no category) are judged by name; those that say nothing default to To do, flagged LOW', () => {
      expect(statusRows(CLICKUP)).toEqual([
        ['open', T.TODO, false, 'HIGH', 'SOURCE_CATEGORY'],
        ['backlog', T.TODO, false, 'LOW', 'DEFAULT'],
        ['prog', T.IN_PROGRESS, false, 'MEDIUM', 'NAME_IN_PROGRESS'],
        ['rev', T.IN_PROGRESS, false, 'MEDIUM', 'NAME_IN_PROGRESS'],
        ['wait', T.BLOCKED, false, 'LOW', 'NAME_BLOCKED'],
        ['done', T.DONE, false, 'HIGH', 'SOURCE_CATEGORY'],
        ['closed', T.DONE, false, 'HIGH', 'SOURCE_CATEGORY'],
        ['wont', T.DONE, true, 'MEDIUM', 'NAME_CANCELED'],
      ]);
    });
    it('Linear: backlog / unstarted -> To do, started -> In progress, completed -> Done, canceled and duplicate -> Done excluded', () => {
      expect(statusRows(LINEAR).map(([id, c, ex]) => [id.split(':')[1], c, ex])).toEqual([
        ['triage', T.TODO, false], ['backlog', T.TODO, false], ['todo', T.TODO, false], ['started', T.IN_PROGRESS, false],
        ['review', T.IN_PROGRESS, false], ['done', T.DONE, false], ['canceled', T.DONE, true], ['dup', T.DONE, true],
      ]);
    });
    it('GitHub: open / closed', () => {
      expect(statusRows(GITHUB).map(([id, c]) => [id, c])).toEqual([['open', T.TODO], ['closed', T.DONE]]);
    });

    it.each([
      // category, name, expected category, excluded, reason
      ['BACKLOG', 'Anything', T.TODO, false, 'SOURCE_CATEGORY'],
      ['TODO', 'Ready', T.TODO, false, 'SOURCE_CATEGORY'],
      ['IN_PROGRESS', 'Coding', T.IN_PROGRESS, false, 'SOURCE_CATEGORY'],
      ['DONE', 'Shipped', T.DONE, false, 'SOURCE_CATEGORY'],
      ['CANCELED', 'Whatever', T.DONE, true, 'SOURCE_CATEGORY'],
      ['TODO', 'On hold', T.BLOCKED, false, 'NAME_BLOCKED'],
      ['BACKLOG', 'Blocked', T.BLOCKED, false, 'NAME_BLOCKED'],
      ['UNKNOWN', 'Blocked by legal', T.BLOCKED, false, 'NAME_BLOCKED'],
      // a source that SAYS a status is finished is never turned into Blocked by its name
      ['DONE', 'Blocked (resolved)', T.DONE, false, 'SOURCE_CATEGORY'],
      ['CANCELED', 'Blocked forever', T.DONE, true, 'SOURCE_CATEGORY'],
      ['UNKNOWN', 'Done', T.DONE, false, 'NAME_DONE'],
      ['UNKNOWN', 'Duplicate', T.DONE, true, 'NAME_CANCELED'],
      ['UNKNOWN', 'In Review', T.IN_PROGRESS, false, 'NAME_IN_PROGRESS'],
      ['UNKNOWN', 'Mystery', T.TODO, false, 'DEFAULT'],
      ['UNKNOWN', '', T.TODO, false, 'DEFAULT'],
    ] as const)('%s "%s" -> %s (excluded %s, %s)', (category, name, want, excluded, reason) => {
      const s = suggestStatus('p', { externalId: 's', name, category });
      expect([s.category, s.excludeFromProgress, s.reason]).toEqual([want, excluded, reason]);
    });

    it('never suggests BLOCKED from a category, and BLOCKED is always LOW confidence (it is confirmed by a person)', () => {
      for (const category of ['BACKLOG', 'TODO', 'IN_PROGRESS', 'DONE', 'CANCELED', 'UNKNOWN'] as const) {
        const s = suggestStatus('p', { externalId: 's', name: 'Anything', category });
        expect(s.category).not.toBe(T.BLOCKED);
      }
      for (const category of ['TODO', 'IN_PROGRESS', 'UNKNOWN'] as const) {
        expect(suggestStatus('p', { externalId: 's', name: 'Blocked', category }).confidence).toBe('LOW');
      }
    });

    it('is total: any category / name yields one valid suggestion', () => {
      const names = ['', ' ', 'x'.repeat(500), '💥', 'DONE', 'blocked', "won't", '\u0000'];
      const cats = ['BACKLOG', 'TODO', 'IN_PROGRESS', 'DONE', 'CANCELED', 'UNKNOWN', 'bogus', undefined, null];
      for (const name of names) for (const category of cats) {
        const s = suggestStatus('p', { externalId: 's', name, category } as never);
        expect(Object.values(T)).toContain(s.category);
        expect(['LOW', 'MEDIUM', 'HIGH']).toContain(s.confidence);
        if (s.excludeFromProgress) expect(s.category).toBe(T.DONE);
      }
    });
  });

  describe('priorities', () => {
    it('Jira (a custom value stays unmatched, flagged)', () => {
      expect(prioRows(JIRA)).toEqual([
        ['Highest', P.URGENT, 'SOURCE_TABLE'], ['High', P.HIGH, 'SOURCE_TABLE'], ['Medium', P.MEDIUM, 'SOURCE_TABLE'],
        ['Low', P.LOW, 'SOURCE_TABLE'], ['Lowest', P.LOW, 'SOURCE_TABLE'], ['Showstopper', null, 'NONE'],
      ]);
    });
    it('ClickUp', () => {
      expect(prioRows(CLICKUP)).toEqual([
        ['Urgent', P.URGENT, 'SOURCE_TABLE'], ['High', P.HIGH, 'SOURCE_TABLE'], ['Normal', P.MEDIUM, 'SOURCE_TABLE'], ['Low', P.LOW, 'SOURCE_TABLE'],
        ['1', P.URGENT, 'SOURCE_TABLE'], ['4', P.LOW, 'SOURCE_TABLE'],
      ]);
    });
    it('Linear: 0 = no priority, 1..4 = urgent..low', () => {
      expect(prioRows(LINEAR)).toEqual([
        ['0', null, 'SOURCE_TABLE'], ['1', P.URGENT, 'SOURCE_TABLE'], ['2', P.HIGH, 'SOURCE_TABLE'], ['3', P.MEDIUM, 'SOURCE_TABLE'], ['4', P.LOW, 'SOURCE_TABLE'],
        ['No priority', null, 'SOURCE_TABLE'], ['Urgent', P.URGENT, 'SOURCE_TABLE'],
      ]);
    });
    it('GitHub label heuristics (generic table), the unrecognised one stays null', () => {
      expect(prioRows(GITHUB)).toEqual([
        ['priority:high', P.HIGH, 'GENERIC_TABLE'], ['Priority: Low', P.LOW, 'GENERIC_TABLE'], ['P0', P.URGENT, 'GENERIC_TABLE'],
        ['p2', P.MEDIUM, 'GENERIC_TABLE'], ['critical', P.URGENT, 'GENERIC_TABLE'], ['nice to have', null, 'NONE'],
      ]);
    });
  });

  describe('people: members only, verified e-mail only', () => {
    const rows = (inv: MappingInventory, ctx?: MappingContext, by = true) => run(inv, ctx, by).users.map((u) => [u.externalId, u.target.kind === 'user' ? u.target.userId : 'importer', u.reason, u.confidence] as const);

    it('Jira: e-mail matches case-insensitively; an UNVERIFIED local address, no e-mail, a bot and a non-member all stay with the importer', () => {
      expect(rows(JIRA)).toEqual([
        ['j-1', 'local-ana', 'VERIFIED_EMAIL', 'MEDIUM'],
        ['j-2', 'importer', 'NONE', 'LOW'],
        ['j-3', 'importer', 'NONE', 'LOW'],
        ['j-4', 'importer', 'BOT', 'HIGH'],
        ['j-5', 'importer', 'NONE', 'LOW'],
      ]);
    });
    it('an earlier IdentityLink wins over e-mail, and is honoured for providers that hide e-mails (GitHub)', () => {
      const ctx = { ...CONTEXT, identityLinks: [{ externalUserId: 'gh-octocat', userId: 'local-cleo' }, { externalUserId: 'j-1', userId: 'local-cleo' }] };
      expect(rows(GITHUB, ctx)[0]).toEqual(['gh-octocat', 'local-cleo', 'IDENTITY_LINK', 'HIGH']);
      expect(rows(JIRA, ctx)[0]).toEqual(['j-1', 'local-cleo', 'IDENTITY_LINK', 'HIGH']); // link beats the e-mail that would give Ana
    });
    it('a link to someone who is NOT a member of the workspace is ignored (falls back to e-mail / importer)', () => {
      const ctx = { ...CONTEXT, identityLinks: [{ externalUserId: 'j-1', userId: 'someone-outside' }] };
      expect(rows(JIRA, ctx)[0]).toEqual(['j-1', 'local-ana', 'VERIFIED_EMAIL', 'MEDIUM']);
    });
    it('matchByEmail = false turns e-mail matching off but keeps links', () => {
      const ctx = { ...CONTEXT, identityLinks: [{ externalUserId: 'j-3', userId: 'local-cleo' }] };
      const r = rows(JIRA, ctx, false);
      expect(r[0]).toEqual(['j-1', 'importer', 'NONE', 'LOW']);
      expect(r[2]).toEqual(['j-3', 'local-cleo', 'IDENTITY_LINK', 'HIGH']);
    });
    it('a bot is never matched, even by a link', () => {
      const ctx = { ...CONTEXT, identityLinks: [{ externalUserId: 'j-4', userId: 'local-ana' }] };
      expect(rows(JIRA, ctx)[3]).toEqual(['j-4', 'importer', 'BOT', 'HIGH']);
    });
    it('two members sharing one verified address (should not happen) are ambiguous: nobody is guessed', () => {
      const dup = { userId: 'local-ana2', name: 'Ana Two', email: 'Ana@Example.com', emailVerified: true };
      expect(rows(JIRA, { ...CONTEXT, members: [...CONTEXT.members, dup] })[0]).toEqual(['j-1', 'importer', 'NONE', 'LOW']);
    });
    it('a member without an address, or with an unverified one, can never be e-mail matched', () => {
      const ctx = { ...CONTEXT, members: [{ userId: 'u', name: 'N', email: null, emailVerified: true }, { userId: 'v', name: 'V', email: 'ana@example.com', emailVerified: false }] };
      expect(rows(JIRA, ctx)[0][1]).toBe('importer');
    });
    it('whitespace and case in the source address do not matter', () => {
      const inv = { ...JIRA, users: [{ externalId: 'x', name: 'X', email: '  Cleo@EXAMPLE.com ' }] };
      expect(rows(inv)[0]).toEqual(['x', 'local-cleo', 'VERIFIED_EMAIL', 'MEDIUM']);
    });
    it('the importer user is just another member (an e-mail may match them)', () => {
      const inv = { ...JIRA, users: [{ externalId: 'x', name: 'X', email: 'importer@example.com' }] };
      expect(rows(inv)[0][1]).toBe(IMPORTER);
    });
  });

  describe('issue types', () => {
    it('Jira: names match the workspace\'s case-insensitively; new ones are created with the source\'s level, else a guess from the name', () => {
      expect(run(JIRA).issueTypes.map((t) => [t.externalId, t.target.kind === 'existing' ? t.target.id : t.target.kind, t.level, t.reason])).toEqual([
        ['epic', 'create', IssueTypeLevel.EPIC, 'NEW'],
        ['story', 'create', IssueTypeLevel.STANDARD, 'NEW'],
        ['bug', 'it-bug', IssueTypeLevel.STANDARD, 'NAME_MATCH'],
        ['sub', 'create', IssueTypeLevel.SUBTASK, 'NEW'],
      ]);
    });
    it('an existing type keeps the WORKSPACE\'s level, not the source\'s', () => {
      const ctx = { ...CONTEXT, issueTypes: [{ id: 'it-epic', name: 'EPIC', level: IssueTypeLevel.STANDARD }] };
      const t = run(JIRA, ctx).issueTypes[0];
      expect(t.target).toEqual({ kind: 'existing', id: 'it-epic' });
      expect(t.level).toBe(IssueTypeLevel.STANDARD);
    });
    it.each([['Epic', IssueTypeLevel.EPIC], ['sub-task', IssueTypeLevel.SUBTASK], ['Subtask', IssueTypeLevel.SUBTASK], ['Sub-issue', IssueTypeLevel.SUBTASK], ['Task', IssueTypeLevel.STANDARD], ['Epics', IssueTypeLevel.STANDARD]])('level guess %j -> %s', (name, level) => {
      expect(run({ ...JIRA, issueTypes: [{ externalId: 'x', name }] }, { ...CONTEXT, issueTypes: [] }).issueTypes[0].level).toBe(level);
    });
  });

  describe('custom fields', () => {
    it('same name + same type = reuse; same name, different type = a NEW field named with the source appended; otherwise new', () => {
      expect(run(JIRA).customFields.map((f) => [f.externalId, f.target.kind === 'existing' ? f.target.id : 'create', f.reason, f.createName])).toEqual([
        ['cf1', 'cf-points', 'NAME_AND_TYPE_MATCH', 'Story Points'],
        ['cf2', 'create', 'NAME_CONFLICT', 'Severity (Jira)'],
        ['cf3', 'create', 'NEW', 'Reviewer'],
      ]);
    });
    it('picks the same-type field when several share a name', () => {
      const ctx = { ...CONTEXT, customFields: [{ id: 'a', name: 'Severity', dataType: FieldType.TEXT }, { id: 'b', name: 'severity', dataType: FieldType.SELECT }] };
      expect(run(JIRA, ctx).customFields[1].target).toEqual({ kind: 'existing', id: 'b' });
    });
    it('a created name that would be too long is cut to 200', () => {
      const inv = { ...JIRA, displayName: 'D'.repeat(60), customFields: [{ externalId: 'x', name: 'n'.repeat(190), dataType: 'TEXT' as const }] };
      const ctx = { ...CONTEXT, customFields: [{ id: 'a', name: 'n'.repeat(190), dataType: FieldType.NUMBER }] };
      expect(run(inv, ctx).customFields[0].createName.length).toBeLessThanOrEqual(200);
    });
  });

  it('an empty inventory has no suggestions; suggestions are deterministic and never mutate their input', () => {
    expect(run({ system: 'x', displayName: 'X', projects: [], priorities: [], users: [], issueTypes: [], customFields: [] })).toEqual({ statuses: [], priorities: [], users: [], issueTypes: [], customFields: [] });
    const frozen = JSON.parse(JSON.stringify(JIRA));
    const freeze = (o: unknown): void => { if (o && typeof o === 'object') { Object.freeze(o); Object.values(o).forEach(freeze); } };
    freeze(frozen);
    const ctx = JSON.parse(JSON.stringify(CONTEXT));
    freeze(ctx);
    expect(run(frozen, ctx)).toEqual(run(JIRA));
  });
});
