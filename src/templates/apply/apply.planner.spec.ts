import { fixtureJson } from '../blueprint/blueprint.fixtures';
import { resolveBlueprint, ResolvedBlueprint } from '../resolve';
import { buildApplyPlan, uniqueProjectName } from './apply.planner';
import { LimitState, WorkspaceState } from './apply.types';

const empty = (): WorkspaceState => ({
  tags: [],
  customFields: [],
  issueTypes: [],
  projectNames: [],
  projectCount: 0,
  iterationCount: 0,
  taskCount: 0,
});
const unlimited: LimitState = {
  projectsRemaining: null,
  tasksPerProject: null,
};

function resolve(
  name: 'student-workspace' | 'sprint-board' | 'content-calendar',
  input: { variables?: any; modules?: any } = {},
): ResolvedBlueprint {
  const defaults: any = {
    'student-workspace': { semesterStart: '2026-09-01' },
    'content-calendar': { launchDate: '2026-10-09' },
    'sprint-board': {},
  };
  const r = resolveBlueprint(fixtureJson(name), {
    today: '2026-10-09',
    variables: { ...defaults[name], ...input.variables },
    modules: input.modules,
  });
  if (r.ok === false) throw new Error(JSON.stringify(r.issues));
  return r.resolved;
}
const plan = (
  r: ResolvedBlueprint,
  state = empty(),
  limits = unlimited,
  mode: 'MERGE' | 'NEW_WORKSPACE' = 'MERGE',
) => buildApplyPlan(r, { mode, kind: r.meta.kind }, state, limits);

describe('buildApplyPlan: merge rules', () => {
  it('into an empty workspace everything is created, nothing blocks', () => {
    const p = plan(resolve('student-workspace'));
    expect(p.blockers).toEqual([]);
    expect(p.counts).toMatchObject({
      tags: { create: 4, reuse: 0 },
      customFields: { create: 2, reuse: 0, skip: 0 },
      issueTypes: { create: 3, reuse: 0 },
      tasks: 9,
      droppedCustomValues: 0,
    });
    expect(p.projects.map((x) => [x.name, x.tasks])).toEqual([
      ['Introduction to Biology: coursework', 9],
    ]);
    expect(p.warnings.map((w) => w.code)).toEqual(['WORKSPACE_IDENTITY_KEPT']);
    expect(p.counts.assets.copies).toBeGreaterThan(0); // the fixture carries a reference file: it is COPIED now, no warning
  });

  it('tags are reused by name, ignoring case and spacing', () => {
    const p = plan(resolve('student-workspace'), {
      ...empty(),
      tags: [
        { id: 't1', name: 'EXAM' },
        { id: 't2', name: ' reading ' },
      ],
    });
    expect(p.tags.map((t) => [t.name, t.action, t.existingId])).toEqual([
      ['exam', 'REUSE', 't1'],
      ['reading', 'REUSE', 't2'],
      ['assignment', 'CREATE', undefined],
      ['lab', 'CREATE', undefined],
    ]);
    expect(p.counts.tags).toEqual({ create: 2, reuse: 2 });
  });

  it('custom fields: reused by key when the type matches, skipped with a warning when it does not', () => {
    const p = plan(resolve('student-workspace'), {
      ...empty(),
      customFields: [
        {
          id: 'f1',
          key: 'Prof-Review',
          dataType: 'SELECT',
          options: ['pending', 'approved', 'changes requested'],
        },
        { id: 'f2', key: 'exam-weight', dataType: 'TEXT', options: null },
      ],
    });
    expect(p.customFields.map((f) => [f.key, f.action, f.existingId])).toEqual([
      ['prof-review', 'REUSE', 'f1'],
      ['exam-weight', 'SKIP', 'f2'],
    ]);
    expect(p.warnings.map((w) => w.code)).toContain('FIELD_TYPE_CONFLICT');
    // the two tasks with an exam-weight value lose it
    expect(p.counts.droppedCustomValues).toBe(2);
    expect(p.warnings.map((w) => w.code)).toContain('VALUES_DROPPED');
  });

  it('a reused SELECT field with other options drops the values that no longer fit', () => {
    const p = plan(resolve('student-workspace'), {
      ...empty(),
      customFields: [
        {
          id: 'f1',
          key: 'prof-review',
          dataType: 'SELECT',
          options: ['yes', 'no'],
        },
      ],
    });
    expect(p.warnings.map((w) => w.code)).toEqual(
      expect.arrayContaining(['FIELD_OPTIONS_DIFFER', 'VALUES_DROPPED']),
    );
    expect(p.counts.droppedCustomValues).toBe(2); // 'pending' on the essay and the midterm
  });

  it('issue types are reused by name', () => {
    const p = plan(resolve('student-workspace'), {
      ...empty(),
      issueTypes: [{ id: 'i1', name: 'exam' }],
    });
    expect(p.issueTypes.map((t) => [t.name, t.action])).toEqual([
      ['Assignment', 'CREATE'],
      ['Exam', 'REUSE'],
      ['Reading', 'CREATE'],
    ]);
  });

  it('projects are always new; a name clash becomes "Name (2)", then "(3)"', () => {
    const r = resolve('student-workspace', { modules: { labs: true } });
    const p = plan(r, {
      ...empty(),
      projectNames: [
        'introduction to biology: coursework',
        'Introduction to Biology: coursework (2)',
      ],
    });
    expect(p.projects.map((x) => x.name)).toEqual([
      'Introduction to Biology: coursework (3)',
      'Introduction to Biology: labs',
    ]);
    expect(p.projects[0].renamedFrom).toBe(
      'Introduction to Biology: coursework',
    );
    expect(p.warnings.map((w) => w.code)).toContain('PROJECT_RENAMED');
  });

  it('two projects of the template that would collide are renamed apart too', () => {
    const r = resolve('student-workspace', { modules: { labs: true } });
    r.projects[1].name = r.projects[0].name;
    expect(plan(r).projects.map((x) => x.name)).toEqual([
      r.projects[0].name,
      `${r.projects[0].name} (2)`,
    ]);
  });

  it('uniqueProjectName never exceeds 120 characters', () => {
    const long = 'x'.repeat(120);
    const out = uniqueProjectName(long, new Set([long]));
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out.endsWith(' (2)')).toBe(true);
  });

  it("never claims to change the workspace: identity is kept, and the template's own is reported as ignored", () => {
    const p = plan(resolve('student-workspace'));
    expect(JSON.stringify(p)).not.toContain('"workspace"');
    expect(p.warnings[0].code).toBe('WORKSPACE_IDENTITY_KEPT');
  });
});

