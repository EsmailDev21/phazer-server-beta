import { ActionExecutor, ActionRun } from './action-executor.service';
import { checkRuleSemantics, validateRule } from './dsl';
import { TREE_LIMIT_ENV } from './dsl/rule.settings';

/** Step 5.13: captured variables (`as`), `{{name.prop}}` and WITH. */

const saved: Record<string, string | undefined> = {};
beforeEach(() =>
  Object.values(TREE_LIMIT_ENV).forEach((k) => {
    saved[k] = process.env[k];
    delete process.env[k];
  }),
);
afterEach(() =>
  Object.values(TREE_LIMIT_ENV).forEach((k) =>
    saved[k] === undefined
      ? delete process.env[k]
      : (process.env[k] = saved[k]),
  ),
);

const tag = (id = 't1') => ({ type: 'ADD_TAG', tagId: id });
const make = (as?: string, extra: object = {}) => ({
  type: 'CREATE_TASK',
  title: 'Follow up',
  ...(as ? { as } : {}),
  ...extra,
});
const sub = (as?: string) => ({
  type: 'CREATE_SUBTASK',
  title: 's',
  ...(as ? { as } : {}),
});
const say = (body: string) => ({ type: 'COMMENT', body });
const WITH = (task: string, body: unknown[] = [tag()]) => ({
  type: 'WITH',
  task,
  do: body,
});
const IF = (then: unknown[], other?: unknown[]) => ({
  type: 'IF',
  conditions: { all: [{ field: 'PRIORITY', op: 'IN', value: ['HIGH'] }] },
  then,
  ...(other ? { else: other } : {}),
});
const EACH = (body: unknown[]) => ({
  type: 'FOR_EACH',
  over: 'SUBTASKS',
  do: body,
});
// STATUS_CHANGED: a CREATE_SUBTASK is not a re-trigger risk there
const rule = (
  actions: unknown[],
  trigger: unknown = { type: 'STATUS_CHANGED' },
) => ({ trigger, actions });
const SCHEDULE = { type: 'SCHEDULE', frequency: 'DAILY', hour: 1 };
const issues = (input: unknown) => {
  const v = validateRule(input) as {
    ok: boolean;
    issues?: Array<{ code: string; path: string }>;
  };
  return v.ok ? [] : v.issues!.map((i) => `${i.code}@${i.path}`);
};
const ok = (input: unknown) => {
  const v = validateRule(input);
  if (v.ok === false) throw new Error(JSON.stringify(v.issues));
  return v.rule;
};

describe('capturing with `as`', () => {
  it('is allowed on CREATE_TASK and CREATE_SUBTASK and nowhere else', () => {
    expect(validateRule(rule([make('followUp')])).ok).toBe(true);
    expect(validateRule(rule([sub('child')])).ok).toBe(true);
    expect(validateRule(rule([{ ...tag(), as: 'x' }])).ok).toBe(false);
  });

  it.each(['Follow', '1a', 'a b', 'a-b', 'a.b', '', 'x'.repeat(31)])(
    'refuses the name %j',
    (name) => {
      // set `as` directly: the `make` helper leaves out an empty name
      expect(validateRule(rule([{ ...make(), as: name }])).ok).toBe(false);
    },
  );
  it.each(['task', 'trigger', 'actor', 'date', 'item'])(
    'refuses the reserved name %s',
    (name) => {
      expect(issues(rule([make(name)]))).toEqual([
        'RESERVED_NAME@/actions/0/as',
      ]);
    },
  );
  it.each(['a', 'followUp', 'x1', 'a'.repeat(30)])(
    'accepts the name %j',
    (name) => {
      expect(validateRule(rule([make(name)])).ok).toBe(true);
    },
  );
});

