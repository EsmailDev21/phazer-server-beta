import { fixtureJson } from '../blueprint/blueprint.fixtures';
import { resolveBlueprint, ResolveInput } from './resolve.blueprint';
import { ResolvedTask } from './resolve.types';

const TODAY = '2026-10-09'; // a Friday
const run = (doc: unknown, input: Partial<ResolveInput> = {}) => resolveBlueprint(doc, { today: TODAY, ...input });
const ok = (doc: unknown, input: Partial<ResolveInput> = {}) => {
  const r = run(doc, input);
  if (r.ok === false) throw new Error(JSON.stringify(r.issues, null, 1));
  return r.resolved;
};
const bad = (doc: unknown, input: Partial<ResolveInput> = {}) => {
  const r = run(doc, input);
  if (r.ok === true) throw new Error('expected failure');
  return r.issues;
};
const find = (tasks: ResolvedTask[], key: string): ResolvedTask | undefined =>
  tasks.flatMap((t) => [t, ...t.children]).find((t) => t.nodeKey === key) ??
  tasks.flatMap((t) => t.children).map((c) => find([c], key)).find(Boolean);

describe('student workspace', () => {
  const student = () => fixtureJson('student-workspace');
  const vars = { course: 'Biology 101', semesterStart: '2026-09-01' }; // a Tuesday

  it('renders text, anchors dates, skips weekends', () => {
    const r = ok(student(), { variables: vars, modules: { labs: true } });
    expect(r.anchorDate).toBe('2026-09-01');
    expect(r.workspace.name).toBe('Biology 101');
    expect(r.workspace.description).toBe('Everything for Biology 101, starting September 1.');
    const cw = r.projects[0];
    expect(cw.name).toBe('Biology 101: coursework');
    const t = (k: string) => find(cw.tasks, k)!;
    expect(t('read-ch1')).toMatchObject({ title: 'Read chapter 1 of Biology 101', startDate: '2026-09-01', dueDate: '2026-09-07' });
    expect(t('essay').title).toBe('Essay: biology-101');
    // Tue + 46 = Sat -> Mon; Tue + 47 = Sun -> Mon
    expect(t('midterm-practice').dueDate).toBe('2026-10-19');
    expect(t('midterm-past-paper').dueDate).toBe('2026-10-19');
    expect(t('midterm').dueDate).toBe('2026-10-20');
    expect(t('essay-draft').comments[0].body).toBe('Reviewed on Tue 1 Sep: add sources.');
    expect(r.workspace.iterations.map((i) => [i.nodeKey, i.startDate, i.endDate])).toEqual([
      ['it-midterm', '2026-09-01', '2026-10-20'],
      ['it-finals', '2026-10-21', '2026-12-10'],
    ]);
    expect(r.projects.map((p) => p.name)).toEqual(['Biology 101: coursework', 'Biology 101: labs']);
  });

  it('modules: labs are off by default, off means the project and its tasks are gone', () => {
    const r = ok(student(), { variables: vars });
    expect(r.projects.map((p) => p.nodeKey)).toEqual(['coursework']);
    expect(r.dropped.projects).toEqual(['labs']);
    expect(r.dropped.tasks.sort()).toEqual(['lab-1', 'lab-2']);
  });

  it('turning exam-prep off drops the midterm subtree and the dependencies that touched it', () => {
    const r = ok(student(), { variables: vars, modules: { 'exam-prep': false } });
    const cw = r.projects[0];
    expect(find(cw.tasks, 'midterm')).toBeUndefined();
    expect(find(cw.tasks, 'midterm-past-paper')).toBeUndefined();
    expect(cw.dependencies).toEqual([{ from: 'essay-outline', to: 'essay-draft', type: 'BLOCKS' }]);
    expect(r.dropped.dependencies).toBe(2);
    expect(r.assets.map((a) => a.key)).toEqual(['rubric']); // essay still attaches it
  });

  it('roles: members get assigned, invites and unassigned do not', () => {
    const r = ok(student(), {
      variables: vars,
      roles: { student: { type: 'MEMBER', userId: 'u1' }, professor: { type: 'INVITE', email: 'Prof@Uni.edu' } },
      eligibleUserIds: new Set(['u1']),
    });
    const essay = find(r.projects[0].tasks, 'essay')!;
    expect(essay.assigneeRoles).toEqual(['student', 'professor']);
    expect(essay.assigneeUserIds).toEqual(['u1']);
    expect(r.roles.find((x) => x.key === 'professor')!.assignment).toEqual({ type: 'INVITE', email: 'prof@uni.edu' });
    expect(JSON.stringify(r)).not.toContain('Prof@Uni');
  });

  it('defaults carry a whole apply with no input but the date', () => {
    const r = ok(student(), {});
    expect(r.workspace.name).toBe('Introduction to Biology');
    expect(r.anchorDate).toBe('2026-09-01');
  });

  it('is deterministic and does not touch its input', () => {
    const doc = student();
    const before = JSON.stringify(doc);
    const a = ok(doc, { variables: vars });
    const b = ok(doc, { variables: vars });
    expect(JSON.stringify(doc)).toBe(before);
    expect(a).toEqual(b);
  });

  it('collects every problem across the pipeline', () => {
    const issues = bad(student(), { variables: { course: 5, nope: 1 }, modules: { ghost: true }, roles: { ghost: {} } });
    expect(issues.map((i) => i.code).sort()).toEqual(['MODULE_UNKNOWN', 'ROLE_UNKNOWN', 'VARIABLE_INVALID', 'VARIABLE_UNKNOWN']);
  });
});