describe('buildApplyPlan: modes, limits and blockers', () => {
  it('a PROJECT template cannot NEW_WORKSPACE; NEW_WORKSPACE needs an empty workspace', () => {
    expect(
      plan(
        resolve('sprint-board'),
        empty(),
        unlimited,
        'NEW_WORKSPACE',
      ).blockers.map((b) => b.code),
    ).toContain('KIND_MODE_MISMATCH');
    const busy = { ...empty(), projectCount: 1, projectNames: ['x'] };
    expect(
      plan(
        resolve('student-workspace'),
        busy,
        unlimited,
        'NEW_WORKSPACE',
      ).blockers.map((b) => b.code),
    ).toEqual(['WORKSPACE_NOT_EMPTY']);
    expect(plan(resolve('student-workspace'), busy).blockers).toEqual([]); // the same state is fine for MERGE
  });

  it('project limit: blocks with suggestions when the plan has no room', () => {
    const r = resolve('student-workspace', { modules: { labs: true } });
    const p = plan(r, empty(), { projectsRemaining: 1, tasksPerProject: null });
    expect(p.blockers).toEqual([
      expect.objectContaining({
        code: 'PROJECT_LIMIT',
        suggestions: expect.arrayContaining([
          expect.stringContaining('modules'),
        ]),
      }),
    ]);
    expect(
      plan(r, empty(), { projectsRemaining: 2, tasksPerProject: null })
        .blockers,
    ).toEqual([]);
  });

  it('turning a module off can make a blocked apply fit', () => {
    const limits = { projectsRemaining: 1, tasksPerProject: null };
    expect(
      plan(
        resolve('student-workspace', { modules: { labs: true } }),
        empty(),
        limits,
      ).blockers,
    ).toHaveLength(1);
    expect(
      plan(
        resolve('student-workspace', { modules: { labs: false } }),
        empty(),
        limits,
      ).blockers,
    ).toEqual([]);
  });

  it('per-project task cap (personal plans)', () => {
    const p = plan(resolve('student-workspace'), empty(), {
      projectsRemaining: null,
      tasksPerProject: 5,
    });
    expect(p.blockers.map((b) => b.code)).toEqual(['TASK_LIMIT']);
    expect(
      plan(resolve('student-workspace'), empty(), {
        projectsRemaining: null,
        tasksPerProject: 9,
      }).blockers,
    ).toEqual([]);
  });

  it('issue type and iteration caps count what is already there', () => {
    const many = Array.from({ length: 49 }, (_, i) => ({
      id: `i${i}`,
      name: `T${i}`,
    }));
    expect(
      plan(resolve('student-workspace'), {
        ...empty(),
        issueTypes: many,
      }).blockers.map((b) => b.code),
    ).toEqual(['ISSUE_TYPE_LIMIT']);
    expect(
      plan(resolve('student-workspace'), {
        ...empty(),
        iterationCount: 999,
      }).blockers.map((b) => b.code),
    ).toEqual(['ITERATION_LIMIT']);
  });

  it('warns about what an apply does not do yet: invites, automations', () => {
    const r = resolve('sprint-board');
    expect(plan(r).warnings.map((w) => w.code)).toContain(
      'AUTOMATIONS_CREATED_OFF',
    );
    const withInvite = resolveBlueprint(fixtureJson('sprint-board'), {
      today: '2026-10-09',
      roles: { developer: { type: 'INVITE', email: 'a@b.co' } },
    });
    if (withInvite.ok === false) throw new Error('x');
    expect(plan(withInvite.resolved).warnings.map((w) => w.code)).toContain(
      'INVITES_NOT_SENT',
    );
  });

  it('is pure: the same inputs give the same plan, and inputs are not modified', () => {
    const r = resolve('student-workspace');
    const s = { ...empty(), tags: [{ id: 't', name: 'exam' }] };
    const before = JSON.stringify([r, s]);
    expect(JSON.stringify(plan(r, s))).toBe(JSON.stringify(plan(r, s)));
    expect(JSON.stringify([r, s])).toBe(before);
  });
});

