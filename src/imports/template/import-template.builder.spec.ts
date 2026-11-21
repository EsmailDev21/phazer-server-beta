import { FieldType, IterationKind, IssueTypeLevel, DependencyType } from '@prisma/client';
import { BLUEPRINT_LIMITS } from '../../templates/blueprint';
import { sanitize } from '../../templates/sanitize';
import { validateBlueprint } from '../../templates/blueprint';
import { MappedPage, MappedTask } from '../mapping';
import { ANONYMOUS_USER, ImportTemplateError, buildRawFromImport } from './import-template.builder';

const emptyPage = (): MappedPage => ({ projects: [], customFields: [], issueTypes: [], iterations: [], tags: [], tasks: [], dependencies: [], issues: [] }) as unknown as MappedPage;
const project = (id: string, name = id) => ({ externalId: id, name, description: null, statuses: [{ externalId: `${id}:todo`, sourceExternalIds: [`${id}:todo`], name: 'To Do', category: 'TODO', color: null, excludeFromProgress: false }, { externalId: `${id}:done`, sourceExternalIds: [`${id}:done`, `${id}:closed`], name: 'Done', category: 'DONE', color: null, excludeFromProgress: false }], initialStatusExternalId: `${id}:todo`, archived: false });
const task = (id: string, extra: Partial<MappedTask> = {}): MappedTask => ({ externalId: id, projectExternalId: 'P', title: `Task ${id}`, description: null, tags: [], assigneeUserIds: [], customValues: [], comments: [], attachments: [], history: [], archived: false, ...extra }) as unknown as MappedTask;
const page = (over: Partial<MappedPage>): MappedPage => ({ ...emptyPage(), ...over });
const OPTS = { name: 'T', sourceId: 'job1' };