describe('using a variable in text', () => {
  it('works in any later action of the same list, for every property', () => {
    for (const prop of [
      'id',
      'key',
      'title',
      'status',
      'priority',
      'project',
      'assignees',
      'dueDate',
    ])
      expect(validateRule(rule([make('f'), say(`{{f.${prop}}}`)])).ok).toBe(
        true,
      );
  });

  it('also in a CREATE_TASK title, a description and a subtask title', () => {
    expect(
      validateRule(
        rule([
          make('f'),
          make('g', {
            title: 'After {{f.key}}',
            description: 'See {{f.title}}',
          }),
          { type: 'CREATE_SUBTASK', title: 'Prep {{g.key}}' },
        ]),
      ).ok,
    ).toBe(true);
  });

  it('is refused before it is captured, and in the action that captures it', () => {
    expect(issues(rule([say('{{f.title}}'), make('f')]))).toEqual([
      'UNKNOWN_VARIABLE@/actions/0/body',
    ]);
    expect(issues(rule([make('f', { title: 'Re {{f.title}}' })]))).toEqual([
      'UNKNOWN_VARIABLE@/actions/0/title',
    ]);
  });

  it('is refused for a property it does not have, naming the ones it has', () => {
    const v = validateRule(rule([make('f'), say('{{f.nope}}')])) as {
      issues: Array<{ message: string }>;
    };
    expect(v.issues[0].message).toMatch(/no "nope".*id, key, title/);
  });

  it('keeps refusing unknown built-in placeholders', () => {
    expect(validateRule(rule([say('{{nope}}')])).ok).toBe(false);
    expect(validateRule(rule([say('{{task.nope}}')])).ok).toBe(false);
    expect(validateRule(rule([say('{{Bad.title}}')])).ok).toBe(false);
  });

  it('is visible inside what follows it: a branch, a loop, a WITH', () => {
    expect(
      validateRule(
        rule([
          make('f'),
          IF([say('{{f.key}}')], [say('{{f.title}}')]),
          EACH([say('{{f.key}}')]),
          WITH('f', [say('{{f.key}}')]),
        ]),
      ).ok,
    ).toBe(true);
  });

  it('does NOT leave the branch, loop or WITH it was captured in', () => {
    expect(issues(rule([IF([make('f')]), say('{{f.title}}')]))).toEqual([
      'UNKNOWN_VARIABLE@/actions/1/body',
    ]);
    expect(issues(rule([EACH([make('f')]), say('{{f.title}}')]))).toEqual([
      'UNKNOWN_VARIABLE@/actions/1/body',
    ]);
    // a name captured in the `then` is not there in the `else`
    expect(issues(rule([IF([make('f')], [say('{{f.title}}')])]))).toEqual([
      'UNKNOWN_VARIABLE@/actions/0/else/0/body',
    ]);
    // ... but can be used right after it, inside the same branch
    expect(validateRule(rule([IF([make('f'), say('{{f.title}}')])])).ok).toBe(
      true,
    );
  });

  it('can be captured once per scope; the same name in two branches is fine', () => {
    expect(issues(rule([make('f'), make('f')]))).toEqual([
      'VARIABLE_EXISTS@/actions/1/as',
    ]);
    expect(issues(rule([make('f'), IF([make('f')])]))).toEqual([
      'VARIABLE_EXISTS@/actions/1/then/0/as',
    ]);
    expect(validateRule(rule([IF([make('f')], [make('f')])])).ok).toBe(true);
  });
});

