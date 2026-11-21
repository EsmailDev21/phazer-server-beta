import { BlueprintV1, validateBlueprint } from '../blueprint';
import { buildRawBlueprint } from './extract.builder';
import { fieldKey, slug, statusKey, uniqueKey } from './extract.keys';
import { snapshotFixture } from './extract.fixtures';
import {
  ExtractError,
  RawBlueprint,
  RawTask,
  WorkspaceSnapshot,
} from './extract.types';

const snapshot = snapshotFixture;
const flat = (tasks: RawTask[]): RawTask[] =>
  tasks.flatMap((t) => [t, ...flat(t.children)]);
const shuffle = <T>(arr: T[], seed: number): T[] => {
  const a = [...arr];
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

describe('buildRawBlueprint: workspace', () => {
  const { raw, report } = buildRawBlueprint(snapshot(), {
    includeComments: true,
    includeAttachments: true,
  });

  it('keeps the workspace, definitions and every project, in a stable order', () => {
    expect(raw.meta).toEqual({
      name: 'Biology 101',
      description: 'Semester',
      kind: 'WORKSPACE',
    });
    expect(raw.workspace).toMatchObject({
      name: 'Biology 101',
      key: 'BIO',
      icon: 'leaf',
      description: 'Semester',
    });
    expect(raw.workspace.tags.map((t) => t.name)).toEqual([
      'exam',
      'Reading',
      'unused',
    ]);
    expect(raw.workspace.customFields.map((f) => [f.key, f.order])).toEqual([
      ['weight', 1],
      ['prof-review', 2],
      ['reviewer', 3],
    ]);
    expect(raw.projects.map((p) => p.nodeKey)).toEqual([
      'p-coursework',
      'p-labs',
    ]);
    expect(raw.source).toEqual({ workspaceId: 'ws1' });
  });

  it('nodeKeys: tasks are t<number>, projects and iterations are slugs', () => {
    expect(flat(raw.projects[0].tasks).map((t) => t.nodeKey)).toEqual([
      't1',
      't2',
      't3',
      't4',
    ]);
    // same start date, so the name breaks the tie
    expect(raw.workspace.iterations.map((i) => i.nodeKey)).toEqual([
      'i-lab-sprint',
      'i-midterm',
    ]);
  });

  it('builds the task tree with refs by name / key, and absolute dates', () => {
    const [read, mid] = raw.projects[0].tasks;
    expect(read).toMatchObject({
      title: 'Read ch 1',
      issueType: 'Reading',
      status: 'to-do',
      priority: 'MEDIUM',
      estimate: 2,
      startDate: '2026-09-01',
      dueDate: '2026-09-07',
      iteration: 'i-midterm',
      tags: ['Reading'],
    });
    expect(read.assigneeUserIds).toEqual(['u1', 'u2']); // sorted
    expect(mid.children[0].children[0].title).toBe('Past paper');
    expect(mid.customValues).toEqual({
      weight: 30,
      'prof-review': 'pending',
      reviewer: 'u9',
    });
  });

  it('workflow: keys, defaults, excludeFromProgress, transitions sorted, enforce flag', () => {
    const wf = raw.projects[0].workflow!;
    expect(wf.statuses.map((s) => s.key)).toEqual([
      'to-do',
      'in-progress',
      'done',
      'dropped',
    ]);
    expect(wf.statuses[3]).toMatchObject({ excludeFromProgress: true });
    expect(wf.statuses[0]).toMatchObject({ isDefault: true });
    expect(wf.transitions).toEqual([
      { from: 'in-progress', to: 'done' },
      { from: 'to-do', to: 'in-progress' },
    ]);
    expect(wf.enforceTransitions).toBe(true);
    expect(raw.projects[1].workflow!.enforceTransitions).toBeUndefined();
  });

  it('statuses follow their position, not their id', () => {
    const s = snapshot();
    s.statuses.find((x) => x.id === 's1')!.position = 10; // "To do" moved to the end
    const wf = buildRawBlueprint(s).raw.projects[0].workflow!;
    expect(wf.statuses.map((x) => x.key)).toEqual([
      'in-progress',
      'done',
      'dropped',
      'to-do',
    ]);
  });

  it('project-scoped iterations point at their project', () => {
    expect(
      raw.workspace.iterations.find((i) => i.nodeKey === 'i-lab-sprint'),
    ).toMatchObject({ project: 'p-labs', startDate: '2026-09-01' });
  });

  it('comments (flattened, ordered), attachments (confirmed only) and their assets', () => {
    const mid = raw.projects[0].tasks[1];
    expect(mid.comments.map((c) => [c.body, c.authorUserId])).toEqual([
      ['Covers chapter 7 too', 'u1'],
      ['Noted', 'u2'],
    ]);
    expect(mid.attachments).toEqual(['a1']);
    expect(raw.assets).toEqual([
      {
        key: 'a1',
        fileName: 'syllabus.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1000,
        sourceAttachmentId: 'a1',
      },
    ]);
    expect(report.comments).toEqual({ included: 2, repliesFlattened: 1 });
    expect(report.attachments).toEqual({ included: 1, unconfirmedSkipped: 1 });
  });

  it('dependencies stay inside a project and between kept tasks; the rest is reported', () => {
    expect(raw.projects[0].dependencies).toEqual([
      { from: 't1', to: 't2', type: 'BLOCKS' },
    ]);
    expect(report.dependencies).toEqual({
      included: 1,
      droppedOutsideProject: 1,
      droppedMissingEnd: 1,
    });
  });

  it('skips archived, inbox and orphaned tasks and says so', () => {
    expect(flat(raw.projects[0].tasks).map((t) => t.title)).not.toContain(
      'Old idea',
    );
    expect(flat(raw.projects[0].tasks).map((t) => t.title)).not.toContain(
      'Child of archived',
    );
    expect(report.tasks).toEqual({
      included: 5,
      archivedSkipped: 1,
      inboxSkipped: 1,
      orphanedSkipped: 1,
      tooDeepSkipped: 0,
    });
    expect(report.customFieldKeyChanges).toEqual([
      { from: 'prof review', to: 'prof-review' },
    ]);
    expect(report.exceedsNodeLimit).toBe(false);
  });

  it('comments and attachments are opt-in', () => {
    const plain = buildRawBlueprint(snapshot()).raw;
    expect(plain.assets).toEqual([]);
    expect(
      flat(plain.projects[0].tasks).every(
        (t) => t.comments.length === 0 && t.attachments.length === 0,
      ),
    ).toBe(true);
  });

  it('includeArchived brings archived tasks (and their live children) back', () => {
    const r = buildRawBlueprint(snapshot(), { includeArchived: true }).raw;
    const titles = flat(r.projects[0].tasks).map((t) => t.title);
    expect(titles).toContain('Old idea');
    expect(titles).toContain('Child of archived');
  });
});

describe('buildRawBlueprint: one project', () => {
  const { raw } = buildRawBlueprint(snapshot(), { projectId: 'p1' });

  it('is a PROJECT template with no workspace identity', () => {
    expect(raw.meta).toMatchObject({
      name: 'Coursework',
      description: 'Main',
      kind: 'PROJECT',
    });
    expect(raw.workspace.name).toBeUndefined();
    expect(raw.workspace.key).toBeUndefined();
    expect(raw.source).toEqual({ workspaceId: 'ws1', projectId: 'p1' });
    expect(raw.projects.map((p) => p.nodeKey)).toEqual(['p-coursework']);
  });

  it('carries only the definitions the project uses', () => {
    expect(raw.workspace.tags.map((t) => t.name)).toEqual(['exam', 'Reading']);
    expect(raw.workspace.customFields.map((f) => f.key)).toEqual([
      'weight',
      'prof-review',
      'reviewer',
    ]);
    expect(raw.workspace.issueTypes.map((t) => t.name)).toEqual([
      'Exam',
      'Reading',
    ]);
    // the workspace-wide iteration its tasks use stays; the other project's sprint goes
    expect(raw.workspace.iterations.map((i) => i.nodeKey)).toEqual([
      'i-midterm',
    ]);
  });

  it("does not count another project's inbox as skipped", () => {
    expect(
      buildRawBlueprint(snapshot(), { projectId: 'p1' }).report.tasks
        .inboxSkipped,
    ).toBe(0);
  });

  it('an unknown project is an error', () => {
    expect(() => buildRawBlueprint(snapshot(), { projectId: 'nope' })).toThrow(
      ExtractError,
    );
  });
});

describe('determinism', () => {
  it('row order does not matter: 25 shuffles give the same document', () => {
    const base = JSON.stringify(
      buildRawBlueprint(snapshot(), {
        includeComments: true,
        includeAttachments: true,
      }),
    );
    for (let seed = 1; seed <= 25; seed++) {
      const s = snapshot();
      const shuffled: WorkspaceSnapshot = {
        ...s,
        tags: shuffle(s.tags, seed),
        customFields: shuffle(s.customFields, seed + 1),
        issueTypes: shuffle(s.issueTypes, seed + 2),
        iterations: shuffle(s.iterations, seed + 3),
        projects: shuffle(s.projects, seed + 4),
        statuses: shuffle(s.statuses, seed + 5),
        transitions: shuffle(s.transitions, seed + 6),
        tasks: shuffle(s.tasks, seed + 7).map((t) => ({
          ...t,
          assigneeIds: shuffle(t.assigneeIds, seed),
          tagIds: shuffle(t.tagIds, seed),
          customValues: shuffle(t.customValues, seed),
        })),
        dependencies: shuffle(s.dependencies, seed + 8),
        comments: shuffle(s.comments!, seed + 9),
        attachments: shuffle(s.attachments!, seed + 10),
      };
      expect(
        JSON.stringify(
          buildRawBlueprint(shuffled, {
            includeComments: true,
            includeAttachments: true,
          }),
        ),
      ).toBe(base);
    }
  });

  it('database ids never appear in a nodeKey, name or key (renaming ids changes nothing)', () => {
    const s = snapshot();
    const renamed = JSON.parse(
      JSON.stringify(s).replace(
        /"(k|p|s|tg|cf|it|in|c|a)(\d+)"/g,
        '"zz-$1-$2-zz"',
      ),
      (_k, v) =>
        typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)
          ? new Date(v)
          : v,
    );
    const a = buildRawBlueprint(s, {
      includeComments: true,
      includeAttachments: true,
    }).raw;
    const b = buildRawBlueprint(renamed, {
      includeComments: true,
      includeAttachments: true,
    }).raw;
    expect(JSON.stringify(a).includes('zz-')).toBe(false);
    expect(JSON.stringify(b).includes('zz-')).toBe(true); // only in source ids, proving the rename happened
    const scrub = (r: RawBlueprint) =>
      JSON.stringify({
        ...r,
        source: null,
        assets: r.assets.map((x) => ({ ...x, sourceAttachmentId: null })),
      });
    expect(scrub(b)).toBe(scrub(a));
  });

  it('a renamed task keeps its key; a moved task keeps its key', () => {
    const s = snapshot();
    s.tasks.find((t) => t.id === 'k2')!.title = 'Midterm (renamed)';
    s.tasks.find((t) => t.id === 'k1')!.projectId = 'p2';
    const r = buildRawBlueprint(s).raw;
    expect(
      flat(r.projects[0].tasks).find((t) => t.title === 'Midterm (renamed)')!
        .nodeKey,
    ).toBe('t2');
    expect(
      flat(r.projects[1].tasks).find((t) => t.title === 'Read ch 1')!.nodeKey,
    ).toBe('t1');
  });
});