describe('content calendar (weekdays only, anchor on a Saturday)', () => {
  const cal = () => fixtureJson('content-calendar');
  it('anchor + offsets land on weekdays; calendar helpers do not skip', () => {
    const r = ok(cal(), { variables: { launchDate: '2026-10-10' }, modules: { paid: true } });
    const post1 = find(r.projects[0].tasks, 'post-1')!;
    expect(post1.startDate).toBe('2026-10-05'); // Sat -7 = Sat -> Mon
    expect(post1.dueDate).toBe('2026-10-12'); // Sat -> Mon
    expect(post1.customValues['go-live']).toBe('2026-10-12');
    expect(post1.customValues.channels).toEqual(['Newsletter', 'Social']);
    expect(post1.comments[0].body).toBe('Draft due 2026-10-07'); // addDays is plain calendar math
    expect(post1.title).toBe('Acme launch post (Blog)');
    expect(post1.description).toBe('Goes live Saturday 10 October. Slug: acme.');
    expect(r.projects[0].description).toBe('A 4-week plan for Acme.');
  });

  it('the required date must be supplied', () => {
    expect(bad(cal(), {}).map((i) => [i.code, i.path])).toEqual([['VARIABLE_MISSING', '/variables/launchDate']]);
  });
});

describe('sprint board (no anchor variable: anchor = today)', () => {
  it('uses the injected date, never the clock', () => {
    const r = ok(fixtureJson('sprint-board'), { variables: { team: 'Core' } });
    expect(r.anchorDate).toBe(TODAY);
    expect(r.projects[0].name).toBe('Core sprint board');
    expect(r.workspace.iterations.map((i) => [i.startDate, i.endDate])).toEqual([
      ['2026-10-09', '2026-10-22'], ['2026-10-23', '2026-11-05'], ['2026-11-06', '2026-11-19'],
    ]);
    expect(r.projects[0].dependencies[0].type).toBe('BLOCKS');
    expect(r.projects[0].automations).toHaveLength(1);
  });
  it('a different today moves everything', () => {
    expect(ok(fixtureJson('sprint-board'), { today: '2027-01-04' }).workspace.iterations[0].startDate).toBe('2027-01-04');
  });
});

describe('what substitution can and cannot do', () => {
  const student = () => fixtureJson('student-workspace');

  it('values stay values: placeholders, newlines, controls and prototype names in a value do nothing', () => {
    const r = ok(student(), { variables: { course: '{{semesterStart}} \\{{x}}', semesterStart: '2026-09-01' } });
    expect(r.workspace.name).toBe('{{semesterStart}} \\{{x}}');
    for (const evil of ['a\nb', 'a\u0000b', '\u202e']) {
      const issues = run(student(), { variables: { course: evil, semesterStart: '2026-09-01' } });
      if (evil === '\u202e') continue; // a bidi control is printable text; only C0/C1 are refused
      expect(issues.ok).toBe(false);
    }
    expect(bad(student(), { variables: JSON.parse('{"__proto__":{"course":"x"},"semesterStart":"2026-09-01"}') }).map((i) => i.code))
      .toEqual(['VARIABLE_UNKNOWN']);
  });

  it('keys and structure never change: only leaf text does', () => {
    const doc = student();
    const r = ok(doc, { variables: { course: 'tasks", "x": "', semesterStart: '2026-09-01' } });
    expect(Object.keys(r.projects[0].tasks[0]).sort()).toEqual(
      ['assigneeRoles', 'assigneeUserIds', 'attachments', 'children', 'comments', 'customValues', 'dueDate', 'estimate', 'issueType', 'iteration', 'nodeKey', 'priority', 'startDate', 'status', 'tags', 'title', 'description'].sort(),
    );
    expect(r.projects[0].tasks[0].title).toBe('Read chapter 1 of tasks", "x": "');
  });

  it('a value that makes a field too long is caught AFTER substitution, with the right path', () => {
    const issues = bad(student(), { variables: { course: 'x'.repeat(130), semesterStart: '2026-09-01' }, modules: { labs: true } });
    expect(issues.map((i) => i.code)).toContain('TEXT_TOO_LONG');
    expect(issues.find((i) => i.path === '/projects/1/name')).toBeDefined(); // original index of labs
  });

  it('paths point into the ORIGINAL document even when earlier nodes were dropped', () => {
    const doc = student();
    doc.modules.push({ key: 'cw', label: 'cw', includes: ['coursework'] });
    const issues = bad(doc, { variables: { course: 'x'.repeat(130), semesterStart: '2026-09-01' }, modules: { cw: false, labs: true } });
    expect(issues.map((i) => i.path)).toContain('/projects/1/name');
    expect(issues.map((i) => i.path)).not.toContain('/projects/0/name');
  });

  it('dates outside 1900-2200 are errors, not wraparounds', () => {
    const issues = bad(student(), { variables: { course: 'x', semesterStart: '2200-12-01' } });
    expect(issues.map((i) => i.code)).toContain('DATE_OUT_OF_RANGE');
  });

  it('refuses a bad "today" and an invalid blueprint before doing anything', () => {
    expect(bad(student(), { today: '2026-02-30' }).map((i) => i.code)).toEqual(['DATE_INVALID']);
    expect(bad({ nope: 1 }).every((i) => i.code === 'BLUEPRINT_INVALID')).toBe(true);
    expect(bad(null)[0].code).toBe('BLUEPRINT_INVALID');
  });
});