describe('WITH', () => {
  it('validates after a capture, and needs one', () => {
    expect(validateRule(rule([make('f'), WITH('f')])).ok).toBe(true);
    expect(issues(rule([WITH('f')]))).toEqual([
      'UNKNOWN_VARIABLE@/actions/0/task',
    ]);
    expect(issues(rule([IF([make('f')]), WITH('f')]))).toEqual([
      'UNKNOWN_VARIABLE@/actions/1/task',
    ]);
  });

  it('needs a non-empty do, a valid name, and no stray keys', () => {
    expect(validateRule(rule([make('f'), WITH('f', [])])).ok).toBe(false);
    expect(validateRule(rule([make('f'), WITH('F')])).ok).toBe(false);
    expect(validateRule(rule([make('f'), { ...WITH('f'), extra: 1 }])).ok).toBe(
      false,
    );
  });

  it('shares the nesting depth with IF and FOR_EACH', () => {
    expect(validateRule(rule([make('f'), IF([IF([WITH('f')])])])).ok).toBe(
      true,
    );
    expect(issues(rule([make('f'), IF([IF([IF([WITH('f')])])])]))).toEqual([
      'IF_TOO_DEEP@/actions/1/then/0/then/0/then/0',
    ]);
  });

  it('works in a SCHEDULE rule (no task): create, then act on it', () => {
    expect(
      validateRule(
        rule(
          [
            make('review', { title: 'Weekly {{date}}' }),
            WITH('review', [tag(), say('Created {{review.key}}')]),
          ],
          SCHEDULE,
        ),
      ).ok,
    ).toBe(true);
    // but a plain task action beside it is still refused
    expect(issues(rule([make('review'), tag()], SCHEDULE))).toEqual([
      'ACTION_NEEDS_TASK@/actions/1/type',
    ]);
  });

  it('still refuses creating what triggers the rule, from inside a WITH', () => {
    const r = ok(
      rule([make('f'), WITH('f', [sub()])], { type: 'TASK_CREATED' }),
    );
    const found = checkRuleSemantics(r, 'p1', {
      projectIds: new Set(['p1']),
      statuses: new Map(),
      tagIds: new Set(),
      issueTypeIds: new Set(),
      iterationIds: new Set(),
      customFields: new Map(),
      validUserIds: new Set(),
    });
    expect(found.map((i) => `${i.code}@${i.path}`)).toEqual([
      'UNBOUNDED_RECURSION@/actions/0', // the CREATE_TASK itself
      'UNBOUNDED_RECURSION@/actions/1/do/0', // and the subtask hidden inside the WITH
    ]);
  });
});

// ------------------------------------------------------------------ executing ------------------
const RUN: ActionRun = {
  ruleId: 'r1',
  writeDepth: 1,
  workspaceId: 'w1',
  projectId: 'p1',
  taskId: 'event',
  createdById: 'c1',
  triggererId: 'u1',
  actorId: 'sys',
  vars: { 'task.title': 'Original', 'actor.name': 'Ann', date: '2026-10-26' },
};