describe('buildApplyPlan: reference files (step 3.7)', () => {
  const r = () => resolve('student-workspace', { variables: {} });
  const copies = (x: ResolvedBlueprint) => {
    const keys = new Map(x.assets.map((a) => [a.key, a.sizeBytes]));
    let n = 0;
    let bytes = 0;
    const walk = (ts: any[]) =>
      ts.forEach((t) => {
        t.attachments.forEach((k: string) => {
          n += 1;
          bytes += keys.get(k)!;
        });
        walk(t.children);
      });
    x.projects.forEach((p) => walk(p.tasks));
    return { copies: n, bytes };
  };

  it('counts one copy per task attachment (the same file on two tasks is two copies, two lots of quota)', () => {
    const x = r();
    const c = copies(x);
    expect(c.copies).toBeGreaterThan(0);
    expect(
      buildApplyPlan(
        x,
        { mode: 'MERGE', kind: x.meta.kind },
        empty(),
        unlimited,
      ).counts.assets,
    ).toEqual(c);
    // attach the first asset to one more task: one more copy
    const task = x.projects[0].tasks.find((t) => t.attachments.length === 0)!;
    task.attachments = [x.assets[0].key];
    expect(
      buildApplyPlan(
        x,
        { mode: 'MERGE', kind: x.meta.kind },
        empty(),
        unlimited,
      ).counts.assets,
    ).toEqual({ copies: c.copies + 1, bytes: c.bytes + x.assets[0].sizeBytes });
  });

  it('blocks with STORAGE_LIMIT only when the bytes do not fit (exactly equal fits)', () => {
    const x = r();
    const { bytes } = copies(x);
    const at = (storageRemainingBytes: number | null) =>
      buildApplyPlan(x, { mode: 'MERGE', kind: x.meta.kind }, empty(), {
        ...unlimited,
        storageRemainingBytes,
      }).blockers.map((b) => b.code);
    expect(at(bytes)).toEqual([]);
    expect(at(bytes - 1)).toEqual(['STORAGE_LIMIT']);
    expect(at(-5)).toEqual(['STORAGE_LIMIT']); // already over: nothing fits
    expect(at(null)).toEqual([]);
  });

  it('blocks a file over the plan per-file cap, and a file whose bytes are no longer stored', () => {
    const x = r();
    const biggest = Math.max(...x.assets.map((a) => a.sizeBytes));
    const codes = (l: Partial<LimitState>) =>
      buildApplyPlan(x, { mode: 'MERGE', kind: x.meta.kind }, empty(), {
        ...unlimited,
        ...l,
      }).blockers.map((b) => b.code);
    expect(codes({ maxFileBytes: biggest })).toEqual([]);
    expect(codes({ maxFileBytes: biggest - 1 })).toEqual(['FILE_TOO_LARGE']);
    expect(codes({ missingAssetShas: [x.assets[0].sha256] })).toEqual([
      'ASSET_MISSING',
    ]);
  });
});

