import { FieldType, ImportIssueSeverity as Sev, IssueTypeLevel, Priority, TaskStatus } from '@prisma/client';
import { CANONICAL_LIMITS, CanonicalBundle, validateBundle } from '../canonical';
import { applyMapping, mappedTaskHash } from './mapping.apply';
import { resolve } from './mapping.resolve';
import { CONTEXT, JIRA } from './fixtures/provider-fixtures';
import { MappingConfigV1, MappingContext, MappingInventory } from './mapping.types';

const T = TaskStatus;

/** A page as the Jira adapter would emit it for the JIRA fixture inventory, validated like real input. */
function page(extra: Record<string, unknown> = {}): CanonicalBundle {
  const r = validateBundle({
    schemaVersion: 1,
    source: { system: 'jira', displayName: 'Jira' },
    projects: JIRA.projects.map((p) => ({ externalId: p.externalId, name: p.name, key: 'ENG', statuses: p.statuses })),
    issueTypes: JIRA.issueTypes,
    customFields: JIRA.customFields,
    ...extra,
  });
  if ('fatal' in r) throw new Error(JSON.stringify(r.fatal));
  return r.bundle;
}
const task = (extra: Record<string, unknown> = {}) => ({ externalId: 't1', title: 'A task', projectExternalId: 'ENG', ...extra });
const map = (p: CanonicalBundle, config: Partial<MappingConfigV1> = {}, inv: MappingInventory = JIRA, ctx: MappingContext = CONTEXT) =>
  applyMapping(p, resolve(inv, ctx, { version: 1, ...config }).resolved);
const one = (extra: Record<string, unknown>, config: Partial<MappingConfigV1> = {}) => map(page({ tasks: [task(extra)] }), config).tasks[0];