function harness(
  opts: { goneAfterCreate?: boolean; children?: string[] } = {},
) {
  const log: string[] = [];
  const created: Record<string, { title: string; assignees: string[] }> = {};
  let n = 0;
  const prisma = {
    task: {
      findUnique: async (q: {
        where: { id: string };
        select: Record<string, unknown>;
      }) => {
        if (q.select.workspace) {
          const t = created[q.where.id];
          if (!t) return null;
          return {
            number: 7,
            title: t.title,
            status: 'TODO',
            priority: 'HIGH',
            dueDate: new Date('2026-11-03T10:00:00Z'),
            workspace: { key: 'ABC' },
            workflowStatus: { name: 'Backlog' },
            project: { name: 'Website' },
            assignees: t.assignees.map((name) => ({ name })),
          };
        }
        return { parentId: null };
      },
    },
  };
  const domainWriter = {
    createTask: async (dto: { title: string; parentId?: string }) => {
      const id = `new${++n}`;
      created[id] = { title: dto.title, assignees: [] };
      log.push(
        `create:${id}:${dto.title}${dto.parentId ? `:parent=${dto.parentId}` : ''}`,
      );
      return { id };
    },
  };
  const tasks = {
    setAssignees: async (id: string, dto: { userIds: string[] }) => {
      created[id].assignees = dto.userIds.map((u) =>
        u === 'u1' ? 'Ann Lee' : u,
      );
      log.push(`assign:${id}:${dto.userIds.join(',')}`);
    },
  };
  const tags = {
    attach: async (id: string, tagId: string) =>
      void log.push(`attach:${id}:${tagId}`),
  };
  const comments = {
    createSystemComment: async (
      _k: unknown,
      id: string,
      _a: string,
      body: string,
    ) => void log.push(`comment:${id}:${body}`),
  };
  const taskQuery = {
    run: async (input: { structural?: { id?: string; parentId?: string } }) => {
      if (input.structural?.parentId)
        return {
          items: (opts.children ?? []).map((cid, k) => ({
            id: cid,
            key: `ABC-${cid}`,
            statusName: 'Backlog',
            createdById: 'sys',
            title: `Child ${k + 1}`,
            projectId: 'p1',
            parentId: input.structural!.parentId!,
            status: 'TODO',
            workflowStatusId: null,
            priority: null,
            dueDate: null,
          })),
          nextCursor: null,
          scanned: 0,
          capped: false,
        };
      const id = input.structural?.id;
      if (opts.goneAfterCreate || !id || !created[id])
        return { items: [], nextCursor: null, scanned: 0, capped: false };
      return {
        items: [
          {
            id,
            key: `ABC-${id}`,
            statusName: 'Backlog',
            createdById: 'sys',
            title: created[id].title,
            projectId: 'p1',
            parentId: null,
            status: 'TODO',
            workflowStatusId: null,
            priority: 'HIGH',
            dueDate: null,
          },
        ],
        nextCursor: null,
        scanned: 1,
        capped: false,
      };
    },
  };
  const ex = new ActionExecutor(
    prisma as never,
    tasks as never,
    tags as never,
    {} as never,
    comments as never,
    domainWriter as never,
    taskQuery as never,
    {} as never, // the notifier
  );
  return { ex, log };
}