describe('buildApplyPlan: automations and saved views (step 5.5)', () => {
  const rule = (name: string, over: Record<string, unknown> = {}) => ({
    kind: 'rule.v1',
    name,
    trigger: { type: 'TASK_CREATED' },
    conditions: { all: [{ field: 'IS_SUBTASK', op: 'IS_FALSE' }] },
    actions: [{ type: 'ADD_TAG', tagId: 'exam' }],
    ...over,
  });
  const view = (name: string, over: Record<string, unknown> = {}) => ({
    kind: 'view.v1',
    name,
    layout: 'LIST',
    config: {},
    ...over,
  });
  const withItems = (
    automations: unknown[],
    views: unknown[],
  ): ResolvedBlueprint => {
    const r = resolve('student-workspace');
    r.projects[0].automations = automations as any;
    r.projects[0].views = views as any;
    return r;
  };
  const stateOf = (
    over: Partial<NonNullable<WorkspaceState['savedViews']>> = {},
    nameKeys: string[] = [],
    count = nameKeys.length,
  ): WorkspaceState => ({
    ...empty(),
    automations: { count, nameKeys },
    savedViews: { personalOfUser: 0, shared: 0, canShare: true, ...over },
  });

  it('a template with none has no new warnings, counts or blockers', () => {
    const p = plan(resolve('student-workspace'), stateOf());
    expect(p.automations).toEqual([]);
    expect(p.views).toEqual([]);
    expect(p.counts.automations).toEqual({ create: 0, raw: 0, skip: 0 });
    expect(p.warnings.map((w) => w.code)).toEqual(['WORKSPACE_IDENTITY_KEPT']);
  });

  it('portable rules are created, raw items kept inert, and the plan says they all start OFF', () => {
    const p = plan(
      withItems(
        [rule('Tag it'), { name: 'Legacy', when: 'x' }, { when: 'no name' }],
        [],
      ),
      stateOf(),
    );
    expect(p.automations.map((a) => [a.finalName, a.action])).toEqual([
      ['Tag it', 'CREATE'],
      ['Legacy', 'RAW'],
      ['Imported automation 1', 'RAW'],
    ]);
    expect(p.counts.automations).toEqual({ create: 1, raw: 2, skip: 0 });
    expect(p.warnings.map((w) => w.code)).toContain('AUTOMATIONS_CREATED_OFF');
    expect(
      p.warnings.find((w) => w.code === 'AUTOMATIONS_CREATED_OFF')!.message,
    ).toMatch(/^3 automation/);
  });

  it('an item that cannot bind here is skipped with the first reason; a skipped field means a skipped rule', () => {
    const p = plan(
      withItems(
        [
          rule('Bad', { actions: [{ type: 'ADD_TAG', tagId: 'ghost' }] }),
          rule('Fine'),
        ],
        [],
      ),
      stateOf(),
    );
    expect(p.automations.map((a) => [a.name, a.action])).toEqual([
      ['Bad', 'SKIP'],
      ['Fine', 'CREATE'],
    ]);
    expect(p.automations[0].reason).toMatch(
      /^UNKNOWN_REF at \/actions\/0\/tagId$/,
    );
    const clash: WorkspaceState = {
      ...stateOf(),
      customFields: [
        {
          id: 'f1',
          key: 'prof-review',
          dataType: 'TEXT',
          options: null,
        } as any,
      ],
    };
    const r = withItems(
      [
        rule('Uses the field', {
          actions: [
            {
              type: 'SET_CUSTOM_FIELD',
              customFieldId: 'prof-review',
              value: 'pending',
            },
          ],
        }),
      ],
      [],
    );
    expect(plan(r, clash).automations[0]).toMatchObject({ action: 'SKIP' });
  });

  it('names are made unique against the workspace and against each other, compared like automation names', () => {
    const p = plan(
      withItems([rule('Tag it'), rule('Other')], []),
      stateOf({}, ['tag it']),
    );
    expect(p.automations.map((a) => a.finalName)).toEqual([
      'Tag it (2)',
      'Other',
    ]);
    expect(
      p.warnings.filter((w) => w.code === 'AUTOMATION_RENAMED'),
    ).toHaveLength(1);
    const q = plan(withItems([rule('A'), rule('A')], []), stateOf());
    expect(q.automations.map((a) => a.finalName)).toEqual(['A', 'A (2)']); // even if a template slipped two through
  });

  it('a view is shared only when the template asks AND the person may share', () => {
    const items = [view('Team', { shared: true }), view('Mine')];
    expect(
      plan(withItems([], items), stateOf({ canShare: true })).counts.savedViews,
    ).toEqual({ personal: 1, shared: 1, skip: 0 });
    const noShare = plan(withItems([], items), stateOf({ canShare: false }));
    expect(noShare.counts.savedViews).toEqual({
      personal: 2,
      shared: 0,
      skip: 0,
    });
    expect(noShare.warnings.map((w) => w.code)).toContain('VIEW_NOT_SHARED');
    expect(
      plan(
        withItems([], [view('Mine')]),
        stateOf({ canShare: false }),
      ).warnings.map((w) => w.code),
    ).not.toContain('VIEW_NOT_SHARED');
  });

  it('unreadable or invalid views are skipped and named', () => {
    const p = plan(
      withItems(
        [],
        [
          view('Ok'),
          { name: 'Old', filter: {} },
          view('Broken', { layout: 'CALENDAR' }),
        ],
      ),
      stateOf(),
    );
    expect(p.views.map((v) => [v.name, v.action])).toEqual([
      ['Ok', 'CREATE'],
      ['Old', 'SKIP'],
      ['Broken', 'SKIP'],
    ]);
    expect(p.views[1].reason).toBe('not a recognised saved view');
    expect(p.warnings.filter((w) => w.code === 'VIEW_SKIPPED')).toHaveLength(2);
  });

  it('limits block: automations per workspace, personal views per person, shared views per workspace', () => {
    const rules = Array.from({ length: 3 }, (_, i) => rule(`R${i}`));
    expect(
      plan(withItems(rules, []), stateOf({}, [], 98)).blockers.map(
        (b) => b.code,
      ),
    ).toEqual(['AUTOMATION_LIMIT']);
    expect(plan(withItems(rules, []), stateOf({}, [], 97)).blockers).toEqual(
      [],
    );
    const mine = [view('A'), view('B')];
    expect(
      plan(withItems([], mine), stateOf({ personalOfUser: 99 })).blockers.map(
        (b) => b.code,
      ),
    ).toEqual(['VIEW_LIMIT']);
    expect(
      plan(withItems([], mine), stateOf({ personalOfUser: 98 })).blockers,
    ).toEqual([]);
    const team = [view('A', { shared: true }), view('B', { shared: true })];
    expect(
      plan(withItems([], team), stateOf({ shared: 49 })).blockers.map(
        (b) => b.code,
      ),
    ).toEqual(['VIEW_LIMIT']);
  });

  it("the plan carries names, counts and reasons only: never a rule's text", () => {
    const p = plan(
      withItems(
        [
          rule('Secret sauce', {
            actions: [
              {
                type: 'COMMENT',
                body: 'internal: {{task.title}} confidential',
              },
            ],
          }),
        ],
        [
          view('V', {
            config: {
              filters: {
                all: [
                  { field: 'TITLE', op: 'CONTAINS', value: 'confidential' },
                ],
              },
            },
          }),
        ],
      ),
      stateOf(),
    );
    expect(JSON.stringify(p)).not.toContain('confidential');
  });
});
