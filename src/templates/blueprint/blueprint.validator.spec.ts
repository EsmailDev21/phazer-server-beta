import * as fs from 'fs';
import * as path from 'path';
import { BlueprintIssueCode } from './blueprint.issues';
import { BLUEPRINT_LIMITS as L } from './blueprint.limits';
import { BLUEPRINT_V1_SCHEMA } from './blueprint.schema';
import {
  fixtureJson,
  fixtureText,
  GOLDEN_FIXTURES,
} from './blueprint.fixtures';
import { BlueprintV1 } from './blueprint.types';
import { parseBlueprintJson, validateBlueprint } from './blueprint.validator';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

function issuesOf(input: unknown) {
  const r = validateBlueprint(input);
  if (r.ok === true) throw new Error('expected the blueprint to be rejected');
  return r.issues;
}
function expectRejected(
  input: unknown,
  code: BlueprintIssueCode,
  at?: string | RegExp,
) {
  const issues = issuesOf(input);
  const hit = issues.find(
    (i) =>
      i.code === code &&
      (at === undefined ||
        (typeof at === 'string' ? i.path === at : at.test(i.path))),
  );
  if (!hit) {
    throw new Error(
      `expected ${code}${at ? ` at ${at}` : ''}; got ${JSON.stringify(issues.slice(0, 6))}`,
    );
  }
}