describe('key helpers', () => {
  it('slug', () => {
    expect(slug('Intro à la Biologie!', 60)).toBe('intro-a-la-biologie');
    expect(slug('日本語', 60)).toBe('');
    expect(slug('a'.repeat(100), 10)).toBe('a'.repeat(10));
    expect(slug('ab-cd-ef', 5)).toBe('ab-cd');
  });
  it('uniqueKey adds -2, -3 on clashes and falls back for empty slugs', () => {
    const taken = new Set<string>();
    expect([
      uniqueKey('p-', 'Labs', taken),
      uniqueKey('p-', 'labs', taken),
      uniqueKey('p-', 'LABS!', taken),
    ]).toEqual(['p-labs', 'p-labs-2', 'p-labs-3']);
    expect(uniqueKey('p-', '日本', taken)).toBe('p-x');
    expect(
      uniqueKey('i-', 'x'.repeat(200), new Set()).length,
    ).toBeLessThanOrEqual(60);
  });
  it('statusKey fits the 40-char local key format', () => {
    const taken = new Set<string>();
    expect(statusKey('To do', taken)).toBe('to-do');
    expect(statusKey('TO DO', taken)).toBe('to-do-2');
    expect(statusKey('???', taken)).toBe('s');
    expect(statusKey('x'.repeat(100), taken)).toMatch(
      /^[a-z0-9][a-z0-9_-]{0,39}$/,
    );
  });
  it('fieldKey makes odd keys legal and compares ignoring case', () => {
    const taken = new Set<string>();
    expect(fieldKey('prof review', taken)).toBe('prof-review');
    expect(fieldKey('Prof-Review', taken)).toBe('Prof-Review-2');
    expect(fieldKey('__x', taken)).toBe('x');
    expect(fieldKey('日本', taken)).toBe('field');
    expect(fieldKey('ok.key_1', taken)).toBe('ok.key_1');
  });
});