describe('applying a mapping to a page (step 4.3)', () => {
  describe('projects and their workflow statuses', () => {
    const p = map(page()).projects[0];
    it('one workflow status per source status, in source order, with category, exclusion and colour', () => {
      expect(p.statuses.map((s) => [s.externalId, s.name, s.category, s.excludeFromProgress, s.position])).toEqual([
        ['10000', 'Backlog', T.TODO, false, 0], ['10001', 'To Do', T.TODO, false, 1], ['10002', 'In Progress', T.IN_PROGRESS, false, 2],
        ['10003', 'In Review', T.IN_PROGRESS, false, 3], ['10004', 'Blocked', T.BLOCKED, false, 4], ['10005', 'Done', T.DONE, false, 5], ['10006', "Won't Do", T.DONE, true, 6],
      ]);
      expect(p.statuses.every((s) => /^#[0-9A-Fa-f]{6}$/.test(s.color))).toBe(true);
    });
    it('the initial status is the first To-do-category one by position', () => {
      expect(p.initialStatusExternalId).toBe('10000');
    });
    it('the project keeps its key / name; a rename applies', () => {
      expect(p).toMatchObject({ externalId: 'ENG', key: 'ENG', name: 'Engineering' });
      expect(map(page(), { projects: [{ externalId: 'ENG', name: 'Platform' }] }).projects[0].name).toBe('Platform');
    });
    it('merged statuses become ONE workflow status that lists every source status it stands for', () => {
      const m = map(page(), { statuses: [{ statusExternalId: '10003', mergeInto: '10002' }] }).projects[0];
      expect(m.statuses.map((s) => s.externalId)).toEqual(['10000', '10001', '10002', '10004', '10005', '10006']);
      expect(m.statuses.find((s) => s.externalId === '10002')?.sourceExternalIds).toEqual(['10002', '10003']);
      expect(m.statuses.map((s) => s.position)).toEqual([0, 1, 2, 3, 4, 5]); // renumbered, no gaps
    });
    it('a rename that would collide gets a distinct name (the database would refuse a duplicate)', () => {
      const m = map(page(), { statuses: [{ statusExternalId: '10003', name: 'in progress' }] }).projects[0];
      expect(m.statuses.map((s) => s.name)).toContain('in progress (2)');
    });
    it('a project with no statuses (GitHub-like) gets none and no initial status: the executor seeds the defaults', () => {
      const bare = validateBundle({ schemaVersion: 1, source: { system: 'jira', displayName: 'Jira' }, projects: [{ externalId: 'ENG', name: 'E' }] });
      const m = map((bare as { bundle: CanonicalBundle }).bundle).projects[0];
      expect(m.statuses).toEqual([]);
      expect(m).not.toHaveProperty('initialStatusExternalId');
    });
    it('a workflow missing a required category is COMPLETED with synthetic statuses (the database refuses a project without To Do / In Progress / Done)', () => {
      const r = validateBundle({ schemaVersion: 1, source: { system: 'github', displayName: 'GitHub' }, projects: [{ externalId: 'repo', name: 'repo', statuses: [{ externalId: 'open', name: 'Open', category: 'TODO' }, { externalId: 'closed', name: 'Closed', category: 'DONE' }] }] });
      const inv: MappingInventory = { system: 'github', displayName: 'GitHub', projects: [{ externalId: 'repo', name: 'repo', statuses: [{ externalId: 'open', name: 'Open', category: 'TODO' }, { externalId: 'closed', name: 'Closed', category: 'DONE' }] }], priorities: [], users: [], issueTypes: [], customFields: [] };
      const m = map((r as { bundle: CanonicalBundle }).bundle, {}, inv).projects[0];
      expect(m.statuses.map((s) => [s.externalId, s.name, s.category, s.sourceExternalIds, s.position])).toEqual([
        ['open', 'Open', T.TODO, ['open'], 0], ['synthetic:repo:IN_PROGRESS', 'In Progress', T.IN_PROGRESS, [], 1], ['closed', 'Closed', T.DONE, ['closed'], 2],
      ]);
      expect(m.initialStatusExternalId).toBe('open');
    });
    it('a source with only one category gets the other two, in a sensible order, with distinct names', () => {
      const one = (statuses: unknown[]) => {
        const r = validateBundle({ schemaVersion: 1, source: { system: 'jira', displayName: 'Jira' }, projects: [{ externalId: 'ENG', name: 'E', statuses }] });
        const inv: MappingInventory = { ...JIRA, projects: [{ externalId: 'ENG', name: 'E', statuses: statuses as never }] };
        return map((r as { bundle: CanonicalBundle }).bundle, {}, inv).projects[0];
      };
      const m = one([{ externalId: 'a', name: 'To Do', category: 'IN_PROGRESS' }]); // a status literally named "To Do" that is In Progress
      expect(m.statuses.map((s) => [s.name, s.category])).toEqual([['To Do (2)', T.TODO], ['To Do', T.IN_PROGRESS], ['Done', T.DONE]]);
      expect(m.initialStatusExternalId).toBe('synthetic:ENG:TODO');
      expect(new Set(m.statuses.map((s) => s.name.toLowerCase())).size).toBe(3);
    });
    it('over the 30-status ceiling once the missing categories are added: the overflow FOLDS into its category\'s first status, nothing is dropped', () => {
      const statuses = Array.from({ length: 30 }, (_, i) => ({ externalId: `s${i}`, name: `Todo ${i}`, category: 'TODO' }));
      const r = validateBundle({ schemaVersion: 1, source: { system: 'jira', displayName: 'Jira' }, projects: [{ externalId: 'ENG', name: 'E', statuses }] });
      const inv: MappingInventory = { ...JIRA, projects: [{ externalId: 'ENG', name: 'E', statuses: statuses as never }] };
      const m = map((r as { bundle: CanonicalBundle }).bundle, {}, inv).projects[0];
      expect(m.statuses.length).toBeLessThanOrEqual(30);
      expect(new Set(m.statuses.map((s) => s.category))).toEqual(new Set([T.TODO, T.IN_PROGRESS, T.DONE]));
      const mapped = m.statuses.flatMap((s) => s.sourceExternalIds).sort();
      expect(mapped).toEqual(statuses.map((s) => s.externalId).sort()); // every source status still has a home
      expect(m.statuses.map((s) => s.position)).toEqual(m.statuses.map((_, i) => i));
    });
    it('every mapped workflow is valid for the database whatever the source looks like', () => {
      const cats = ['BACKLOG', 'TODO', 'IN_PROGRESS', 'DONE', 'CANCELED', 'UNKNOWN'] as const;
      for (let mask = 1; mask < 64; mask++) {
        const statuses = cats.filter((_, i) => mask & (1 << i)).map((category, i) => ({ externalId: `x${i}`, name: category === 'UNKNOWN' ? 'Mystery' : `S ${category}`, category }));
        const r = validateBundle({ schemaVersion: 1, source: { system: 'jira', displayName: 'Jira' }, projects: [{ externalId: 'ENG', name: 'E', statuses }] });
        const inv: MappingInventory = { ...JIRA, projects: [{ externalId: 'ENG', name: 'E', statuses: statuses as never }] };
        const m = map((r as { bundle: CanonicalBundle }).bundle, {}, inv).projects[0];
        const present = new Set(m.statuses.map((s) => s.category));
        for (const c of [T.TODO, T.IN_PROGRESS, T.DONE]) expect(present.has(c)).toBe(true);
        expect(m.statuses.length).toBeLessThanOrEqual(30);
        expect(new Set(m.statuses.map((s) => s.name.toLowerCase())).size).toBe(m.statuses.length);
        expect(m.statuses.find((s) => s.externalId === m.initialStatusExternalId)?.category).toBe(T.TODO);
      }
    });
    it('without a TODO status the first one starts', () => {
      const only = validateBundle({ schemaVersion: 1, source: { system: 'jira', displayName: 'Jira' }, projects: [{ externalId: 'ENG', name: 'E', statuses: [{ externalId: 'a', name: 'Doing', category: 'IN_PROGRESS' }, { externalId: 'b', name: 'Done', category: 'DONE' }] }] });
      expect(map((only as { bundle: CanonicalBundle }).bundle).projects[0].initialStatusExternalId).toBe('a');
    });
    it('source colours are kept; positions given by the source order the statuses', () => {
      const r = validateBundle({ schemaVersion: 1, source: { system: 'jira', displayName: 'Jira' }, projects: [{ externalId: 'ENG', name: 'E', statuses: [{ externalId: 'late', name: 'Late', category: 'DONE', color: '#112233', position: 9 }, { externalId: 'early', name: 'Early', category: 'TODO', position: 1 }] }] });
      const inv: MappingInventory = { ...JIRA, projects: [{ externalId: 'ENG', name: 'E', statuses: [{ externalId: 'late', name: 'Late', category: 'DONE', color: '#112233', position: 9 }, { externalId: 'early', name: 'Early', category: 'TODO', position: 1 }] }] };
      const m = map((r as { bundle: CanonicalBundle }).bundle, {}, inv).projects[0];
      expect(m.statuses.filter((s) => s.sourceExternalIds.length > 0).map((s) => [s.externalId, s.color])).toEqual([['early', '#94A3B8'], ['late', '#112233']]); // (a synthetic In Progress sits between them)
    });
  });

  describe('task status, priority, type', () => {
    it('status: category on the task, the (root) workflow status it points at', () => {
      expect(one({ statusExternalId: '10004' })).toMatchObject({ status: T.BLOCKED, workflowStatusExternalId: '10004' });
      expect(one({ statusExternalId: '10006' })).toMatchObject({ status: T.DONE, workflowStatusExternalId: '10006' });
      expect(one({ statusExternalId: '10003' }, { statuses: [{ statusExternalId: '10003', mergeInto: '10002' }] })).toMatchObject({ status: T.IN_PROGRESS, workflowStatusExternalId: '10002' });
    });
    it('no status: To do and the project\'s initial status; an unknown status is reported once and treated the same', () => {
      expect(one({})).toMatchObject({ status: T.TODO });
      expect(one({})).not.toHaveProperty('workflowStatusExternalId');
      const r = map(page({ tasks: [task({ externalId: 'a', statusExternalId: 'zzz' }), task({ externalId: 'b', statusExternalId: 'zzz' })] }));
      expect(r.tasks.every((t) => t.status === T.TODO && t.workflowStatusExternalId === undefined)).toBe(true);
      expect(r.issues).toEqual([{ severity: Sev.INFO, code: 'STATUS_UNKNOWN', externalRef: 'status:zzz', message: expect.any(String) }]);
    });
    it('priority: the table, an override, "no priority"; an unrecognised value is reported ONCE per page', () => {
      expect(one({ priority: 'Highest' }).priority).toBe(Priority.URGENT);
      expect(one({ priority: 'High (2)' }).priority).toBe(Priority.HIGH);
      expect(one({}).priority).toBeNull();
      expect(one({ priority: 'Showstopper' }, { priorities: [{ raw: 'showstopper', priority: Priority.URGENT }] }).priority).toBe(Priority.URGENT);
      const r = map(page({ tasks: [task({ externalId: 'a', priority: 'Mystery' }), task({ externalId: 'b', priority: 'mystery' })] }));
      expect(r.tasks.map((t) => t.priority)).toEqual([null, null]);
      expect(r.issues.filter((i) => i.code === 'PRIORITY_UNMATCHED')).toHaveLength(1);
    });
    it('issue type: existing by id, create by source id, skip / unknown = none', () => {
      expect(one({ issueTypeExternalId: 'bug' }).issueType).toEqual({ kind: 'existing', id: 'it-bug', externalId: 'bug' });
      expect(one({ issueTypeExternalId: 'story' }).issueType).toEqual({ kind: 'create', externalId: 'story' });
      expect(one({ issueTypeExternalId: 'story' }, { issueTypes: [{ externalId: 'story', target: { kind: 'skip' } }] })).not.toHaveProperty('issueType');
      expect(one({ issueTypeExternalId: 'unheard-of' })).not.toHaveProperty('issueType');
    });
  });

  describe('people', () => {
    it('assignees: matched members are assigned (de-duplicated); everyone else is left off, reported ONCE per person per page', () => {
      const r = map(page({ users: JIRA.users, tasks: [task({ externalId: 'a', assigneeExternalIds: ['j-1', 'j-3'] }), task({ externalId: 'b', assigneeExternalIds: ['j-3', 'j-5'] })] }));
      expect(r.tasks.map((t) => t.assigneeUserIds)).toEqual([['local-ana'], []]);
      expect(r.issues.filter((i) => i.code === 'USER_UNMAPPED').map((i) => i.externalRef)).toEqual(['user:j-3', 'user:j-5']);
      expect(r.issues.every((i) => i.severity === Sev.WARN)).toBe(true);
    });
    it('two source people mapped to one member assign them once', () => {
      const t = one({ assigneeExternalIds: ['j-1', 'j-2'] }, { users: [{ externalId: 'j-2', target: { kind: 'user', userId: 'local-ana' } }] });
      expect(t.assigneeUserIds).toEqual(['local-ana']);
    });
    it('creator: the member when matched, otherwise the importer labelled "Name (via Jira)"', () => {
      expect(one({ creatorExternalId: 'j-1' }).creator).toEqual({ kind: 'user', userId: 'local-ana' });
      expect(one({ creatorExternalId: 'j-3' }).creator).toEqual({ kind: 'importer', label: 'Dana NoEmail (via Jira)' });
      expect(one({}).creator).toEqual({ kind: 'importer', label: 'Someone (via Jira)' });
      expect(one({ creatorExternalId: 'j-4' }).creator).toEqual({ kind: 'importer', label: 'Automation for Jira (via Jira)' });
    });
  });

  describe('comments', () => {
    const c = (extra: Record<string, unknown>) => one({ comments: [{ externalId: 'c1', body: 'Looks good', ...extra }] }).comments[0];
    it('a matched author keeps the comment as written', () => {
      expect(c({ authorExternalId: 'j-1' })).toEqual({ externalId: 'c1', author: { kind: 'user', userId: 'local-ana' }, body: 'Looks good' });
    });
    it('an unmatched author: credited to the importer, named in bold on its own line ("Name (via Jira)")', () => {
      expect(c({ authorExternalId: 'j-3' })).toMatchObject({ author: { kind: 'importer', label: 'Dana NoEmail (via Jira)' }, body: '**Dana NoEmail (via Jira)**\n\nLooks good' });
    });
    it('a person the source did not even list: the name the comment carries, else "Someone"', () => {
      expect(c({ authorName: 'Ghost Writer' }).body).toBe('**Ghost Writer (via Jira)**\n\nLooks good');
      expect(c({}).body).toBe('**Someone (via Jira)**\n\nLooks good');
    });
    it('the author\'s name cannot inject markdown into the comment', () => {
      const body = c({ authorName: '*x* [click](https://evil.example) <b>' }).body;
      expect(body.split('\n')[0]).toBe('**\\*x\\* \\[click\\](https://evil.example) \\<b\\> (via Jira)**');
    });
    it('a body that no longer fits once the name is added is cut (and reported); a matched author\'s is never touched', () => {
      const long = 'w '.repeat(CANONICAL_LIMITS.commentBody / 2);
      const r = map(page({ tasks: [task({ comments: [{ externalId: 'c1', body: long, authorName: 'N' }, { externalId: 'c2', body: long, authorExternalId: 'j-1' }] })] }));
      const [a, b] = r.tasks[0].comments;
      expect(a.body.length).toBeLessThanOrEqual(CANONICAL_LIMITS.commentBody);
      expect(b.body).toBe(long.trim());
      expect(r.issues.filter((i) => i.code === 'COMMENT_TRUNCATED')).toHaveLength(1);
    });
    it('threads, dates and edit times pass through', () => {
      const out = one({ comments: [{ externalId: 'a', body: 'x', authorExternalId: 'j-1', createdAt: '2026-01-01T00:00:00Z' }, { externalId: 'b', body: 'y', authorExternalId: 'j-1', parentExternalId: 'a', editedAt: '2026-01-02T00:00:00Z' }] }).comments;
      expect(out[0].createdAt).toBe('2026-01-01T00:00:00.000Z');
      expect(out[1]).toMatchObject({ parentExternalId: 'a', editedAt: '2026-01-02T00:00:00.000Z' });
    });
  });

  describe('history', () => {
    it('actors are mapped like authors; entries without an actor keep none', () => {
      const h = one({ history: [{ externalId: 'h1', at: '2026-01-01T00:00:00Z', field: 'status', from: 'A', to: 'B', actorExternalId: 'j-1' }, { externalId: 'h2', at: '2026-01-02T00:00:00Z', field: 'x', actorExternalId: 'j-3' }, { externalId: 'h3', at: '2026-01-03T00:00:00Z', field: 'y' }] }).history;
      expect(h.map((x) => x.actor)).toEqual([{ kind: 'user', userId: 'local-ana' }, { kind: 'importer', label: 'Dana NoEmail (via Jira)' }, null]);
      expect(h[0]).toMatchObject({ from: 'A', to: 'B' });
      expect(h[2]).not.toHaveProperty('from');
    });
  });

  describe('custom fields', () => {
    const cv = (values: unknown[], config: Partial<MappingConfigV1> = {}) => one({ customValues: values }, config).customValues;
    it('values follow their field\'s target: existing id, created, or dropped when skipped', () => {
      expect(cv([{ fieldExternalId: 'cf1', value: 5 }, { fieldExternalId: 'cf2', value: 'S1' }])).toEqual([
        { fieldExternalId: 'cf1', target: { kind: 'existing', id: 'cf-points' }, value: 5 },
        { fieldExternalId: 'cf2', target: { kind: 'create' }, value: 'S1' },
      ]);
      expect(cv([{ fieldExternalId: 'cf1', value: 5 }], { customFields: [{ externalId: 'cf1', target: { kind: 'skip' } }] })).toEqual([]);
    });
    it('a USER field value becomes the local user id; an unmatched person leaves it empty and is reported once', () => {
      expect(cv([{ fieldExternalId: 'cf3', value: 'j-1' }])).toEqual([{ fieldExternalId: 'cf3', target: { kind: 'create' }, value: 'local-ana' }]);
      const r = map(page({ users: JIRA.users, tasks: [task({ externalId: 'a', customValues: [{ fieldExternalId: 'cf3', value: 'j-3' }] }), task({ externalId: 'b', customValues: [{ fieldExternalId: 'cf3', value: 'j-3' }] })] }));
      expect(r.tasks.map((t) => t.customValues)).toEqual([[], []]);
      expect(r.issues.filter((i) => i.code === 'CUSTOM_VALUE_USER_UNMAPPED')).toHaveLength(1);
    });
    it('a value for a field the mapping does not know is dropped', () => {
      expect(cv([{ fieldExternalId: 'not-in-inventory', value: 'x' }])).toEqual([]);
    });
  });

  describe('entities to create on this page', () => {
    const r = map(page({ tags: [{ name: 'bug', color: '#ff0000' }], iterations: [{ externalId: 'sp1', kind: 'SPRINT', name: 'S1' }], dependencies: [{ externalId: 'd1', fromExternalId: 'a', toExternalId: 'b', type: 'BLOCKS' }] }));
    it('only issue types / fields whose target is CREATE are listed, with the mapped name and level', () => {
      expect(r.issueTypes.map((t) => [t.externalId, t.name, t.level])).toEqual([['epic', 'Epic', IssueTypeLevel.EPIC], ['story', 'Story', IssueTypeLevel.STANDARD], ['sub', 'Sub-task', IssueTypeLevel.SUBTASK]]);
      expect(r.customFields.map((f) => [f.externalId, f.name, f.dataType, f.options])).toEqual([
        ['cf2', 'Severity (Jira)', FieldType.SELECT, ['S1', 'S2']], ['cf3', 'Reviewer', FieldType.USER, undefined],
      ]);
    });
    it('a created type / field uses the person\'s level / name override', () => {
      const o = map(page(), { issueTypes: [{ externalId: 'story', target: { kind: 'create' }, level: IssueTypeLevel.EPIC }], customFields: [{ externalId: 'cf2', target: { kind: 'create' }, name: 'Sev' }] });
      expect(o.issueTypes.find((t) => t.externalId === 'story')?.level).toBe(IssueTypeLevel.EPIC);
      expect(o.customFields.find((f) => f.externalId === 'cf2')?.name).toBe('Sev');
    });
    it('iterations, tags and dependencies pass through', () => {
      expect(r.iterations).toEqual([{ externalId: 'sp1', kind: 'SPRINT', name: 'S1' }]);
      expect(r.tags).toEqual([{ name: 'bug', color: '#ff0000' }]);
      expect(r.dependencies).toEqual([{ externalId: 'd1', fromExternalId: 'a', toExternalId: 'b', type: 'BLOCKS' }]);
    });
  });

  describe('everything else a task carries', () => {
    it('references, text, dates, estimate, tags, attachments pass through untouched', () => {
      const t = one({ key: 'ENG-1', url: 'https://x.com/1', parentExternalId: 'p', description: 'Body', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', startDate: '2026-01-03', dueDate: '2026-01-04', estimate: 3, iterationExternalId: 'sp1', archived: false, tags: ['a', 'b'], attachments: [{ externalId: 'at', fileName: 'f.txt', providerRef: 'r' }] });
      expect(t).toMatchObject({ externalId: 't1', key: 'ENG-1', url: 'https://x.com/1', projectExternalId: 'ENG', parentExternalId: 'p', title: 'A task', description: 'Body', estimate: 3, iterationExternalId: 'sp1', archived: false, tags: ['a', 'b'] });
      expect(t.startDate).toBe('2026-01-03T00:00:00.000Z');
      expect(t.attachments).toEqual([{ externalId: 'at', fileName: 'f.txt', providerRef: 'r', uploader: expect.objectContaining({ kind: 'importer' }) }]);
    });
    it('an empty page maps to an empty result', () => {
      const r = validateBundle({ schemaVersion: 1, source: { system: 'jira', displayName: 'Jira' } });
      expect(map((r as { bundle: CanonicalBundle }).bundle)).toEqual({ projects: [], issueTypes: [], customFields: [], iterations: [], tags: [], tasks: [], dependencies: [], issues: [] });
    });
    it('does not mutate the page or the resolved mapping', () => {
      const p = page({ tasks: [task({ assigneeExternalIds: ['j-1'], comments: [{ externalId: 'c', body: 'x', authorExternalId: 'j-3' }] })] });
      const before = JSON.stringify(p);
      const res = resolve(JIRA, CONTEXT, { version: 1 }).resolved;
      const f = (o: unknown): void => { if (o && typeof o === 'object' && !(o instanceof Map)) { Object.freeze(o); Object.values(o).forEach(f); } };
      f(p);
      expect(() => applyMapping(p, res)).not.toThrow();
      expect(JSON.stringify(p)).toBe(before);
    });
  });

  describe('mappedTaskHash: re-running is a no-op until the MAPPING changes', () => {
    const base = { assigneeExternalIds: ['j-1'], priority: 'High', statusExternalId: '10002', description: 'D' };
    it('same page + same mapping = same hash', () => {
      expect(mappedTaskHash(one(base))).toBe(mappedTaskHash(one(base)));
    });
    it('a change to the task, OR to the mapping that affects it, changes the hash', () => {
      const h = mappedTaskHash(one(base));
      expect(mappedTaskHash(one({ ...base, description: 'D2' }))).not.toBe(h);
      expect(mappedTaskHash(one(base, { priorities: [{ raw: 'High', priority: Priority.LOW }] }))).not.toBe(h);
      expect(mappedTaskHash(one(base, { users: [{ externalId: 'j-1', target: { kind: 'importer' } }] }))).not.toBe(h);
      expect(mappedTaskHash(one(base, { statuses: [{ statusExternalId: '10002', category: T.BLOCKED }] }))).not.toBe(h);
    });
    it('comments, attachments, history and updatedAt do not change it (their own refs track them)', () => {
      const h = mappedTaskHash(one(base));
      expect(mappedTaskHash(one({ ...base, comments: [{ externalId: 'c', body: 'new' }], attachments: [{ externalId: 'a', fileName: 'f', providerRef: 'r' }], history: [{ externalId: 'h', at: '2026-01-01T00:00:00Z', field: 'f' }], updatedAt: '2026-02-02T00:00:00Z' }))).toBe(h);
    });
    it('a mapping change that does not touch the task leaves its hash alone', () => {
      const h = mappedTaskHash(one(base));
      expect(mappedTaskHash(one(base, { priorities: [{ raw: 'Showstopper', priority: Priority.URGENT }] }))).toBe(h);
    });
  });
});
