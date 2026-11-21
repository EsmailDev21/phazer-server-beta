import { IssueTypeLevel, Priority, TaskStatus } from '@prisma/client';
import { CONFIG_LIMITS, checkConfig, parseConfig } from './mapping.config';
import { CONTEXT, JIRA } from './fixtures/provider-fixtures';
import { MappingConfigV1 } from './mapping.types';

const ok = (raw: unknown): MappingConfigV1 => {
  const r = parseConfig(raw);
  if ('problems' in r) throw new Error(`expected ok: ${JSON.stringify(r.problems)}`);
  return r.config;
};
const bad = (raw: unknown) => {
  const r = parseConfig(raw);
  if (!('problems' in r)) throw new Error('expected problems');
  return r.problems;
};
const check = (c: unknown, inv: typeof JIRA | null = JIRA, ctx: typeof CONTEXT | null = CONTEXT) => checkConfig(ok(c), inv, ctx);
const codes = (p: Array<{ code: string }>) => p.map((x) => x.code);

describe('mapping config (step 4.3)', () => {
  describe('parseConfig: strict shape', () => {
    it('nothing, null, {} are "no overrides"', () => {
      for (const v of [undefined, null, {}]) expect(ok(v)).toEqual({ version: 1 });
    });
    it('a complete config round-trips unchanged', () => {
      const full = {
        version: 1, matchByEmail: false,
        projects: [{ externalId: 'ENG', name: 'Eng' }],
        statuses: [{ statusExternalId: '10001', category: 'IN_PROGRESS', excludeFromProgress: false, name: 'Doing' }, { statusExternalId: '10003', mergeInto: '10002' }],
        priorities: [{ raw: 'Showstopper', priority: 'URGENT' }, { raw: 'Meh', priority: null }],
        users: [{ externalId: 'j-1', target: { kind: 'user', userId: 'u1' } }, { externalId: 'j-2', target: { kind: 'importer' } }],
        issueTypes: [{ externalId: 'epic', target: { kind: 'create' }, level: 'EPIC' }, { externalId: 'bug', target: { kind: 'existing', id: 'it-bug' } }, { externalId: 'sub', target: { kind: 'skip' } }],
        customFields: [{ externalId: 'cf1', target: { kind: 'create' }, name: 'Pts' }],
      };
      expect(ok(full)).toEqual(full);
    });
    it('returns a COPY, never the caller\'s object', () => {
      const input = { version: 1, projects: [{ externalId: 'a', name: 'n' }] };
      const out = ok(input);
      out.projects![0].name = 'changed';
      expect(input.projects[0].name).toBe('n');
    });
    it.each([
      ['wrong version', { version: 2 }], ['no version', { projects: [] }], ['unknown key', { version: 1, extra: 1 }], ['array', []], ['string', 'x'],
      ['unknown row key', { version: 1, projects: [{ externalId: 'a', name: 'n', color: 'red' }] }],
      ['missing row field', { version: 1, projects: [{ externalId: 'a' }] }],
      ['empty id', { version: 1, users: [{ externalId: '', target: { kind: 'importer' } }] }],
      ['bad category', { version: 1, statuses: [{ statusExternalId: 's', category: 'ARCHIVED' }] }],
      ['bad priority', { version: 1, priorities: [{ raw: 'x', priority: 'CRITICAL' }] }],
      ['priority missing', { version: 1, priorities: [{ raw: 'x' }] }],
      ['user target without id', { version: 1, users: [{ externalId: 'a', target: { kind: 'user' } }] }],
      ['importer target with id', { version: 1, users: [{ externalId: 'a', target: { kind: 'importer', userId: 'x' } }] }],
      ['unknown target kind', { version: 1, users: [{ externalId: 'a', target: { kind: 'skip' } }] }],
      ['entity target existing without id', { version: 1, issueTypes: [{ externalId: 'a', target: { kind: 'existing' } }] }],
      ['bad level', { version: 1, issueTypes: [{ externalId: 'a', target: { kind: 'create' }, level: 'HUGE' }] }],
      ['matchByEmail not boolean', { version: 1, matchByEmail: 'yes' }],
      ['rows not an array', { version: 1, statuses: {} }],
      ['name too long', { version: 1, projects: [{ externalId: 'a', name: 'n'.repeat(CONFIG_LIMITS.name + 1) }] }],
      ['too many rows', { version: 1, users: Array.from({ length: CONFIG_LIMITS.maxRows + 1 }, (_, i) => ({ externalId: `u${i}`, target: { kind: 'importer' } })) }],
      ['__proto__ key', JSON.parse('{"version":1,"__proto__":{"x":1}}')],
      ['__proto__ in a row', JSON.parse('{"version":1,"projects":[{"externalId":"a","name":"n","__proto__":{}}]}')],
    ])('rejects %s', (_n, raw) => {
      const p = bad(raw);
      expect(p.length).toBeGreaterThan(0);
      expect(p.every((x) => x.code === 'INVALID_SHAPE')).toBe(true);
    });
    it('non-JSON input (a cycle) is a shape problem, not an exception', () => {
      const a: Record<string, unknown> = { version: 1 };
      a.self = a;
      expect(bad(a)[0].code).toBe('INVALID_SHAPE');
    });
    it('control characters are removed from names and raw priority keys', () => {
      const c = ok({ version: 1, projects: [{ externalId: 'a', name: ' Na\u0000me ' }], priorities: [{ raw: 'Hi\u0007gh', priority: 'HIGH' }], statuses: [{ statusExternalId: 's', name: 'Do\u0001ne' }], customFields: [{ externalId: 'f', target: { kind: 'create' }, name: 'F\u0000' }] });
      expect([c.projects![0].name, c.priorities![0].raw, c.statuses![0].name, c.customFields![0].name]).toEqual(['Name', 'High', 'Done', 'F']);
    });
    it('problem paths point at the offending row', () => {
      expect(bad({ version: 1, statuses: [{ statusExternalId: 'a' }, { statusExternalId: 'b', category: 'NOPE' }] }).some((p) => p.path.startsWith('/statuses/1'))).toBe(true);
    });
  });

  describe('checkConfig: duplicates', () => {
    it.each([
      ['projects', { projects: [{ externalId: 'ENG', name: 'a' }, { externalId: 'ENG', name: 'b' }] }],
      ['statuses', { statuses: [{ statusExternalId: '10001' }, { statusExternalId: '10001' }] }],
      ['priorities (case / decoration insensitive)', { priorities: [{ raw: 'High', priority: Priority.HIGH }, { raw: 'high (2)', priority: Priority.LOW }] }],
      ['users', { users: [{ externalId: 'j-1', target: { kind: 'importer' } }, { externalId: 'j-1', target: { kind: 'importer' } }] }],
      ['issue types', { issueTypes: [{ externalId: 'bug', target: { kind: 'skip' } }, { externalId: 'bug', target: { kind: 'skip' } }] }],
      ['custom fields', { customFields: [{ externalId: 'cf1', target: { kind: 'skip' } }, { externalId: 'cf1', target: { kind: 'skip' } }] }],
    ])('%s', (_n, rows) => {
      expect(codes(check({ version: 1, ...rows }))).toContain('DUPLICATE_KEY');
    });
  });

  describe('checkConfig: against the job\'s inventory', () => {
    it('a valid config has no problems', () => {
      expect(check({ version: 1, statuses: [{ statusExternalId: '10004', category: TaskStatus.BLOCKED }], priorities: [{ raw: 'Showstopper', priority: Priority.URGENT }], users: [{ externalId: 'j-2', target: { kind: 'user', userId: 'local-ben' } }] })).toEqual([]);
    });
    it('every row must name something that is part of the import', () => {
      const p = check({ version: 1, projects: [{ externalId: 'NOPE', name: 'x' }], statuses: [{ statusExternalId: 'nope' }], users: [{ externalId: 'nope', target: { kind: 'importer' } }], issueTypes: [{ externalId: 'nope', target: { kind: 'skip' } }], customFields: [{ externalId: 'nope', target: { kind: 'skip' } }] });
      expect(p.map((x) => x.path)).toEqual(['/projects/0', '/statuses/0', '/users/0', '/issueTypes/0', '/customFields/0']);
      expect(new Set(codes(p))).toEqual(new Set(['UNKNOWN_SOURCE_ENTITY']));
    });
    it('with no inventory yet, only shape and duplicates are checked', () => {
      expect(check({ version: 1, statuses: [{ statusExternalId: 'anything' }] }, null, null)).toEqual([]);
    });

    describe('merging statuses', () => {
      it('into another status of the same project is fine', () => {
        expect(check({ version: 1, statuses: [{ statusExternalId: '10003', mergeInto: '10002' }] })).toEqual([]);
      });
      it.each([
        ['itself', { statuses: [{ statusExternalId: '10003', mergeInto: '10003' }] }, 'MERGE_INVALID'],
        ['a chain (target is itself merged)', { statuses: [{ statusExternalId: '10003', mergeInto: '10002' }, { statusExternalId: '10002', mergeInto: '10001' }] }, 'MERGE_INVALID'],
        ['a loop', { statuses: [{ statusExternalId: '10003', mergeInto: '10002' }, { statusExternalId: '10002', mergeInto: '10003' }] }, 'MERGE_INVALID'],
        ['a status that does not exist', { statuses: [{ statusExternalId: '10003', mergeInto: 'nope' }] }, 'UNKNOWN_SOURCE_ENTITY'],
        ['with other fields on the merged row', { statuses: [{ statusExternalId: '10003', mergeInto: '10002', category: TaskStatus.DONE }] }, 'MERGE_INVALID'],
      ])('refuses merging into %s', (_n, rows, code) => {
        expect(codes(check({ version: 1, ...rows }))).toContain(code);
      });
      it('across projects is refused', () => {
        const inv = { ...JIRA, projects: [...JIRA.projects, { externalId: 'OPS', name: 'Ops', statuses: [{ externalId: 'o1', name: 'Open', category: 'TODO' as const }] }] };
        expect(codes(check({ version: 1, statuses: [{ statusExternalId: 'o1', mergeInto: '10002' }] }, inv))).toContain('MERGE_INVALID');
      });
    });

    it('two statuses of one project that would end up with the same name collide; merging one resolves it', () => {
      const rename = { statusExternalId: '10003', name: 'in progress' }; // folds equal to "In Progress" (10002)
      expect(codes(check({ version: 1, statuses: [rename] }))).toContain('NAME_COLLISION');
      expect(check({ version: 1, statuses: [{ statusExternalId: '10003', mergeInto: '10002' }] })).toEqual([]);
    });
    it('"excluded from progress" is only allowed on a DONE status', () => {
      expect(codes(check({ version: 1, statuses: [{ statusExternalId: '10002', excludeFromProgress: true }] }))).toContain('CATEGORY_INVALID');
      expect(check({ version: 1, statuses: [{ statusExternalId: '10002', category: TaskStatus.DONE, excludeFromProgress: true }] })).toEqual([]);
      expect(check({ version: 1, statuses: [{ statusExternalId: '10005', excludeFromProgress: true }] })).toEqual([]); // Done already
    });
  });

  describe('checkConfig: against the workspace', () => {
    it('a person target must be a member', () => {
      expect(codes(check({ version: 1, users: [{ externalId: 'j-1', target: { kind: 'user', userId: 'a-stranger' } }] }))).toEqual(['NOT_A_MEMBER']);
    });
    it('an "existing" issue type / field must exist here; a field must have the source field\'s type', () => {
      expect(codes(check({ version: 1, issueTypes: [{ externalId: 'bug', target: { kind: 'existing', id: 'ghost' } }] }))).toEqual(['UNKNOWN_TARGET']);
      expect(codes(check({ version: 1, customFields: [{ externalId: 'cf1', target: { kind: 'existing', id: 'ghost' } }] }))).toEqual(['UNKNOWN_TARGET']);
      expect(codes(check({ version: 1, customFields: [{ externalId: 'cf2', target: { kind: 'existing', id: 'cf-severity' } }] }))).toEqual(['TYPE_MISMATCH']); // source SELECT, workspace TEXT
      expect(check({ version: 1, customFields: [{ externalId: 'cf1', target: { kind: 'existing', id: 'cf-points' } }], issueTypes: [{ externalId: 'epic', target: { kind: 'create' }, level: IssueTypeLevel.EPIC }] })).toEqual([]);
    });
  });
});