describe('limits', () => {
  it('flags a snapshot that is over the node limit', () => {
    const s = snapshot();
    s.tasks = Array.from({ length: 5001 }, (_, i) => ({
      ...s.tasks[0],
      id: `x${i}`,
      number: 100 + i,
    }));
    expect(buildRawBlueprint(s).report.exceedsNodeLimit).toBe(true);
  });
  it('drops subtasks nested deeper than a blueprint allows, and reports them', () => {
    const s = snapshot();
    const base = s.tasks[0];
    s.tasks = [
      { ...base, id: 'a', number: 1, parentId: null },
      { ...base, id: 'b', number: 2, parentId: 'a' },
      { ...base, id: 'c', number: 3, parentId: 'b' },
      { ...base, id: 'd', number: 4, parentId: 'c' },
      { ...base, id: 'e', number: 5, parentId: 'd' },
    ];
    const { raw, report } = buildRawBlueprint(s);
    expect(flat(raw.projects[0].tasks)).toHaveLength(3);
    expect(report.tasks).toMatchObject({
      included: 3,
      tooDeepSkipped: 2,
      orphanedSkipped: 0,
    });
  });
});

// ---------------------------------------------------------------------------------------------
// What the sanitizer (3.4) will do, in miniature, to prove extractor output FITS the format:
// users -> roles, dates -> offsets, source ids dropped. Not the real sanitizer.
function toBlueprint(raw: RawBlueprint, anchor: string): BlueprintV1 {
  const day = (iso?: string) =>
    iso === undefined
      ? undefined
      : Math.round((Date.parse(iso) - Date.parse(anchor)) / 86_400_000);
  const roles = new Map<string, string>();
  const role = (u: string) =>
    roles.has(u)
      ? roles.get(u)!
      : (roles.set(u, `person-${roles.size + 1}`), roles.get(u)!);
  const userFields = new Set(
    raw.workspace.customFields
      .filter((f) => f.dataType === 'USER')
      .map((f) => f.key),
  );
  const convert = (t: RawTask): any => ({
    nodeKey: t.nodeKey,
    title: t.title,
    description: t.description,
    issueType: t.issueType,
    status: t.status,
    priority: t.priority,
    tags: t.tags.length ? t.tags : undefined,
    customValues: Object.keys(t.customValues).filter((k) => !userFields.has(k))
      .length
      ? Object.fromEntries(
          Object.entries(t.customValues).filter(([k]) => !userFields.has(k)),
        )
      : undefined,
    assigneeRoles: t.assigneeUserIds.length
      ? t.assigneeUserIds.map(role)
      : undefined,
    startOffsetDays: day(t.startDate),
    dueOffsetDays: day(t.dueDate),
    estimate: t.estimate,
    iteration: t.iteration,
    children: t.children.length ? t.children.map(convert) : undefined,
    comments: t.comments.length
      ? t.comments.map((c) => ({ body: c.body }))
      : undefined,
    attachments: t.attachments.length ? t.attachments : undefined,
  });
  const bp: any = {
    schemaVersion: 1,
    meta: raw.meta,
    workspace: {
      ...(raw.meta.kind === 'WORKSPACE'
        ? {
            name: raw.workspace.name,
            key: raw.workspace.key,
            icon: raw.workspace.icon,
            description: raw.workspace.description,
          }
        : {}),
      tags: raw.workspace.tags,
      customFields: raw.workspace.customFields,
      issueTypes: raw.workspace.issueTypes,
      iterations: raw.workspace.iterations.map((i) => ({
        nodeKey: i.nodeKey,
        kind: i.kind,
        name: i.name,
        goal: i.goal,
        startOffsetDays: day(i.startDate),
        endOffsetDays: day(i.endDate),
        project: i.project,
      })),
    },
    projects: raw.projects.map((p) => ({
      nodeKey: p.nodeKey,
      name: p.name,
      description: p.description,
      workflow: p.workflow,
      tasks: p.tasks.map(convert),
      dependencies: p.dependencies,
    })),
    roles: [...roles.values()].map((k) => ({ key: k, label: k })),
    assets: raw.assets.map((a) => ({
      key: a.key,
      fileName: a.fileName,
      mimeType: a.mimeType,
      sizeBytes: a.sizeBytes,
      sha256: '0'.repeat(64),
    })),
  };
  return JSON.parse(JSON.stringify(bp));
}

describe('extractor output fits Blueprint v1 (via a stand-in for the 3.4 sanitizer)', () => {
  for (const [label, opts] of [
    ['workspace', { includeComments: true, includeAttachments: true }],
    [
      'project',
      { projectId: 'p1', includeComments: true, includeAttachments: true },
    ],
  ] as const) {
    it(`${label} extraction validates`, () => {
      const { raw } = buildRawBlueprint(snapshot(), opts);
      const r = validateBlueprint(toBlueprint(raw, '2026-09-01'));
      if (r.ok === false) throw new Error(JSON.stringify(r.issues, null, 1));
      expect(r.stats.tasks).toBe(label === 'workspace' ? 5 : 4);
    });
  }
});
