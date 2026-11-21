import { FieldType, IssueTypeLevel, Priority, TaskStatus } from '@prisma/client';
import { CLICKUP, CONTEXT, GITHUB, JIRA } from './fixtures/provider-fixtures';
import { resolve } from './mapping.resolve';
import { MappingConfigV1, MappingContext, MappingInventory } from './mapping.types';

const T = TaskStatus;
const go = (inv: MappingInventory, config: Partial<MappingConfigV1> = {}, ctx: MappingContext = CONTEXT) => resolve(inv, ctx, { version: 1, ...config });
const st = (r: ReturnType<typeof go>, id: string) => r.resolved.statuses.get(id)!;
const codes = (r: ReturnType<typeof go>) => r.attention.map((a) => `${a.code}:${a.key}`);

describe('mapping resolution: suggestions + overrides (step 4.3)', () => {
  describe('with no overrides it IS the suggestion', () => {
    const r = go(JIRA);
    it('statuses carry name, category, colour (the source\'s, else the category\'s) and position', () => {
      expect(st(r, '10002')).toMatchObject({ name: 'In Progress', category: T.IN_PROGRESS, rootExternalId: '10002', overridden: false, position: 2 });
      expect(st(r, '10002').color).toBe('#3B82F6');
      expect(st(r, '10006')).toMatchObject({ category: T.DONE, excludeFromProgress: true });
    });
    it('people, priorities, types and fields are populated', () => {
      expect(r.resolved.users.get('j-1')?.target).toEqual({ kind: 'user', userId: 'local-ana' });
      expect(r.resolved.priorities.get('highest')).toBe(Priority.URGENT);
      expect(r.resolved.priorities.get('showstopper')).toBeNull();
      expect(r.resolved.issueTypes.get('bug')?.target).toEqual({ kind: 'existing', id: 'it-bug' });
      expect(r.resolved.customFields.get('cf2')).toMatchObject({ target: { kind: 'create' }, name: 'Severity (Jira)', dataType: FieldType.SELECT });
      expect(r.resolved.matchByEmail).toBe(true);
      expect(r.resolved.importerUserId).toBe('local-importer');
    });
    it('attention: the guessed Blocked status, the unmatched priority, the unmapped people, the field name conflict', () => {
      expect(codes(r)).toEqual(['STATUS_BLOCKED_GUESS:10004', 'PRIORITY_UNMATCHED:Showstopper', 'USERS_UNMAPPED:users', 'CUSTOM_FIELD_NAME_CONFLICT:cf2']);
      expect(r.attention.find((a) => a.code === 'USERS_UNMAPPED')?.message).toMatch(/^3 people /); // j-2, j-3, j-5 (the bot is not "unmatched")
    });
    it('ClickUp: a status that says nothing is flagged as defaulted', () => {
      expect(codes(go(CLICKUP))).toEqual(['STATUS_DEFAULTED:backlog', 'STATUS_BLOCKED_GUESS:wait']);
    });
    it('GitHub: nothing to confirm except the unrecognised priority and the unmatched person', () => {
      expect(codes(go(GITHUB))).toEqual(['PRIORITY_UNMATCHED:nice to have', 'USERS_UNMAPPED:users']);
    });
    it('is deterministic and does not mutate its inputs', () => {
      const frozen = JSON.parse(JSON.stringify(JIRA));
      const f = (o: unknown): void => { if (o && typeof o === 'object') { Object.freeze(o); Object.values(o).forEach(f); } };
      f(frozen);
      expect(resolve(frozen, CONTEXT, { version: 1 }).attention).toEqual(go(JIRA).attention);
    });
  });

  describe('status overrides', () => {
    it('confirming the Blocked guess clears its attention item; changing the category, name and exclusion applies', () => {
      const r = go(JIRA, { statuses: [{ statusExternalId: '10004', category: T.BLOCKED }, { statusExternalId: '10001', category: T.IN_PROGRESS, name: 'Ready' }, { statusExternalId: '10003', category: T.DONE, excludeFromProgress: true }] });
      expect(codes(r)).not.toContain('STATUS_BLOCKED_GUESS:10004');
      expect(st(r, '10001')).toMatchObject({ name: 'Ready', category: T.IN_PROGRESS, overridden: true });
      expect(st(r, '10003')).toMatchObject({ category: T.DONE, excludeFromProgress: true });
    });
    it('moving a status OFF Done clears its exclusion (it only means something on Done)', () => {
      expect(st(go(JIRA, { statuses: [{ statusExternalId: '10006', category: T.TODO }] }), '10006')).toMatchObject({ category: T.TODO, excludeFromProgress: false });
    });
    it('merging folds a status into another: it takes the root\'s name, category, colour and position, and points at it', () => {
      const r = go(JIRA, { statuses: [{ statusExternalId: '10003', mergeInto: '10002' }] });
      expect(st(r, '10003')).toMatchObject({ statusExternalId: '10003', rootExternalId: '10002', name: 'In Progress', category: T.IN_PROGRESS, position: 2 });
      expect(st(r, '10002').rootExternalId).toBe('10002');
    });
    it('a merge into a status that is itself renamed uses the root\'s FINAL values', () => {
      const r = go(JIRA, { statuses: [{ statusExternalId: '10003', mergeInto: '10002' }, { statusExternalId: '10002', name: 'Doing', category: T.BLOCKED }] });
      expect(st(r, '10003')).toMatchObject({ name: 'Doing', category: T.BLOCKED });
    });
    it('an overridden status is no longer "guessed" or "defaulted" in the attention list', () => {
      expect(codes(go(CLICKUP, { statuses: [{ statusExternalId: 'backlog', category: T.TODO }, { statusExternalId: 'wait', category: T.BLOCKED }] }))).toEqual([]);
    });
  });

  describe('priorities', () => {
    it('a row matches by the normalised key ("Showstopper", "showstopper (1)"), overriding the table and clearing attention', () => {
      const r = go(JIRA, { priorities: [{ raw: 'SHOWSTOPPER (1)', priority: Priority.URGENT }, { raw: 'high', priority: Priority.LOW }, { raw: 'Medium', priority: null }] });
      expect(r.resolved.priorities.get('showstopper')).toBe(Priority.URGENT);
      expect(r.resolved.priorities.get('high')).toBe(Priority.LOW);
      expect(r.resolved.priorities.get('medium')).toBeNull();
      expect(codes(r)).not.toContain('PRIORITY_UNMATCHED:Showstopper');
    });
  });

  describe('people', () => {
    it('an override sets the target; clearing the "unmapped" count', () => {
      const r = go(JIRA, { users: [{ externalId: 'j-2', target: { kind: 'user', userId: 'local-ben' } }, { externalId: 'j-3', target: { kind: 'user', userId: 'local-cleo' } }, { externalId: 'j-5', target: { kind: 'importer' } }] });
      expect(r.resolved.users.get('j-2')?.target).toEqual({ kind: 'user', userId: 'local-ben' });
      expect(codes(r)).not.toContain('USERS_UNMAPPED:users'); // all three were decided by a person
    });
    it('every override marks the person as decided (even when the choice is the importer): "unmatched" means nobody chose', () => {
      const r = go(JIRA, { users: [{ externalId: 'j-3', target: { kind: 'importer' } }] });
      expect(r.resolved.users.get('j-3')?.decided).toBe(true);
      expect(r.resolved.users.get('j-2')?.decided).toBe(false);
      expect(r.resolved.users.get('j-1')?.decided).toBe(false); // matched by the engine, not by a person
    });
    it('a person can be sent to the importer instead of the e-mail match', () => {
      expect(go(JIRA, { users: [{ externalId: 'j-1', target: { kind: 'importer' } }] }).resolved.users.get('j-1')?.target).toEqual({ kind: 'importer' });
    });
    it('matchByEmail: false in the config turns the matching off', () => {
      const r = go(JIRA, { matchByEmail: false });
      expect(r.resolved.users.get('j-1')?.target).toEqual({ kind: 'importer' });
      expect(r.resolved.matchByEmail).toBe(false);
    });
  });

  describe('issue types and custom fields', () => {
    it('create with another level, or skip; an existing target keeps the workspace\'s level', () => {
      const r = go(JIRA, { issueTypes: [{ externalId: 'story', target: { kind: 'create' }, level: IssueTypeLevel.EPIC }, { externalId: 'epic', target: { kind: 'skip' } }, { externalId: 'sub', target: { kind: 'existing', id: 'it-bug' }, level: IssueTypeLevel.EPIC }] });
      expect(r.resolved.issueTypes.get('story')).toMatchObject({ target: { kind: 'create' }, level: IssueTypeLevel.EPIC });
      expect(r.resolved.issueTypes.get('epic')?.target).toEqual({ kind: 'skip' });
      expect(r.resolved.issueTypes.get('sub')).toMatchObject({ target: { kind: 'existing', id: 'it-bug' }, level: IssueTypeLevel.SUBTASK });
    });
    it('a field can be skipped, renamed on creation, or pointed at an existing one; a handled conflict leaves attention', () => {
      const r = go(JIRA, { customFields: [{ externalId: 'cf2', target: { kind: 'create' }, name: 'Severity level' }, { externalId: 'cf3', target: { kind: 'skip' } }] });
      expect(r.resolved.customFields.get('cf2')).toMatchObject({ target: { kind: 'create' }, name: 'Severity level' });
      expect(r.resolved.customFields.get('cf3')?.target).toEqual({ kind: 'skip' });
      expect(codes(r)).not.toContain('CUSTOM_FIELD_NAME_CONFLICT:cf2');
    });
  });

  describe('stale rows (the selection changed after the mapping was saved) are ignored and reported, never thrown', () => {
    it('unknown ids, a merge that no longer holds, and a person who stopped being a member', () => {
      const r = go(JIRA, {
        projects: [{ externalId: 'GONE', name: 'x' }],
        statuses: [{ statusExternalId: 'gone' }, { statusExternalId: '10003', mergeInto: 'gone' }],
        users: [{ externalId: 'gone', target: { kind: 'importer' } }, { externalId: 'j-2', target: { kind: 'user', userId: 'left-the-workspace' } }],
        issueTypes: [{ externalId: 'gone', target: { kind: 'skip' } }],
        customFields: [{ externalId: 'gone', target: { kind: 'skip' } }],
      });
      expect(r.attention.filter((a) => a.code === 'CONFIG_ROW_IGNORED')).toHaveLength(7);
      expect(st(r, '10003').rootExternalId).toBe('10003'); // the bad merge did not apply
      expect(r.resolved.users.get('j-2')?.target).toEqual({ kind: 'importer' });
      expect(r.resolved.projects.has('GONE')).toBe(false);
    });
    it('a merge CHAIN (which checkConfig refuses) is not followed: no status ever points at a non-root', () => {
      const r = go(JIRA, { statuses: [{ statusExternalId: '10003', mergeInto: '10002' }, { statusExternalId: '10002', mergeInto: '10001' }] });
      for (const s of r.resolved.statuses.values()) expect(r.resolved.statuses.get(s.rootExternalId)?.rootExternalId).toBe(s.rootExternalId);
    });
  });

  it('project rename', () => {
    expect(go(JIRA, { projects: [{ externalId: 'ENG', name: 'Platform' }] }).resolved.projects.get('ENG')).toEqual({ name: 'Platform' });
  });
});