describe('buildRawFromImport (step 4.9)', () => {
  it('a single project is a PROJECT template, several are a WORKSPACE template; the source is the job, nothing real', () => {
    expect(buildRawFromImport([page({ projects: [project('P')] as never })], OPTS).raw.meta.kind).toBe('PROJECT');
    const two = buildRawFromImport([page({ projects: [project('P'), project('Q')] as never })], OPTS).raw;
    expect(two.meta.kind).toBe('WORKSPACE');
    expect(two.source).toEqual({ workspaceId: 'import:job1' });
  });

  it('nothing to export is a clear error', () => {
    expect(() => buildRawFromImport([emptyPage()], OPTS)).toThrow(ImportTemplateError);
    expect(() => buildRawFromImport([emptyPage()], OPTS)).toThrow(/no projects/);
  });

  it('workflow: statuses keep category and default; folded source statuses all resolve to the one key; tasks get their status key', () => {
    const { raw } = buildRawFromImport([page({ projects: [project('P')] as never, tasks: [task('1', { workflowStatusExternalId: 'P:closed' } as never)] as never })], OPTS);
    const wf = raw.projects[0].workflow!;
    expect(wf.statuses.map((s) => [s.key, s.category, s.isDefault])).toEqual([['to-do', 'TODO', true], ['done', 'DONE', undefined], ['in-progress', 'IN_PROGRESS', undefined]]); // In Progress added: a rule of the blueprint
    expect(raw.projects[0].tasks[0].status).toBe('done');
  });

  it('a workflow with no In Progress status gets the standard one (a blueprint rule), reported; two statuses of one name become one', () => {
    const p = page({ projects: [{ ...project('P'), statuses: [{ externalId: 'a', sourceExternalIds: ['a'], name: 'Open', category: 'TODO' }, { externalId: 'b', sourceExternalIds: ['b'], name: 'open', category: 'TODO' }, { externalId: 'c', sourceExternalIds: ['c'], name: 'Done', category: 'DONE', excludeFromProgress: true }] }] as never, tasks: [task('1', { workflowStatusExternalId: 'b' } as never)] as never });
    const r = buildRawFromImport([p], OPTS);
    const wf = r.raw.projects[0].workflow!;
    expect(wf.statuses.map((x) => [x.name, x.category])).toEqual([['Open', 'TODO'], ['Done', 'DONE'], ['In Progress', 'IN_PROGRESS']]);
    expect(r.raw.projects[0].tasks[0].status).toBe(wf.statuses[0].key); // 'b' folded into 'a'
    expect(r.report.workflowCompleted).toEqual(['P: In Progress']);
    const s = sanitize(r.raw, {});
    expect(s.ok).toBe(true);
  });

  it('a project with no statuses keeps the workspace default workflow (nothing is invented)', () => {
    const r = buildRawFromImport([page({ projects: [{ ...project('P'), statuses: [] }] as never, tasks: [task('1')] as never })], OPTS);
    expect(r.raw.projects[0].workflow).toBeUndefined();
  });

  it('parents inside the project become the tree (in a deterministic order); a missing parent makes a root, and is reported', () => {
    const r = buildRawFromImport([page({ projects: [project('P')] as never, tasks: [task('3', { parentExternalId: '1' }), task('1'), task('2', { parentExternalId: 'gone' })] as never })], OPTS);
    expect(r.raw.projects[0].tasks.map((t) => [t.title, t.children.map((c) => c.title)])).toEqual([['Task 1', ['Task 3']], ['Task 2', []]]);
    expect(r.report.tasks).toMatchObject({ included: 3, orphanedParent: 1 });
  });

  it('a parent loop is broken (and reported), a self-parent too: nothing loops forever, nothing is lost', () => {
    const r = buildRawFromImport([page({ projects: [project('P')] as never, tasks: [task('a', { parentExternalId: 'b' }), task('b', { parentExternalId: 'a' }), task('c', { parentExternalId: 'c' })] as never })], OPTS);
    const count = (ts: Array<{ children: unknown[] }>): number => ts.reduce((n, t) => n + 1 + count(t.children as never), 0);
    expect(count(r.raw.projects[0].tasks)).toBe(3);
    expect(r.report.tasks.parentCycle).toBe(1);
    expect(r.report.tasks.orphanedParent).toBe(1); // the self-parent has no real parent: a root, counted as an orphan
  });

  it('a chain deeper than the template allows is flattened to the last allowed level', () => {
    const n = BLUEPRINT_LIMITS.maxTaskLevels + 3;
    const tasks = Array.from({ length: n }, (_, i) => task(String(i).padStart(3, '0'), i === 0 ? {} : { parentExternalId: String(i - 1).padStart(3, '0') }));
    const r = buildRawFromImport([page({ projects: [project('P')] as never, tasks: tasks as never })], OPTS);
    const depth = (ts: Array<{ children: unknown[] }>): number => (ts.length ? 1 + Math.max(...ts.map((t) => depth(t.children as never))) : 0);
    expect(depth(r.raw.projects[0].tasks)).toBeLessThanOrEqual(BLUEPRINT_LIMITS.maxTaskLevels);
    expect(r.report.tasks.flattenedTooDeep).toBeGreaterThan(0);
    expect(r.report.tasks.included).toBe(n);
  });

  it('archived tasks and tasks of no project are left out (counted); the rest keep dates as day strings, estimate, priority, tags, issue type, iteration', () => {
    const p = page({
      projects: [project('P')] as never,
      issueTypes: [{ externalId: 'it1', name: 'Bug', level: IssueTypeLevel.STANDARD, color: null }] as never,
      iterations: [{ externalId: 'i1', kind: IterationKind.SPRINT, name: 'Sprint 1', goal: 'g', startDate: '2026-01-05T09:00:00.000Z', endDate: '2026-01-19T09:00:00.000Z', projectExternalId: 'P' }] as never,
      tasks: [
        task('1', { archived: true }),
        task('2', { projectExternalId: null as never }),
        task('3', { issueType: { externalId: 'it1' } as never, iterationExternalId: 'i1', priority: 'HIGH' as never, estimate: 3, tags: ['a', 'a', 'b'], startDate: '2026-01-06T10:00:00.000Z', dueDate: '2026-01-10T00:00:00.000Z' }),
      ] as never,
    });
    const r = buildRawFromImport([p], OPTS);
    expect(r.report.tasks).toMatchObject({ included: 1, archivedSkipped: 1 });
    expect(r.raw.projects[0].tasks[0]).toMatchObject({ issueType: 'Bug', priority: 'HIGH', estimate: 3, tags: ['a', 'b'], startDate: '2026-01-06', dueDate: '2026-01-10', iteration: r.raw.workspace.iterations[0].nodeKey });
    expect(r.raw.workspace.iterations[0]).toMatchObject({ startDate: '2026-01-05', endDate: '2026-01-19', project: r.raw.projects[0].nodeKey });
    expect(r.raw.workspace.tags.map((t) => t.name).sort()).toEqual(['a', 'b']);
  });

  it('custom fields get unique keys; values go by key; select options travel; a key that had to change is reported', () => {
    const p = page({
      projects: [project('P')] as never,
      customFields: [{ externalId: 'f1', name: 'Customer', dataType: FieldType.TEXT }, { externalId: 'f2', name: 'Customer', dataType: FieldType.SELECT, options: ['a', 'b'] }, { externalId: 'f3', name: 'Story points!', dataType: FieldType.NUMBER }] as never,
      tasks: [task('1', { customValues: [{ fieldExternalId: 'f1', value: 'Acme' }, { fieldExternalId: 'f3', value: 5 }, { fieldExternalId: 'nope', value: 1 }, { fieldExternalId: 'f2', value: null }] as never })] as never,
    });
    const r = buildRawFromImport([p], OPTS);
    const keys = r.raw.workspace.customFields.map((f) => f.key);
    expect(new Set(keys).size).toBe(3);
    expect(r.raw.workspace.customFields.find((f) => f.dataType === FieldType.SELECT)!.options).toEqual(['a', 'b']);
    expect(Object.values(r.raw.projects[0].tasks[0].customValues).sort()).toEqual(['Acme', 5].sort());
    expect(r.report.customFieldKeyChanges.length).toBeGreaterThan(0);
  });

  it('dependencies stay when both ends are in the project; across projects / unknown ends they are dropped and counted', () => {
    const p = page({
      projects: [project('P'), project('Q')] as never,
      tasks: [task('1'), task('2'), task('3', { projectExternalId: 'Q' })] as never,
      dependencies: [{ externalId: 'd1', fromExternalId: '1', toExternalId: '2', type: DependencyType.BLOCKS }, { externalId: 'd1b', fromExternalId: '1', toExternalId: '2', type: DependencyType.BLOCKS }, { externalId: 'd2', fromExternalId: '1', toExternalId: '3', type: DependencyType.BLOCKS }, { externalId: 'd3', fromExternalId: '1', toExternalId: 'ghost', type: DependencyType.RELATES_TO }] as never,
    });
    const r = buildRawFromImport([p], OPTS);
    expect(r.raw.projects[0].dependencies).toHaveLength(1);
    expect(r.report.dependencies).toEqual({ included: 1, droppedOutsideProject: 1, droppedMissingEnd: 1 });
  });

  it('comments only when asked; replies are flattened; strangers are anonymous; files and history are counted and dropped', () => {
    const c = (id: string, extra = {}) => ({ externalId: id, body: `b${id}`, author: { kind: 'importer', label: 'x' }, createdAt: '2026-01-01T00:00:00.000Z', parentExternalId: null, ...extra });
    const p = page({ projects: [project('P')] as never, tasks: [task('1', { comments: [c('1'), c('2', { parentExternalId: '1', author: { kind: 'user', userId: 'src:ana' } })] as never, attachments: [{}, {}] as never, history: [{}] as never })] as never });
    const off = buildRawFromImport([p], OPTS);
    expect(off.raw.projects[0].tasks[0].comments).toEqual([]);
    const on = buildRawFromImport([p], { ...OPTS, includeComments: true });
    expect(on.raw.projects[0].tasks[0].comments.map((x) => x.authorUserId)).toEqual([ANONYMOUS_USER, 'src:ana']);
    expect(on.report).toMatchObject({ attachmentsDropped: 2, historyDropped: 1, comments: { included: 2, repliesFlattened: 1 } });
    expect(on.raw.projects[0].tasks[0].attachments).toEqual([]);
  });

  it('more items than a template holds is refused with the number and the limit', () => {
    const tasks = Array.from({ length: BLUEPRINT_LIMITS.maxNodes + 1 }, (_, i) => task(String(i)));
    expect(() => buildRawFromImport([page({ projects: [project('P')] as never, tasks: tasks as never })], OPTS)).toThrow(/at most .* items/);
  });

  it('pages are a transport: the same entity on two pages counts once, and the same input builds the same document', () => {
    const a = page({ projects: [project('P')] as never, tasks: [task('2'), task('1')] as never });
    const b = page({ projects: [project('P')] as never, tasks: [task('1'), task('3')] as never });
    const one = buildRawFromImport([a, b], OPTS);
    expect(one.report.tasks.included).toBe(3);
    expect(JSON.stringify(buildRawFromImport([a, b], OPTS).raw)).toBe(JSON.stringify(one.raw));
  });

  it('what it builds passes the ONE sanitizer and the ONE validator (people become roles, dates become offsets, nothing real stays)', () => {
    const p = page({
      projects: [project('P')] as never,
      tasks: [task('1', { assigneeUserIds: ['src:ana'], dueDate: '2026-02-01T00:00:00.000Z', description: 'Mail ana@example.com about it' }), task('2', { assigneeUserIds: ['src:ben', 'src:ana'], startDate: '2026-01-05T00:00:00.000Z' })] as never,
    });
    const { raw } = buildRawFromImport([p], OPTS);
    const s = sanitize(raw, {});
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    expect(s.report.roles.created).toBe(2);
    expect(JSON.stringify(s.blueprint)).not.toContain('ana@example.com');
    expect(JSON.stringify(s.blueprint)).not.toContain('src:');
    expect(JSON.stringify(s.blueprint)).not.toContain('2026-02-01');
    expect(validateBlueprint(s.blueprint).ok).toBe(true);
  });
});