describe('executing captures', () => {
  it('fills {{name.prop}} from the task that was created, for every property', async () => {
    const h = harness();
    const r = await h.ex.execute(
      ok(
        rule([
          make('f', { assignees: ['u1'] }),
          say(
            '{{f.id}}|{{f.key}}|{{f.title}}|{{f.status}}|{{f.priority}}|{{f.project}}|{{f.assignees}}|{{f.dueDate}}',
          ),
        ]),
      ).actions,
      RUN,
    );
    expect(r).toEqual({ done: 2 });
    expect(h.log).toContain(
      'comment:event:new1|ABC-7|Follow up|Backlog|HIGH|Website|Ann Lee|2026-11-03',
    );
  });

  it('WITH acts on the captured task: every action inside works on IT', async () => {
    const h = harness();
    await h.ex.execute(
      ok(
        rule([
          make('f'),
          WITH('f', [tag('urgent'), say('hello {{task.title}}'), sub()]),
          say('back on the original: {{task.title}}'),
        ]),
      ).actions,
      RUN,
    );
    expect(h.log).toEqual([
      'create:new1:Follow up',
      'attach:new1:urgent',
      'comment:new1:hello Follow up',
      'create:new2:s:parent=new1',
      'comment:event:back on the original: Original',
    ]);
  });

  it('a capture of a subtask works the same way', async () => {
    const h = harness();
    await h.ex.execute(
      ok(rule([sub('child'), WITH('child', [tag()])])).actions,
      RUN,
    );
    expect(h.log).toEqual(['create:new1:s:parent=event', 'attach:new1:t1']);
  });

  it('does not look the task up at all when nothing captures it', async () => {
    const h = harness();
    const r = await h.ex.execute(ok(rule([make()])).actions, RUN);
    expect(r).toEqual({ done: 1 });
  });

  it('two captures in one run do not interfere', async () => {
    const h = harness();
    await h.ex.execute(
      ok(
        rule([
          make('a'),
          make('b', { title: 'Second' }),
          say('{{a.title}} / {{b.title}}'),
        ]),
      ).actions,
      RUN,
    );
    expect(h.log.at(-1)).toBe('comment:event:Follow up / Second');
  });

  it('WITH fails clearly when the captured task is gone, naming it', async () => {
    const h = harness({ goneAfterCreate: true });
    const r = await h.ex.execute(ok(rule([make('f'), WITH('f')])).actions, RUN);
    expect(r).toMatchObject({
      done: 1,
      failedAt: 1,
      failedPath: '/actions/1',
      error: 'The task "f" no longer exists',
    });
  });

  it('a failure inside WITH is reported at the inner pointer, against the captured task', async () => {
    const h = harness();
    const r = await h.ex.execute(
      ok(
        rule([
          make('f'),
          WITH('f', [tag(), { type: 'SET_PRIORITY', priority: null }]),
        ]),
      ).actions,
      RUN,
    );
    expect(r).toMatchObject({
      done: 2,
      failedAt: 1,
      failedPath: '/actions/1/do/1',
      failedItem: { index: 0, taskId: 'new1' },
      failedItems: [{ path: '/actions/1', index: 0, taskId: 'new1' }],
    });
  });

  it('works in a run with no task (a SCHEDULE rule): create, then act on it', async () => {
    const h = harness();
    const r = await h.ex.execute(
      ok(
        rule(
          [
            make('review', { title: 'Weekly {{date}}' }),
            WITH('review', [tag('weekly'), say('{{review.key}} is ready')]),
          ],
          SCHEDULE,
        ),
      ).actions,
      { ...RUN, taskId: null, vars: { date: '2026-10-26' } },
    );
    expect(r).toEqual({ done: 3 });
    expect(h.log).toEqual([
      'create:new1:Weekly 2026-10-26',
      'attach:new1:weekly',
      'comment:new1:ABC-7 is ready',
    ]);
  });

  it('a WITH inside a loop: a failure names the loop task AND the captured task, outermost first', async () => {
    const h = harness({ children: ['c1', 'c2'] });
    const r = await h.ex.execute(
      ok(
        rule([
          EACH([
            make('f'),
            WITH('f', [tag(), { type: 'SET_PRIORITY', priority: null }]),
          ]),
        ]),
      ).actions,
      RUN,
    );
    expect(r).toMatchObject({
      failedPath: '/actions/0/do/1/do/1',
      failedItem: { taskId: 'new1' },
      failedItems: [
        { path: '/actions/0', index: 0, taskId: 'c1' },
        { path: '/actions/0/do/1', index: 0, taskId: 'new1' },
      ],
    });
  });

  it('a capture inside a loop body is fresh for every task (the name is free again)', async () => {
    const h = harness({ children: ['c1', 'c2'] });
    const r = await h.ex.execute(
      ok(
        rule([
          EACH([
            make('f', { title: 'For {{task.title}}' }),
            say('{{f.title}}'),
          ]),
        ]),
      ).actions,
      RUN,
    );
    expect(r).toEqual({ done: 4 });
    expect(h.log.filter((l) => l.startsWith('comment:'))).toEqual([
      'comment:c1:For Child 1',
      'comment:c2:For Child 2',
    ]);
  });

  it('a loop inside a WITH: a failure names the captured task, then the loop task, outermost first', async () => {
    const h = harness({ children: ['c1'] });
    const r = await h.ex.execute(
      ok(
        rule([
          make('f'),
          WITH('f', [EACH([{ type: 'SET_PRIORITY', priority: null }])]),
        ]),
      ).actions,
      RUN,
    );
    expect(r).toMatchObject({
      failedPath: '/actions/1/do/0/do/0',
      failedItem: { taskId: 'c1' },
      failedItems: [
        { path: '/actions/1', index: 0, taskId: 'new1' },
        { path: '/actions/1/do/0', index: 0, taskId: 'c1' },
      ],
    });
  });
});