// ---------------------------------------------------------------------------------------------
describe('golden fixtures', () => {
  it.each(GOLDEN_FIXTURES)('%s is valid, with no warnings', (name) => {
    const r = parseBlueprintJson(fixtureText(name));
    if (r.ok === false) throw new Error(JSON.stringify(r.issues, null, 1));
    expect(r.warnings).toEqual([]);
    expect(r.migratedFrom).toBeNull();
  });

  it('student workspace: the exam tag and the prof-review field survive, with their shape', () => {
    const r = parseBlueprintJson(fixtureText('student-workspace'));
    if (r.ok === false) throw new Error('invalid');
    const ws = r.blueprint.workspace!;
    expect(ws.tags!.map((t) => t.name)).toContain('exam');
    const field = ws.customFields!.find((f) => f.key === 'prof-review')!;
    expect(field.dataType).toBe('SELECT');
    expect(field.options).toEqual(['pending', 'approved', 'changes requested']);
    expect(r.stats).toMatchObject({
      projects: 2,
      tasks: 11,
      rootTasks: 6,
      maxTaskLevels: 3,
      iterations: 2,
      nodes: 15,
      comments: 2,
      dependencies: 3,
      assets: 1,
      assetBytes: 48211,
    });
  });

  it('sprint board: a PROJECT blueprint with an enforced workflow and project-scoped sprints', () => {
    const r = parseBlueprintJson(fixtureText('sprint-board'));
    if (r.ok === false) throw new Error('invalid');
    expect(r.blueprint.meta.kind).toBe('PROJECT');
    expect(r.blueprint.projects[0].workflow!.enforceTransitions).toBe(true);
    expect(r.stats).toMatchObject({
      projects: 1,
      tasks: 7,
      iterations: 3,
      statuses: 7,
      transitions: 8,
    });
  });

  it('content calendar: every custom field type, a USER field defined but never valued', () => {
    const r = parseBlueprintJson(fixtureText('content-calendar'));
    if (r.ok === false) throw new Error('invalid');
    const types = r.blueprint
      .workspace!.customFields!.map((f) => f.dataType)
      .sort();
    expect(types).toEqual([
      'CHECKBOX',
      'DATE',
      'MULTI_SELECT',
      'NUMBER',
      'SELECT',
      'TEXT',
      'URL',
      'USER',
    ]);
    expect(r.blueprint.dateAnchor).toEqual({
      variable: 'launchDate',
      skipWeekends: true,
    });
  });

  it('validation does not change the document it judges', () => {
    for (const name of GOLDEN_FIXTURES) {
      const doc = fixtureJson(name);
      const before = JSON.stringify(doc);
      validateBlueprint(doc);
      expect(JSON.stringify(doc)).toBe(before);
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe('the types and the schema agree (kitchen sink: every optional field of every type)', () => {
  const sink: BlueprintV1 = {
    schemaVersion: 1,
    meta: {
      name: 'Everything',
      description: 'All of it',
      kind: 'WORKSPACE',
      category: 'demo',
      locale: 'pt-BR',
    },
    dateAnchor: { variable: 'start', skipWeekends: true },
    variables: [
      {
        key: 'start',
        label: 'Start',
        type: 'DATE',
        default: '2026-01-05',
        required: true,
      },
      { key: 'title', label: 'Title', type: 'TEXT', default: 'x' },
      { key: 'n', label: 'N', type: 'NUMBER', default: 3, required: false },
      {
        key: 'pick',
        label: 'Pick',
        type: 'SELECT',
        options: ['a', 'b'],
        default: 'a',
      },
      { key: 'flag', label: 'Flag', type: 'BOOLEAN', default: true },
    ],
    roles: [{ key: 'lead', label: 'Lead', suggestedAccess: 'ADMIN' }],
    modules: [
      {
        key: 'extra',
        label: 'Extra',
        defaultEnabled: false,
        includes: ['p1', 't1'],
      },
    ],
    workspace: {
      name: '{{title}} {{n}} {{pick}} {{flag}}',
      key: 'ALL',
      icon: 'star',
      description: 'From {{start}}',
      tags: [{ name: 't' }],
      customFields: [
        {
          key: 'f',
          name: 'F',
          dataType: 'MULTI_SELECT',
          options: ['x', 'y'],
          order: 3,
        },
      ],
      issueTypes: [
        { name: 'Epic', icon: 'bolt', color: '#112233', level: 'EPIC' },
      ],
      iterations: [
        {
          nodeKey: 'i1',
          kind: 'CYCLE',
          name: 'C1',
          goal: 'g',
          startOffsetDays: 0,
          endOffsetDays: 5,
          project: 'p1',
        },
      ],
    },
    projects: [
      {
        nodeKey: 'p1',
        name: 'P',
        description: 'D',
        workflow: {
          statuses: [
            {
              key: 'todo',
              name: 'To do',
              category: 'TODO',
              color: '#000000',
              isDefault: true,
            },
            {
              key: 'doing',
              name: 'Doing',
              category: 'IN_PROGRESS',
              excludeFromProgress: false,
            },
            { key: 'stuck', name: 'Stuck', category: 'BLOCKED' },
            { key: 'done', name: 'Done', category: 'DONE' },
            {
              key: 'gone',
              name: 'Gone',
              category: 'DONE',
              excludeFromProgress: true,
            },
          ],
          transitions: [{ from: 'todo', to: 'doing' }],
          enforceTransitions: true,
        },
        tasks: [
          {
            nodeKey: 't1',
            title: 'T',
            description: 'd',
            issueType: 'epic',
            status: 'todo',
            priority: 'LOW',
            tags: ['T'],
            customValues: { f: ['x'] },
            assigneeRoles: ['lead'],
            startOffsetDays: -1,
            dueOffsetDays: 4,
            estimate: 2.5,
            iteration: 'i1',
            children: [{ nodeKey: 't2', title: 'child' }],
            comments: [{ body: 'hi', authorRole: 'lead' }],
            attachments: ['a1'],
          },
          { nodeKey: 't3', title: 'other' },
        ],
        dependencies: [{ from: 't1', to: 't3', type: 'RELATES_TO' }],
        automations: [{ anything: { goes: [1, 2] } }],
        views: [{ name: 'v' }],
      },
    ],
    assets: [
      {
        key: 'a1',
        fileName: 'f.png',
        mimeType: 'image/png',
        sizeBytes: 10,
        sha256: 'a'.repeat(64),
      },
    ],
    extensions: { 'acme.x': { y: [1, 'z', null] } },
  };

  it('is accepted', () => {
    const r = validateBlueprint(sink);
    if (r.ok === false) throw new Error(JSON.stringify(r.issues, null, 1));
    expect(r.warnings).toEqual([]);
  });

  it('the schema has no object without additionalProperties:false, except the three on purpose', () => {
    const open: string[] = [];
    const walk = (node: unknown, where: string) => {
      if (Array.isArray(node))
        return node.forEach((n, i) => walk(n, `${where}/${i}`));
      if (node === null || typeof node !== 'object') return;
      const n = node as Record<string, unknown>;
      if (n.type === 'object' && n.additionalProperties !== false)
        open.push(where);
      for (const [k, v] of Object.entries(n)) walk(v, `${where}/${k}`);
    };
    walk(BLUEPRINT_V1_SCHEMA, '');
    expect(open.sort()).toEqual([
      '/$defs/project/properties/automations/items',
      '/$defs/project/properties/views/items',
      '/$defs/task/properties/customValues',
      '/properties/extensions',
    ]);
  });

  it('docs/design/blueprint-v1.schema.json is the schema (set UPDATE_BLUEPRINT_SCHEMA=1 to rewrite it)', () => {
    const file = path.join(
      __dirname,
      '..',
      '..',
      '..',
      'docs',
      'design',
      'blueprint-v1.schema.json',
    );
    const expected = `${JSON.stringify(BLUEPRINT_V1_SCHEMA, null, 2)}\n`;
    if (process.env.UPDATE_BLUEPRINT_SCHEMA) fs.writeFileSync(file, expected);
    expect(fs.readFileSync(file, 'utf8')).toBe(expected);
  });
});

// ---------------------------------------------------------------------------------------------
describe('shape: unknown, missing and malformed fields', () => {
  const base = () => fixtureJson('student-workspace');

  it.each<[string, (d: any) => void, BlueprintIssueCode, string | RegExp]>([
    [
      'unknown top-level field',
      (d) => (d.bogus = 1),
      'UNKNOWN_FIELD',
      '/bogus',
    ],
    [
      'unknown field on meta',
      (d) => (d.meta.owner = 'x'),
      'UNKNOWN_FIELD',
      '/meta/owner',
    ],
    [
      'unknown field on a task',
      (d) => (d.projects[0].tasks[0].assignee = 'u1'),
      'UNKNOWN_FIELD',
      '/projects/0/tasks/0/assignee',
    ],
    [
      'a user id smuggled in as assigneeIds',
      (d) => (d.projects[0].tasks[0].assigneeIds = ['u1']),
      'UNKNOWN_FIELD',
      '/projects/0/tasks/0/assigneeIds',
    ],
    [
      'unknown field on a subtask',
      (d) => (d.projects[0].tasks[1].children[0].id = 'cuid'),
      'UNKNOWN_FIELD',
      '/projects/0/tasks/1/children/0/id',
    ],
    [
      'unknown field on a status',
      (d) => (d.projects[0].workflow.statuses[0].id = 'x'),
      'UNKNOWN_FIELD',
      '/projects/0/workflow/statuses/0/id',
    ],
    [
      'unknown field on a tag (colours do not exist in v1)',
      (d) => (d.workspace.tags[0].color = '#fff000'),
      'UNKNOWN_FIELD',
      '/workspace/tags/0/color',
    ],
    [
      'unknown field on a comment (no real author)',
      (d) => (d.projects[0].tasks[1].children[1].comments[0].authorId = 'u'),
      'UNKNOWN_FIELD',
      /comments\/0\/authorId$/,
    ],
    [
      'unknown field on an asset',
      (d) => (d.assets[0].url = 'https://x'),
      'UNKNOWN_FIELD',
      '/assets/0/url',
    ],
    ['missing meta', (d) => delete d.meta, 'MISSING_FIELD', '/meta'],
    [
      'missing meta.name',
      (d) => delete d.meta.name,
      'MISSING_FIELD',
      '/meta/name',
    ],
    [
      'missing meta.kind',
      (d) => delete d.meta.kind,
      'MISSING_FIELD',
      '/meta/kind',
    ],
    [
      'missing projects',
      (d) => delete d.projects,
      'MISSING_FIELD',
      '/projects',
    ],
    [
      'missing tasks on a project',
      (d) => delete d.projects[1].tasks,
      'MISSING_FIELD',
      '/projects/1/tasks',
    ],
    [
      'missing nodeKey on a task',
      (d) => delete d.projects[0].tasks[0].nodeKey,
      'MISSING_FIELD',
      '/projects/0/tasks/0/nodeKey',
    ],
    [
      'missing title on a task',
      (d) => delete d.projects[0].tasks[0].title,
      'MISSING_FIELD',
      '/projects/0/tasks/0/title',
    ],
    [
      'missing key on a status',
      (d) => delete d.projects[0].workflow.statuses[0].key,
      'MISSING_FIELD',
      '/projects/0/workflow/statuses/0/key',
    ],
    ['bad kind', (d) => (d.meta.kind = 'TEAM'), 'SCHEMA', '/meta/kind'],
    [
      'bad priority',
      (d) => (d.projects[0].tasks[0].priority = 'CRITICAL'),
      'SCHEMA',
      '/projects/0/tasks/0/priority',
    ],
    [
      'bad status category',
      (d) => (d.projects[0].workflow.statuses[0].category = 'INBOX'),
      'SCHEMA',
      '/projects/0/workflow/statuses/0/category',
    ],
    [
      'bad colour',
      (d) => (d.projects[0].workflow.statuses[0].color = 'red'),
      'SCHEMA',
      '/projects/0/workflow/statuses/0/color',
    ],
    [
      'nodeKey with a space',
      (d) => (d.projects[0].tasks[0].nodeKey = 'read ch1'),
      'SCHEMA',
      '/projects/0/tasks/0/nodeKey',
    ],
    [
      'nodeKey that is empty',
      (d) => (d.projects[0].tasks[0].nodeKey = ''),
      'SCHEMA',
      '/projects/0/tasks/0/nodeKey',
    ],
    [
      'workspace key in lower case',
      (d) => (d.workspace.key = 'study'),
      'SCHEMA',
      '/workspace/key',
    ],
    [
      'empty title',
      (d) => (d.projects[0].tasks[0].title = ''),
      'SCHEMA',
      '/projects/0/tasks/0/title',
    ],
    [
      'title too long',
      (d) => (d.projects[0].tasks[0].title = 'x'.repeat(L.taskTitle + 1)),
      'SCHEMA',
      '/projects/0/tasks/0/title',
    ],
    [
      'offset beyond ten years',
      (d) => (d.projects[0].tasks[0].dueOffsetDays = L.maxOffsetDays + 1),
      'SCHEMA',
      '/projects/0/tasks/0/dueOffsetDays',
    ],
    [
      'fractional offset',
      (d) => (d.projects[0].tasks[0].dueOffsetDays = 1.5),
      'SCHEMA',
      '/projects/0/tasks/0/dueOffsetDays',
    ],
    [
      'offset as a string',
      (d) => (d.projects[0].tasks[0].dueOffsetDays = '7'),
      'SCHEMA',
      '/projects/0/tasks/0/dueOffsetDays',
    ],
    [
      'negative estimate',
      (d) => (d.projects[0].tasks[0].estimate = -1),
      'SCHEMA',
      '/projects/0/tasks/0/estimate',
    ],
    [
      'estimate over 1000',
      (d) => (d.projects[0].tasks[0].estimate = 1001),
      'SCHEMA',
      '/projects/0/tasks/0/estimate',
    ],
    [
      'tasks is not a list',
      (d) => (d.projects[0].tasks = {}),
      'SCHEMA',
      '/projects/0/tasks',
    ],
    [
      'a custom value key with a space',
      (d) => (d.projects[0].tasks[1].customValues['bad key'] = 'x'),
      'SCHEMA',
      '/projects/0/tasks/1/customValues',
    ],
    [
      'an extension key in upper case',
      (d) => (d.extensions = { Acme: 1 }),
      'SCHEMA',
      '/extensions',
    ],
    [
      'an asset hash that is not sha256',
      (d) => (d.assets[0].sha256 = 'abc'),
      'SCHEMA',
      '/assets/0/sha256',
    ],
    [
      'an asset larger than the cap',
      (d) => (d.assets[0].sizeBytes = L.maxAssetBytes + 1),
      'SCHEMA',
      '/assets/0/sizeBytes',
    ],
    [
      'an asset mime type without a slash',
      (d) => (d.assets[0].mimeType = 'pdf'),
      'SCHEMA',
      '/assets/0/mimeType',
    ],
    [
      'no statuses in a workflow',
      (d) => (d.projects[0].workflow.statuses = []),
      'SCHEMA',
      '/projects/0/workflow/statuses',
    ],
    [
      'too many statuses',
      (d) =>
        (d.projects[0].workflow.statuses = Array.from(
          { length: L.maxStatusesPerProject + 1 },
          (_, i) => ({ key: `s${i}`, name: `S${i}`, category: 'TODO' }),
        )),
      'SCHEMA',
      '/projects/0/workflow/statuses',
    ],
    [
      'too many projects',
      (d) =>
        (d.projects = Array.from({ length: L.maxProjects + 1 }, (_, i) => ({
          nodeKey: `p${i}`,
          name: 'p',
          tasks: [],
        }))),
      'SCHEMA',
      '/projects',
    ],
    [
      'too many comments on a task',
      (d) =>
        (d.projects[0].tasks[0].comments = Array.from(
          { length: L.maxCommentsPerTask + 1 },
          () => ({ body: 'x' }),
        )),
      'SCHEMA',
      '/projects/0/tasks/0/comments',
    ],
    [
      'a variable with a hyphen in its key',
      (d) => (d.variables[0].key = 'my-var'),
      'SCHEMA',
      '/variables/0/key',
    ],
    [
      'a role key with an upper-case letter',
      (d) => (d.roles[0].key = 'Student'),
      'SCHEMA',
      '/roles/0/key',
    ],
    [
      'suggestedAccess OWNER is not a thing',
      (d) => (d.roles[0].suggestedAccess = 'OWNER'),
      'SCHEMA',
      '/roles/0/suggestedAccess',
    ],
  ])('rejects: %s', (_n, mutate, code, at) => {
    const d = base();
    mutate(d);
    expectRejected(d, code, at);
  });

  it('a hostile "__proto__" key is refused wherever it appears', () => {
    const text =
      '{"schemaVersion":1,"meta":{"name":"x","kind":"WORKSPACE"},"projects":[],"extensions":{"__proto__":{"x":1}}}';
    expectRejected(JSON.parse(text), 'NOT_JSON', '/extensions/__proto__');
    const top = JSON.parse(
      '{"__proto__":{"isAdmin":true},"schemaVersion":1,"meta":{"name":"x","kind":"WORKSPACE"},"projects":[]}',
    );
    expectRejected(top, 'NOT_JSON', '/__proto__');
    expect(({} as { isAdmin?: boolean }).isAdmin).toBeUndefined();
  });

  it('reports EVERY shape problem it finds, not just the first', () => {
    const d = base();
    d.bogus = 1;
    delete d.meta.name;
    d.projects[0].tasks[0].priority = 'NOPE';
    const issues = issuesOf(d);
    expect(issues.map((i) => i.code).sort()).toEqual([
      'MISSING_FIELD',
      'SCHEMA',
      'UNKNOWN_FIELD',
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
describe('versions', () => {
  const base = () => fixtureJson('sprint-board');
  it('missing, invalid and newer versions are distinct, stable codes', () => {
    const missing = base();
    delete missing.schemaVersion;
    expectRejected(missing, 'VERSION_MISSING', '/schemaVersion');
    expectRejected(
      { ...base(), schemaVersion: '1' },
      'VERSION_INVALID',
      '/schemaVersion',
    );
    expectRejected({ ...base(), schemaVersion: 0 }, 'VERSION_INVALID');
    expectRejected(
      { ...base(), schemaVersion: 2 },
      'VERSION_TOO_NEW',
      '/schemaVersion',
    );
  });
  it('a non-object is rejected cleanly', () => {
    for (const v of [null, [], 'x', 3, true])
      expect(validateBlueprint(v).ok).toBe(false);
  });
  it("a migration's OUTPUT is validated like any other input", () => {
    const r = validateBlueprint(base(), {
      migration: {
        currentVersion: 2,
        migrations: { 1: (d) => ({ ...d, schemaVersion: 2, extra: true }) },
      },
    });
    // schemaVersion 2 is not v1's shape: the schema, not the hook, has the last word
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
describe('semantic rules: references, uniqueness, placeholders, workflow, dependencies', () => {
  const ws = () => fixtureJson('student-workspace');
  const sprint = () => fixtureJson('sprint-board');
  const cal = () => fixtureJson('content-calendar');

  type Case = [
    string,
    () => any,
    BlueprintIssueCode,
    string | RegExp | undefined,
  ];
  const cases: Case[] = [
    // ---- uniqueness
    [
      'a task reusing a project nodeKey',
      () => {
        const d = ws();
        d.projects[0].tasks[0].nodeKey = 'labs';
        return d;
      },
      'DUPLICATE',
      '/projects/0/tasks/0/nodeKey',
    ],
    [
      "a subtask reusing its parent's nodeKey",
      () => {
        const d = ws();
        d.projects[0].tasks[1].children[0].nodeKey = 'essay';
        return d;
      },
      'DUPLICATE',
      '/projects/0/tasks/1/children/0/nodeKey',
    ],
    [
      'two projects sharing a task nodeKey',
      () => {
        const d = ws();
        d.projects[1].tasks[0].nodeKey = 'read-ch1';
        return d;
      },
      'DUPLICATE',
      '/projects/1/tasks/0/nodeKey',
    ],
    [
      'an iteration reusing a task nodeKey',
      () => {
        const d = ws();
        d.workspace.iterations[0].nodeKey = 'essay';
        return d;
      },
      'DUPLICATE',
      '/projects/0/tasks/1/nodeKey',
    ],
    [
      'tags differing only by case',
      () => {
        const d = ws();
        d.workspace.tags.push({ name: 'EXAM' });
        return d;
      },
      'DUPLICATE',
      '/workspace/tags/4/name',
    ],
    [
      'tags differing only by spacing',
      () => {
        const d = ws();
        d.workspace.tags.push({ name: ' exam ' });
        return d;
      },
      'DUPLICATE',
      '/workspace/tags/4/name',
    ],
    [
      'tags that fold to the same name (full-width letters)',
      () => {
        const d = ws();
        d.workspace.tags.push({ name: 'ｅｘａｍ' });
        return d;
      },
      'DUPLICATE',
      '/workspace/tags/4/name',
    ],
    [
      'custom field keys differing by case',
      () => {
        const d = ws();
        d.workspace.customFields.push({
          key: 'Prof-Review',
          name: 'x',
          dataType: 'TEXT',
        });
        return d;
      },
      'DUPLICATE',
      '/workspace/customFields/2/key',
    ],
    [
      'issue types differing by case',
      () => {
        const d = ws();
        d.workspace.issueTypes.push({ name: 'exam' });
        return d;
      },
      'DUPLICATE',
      '/workspace/issueTypes/3/name',
    ],
    [
      'two variables differing by case',
      () => {
        const d = ws();
        d.variables.push({ key: 'COURSE', label: 'x', type: 'TEXT' });
        return d;
      },
      'DUPLICATE',
      '/variables/2/key',
    ],
    [
      'a role declared twice',
      () => {
        const d = ws();
        d.roles.push({ key: 'student', label: 'again' });
        return d;
      },
      'DUPLICATE',
      '/roles/2/key',
    ],
    [
      'an asset declared twice',
      () => {
        const d = ws();
        d.assets.push({ ...d.assets[0] });
        return d;
      },
      'DUPLICATE',
      '/assets/1/key',
    ],
    [
      'a module declared twice',
      () => {
        const d = ws();
        d.modules[1].key = 'exam-prep';
        return d;
      },
      'DUPLICATE',
      '/modules/1/key',
    ],
    [
      'a tag listed twice on one task',
      () => {
        const d = ws();
        d.projects[0].tasks[0].tags = ['reading', 'Reading'];
        return d;
      },
      'DUPLICATE',
      '/projects/0/tasks/0/tags/1',
    ],
    [
      'a role listed twice on one task',
      () => {
        const d = ws();
        d.projects[0].tasks[0].assigneeRoles = ['student', 'student'];
        return d;
      },
      'DUPLICATE',
      '/projects/0/tasks/0/assigneeRoles/1',
    ],
    [
      'an asset attached twice to one task',
      () => {
        const d = ws();
        d.projects[0].tasks[1].attachments = ['rubric', 'rubric'];
        return d;
      },
      'DUPLICATE',
      '/projects/0/tasks/1/attachments/1',
    ],
    [
      'status keys repeated',
      () => {
        const d = ws();
        d.projects[0].workflow.statuses[1].key = 'todo';
        return d;
      },
      'DUPLICATE',
      '/projects/0/workflow/statuses/1/key',
    ],
    [
      'status names repeated, ignoring case',
      () => {
        const d = ws();
        d.projects[0].workflow.statuses[1].name = 'TO DO';
        return d;
      },
      'DUPLICATE',
      '/projects/0/workflow/statuses/1/name',
    ],
    [
      'transitions listed twice',
      () => {
        const d = ws();
        d.projects[0].workflow.transitions.push({ from: 'todo', to: 'doing' });
        return d;
      },
      'DUPLICATE',
      '/projects/0/workflow/transitions/4',
    ],
    [
      'a custom-field option listed twice',
      () => {
        const d = ws();
        d.workspace.customFields[0].options.push('pending');
        return d;
      },
      'DUPLICATE',
      '/workspace/customFields/0/options/3',
    ],

    // ---- references
    [
      'an unknown tag on a task',
      () => {
        const d = ws();
        d.projects[0].tasks[0].tags = ['nope'];
        return d;
      },
      'UNKNOWN_REF',
      '/projects/0/tasks/0/tags/0',
    ],
    [
      'an unknown issue type',
      () => {
        const d = ws();
        d.projects[0].tasks[0].issueType = 'Saga';
        return d;
      },
      'UNKNOWN_REF',
      '/projects/0/tasks/0/issueType',
    ],
    [
      'an unknown status key',
      () => {
        const d = ws();
        d.projects[0].tasks[0].status = 'limbo';
        return d;
      },
      'UNKNOWN_REF',
      '/projects/0/tasks/0/status',
    ],
    [
      'a status on a project with no workflow',
      () => {
        const d = cal();
        d.projects[0].tasks[0].status = 'todo';
        return d;
      },
      'UNKNOWN_REF',
      '/projects/0/tasks/0/status',
    ],
    [
      'an unknown assignee role',
      () => {
        const d = ws();
        d.projects[0].tasks[0].assigneeRoles = ['dean'];
        return d;
      },
      'UNKNOWN_REF',
      '/projects/0/tasks/0/assigneeRoles/0',
    ],
    [
      'an unknown comment author role',
      () => {
        const d = ws();
        d.projects[0].tasks[1].children[1].comments[0].authorRole = 'dean';
        return d;
      },
      'UNKNOWN_REF',
      /authorRole$/,
    ],
    [
      'an unknown asset',
      () => {
        const d = ws();
        d.projects[0].tasks[1].attachments = ['ghost'];
        return d;
      },
      'UNKNOWN_REF',
      '/projects/0/tasks/1/attachments/0',
    ],
    [
      'an unknown iteration',
      () => {
        const d = ws();
        d.projects[0].tasks[0].iteration = 'it-void';
        return d;
      },
      'UNKNOWN_REF',
      '/projects/0/tasks/0/iteration',
    ],
    [
      'an iteration ref that points at a task',
      () => {
        const d = ws();
        d.projects[0].tasks[0].iteration = 'essay';
        return d;
      },
      'UNKNOWN_REF',
      '/projects/0/tasks/0/iteration',
    ],
    [
      'an iteration scoped to an unknown project',
      () => {
        const d = sprint();
        d.workspace.iterations[0].project = 'ghost';
        return d;
      },
      'UNKNOWN_REF',
      '/workspace/iterations/0/project',
    ],
    [
      'an iteration scoped to a task, not a project',
      () => {
        const d = sprint();
        d.workspace.iterations[0].project = 'epic-auth';
        return d;
      },
      'UNKNOWN_REF',
      '/workspace/iterations/0/project',
    ],
    [
      'a custom value for an undeclared field',
      () => {
        const d = ws();
        d.projects[0].tasks[1].customValues.ghost = 'x';
        return d;
      },
      'UNKNOWN_REF',
      '/projects/0/tasks/1/customValues/ghost',
    ],
    [
      'a transition to an unknown status',
      () => {
        const d = ws();
        d.projects[0].workflow.transitions[0].to = 'ghost';
        return d;
      },
      'UNKNOWN_REF',
      '/projects/0/workflow/transitions/0/to',
    ],
    [
      'a module including an unknown node',
      () => {
        const d = ws();
        d.modules[0].includes.push('ghost');
        return d;
      },
      'UNKNOWN_REF',
      '/modules/0/includes/1',
    ],
    [
      'a module including an iteration',
      () => {
        const d = ws();
        d.modules[0].includes.push('it-midterm');
        return d;
      },
      'MODULE_INVALID',
      '/modules/0/includes/1',
    ],
    [
      'a module including a node twice',
      () => {
        const d = ws();
        d.modules[0].includes.push('midterm');
        return d;
      },
      'DUPLICATE',
      '/modules/0/includes/1',
    ],
    [
      'a task using an iteration of another project',
      () => {
        const d = sprint();
        d.projects.push({
          nodeKey: 'other',
          name: 'Other',
          tasks: [{ nodeKey: 'x1', title: 'x', iteration: 'sprint-1' }],
        });
        d.meta.kind = 'WORKSPACE';
        return d;
      },
      'ITERATION_SCOPE',
      '/projects/1/tasks/0/iteration',
    ],

    // ---- kinds
    [
      'a PROJECT template with two projects',
      () => {
        const d = sprint();
        d.projects.push({ nodeKey: 'p2', name: 'p2', tasks: [] });
        return d;
      },
      'KIND_MISMATCH',
      '/projects',
    ],
    [
      'a PROJECT template with no project',
      () => {
        const d = sprint();
        d.projects = [];
        d.workspace.iterations = [];
        return d;
      },
      'KIND_MISMATCH',
      '/projects',
    ],
    [
      'a PROJECT template naming a workspace',
      () => {
        const d = sprint();
        d.workspace.name = 'Mine';
        return d;
      },
      'KIND_MISMATCH',
      '/workspace/name',
    ],
    [
      'a PROJECT template with a workspace key',
      () => {
        const d = sprint();
        d.workspace.key = 'ABC';
        return d;
      },
      'KIND_MISMATCH',
      '/workspace/key',
    ],

    // ---- placeholders
    [
      'an undeclared variable in a title',
      () => {
        const d = ws();
        d.projects[0].tasks[0].title = 'Read {{chapter}}';
        return d;
      },
      'PLACEHOLDER_INVALID',
      '/projects/0/tasks/0/title',
    ],
    [
      'an unclosed placeholder',
      () => {
        const d = ws();
        d.projects[0].tasks[0].title = 'Read {{course';
        return d;
      },
      'PLACEHOLDER_SYNTAX',
      '/projects/0/tasks/0/title',
    ],
    [
      'a nested helper call',
      () => {
        const d = ws();
        d.projects[0].tasks[0].description =
          '{{format(addDays(semesterStart, 1), "d")}}';
        return d;
      },
      'PLACEHOLDER_SYNTAX',
      '/projects/0/tasks/0/description',
    ],
    [
      'a code-looking placeholder',
      () => {
        const d = ws();
        d.projects[0].tasks[0].description =
          '{{constructor.constructor("return process")()}}';
        return d;
      },
      'PLACEHOLDER_SYNTAX',
      '/projects/0/tasks/0/description',
    ],
    [
      'an unknown helper',
      () => {
        const d = ws();
        d.projects[0].tasks[0].description = '{{eval(course)}}';
        return d;
      },
      'PLACEHOLDER_INVALID',
      '/projects/0/tasks/0/description',
    ],
    [
      'addDays on a text variable',
      () => {
        const d = ws();
        d.projects[0].tasks[0].description = '{{addDays(course, 2)}}';
        return d;
      },
      'PLACEHOLDER_INVALID',
      '/projects/0/tasks/0/description',
    ],
    [
      'a placeholder in a tag name',
      () => {
        const d = ws();
        d.workspace.tags[0].name = '{{course}}';
        return d;
      },
      'PLACEHOLDER_NOT_ALLOWED',
      '/workspace/tags/0/name',
    ],
    [
      'a placeholder in a status name',
      () => {
        const d = ws();
        d.projects[0].workflow.statuses[0].name = '{{course}}';
        return d;
      },
      'PLACEHOLDER_NOT_ALLOWED',
      '/projects/0/workflow/statuses/0/name',
    ],
    [
      'a placeholder in a custom field name',
      () => {
        const d = ws();
        d.workspace.customFields[0].name = '{{course}}';
        return d;
      },
      'PLACEHOLDER_NOT_ALLOWED',
      '/workspace/customFields/0/name',
    ],
    [
      'a placeholder in a custom TEXT value',
      () => {
        const d = cal();
        d.projects[0].tasks[0].customValues.angle = '{{brand}}';
        return d;
      },
      'PLACEHOLDER_NOT_ALLOWED',
      '/projects/0/tasks/0/customValues/angle',
    ],
    [
      'a placeholder in a role label',
      () => {
        const d = ws();
        d.roles[0].label = '{{course}}';
        return d;
      },
      'PLACEHOLDER_NOT_ALLOWED',
      '/roles/0/label',
    ],
    [
      "a placeholder in the template's own name",
      () => {
        const d = ws();
        d.meta.name = '{{course}}';
        return d;
      },
      'PLACEHOLDER_NOT_ALLOWED',
      '/meta/name',
    ],
    [
      'a placeholder in a comment, bad variable',
      () => {
        const d = ws();
        d.projects[0].tasks[1].children[1].comments[1].body = '{{who}}';
        return d;
      },
      'PLACEHOLDER_INVALID',
      /comments\/1\/body$/,
    ],
    [
      'a blank title (spaces only)',
      () => {
        const d = ws();
        d.projects[0].tasks[0].title = '   ';
        return d;
      },
      'NAME_INVALID',
      '/projects/0/tasks/0/title',
    ],
    [
      'a title with a line break',
      () => {
        const d = ws();
        d.projects[0].tasks[0].title = 'a\nb';
        return d;
      },
      'NAME_INVALID',
      '/projects/0/tasks/0/title',
    ],
    [
      'a tag name with a tab',
      () => {
        const d = ws();
        d.workspace.tags[0].name = 'a\tb';
        return d;
      },
      'NAME_INVALID',
      '/workspace/tags/0/name',
    ],

    // ---- variables and the anchor
    [
      'an anchor naming an unknown variable',
      () => {
        const d = ws();
        d.dateAnchor.variable = 'nope';
        return d;
      },
      'ANCHOR_INVALID',
      '/dateAnchor/variable',
    ],
    [
      'an anchor that is not a DATE variable',
      () => {
        const d = ws();
        d.dateAnchor.variable = 'course';
        return d;
      },
      'ANCHOR_INVALID',
      '/dateAnchor/variable',
    ],
    [
      'a DATE default that is not a date',
      () => {
        const d = ws();
        d.variables[1].default = '2026-02-30';
        return d;
      },
      'VARIABLE_INVALID',
      '/variables/1/default',
    ],
    [
      'a DATE default in the wrong format',
      () => {
        const d = ws();
        d.variables[1].default = '01/09/2026';
        return d;
      },
      'VARIABLE_INVALID',
      '/variables/1/default',
    ],
    [
      'a TEXT default that is a number',
      () => {
        const d = ws();
        d.variables[0].default = 5;
        return d;
      },
      'VARIABLE_INVALID',
      '/variables/0/default',
    ],
    [
      'a SELECT default outside its options',
      () => {
        const d = cal();
        d.variables.find((v: any) => v.key === 'mainChannel').default = 'Radio';
        return d;
      },
      'VARIABLE_INVALID',
      /default$/,
    ],
    [
      'a SELECT variable without options',
      () => {
        const d = cal();
        delete d.variables.find((v: any) => v.key === 'mainChannel').options;
        return d;
      },
      'VARIABLE_INVALID',
      /options$/,
    ],
    [
      'options on a TEXT variable',
      () => {
        const d = ws();
        d.variables[0].options = ['a'];
        return d;
      },
      'VARIABLE_INVALID',
      '/variables/0/options',
    ],
    [
      'a BOOLEAN default that is text',
      () => {
        const d = cal();
        d.variables.find((v: any) => v.key === 'weeks').default = 'four';
        return d;
      },
      'VARIABLE_INVALID',
      /default$/,
    ],

    // ---- dates
    [
      'a task starting after it is due',
      () => {
        const d = ws();
        d.projects[0].tasks[0].startOffsetDays = 10;
        d.projects[0].tasks[0].dueOffsetDays = 2;
        return d;
      },
      'DATE_RANGE',
      '/projects/0/tasks/0',
    ],
    [
      'an iteration ending before it starts',
      () => {
        const d = ws();
        d.workspace.iterations[0].startOffsetDays = 9;
        d.workspace.iterations[0].endOffsetDays = 1;
        return d;
      },
      'DATE_RANGE',
      '/workspace/iterations/0',
    ],

    // ---- workflow (ADR-0006)
    [
      'a workflow with no Done status',
      () => {
        const d = ws();
        d.projects[0].workflow.statuses =
          d.projects[0].workflow.statuses.filter(
            (s: any) => s.category !== 'DONE',
          );
        d.projects[0].workflow.transitions = [];
        d.projects[0].tasks[0].status = 'todo';
        return d;
      },
      'WORKFLOW_INVALID',
      '/projects/0/workflow/statuses',
    ],
    [
      'a workflow with no To Do status',
      () => {
        const d = ws();
        d.projects[0].workflow.statuses[0].category = 'IN_PROGRESS';
        d.projects[0].workflow.statuses[0].isDefault = false;
        return d;
      },
      'WORKFLOW_INVALID',
      '/projects/0/workflow/statuses',
    ],
    [
      'two defaults in one category',
      () => {
        const d = ws();
        d.projects[0].workflow.statuses[2].isDefault = true;
        d.projects[0].workflow.statuses[1].isDefault = true;
        return d;
      },
      'WORKFLOW_INVALID',
      '/projects/0/workflow/statuses/2/isDefault',
    ],
    [
      'excludeFromProgress outside the Done category',
      () => {
        const d = ws();
        d.projects[0].workflow.statuses[0].excludeFromProgress = true;
        return d;
      },
      'WORKFLOW_INVALID',
      '/projects/0/workflow/statuses/0/excludeFromProgress',
    ],
    [
      'a transition from a status to itself',
      () => {
        const d = ws();
        d.projects[0].workflow.transitions.push({ from: 'todo', to: 'todo' });
        return d;
      },
      'WORKFLOW_INVALID',
      '/projects/0/workflow/transitions/4',
    ],
    [
      'enforced transitions with none defined',
      () => {
        const d = ws();
        d.projects[0].workflow.transitions = [];
        d.projects[0].workflow.enforceTransitions = true;
        return d;
      },
      'WORKFLOW_INVALID',
      '/projects/0/workflow/enforceTransitions',
    ],

    // ---- custom fields and values
    [
      'a SELECT field without options',
      () => {
        const d = ws();
        delete d.workspace.customFields[0].options;
        return d;
      },
      'FIELD_INVALID',
      '/workspace/customFields/0/options',
    ],
    [
      'options on a NUMBER field',
      () => {
        const d = ws();
        d.workspace.customFields[1].options = ['a'];
        return d;
      },
      'FIELD_INVALID',
      '/workspace/customFields/1/options',
    ],
    [
      'a SELECT value outside the options',
      () => {
        const d = ws();
        d.projects[0].tasks[1].customValues['prof-review'] = 'maybe';
        return d;
      },
      'VALUE_INVALID',
      '/projects/0/tasks/1/customValues/prof-review',
    ],
    [
      'a NUMBER value that is text',
      () => {
        const d = ws();
        d.projects[0].tasks[2].customValues['exam-weight'] = '30';
        return d;
      },
      'VALUE_INVALID',
      '/projects/0/tasks/2/customValues/exam-weight',
    ],
    [
      'a MULTI_SELECT value with a repeat',
      () => {
        const d = cal();
        d.projects[0].tasks[0].customValues.channels = ['Blog', 'Blog'];
        return d;
      },
      'VALUE_INVALID',
      /channels$/,
    ],
    [
      'a MULTI_SELECT value outside the options',
      () => {
        const d = cal();
        d.projects[0].tasks[0].customValues.channels = ['Radio'];
        return d;
      },
      'VALUE_INVALID',
      /channels$/,
    ],
    [
      'a CHECKBOX value that is text',
      () => {
        const d = cal();
        d.projects[0].tasks[0].customValues.approved = 'yes';
        return d;
      },
      'VALUE_INVALID',
      /approved$/,
    ],
    [
      'a DATE value written as an absolute date',
      () => {
        const d = cal();
        d.projects[0].tasks[0].customValues['go-live'] = '2026-10-09';
        return d;
      },
      'VALUE_INVALID',
      /go-live$/,
    ],
    [
      'a DATE value with extra keys',
      () => {
        const d = cal();
        d.projects[0].tasks[0].customValues['go-live'] = {
          offsetDays: 1,
          tz: 'UTC',
        };
        return d;
      },
      'VALUE_INVALID',
      /go-live$/,
    ],
    [
      'a DATE value with a fractional offset',
      () => {
        const d = cal();
        d.projects[0].tasks[0].customValues['go-live'] = { offsetDays: 0.5 };
        return d;
      },
      'VALUE_INVALID',
      /go-live$/,
    ],
    [
      'a USER value (a person cannot be in a template)',
      () => {
        const d = cal();
        d.projects[0].tasks[0].customValues.reviewer = 'user_123';
        return d;
      },
      'VALUE_INVALID',
      /reviewer$/,
    ],
    [
      'an http URL',
      () => {
        const d = cal();
        d.projects[0].tasks[0].customValues.brief = 'http://example.com/x';
        return d;
      },
      'VALUE_INVALID',
      /brief$/,
    ],
    [
      'a javascript: URL',
      () => {
        const d = cal();
        d.projects[0].tasks[0].customValues.brief = 'javascript:alert(1)';
        return d;
      },
      'VALUE_INVALID',
      /brief$/,
    ],
    [
      'a data: URL',
      () => {
        const d = cal();
        d.projects[0].tasks[0].customValues.brief =
          'data:text/html,<script>1</script>';
        return d;
      },
      'VALUE_INVALID',
      /brief$/,
    ],
    [
      'a URL with credentials',
      () => {
        const d = cal();
        d.projects[0].tasks[0].customValues.brief =
          'https://user:pass@example.com/';
        return d;
      },
      'VALUE_INVALID',
      /brief$/,
    ],
    [
      'text that is not a URL',
      () => {
        const d = cal();
        d.projects[0].tasks[0].customValues.brief = 'not a url';
        return d;
      },
      'VALUE_INVALID',
      /brief$/,
    ],

    // ---- dependencies
    [
      'a task depending on itself',
      () => {
        const d = ws();
        d.projects[0].dependencies.push({ from: 'essay', to: 'essay' });
        return d;
      },
      'DEPENDENCY_INVALID',
      '/projects/0/dependencies/3',
    ],
    [
      'a dependency on an unknown task',
      () => {
        const d = ws();
        d.projects[0].dependencies.push({ from: 'essay', to: 'ghost' });
        return d;
      },
      'UNKNOWN_REF',
      '/projects/0/dependencies/3/to',
    ],
    [
      'a dependency on a project, not a task',
      () => {
        const d = ws();
        d.projects[0].dependencies.push({ from: 'essay', to: 'labs' });
        return d;
      },
      'UNKNOWN_REF',
      '/projects/0/dependencies/3/to',
    ],
    [
      'a dependency listed twice',
      () => {
        const d = ws();
        d.projects[0].dependencies.push({
          from: 'essay-outline',
          to: 'essay-draft',
        });
        return d;
      },
      'DUPLICATE',
      '/projects/0/dependencies/3',
    ],
    [
      'a dependency across projects',
      () => {
        const d = ws();
        d.projects[0].dependencies.push({ from: 'essay', to: 'lab-1' });
        return d;
      },
      'DEPENDENCY_INVALID',
      '/projects/0/dependencies/3/to',
    ],
    [
      'two tasks blocking each other',
      () => {
        const d = ws();
        d.projects[0].dependencies.push({
          from: 'essay-draft',
          to: 'essay-outline',
        });
        return d;
      },
      'DEPENDENCY_CYCLE',
      '/projects/0/dependencies',
    ],
    [
      'a longer cycle',
      () => {
        const d = ws();
        d.projects[0].dependencies = [
          { from: 'essay', to: 'midterm' },
          { from: 'midterm', to: 'final-exam' },
          { from: 'final-exam', to: 'essay' },
        ];
        return d;
      },
      'DEPENDENCY_CYCLE',
      '/projects/0/dependencies',
    ],
    [
      'a relation stored in both directions',
      () => {
        const d = ws();
        d.projects[0].dependencies.push({
          from: 'final-exam',
          to: 'midterm',
          type: 'RELATES_TO',
        });
        return d;
      },
      'DEPENDENCY_INVALID',
      '/projects/0/dependencies/3',
    ],

    // ---- nesting, assets, opaque
    [
      'subtasks four levels deep',
      () => {
        const d = ws();
        d.projects[0].tasks[2].children[1].children[0].children = [
          { nodeKey: 'too-deep', title: 'x' },
        ];
        return d;
      },
      'TASK_TOO_DEEP',
      '/projects/0/tasks/2/children/1/children/0/children',
    ],
    [
      'an asset file name with a path',
      () => {
        const d = ws();
        d.assets[0].fileName = '../../etc/passwd';
        return d;
      },
      'ASSET_INVALID',
      '/assets/0/fileName',
    ],
    [
      'an asset file name that is ..',
      () => {
        const d = ws();
        d.assets[0].fileName = '..';
        return d;
      },
      'ASSET_INVALID',
      '/assets/0/fileName',
    ],
    [
      'assets over the total cap',
      () => {
        const d = ws();
        d.assets = Array.from({ length: 6 }, (_, i) => ({
          key: `a${i}`,
          fileName: `f${i}.bin`,
          mimeType: 'application/octet-stream',
          sizeBytes: L.maxAssetBytes,
          sha256: '0'.repeat(64),
        }));
        d.projects[0].tasks[1].attachments = ['a0'];
        return d;
      },
      'ASSETS_TOO_LARGE',
      '/assets',
    ],
    [
      'an automation over its size cap',
      () => {
        const d = sprint();
        d.projects[0].automations = [
          { blob: 'x'.repeat(L.maxOpaqueItemBytes) },
        ];
        return d;
      },
      'OPAQUE_TOO_LARGE',
      '/projects/0/automations/0',
    ],
  ];

  it.each(cases)('rejects: %s', (_name, make, code, at) => {
    expectRejected(make(), code, at);
  });

  it('the corpus covers every issue code a document can fail with', () => {
    const covered = new Set(cases.map((c) => c[2]));
    const reachableByThisTable: BlueprintIssueCode[] = [
      'DUPLICATE',
      'UNKNOWN_REF',
      'KIND_MISMATCH',
      'PLACEHOLDER_SYNTAX',
      'PLACEHOLDER_INVALID',
      'PLACEHOLDER_NOT_ALLOWED',
      'VARIABLE_INVALID',
      'ANCHOR_INVALID',
      'WORKFLOW_INVALID',
      'FIELD_INVALID',
      'VALUE_INVALID',
      'DATE_RANGE',
      'ITERATION_SCOPE',
      'DEPENDENCY_INVALID',
      'DEPENDENCY_CYCLE',
      'MODULE_INVALID',
      'ASSET_INVALID',
      'NAME_INVALID',
      'TASK_TOO_DEEP',
      'ASSETS_TOO_LARGE',
      'OPAQUE_TOO_LARGE',
    ];
    for (const code of reachableByThisTable) expect(covered).toContain(code);
  });

  it('warnings never block: unused variables, roles and assets are reported', () => {
    const d = ws();
    d.variables.push({ key: 'spare', label: 'Spare', type: 'TEXT' });
    d.roles.push({ key: 'dean', label: 'Dean' });
    d.assets.push({
      key: 'extra',
      fileName: 'x.txt',
      mimeType: 'text/plain',
      sizeBytes: 1,
      sha256: 'b'.repeat(64),
    });
    const r = validateBlueprint(d);
    if (r.ok === false) throw new Error(JSON.stringify(r.issues));
    expect(r.warnings.map((w) => w.code).sort()).toEqual([
      'UNUSED_ASSET',
      'UNUSED_ROLE',
      'UNUSED_VARIABLE',
    ]);
  });

  it('a relation listed once is fine, and a diamond of BLOCKS is not a cycle', () => {
    const d = ws();
    d.projects[0].dependencies = [
      { from: 'essay', to: 'midterm' },
      { from: 'essay', to: 'final-exam' },
      { from: 'midterm', to: 'final-exam' },
      { from: 'read-ch1', to: 'final-exam', type: 'RELATES_TO' },
    ];
    expect(validateBlueprint(d).ok).toBe(true);
  });

  it('an escaped brace is literal text, valid anywhere a template is', () => {
    const d = ws();
    d.projects[0].tasks[0].description = 'Write \\{{like this}} in the notes';
    expect(validateBlueprint(d).ok).toBe(true);
  });

  it('plain fields may contain braces that are not placeholders', () => {
    const d = ws();
    d.workspace.tags.push({ name: 'set {a, b}' });
    expect(validateBlueprint(d).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
describe('limits and hostile input', () => {
  const minimal = (): any => ({
    schemaVersion: 1,
    meta: { name: 'x', kind: 'WORKSPACE' },
    projects: [{ nodeKey: 'p', name: 'p', tasks: [] }],
  });

  it('parseBlueprintJson refuses oversize text BEFORE parsing it', () => {
    const r = parseBlueprintJson('x'.repeat(L.maxBytes + 1)); // not JSON at all
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.issues[0].code).toBe('TOO_LARGE');
  });

  it('an object that is too large is refused too (it may not have come from text)', () => {
    const d = minimal();
    d.projects[0].tasks = Array.from({ length: 260 }, (_, i) => ({
      nodeKey: `t${i}`,
      title: 'x',
      description: 'y'.repeat(9000),
    }));
    expectRejected(d, 'TOO_LARGE', '');
  });

  it('the size limit is in BYTES, not characters', () => {
    const d = minimal();
    d.meta.description = '漢'.repeat(L.metaDescription); // 3 bytes each, still within the field limit
    expect(validateBlueprint(d).ok).toBe(true);
    const big = minimal();
    big.projects[0].tasks = Array.from({ length: 70 }, (_, i) => ({
      nodeKey: `t${i}`,
      title: 'x',
      description: '漢'.repeat(9999),
    }));
    expectRejected(big, 'TOO_LARGE', '');
  });

  it('syntax errors and BOMs', () => {
    expect(parseBlueprintJson('{not json')).toMatchObject({
      ok: false,
      issues: [{ code: 'JSON_SYNTAX' }],
    });
    expect(parseBlueprintJson('')).toMatchObject({
      ok: false,
      issues: [{ code: 'JSON_SYNTAX' }],
    });
    expect(parseBlueprintJson(`\uFEFF${JSON.stringify(minimal())}`).ok).toBe(
      true,
    );
    expect(parseBlueprintJson(undefined as never)).toMatchObject({
      ok: false,
      issues: [{ code: 'NOT_JSON' }],
    });
  });

  it('the node limit counts projects + tasks (every level) + iterations', () => {
    const half = Math.floor(L.maxNodes / 2) + 1;
    const d = minimal();
    d.projects = [0, 1].map((p) => ({
      nodeKey: `p${p}`,
      name: 'p',
      tasks: Array.from({ length: half }, (_, i) => ({
        nodeKey: `p${p}t${i}`,
        title: 't',
      })),
    }));
    expectRejected(d, 'TOO_MANY_NODES', '');

    const atLimit = minimal();
    atLimit.projects[0].tasks = Array.from(
      { length: L.maxNodes - 1 },
      (_, i) => ({ nodeKey: `t${i}`, title: 't' }),
    );
    expect(validateBlueprint(atLimit).ok).toBe(true); // 1 project + 4999 tasks = 5000
    atLimit.projects[0].tasks.push({ nodeKey: 'one-more', title: 't' });
    expectRejected(atLimit, 'TOO_MANY_NODES', '');

    const kids = minimal();
    kids.projects[0].tasks = Array.from({ length: 2000 }, (_, i) => ({
      nodeKey: `a${i}`,
      title: 't',
      children: [
        {
          nodeKey: `b${i}`,
          title: 't',
          children: [{ nodeKey: `c${i}`, title: 't' }],
        },
      ],
    }));
    expectRejected(kids, 'TOO_MANY_NODES', ''); // 6000 tasks in a 2000-root tree
  });

  it('JSON nesting is capped, and a 200 000-level document does not blow the stack', () => {
    let deep: any = 1;
    for (let i = 0; i < 200_000; i++) deep = [deep];
    const d = minimal();
    d.extensions = { 'acme.x': deep };
    expectRejected(d, 'TOO_DEEP');

    let just: any = 1;
    for (let i = 0; i < 10; i++) just = { k: just };
    const ok = minimal();
    ok.extensions = { 'acme.x': just };
    expect(validateBlueprint(ok).ok).toBe(true);
  });

  it('the deepest legal document fits under the JSON depth cap', () => {
    const d = minimal();
    d.workspace = {
      customFields: [
        { key: 'm', name: 'm', dataType: 'MULTI_SELECT', options: ['a'] },
      ],
    };
    d.projects[0].tasks = [
      {
        nodeKey: 'l1',
        title: 'x',
        children: [
          {
            nodeKey: 'l2',
            title: 'x',
            children: [
              {
                nodeKey: 'l3',
                title: 'x',
                customValues: { m: ['a'] },
                comments: [{ body: 'x' }],
              },
            ],
          },
        ],
      },
    ];
    const r = validateBlueprint(d);
    expect(r.ok).toBe(true);
    // root(0) projects(1) project(2) tasks(3) task(4) children(5) task(6) children(7) task(8) comments(9) comment(10)
    expect(10).toBeLessThan(L.maxJsonDepth);
  });

  it('a cyclic object graph is refused, not looped on', () => {
    const d: any = minimal();
    d.extensions = { 'acme.x': {} };
    d.extensions['acme.x'].self = d.extensions;
    expectRejected(d, 'TOO_DEEP');
  });

  it('only JSON values are accepted', () => {
    for (const bad of [
      undefined,
      NaN,
      Infinity,
      10n,
      () => 1,
      new Date(),
      new Map(),
      Symbol('x'),
    ]) {
      const d = minimal();
      d.extensions = { 'acme.x': { v: bad } };
      expectRejected(d, 'NOT_JSON');
    }
    const holes = minimal();
    holes.extensions = { 'acme.x': new Array(3) };
    expectRejected(holes, 'NOT_JSON');
  });

  it('text with NUL, control characters or lone surrogates is refused (Postgres would 500)', () => {
    for (const text of [
      'a\u0000b',
      'a\u0001b',
      'a\u007fb',
      'a\u0085b',
      'a\ud800b',
      'a\udc00b',
    ]) {
      const d = minimal();
      d.projects[0].tasks = [{ nodeKey: 't', title: text }];
      expectRejected(d, 'BAD_TEXT', '/projects/0/tasks/0/title');
    }
    const key = minimal();
    key.extensions = { 'acme.x': { 'bad\u0000key': 1 } };
    expectRejected(key, 'BAD_TEXT');
    // tab, newline, CR, emoji (a valid surrogate pair) are fine
    const fine = minimal();
    fine.projects[0].tasks = [
      { nodeKey: 't', title: 'ok', description: 'a\tb\nc\r\nd 😀' },
    ];
    expect(validateBlueprint(fine).ok).toBe(true);
  });

  it('caps how many issues it reports, and says so', () => {
    const d = minimal();
    for (let i = 0; i < 500; i++) d[`junk${i}`] = i;
    const r = validateBlueprint(d);
    expect(r.ok).toBe(false);
    if (r.ok === false) {
      expect(r.issues).toHaveLength(L.maxIssues);
      expect(r.truncated).toBe(true);
    }
  });

  it('strictness is real: no coercion, no defaults, nothing removed', () => {
    const d = minimal();
    d.projects[0].tasks = [{ nodeKey: 't', title: 'x', estimate: '5' }];
    expectRejected(d, 'SCHEMA', '/projects/0/tasks/0/estimate');
    const e = minimal();
    e.extra = 1;
    expectRejected(e, 'UNKNOWN_FIELD', '/extra');
  });

  it('is fast on a maximal legal document', () => {
    const d = minimal();
    d.projects[0].tasks = Array.from({ length: L.maxNodes - 1 }, (_, i) => ({
      nodeKey: `t${i}`,
      title: `Task ${i} {{x}}`,
      description: 'text '.repeat(20),
    }));
    d.variables = [{ key: 'x', label: 'x', type: 'TEXT' }];
    const t0 = Date.now();
    const r = validateBlueprint(d);
    expect(r.ok).toBe(true);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
