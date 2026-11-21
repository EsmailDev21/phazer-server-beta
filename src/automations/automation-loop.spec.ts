import { FieldType, TaskStatus } from '@prisma/client';
import { RefWalker } from '../templates/portable/portable.refs';
import { ActionExecutor, ActionRun } from './action-executor.service';
import {
  WorkspaceRuleContext,
  checkRuleSemantics,
  collectReferences,
  validateRule,
} from './dsl';
import { TREE_LIMIT_ENV } from './dsl/rule.settings';

/** Step 5.12: FOR_EACH. */

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
const open = {
  all: [{ field: 'STATUS_CATEGORY', op: 'NOT_IN', value: ['DONE'] }],
};
const EACH = (over: string, body: unknown[] = [tag()], extra: object = {}) => ({
  type: 'FOR_EACH',
  over,
  do: body,
  ...extra,
});
const IF = (then: unknown[]) => ({
  type: 'IF',
  conditions: { all: [{ field: 'PRIORITY', op: 'IN', value: ['HIGH'] }] },
  then,
});
const rule = (
  actions: unknown[],
  trigger: unknown = { type: 'STATUS_CHANGED' },
) => ({
  trigger,
  actions,
});
const SCHEDULE = { type: 'SCHEDULE', frequency: 'DAILY', hour: 1 };
const ok = (input: unknown) => {
  const v = validateRule(input);
  if (v.ok === false) throw new Error(JSON.stringify(v.issues));
  return v.rule;
};
const issues = (input: unknown) => {
  const v = validateRule(input) as {
    ok: boolean;
    issues?: Array<{ code: string; path: string }>;
  };
  return v.ok ? [] : v.issues!.map((i) => `${i.code}@${i.path}`);
};

describe('validating a FOR_EACH', () => {
  it.each(['SUBTASKS', 'SIBLINGS', 'PARENT', 'QUERY'])(
    'accepts over %s',
    (over) => {
      expect(validateRule(rule([EACH(over)])).ok).toBe(true);
    },
  );

  it('accepts where, scope (QUERY only) and onError', () => {
    expect(
      validateRule(
        rule([
          EACH('QUERY', [tag()], {
            where: open,
            scope: 'WORKSPACE',
            onError: 'CONTINUE',
          }),
        ]),
      ).ok,
    ).toBe(true);
  });

  it('refuses an empty do, an unknown selector, a bad onError, a scope on a relative selector', () => {
    expect(validateRule(rule([EACH('SUBTASKS', [])])).ok).toBe(false);
    expect(validateRule(rule([EACH('EVERYTHING')])).ok).toBe(false);
    expect(
      validateRule(rule([EACH('SUBTASKS', [tag()], { onError: 'IGNORE' })])).ok,
    ).toBe(false);
    expect(
      issues(rule([EACH('SUBTASKS', [tag()], { scope: 'PROJECT' })])),
    ).toEqual(['NOT_FOR_SELECTOR@/actions/0/scope']);
  });

  it('checks `where` with the rule condition check and the body with the action check, at nested pointers', () => {
    const bad = { all: [{ field: 'PRIORITY', op: 'GT', value: 1 }] };
    expect(
      validateRule(rule([EACH('SUBTASKS', [tag()], { where: bad })])).ok,
    ).toBe(false);
    expect(issues(rule([EACH('SUBTASKS', [{ type: 'ADD_TAG' }])]))).toEqual([
      'MISSING@/actions/0/do/0/tagId',
    ]);
  });

  it('may contain another FOR_EACH, directly or through an IF, within the shared depth budget', () => {
    expect(validateRule(rule([EACH('SUBTASKS', [EACH('SIBLINGS')])])).ok).toBe(
      true,
    );
    expect(
      validateRule(rule([EACH('SUBTASKS', [IF([EACH('SIBLINGS')])])])).ok,
    ).toBe(true);
    // three loops deep is the default depth; the fourth is refused where it starts
    const deep = (n: number): unknown =>
      n === 0 ? tag() : EACH('SUBTASKS', [deep(n - 1)]);
    expect(validateRule(rule([deep(3)])).ok).toBe(true);
    expect(issues(rule([deep(4)]))).toEqual([
      'IF_TOO_DEEP@/actions/0/do/0/do/0/do/0',
    ]);
  });

  it('shares ONE nesting budget with IF: 3 deep by default, 4th refused', () => {
    expect(validateRule(rule([IF([IF([EACH('SUBTASKS')])])])).ok).toBe(true);
    expect(issues(rule([IF([IF([IF([EACH('SUBTASKS')])])])]))).toEqual([
      'IF_TOO_DEEP@/actions/0/then/0/then/0/then/0',
    ]);
    // and the other way round: an IF inside a loop counts the loop
    expect(validateRule(rule([EACH('SUBTASKS', [IF([IF([tag()])])])])).ok).toBe(
      true,
    );
    expect(issues(rule([EACH('SUBTASKS', [IF([IF([IF([tag()])])])])]))).toEqual(
      ['IF_TOO_DEEP@/actions/0/do/0/then/0/then/0'],
    );
    process.env.AUTOMATION_MAX_IF_DEPTH = '1';
    expect(issues(rule([EACH('SUBTASKS', [IF([tag()])])]))).toEqual([
      'IF_TOO_DEEP@/actions/0/do/0',
    ]);
  });

  it('counts the loop and its body in the whole-rule total', () => {
    process.env.AUTOMATION_MAX_TOTAL_ACTIONS = '3';
    expect(validateRule(rule([EACH('SUBTASKS', [tag(), tag()])])).ok).toBe(
      true,
    ); // 1 + 2
    expect(issues(rule([EACH('SUBTASKS', [tag(), tag(), tag()])]))).toEqual([
      'TOO_MANY_ACTIONS@/actions',
    ]);
  });

  describe('in a SCHEDULE rule (no task)', () => {
    it('is allowed over a QUERY, with task actions and task placeholders in its body', () => {
      expect(
        validateRule(
          rule(
            [
              EACH(
                'QUERY',
                [
                  {
                    type: 'COMMENT',
                    body: 'Still open: {{task.title}} ({{task.key}})',
                  },
                ],
                { where: open },
              ),
            ],
            SCHEDULE,
          ),
        ).ok,
      ).toBe(true);
    });
    it.each(['SUBTASKS', 'SIBLINGS', 'PARENT'])(
      'refuses %s (relative to a task it does not have)',
      (over) => {
        expect(issues(rule([EACH(over)], SCHEDULE))).toEqual([
          'ACTION_NEEDS_TASK@/actions/0/type',
        ]);
      },
    );
    it('a task action OUTSIDE the loop is still refused', () => {
      expect(issues(rule([EACH('QUERY'), tag()], SCHEDULE))).toEqual([
        'ACTION_NEEDS_TASK@/actions/1/type',
      ]);
    });
  });
});

const ctx = (): WorkspaceRuleContext => ({
  projectIds: new Set(['p1']),
  statuses: new Map([['s1', { projectId: 'p1', category: TaskStatus.TODO }]]),
  tagIds: new Set(['t1']),
  issueTypeIds: new Set(),
  iterationIds: new Set(),
  customFields: new Map<
    string,
    { dataType: FieldType; options: string[] | null }
  >(),
  validUserIds: new Set(['u1']),
});

describe('a FOR_EACH through the semantic checks', () => {
  it('collects ids from `where` and from the body', () => {
    const r = collectReferences(
      ok(
        rule([
          EACH('SUBTASKS', [tag('t_body'), IF([tag('t_nested')])], {
            where: {
              all: [{ field: 'TAGS', op: 'HAS_ANY', value: ['t_where'] }],
            },
          }),
        ]),
      ),
    );
    expect([...r.tagIds].sort()).toEqual(['t_body', 't_nested', 't_where']);
  });

  it('reports unknown ids at the nested pointers', () => {
    const found = checkRuleSemantics(
      ok(
        rule([
          EACH('SUBTASKS', [tag('t1'), tag('zz')], {
            where: { all: [{ field: 'TAGS', op: 'HAS_ANY', value: ['yy'] }] },
          }),
        ]),
      ),
      'p1',
      ctx(),
    );
    expect(found.map((i) => i.path).sort()).toEqual([
      '/actions/0/do/1/tagId',
      '/actions/0/where/all/0/value/0',
    ]);
  });

  it('keeps a project rule in its project: WORKSPACE scope needs a workspace-wide rule', () => {
    const r = ok(rule([EACH('QUERY', [tag()], { scope: 'WORKSPACE' })]));
    expect(
      checkRuleSemantics(r, 'p1', ctx()).map((i) => `${i.code}@${i.path}`),
    ).toEqual(['SCOPE_NEEDS_WORKSPACE_RULE@/actions/0/scope']);
    expect(checkRuleSemantics(r, null, ctx())).toEqual([]);
    const own = ok(rule([EACH('QUERY', [tag()], { scope: 'PROJECT' })]));
    expect(checkRuleSemantics(own, 'p1', ctx())).toEqual([]);
  });

  it('still refuses creating what triggers the rule from inside a loop', () => {
    const r = ok(
      rule([EACH('SUBTASKS', [{ type: 'CREATE_SUBTASK', title: 's' }])], {
        type: 'TASK_CREATED',
      }),
    );
    expect(
      checkRuleSemantics(r, 'p1', ctx()).map((i) => `${i.code}@${i.path}`),
    ).toEqual(['UNBOUNDED_RECURSION@/actions/0/do/0']);
  });
});

describe('a FOR_EACH in a template', () => {
  it('has the ids of its where and body translated at nested pointers', () => {
    const calls: string[] = [];
    new RefWalker((kind, value, path) => {
      calls.push(`${kind}:${value}@${path}`);
      return value;
    }).rule(
      rule([
        EACH('QUERY', [tag('a')], {
          where: { all: [{ field: 'TAGS', op: 'HAS_ANY', value: ['b'] }] },
        }),
      ]),
    );
    expect(calls).toEqual([
      'tag:b@/actions/0/where/all/0/value/0',
      'tag:a@/actions/0/do/0/tagId',
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
  vars: { 'trigger.to': 'Done', 'actor.name': 'Ann', date: '2026-10-26' },
};

interface Item {
  id: string;
  title: string;
  priority?: string;
  projectId?: string | null;
  fail?: boolean;
}
const row = (i: Item) => ({
  id: i.id,
  key: `ABC-${i.id}`,
  statusName: 'Todo',
  createdById: 'author',
  title: i.title,
  projectId: i.projectId === undefined ? 'p1' : i.projectId,
  parentId: null,
  status: 'TODO',
  workflowStatusId: null,
  priority: i.priority ?? null,
  dueDate: null,
});

function harness(
  items: Item[],
  opts: {
    parents?: Record<string, string | null>;
    capped?: boolean;
    /** the result of the 1st, 2nd, ... task query (nested loops query once per outer task) */
    perQuery?: Item[][];
  } = {},
) {
  const log: string[] = [];
  const queries: Array<Record<string, unknown>> = [];
  const byId = Object.fromEntries(
    [...items, ...(opts.perQuery ?? []).flat()].map((i) => [i.id, i]),
  );
  const prisma = {
    task: {
      findUnique: async (q: {
        where: { id: string };
        select: Record<string, unknown>;
      }) => {
        if (
          q.select.parentId !== undefined &&
          Object.keys(q.select).length === 1
        )
          return { parentId: opts.parents?.[q.where.id] ?? null };
        const it = byId[q.where.id];
        if (!it) return null;
        return {
          title: it.title,
          status: 'TODO',
          workflowStatusId: null,
          priority: it.priority ?? null,
          estimate: null,
          dueDate: null,
          startDate: null,
          createdById: 'author',
          issueTypeId: null,
          iterationId: null,
          projectId: 'p1',
          parentId: null,
          assignees: [],
          tags: [],
          customValues: [],
        };
      },
    },
  };
  const tags = {
    attach: async (taskId: string, tagId: string) => {
      if (byId[taskId]?.fail) throw new Error('boom');
      log.push(`attach:${taskId}:${tagId}`);
    },
  };
  const comments = {
    createSystemComment: async (
      _k: unknown,
      taskId: string,
      _a: string,
      body: string,
    ) => void log.push(`comment:${taskId}:${body}`),
  };
  const taskQuery = {
    run: async (input: Record<string, unknown>) => {
      queries.push(input);
      const list = opts.perQuery
        ? (opts.perQuery[queries.length - 1] ?? [])
        : items;
      return {
        items: list.map(row),
        nextCursor: null,
        scanned: list.length,
        capped: !!opts.capped,
      };
    },
  };
  const ex = new ActionExecutor(
    prisma as never,
    {} as never,
    tags as never,
    {} as never,
    comments as never,
    {} as never,
    taskQuery as never,
    {} as never, // the notifier
  );
  return { ex, log, queries };
}
const actions = (a: unknown[]) => ok(rule(a)).actions;
const items = (n: number): Item[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `i${i + 1}`,
    title: `Task ${i + 1}`,
  }));

describe('executing a FOR_EACH', () => {
  it('runs the body once per task with THAT task as the current one, placeholders per task', async () => {
    const h = harness(items(3));
    const r = await h.ex.execute(
      actions([
        EACH('SUBTASKS', [
          tag('t1'),
          {
            type: 'COMMENT',
            body: '{{task.key}} {{task.title}} -> {{trigger.to}} by {{actor.name}}',
          },
        ]),
      ]),
      RUN,
    );
    expect(r).toEqual({ done: 6 });
    expect(h.log).toEqual([
      'attach:i1:t1',
      'comment:i1:ABC-i1 Task 1 -> Done by Ann',
      'attach:i2:t1',
      'comment:i2:ABC-i2 Task 2 -> Done by Ann',
      'attach:i3:t1',
      'comment:i3:ABC-i3 Task 3 -> Done by Ann',
    ]);
  });

  it('does nothing and succeeds when nothing is selected', async () => {
    const h = harness([]);
    expect(await h.ex.execute(actions([EACH('SUBTASKS')]), RUN)).toEqual({
      done: 0,
    });
    expect(h.log).toEqual([]);
  });

  it('selects ONCE, before running anything', async () => {
    const h = harness(items(3));
    await h.ex.execute(actions([EACH('SUBTASKS')]), RUN);
    expect(h.queries).toHaveLength(1);
  });

  describe('what each selector asks for', () => {
    const base = {
      workspaceId: 'w1',
      userId: null,
      actorId: 'u1',
      limit: 101,
      pageCap: 101,
    };
    it('SUBTASKS: the children of the task the rule fired on, with `where`', async () => {
      const h = harness([]);
      await h.ex.execute(
        actions([EACH('SUBTASKS', [tag()], { where: open })]),
        RUN,
      );
      expect(h.queries[0]).toEqual({
        ...base,
        projectId: null,
        structural: { parentId: 'event' },
        filters: open,
      });
    });
    it('SIBLINGS: the other children of its parent; none without a parent', async () => {
      const withParent = harness([], { parents: { event: 'par' } });
      await withParent.ex.execute(actions([EACH('SIBLINGS')]), RUN);
      expect(withParent.queries[0].structural).toEqual({
        parentId: 'par',
        id: { not: 'event' },
      });
      const orphan = harness([]);
      await orphan.ex.execute(actions([EACH('SIBLINGS')]), RUN);
      expect(orphan.queries[0].structural).toEqual({ id: { in: [] } });
    });
    it('PARENT: the parent; none without one', async () => {
      const withParent = harness([], { parents: { event: 'par' } });
      await withParent.ex.execute(actions([EACH('PARENT')]), RUN);
      expect(withParent.queries[0].structural).toEqual({ id: 'par' });
      const orphan = harness([]);
      await orphan.ex.execute(actions([EACH('PARENT')]), RUN);
      expect(orphan.queries[0].structural).toEqual({ id: { in: [] } });
    });
    it("QUERY: the rule's project by default, the whole workspace on request", async () => {
      const h = harness([]);
      await h.ex.execute(
        actions([EACH('QUERY', [tag()], { where: open })]),
        RUN,
      );
      expect(h.queries[0]).toMatchObject({ projectId: 'p1', structural: {} });
      await h.ex.execute(
        actions([EACH('QUERY', [tag()], { scope: 'WORKSPACE' })]),
        RUN,
      );
      expect(h.queries[1]).toMatchObject({ projectId: null });
    });
    it('QUERY in the project with no project to look in fails clearly', async () => {
      const h = harness([]);
      const r = await h.ex.execute(actions([EACH('QUERY')]), {
        ...RUN,
        projectId: null,
      });
      expect(r).toMatchObject({
        failedPath: '/actions/0',
        error: expect.stringMatching(/no project/i),
      });
      expect(h.queries).toHaveLength(0);
    });
    it('a relative selector with no task fails clearly', async () => {
      const h = harness([]);
      const r = await h.ex.execute(actions([EACH('SUBTASKS')]), {
        ...RUN,
        taskId: null,
      });
      expect(r.error).toMatch(/no task/i);
    });
  });

  it('a task in another project runs its body with that project', async () => {
    const h = harness([{ id: 'x', title: 'x', projectId: 'other' }]);
    const r = await h.ex.execute(
      actions([EACH('QUERY', [{ type: 'CREATE_TASK', title: 'n' }])]),
      RUN,
    );
    // CREATE_TASK needs the domain writer, which this harness does not provide: the point is the project it was given
    expect(r.failedPath).toBe('/actions/0/do/0');
  });

  describe('limits', () => {
    it('refuses a selection over the configured size and runs NOTHING', async () => {
      process.env.AUTOMATION_MAX_FOR_EACH_ITEMS = '2';
      const h = harness(items(3));
      const r = await h.ex.execute(actions([EACH('SUBTASKS')]), RUN);
      expect(r).toMatchObject({
        done: 0,
        failedAt: 0,
        failedPath: '/actions/0',
      });
      expect(r.error).toMatch(/more than 2 tasks/);
      expect(h.log).toEqual([]);
      expect(h.queries[0]).toMatchObject({ limit: 3, pageCap: 3 });
    });
    it('exactly the limit is fine', async () => {
      process.env.AUTOMATION_MAX_FOR_EACH_ITEMS = '3';
      const h = harness(items(3));
      expect(
        (await h.ex.execute(actions([EACH('SUBTASKS')]), RUN)).error,
      ).toBeUndefined();
    });
    it('refuses a search that hit the scan limit instead of acting on part of it', async () => {
      const h = harness(items(2), { capped: true });
      const r = await h.ex.execute(actions([EACH('QUERY')]), RUN);
      expect(r.error).toMatch(/scan too many/);
      expect(h.log).toEqual([]);
    });
    it('stops a run that would execute more than the per-run budget, and says so', async () => {
      process.env.AUTOMATION_MAX_ACTIONS_PER_RUN = '5';
      const h = harness(items(3));
      const r = await h.ex.execute(
        actions([EACH('SUBTASKS', [tag(), { type: 'COMMENT', body: 'x' }])]),
        RUN,
      );
      expect(r.done).toBe(5);
      expect(r.error).toMatch(/limit of 5 actions/);
      expect(r).toMatchObject({
        failedPath: '/actions/0/do/1',
        failedItem: { index: 2, taskId: 'i3' },
      });
    });
    it('the budget also counts actions outside the loop', async () => {
      process.env.AUTOMATION_MAX_ACTIONS_PER_RUN = '2';
      const h = harness(items(2));
      const r = await h.ex.execute(actions([tag(), EACH('SUBTASKS')]), RUN);
      expect(r.done).toBe(2);
      expect(r.failedPath).toBe('/actions/1/do/0');
    });
  });

  describe('when a task fails', () => {
    const three: Item[] = [
      { id: 'i1', title: 'a' },
      { id: 'i2', title: 'b', fail: true },
      { id: 'i3', title: 'c' },
    ];
    it('STOPS at the first failure (the default) and says which task and where', async () => {
      const h = harness(three);
      const r = await h.ex.execute(
        actions([EACH('SUBTASKS', [tag(), { type: 'COMMENT', body: 'x' }])]),
        RUN,
      );
      expect(r).toMatchObject({
        done: 2, // task 1's two actions; task 2 failed on its first
        failedAt: 0,
        failedPath: '/actions/0/do/0',
        failedItem: { index: 1, taskId: 'i2' },
      });
      expect(h.log).toEqual(['attach:i1:t1', 'comment:i1:x']);
    });
    it('onError CONTINUE finishes every task, then fails once, naming how many and the first', async () => {
      const more: Item[] = [...three, { id: 'i4', title: 'd', fail: true }];
      const h = harness(more);
      const r = await h.ex.execute(
        actions([EACH('SUBTASKS', [tag()], { onError: 'CONTINUE' })]),
        RUN,
      );
      expect(h.log).toEqual(['attach:i1:t1', 'attach:i3:t1']);
      expect(r).toMatchObject({
        done: 2,
        failedPath: '/actions/0/do/0',
        failedItem: { index: 1, taskId: 'i2' },
      });
      expect(r.error).toMatch(/2 of 4 tasks failed/);
    });
    it('with CONTINUE and no failure it simply succeeds', async () => {
      const h = harness(items(2));
      expect(
        await h.ex.execute(
          actions([EACH('SUBTASKS', [tag()], { onError: 'CONTINUE' })]),
          RUN,
        ),
      ).toEqual({ done: 2 });
    });
    it('a failure after the loop is not attributed to a task', async () => {
      const h = harness(items(1));
      const r = await h.ex.execute(
        actions([EACH('SUBTASKS'), { type: 'SET_PRIORITY', priority: null }]),
        RUN,
      );
      expect(r.failedPath).toBe('/actions/1');
      expect(r.failedItem).toBeUndefined();
    });
  });

  it('an IF inside the loop looks at the CURRENT item, not the task the rule fired on', async () => {
    const h = harness([
      { id: 'hi', title: 'hi', priority: 'HIGH' },
      { id: 'lo', title: 'lo', priority: 'LOW' },
    ]);
    const r = await h.ex.execute(
      actions([EACH('SUBTASKS', [IF([tag('urgent')])])]),
      RUN,
    );
    expect(r).toEqual({ done: 1 });
    expect(h.log).toEqual(['attach:hi:urgent']);
  });

  it('what the loop does is counted per real action, not per task or per loop', async () => {
    const h = harness(items(4));
    expect(
      await h.ex.execute(
        actions([tag('a'), EACH('SUBTASKS', [tag('b')])]),
        RUN,
      ),
    ).toEqual({ done: 5 });
  });

  describe('a loop inside a loop', () => {
    const outer: Item[] = [
      { id: 'o1', title: 'Outer 1' },
      { id: 'o2', title: 'Outer 2' },
    ];
    const inner1: Item[] = [
      { id: 'a1', title: 'A1' },
      { id: 'a2', title: 'A2' },
    ];
    const inner2: Item[] = [{ id: 'b1', title: 'B1' }];
    const nest = (body: unknown[] = [tag('x')], extra: object = {}) =>
      actions([EACH('SUBTASKS', [EACH('SUBTASKS', body, extra)])]);

    it('runs the inner loop for each outer task, selecting relative to THAT task', async () => {
      const h = harness([], { perQuery: [outer, inner1, inner2] });
      const r = await h.ex.execute(nest(), RUN);
      expect(r).toEqual({ done: 3 });
      expect(h.log).toEqual(['attach:a1:x', 'attach:a2:x', 'attach:b1:x']);
      expect(h.queries.map((q) => q.structural)).toEqual([
        { parentId: 'event' },
        { parentId: 'o1' },
        { parentId: 'o2' },
      ]);
    });

    it("the inner placeholders are the inner task's", async () => {
      const h = harness([], { perQuery: [outer, inner1, inner2] });
      await h.ex.execute(
        nest([{ type: 'COMMENT', body: '{{task.title}}' }]),
        RUN,
      );
      expect(h.log).toEqual([
        'comment:a1:A1',
        'comment:a2:A2',
        'comment:b1:B1',
      ]);
    });

    it('is bounded by the loop-step budget (loops started + tasks processed), even if nothing is done', async () => {
      process.env.AUTOMATION_MAX_LOOP_STEPS_PER_RUN = '5';
      // 1 (outer loop) + 2 outer tasks + 2 inner loops = 5, then the first inner task is step 6
      const h = harness([], { perQuery: [outer, inner1, inner2] });
      const r = await h.ex.execute(nest([IF([tag()])]), RUN);
      expect(r.error).toMatch(/limit of 5 loop steps/);
      expect(r.done).toBe(0);
    });

    it('a failure names every loop it was in, outermost first, and the innermost task', async () => {
      const bad: Item[] = [
        { id: 'a1', title: 'A1' },
        { id: 'a2', title: 'A2', fail: true },
      ];
      const h = harness([], { perQuery: [outer, bad] });
      const r = await h.ex.execute(nest(), RUN);
      expect(r).toMatchObject({
        done: 1,
        failedPath: '/actions/0/do/0/do/0',
        failedItem: { index: 1, taskId: 'a2' },
        failedItems: [
          { path: '/actions/0', index: 0, taskId: 'o1' },
          { path: '/actions/0/do/0', index: 1, taskId: 'a2' },
        ],
      });
    });

    it('CONTINUE in the inner loop finishes its tasks, then the outer STOP ends everything', async () => {
      const bad: Item[] = [
        { id: 'a1', title: 'A1', fail: true },
        { id: 'a2', title: 'A2' },
      ];
      const h = harness([], { perQuery: [outer, bad, inner2] });
      const r = await h.ex.execute(
        nest([tag('x')], { onError: 'CONTINUE' }),
        RUN,
      );
      expect(h.log).toEqual(['attach:a2:x']);
      expect(r.error).toMatch(/1 of 2 tasks failed/);
      expect(h.queries).toHaveLength(2);
    });

    it('both loops continuing finishes everything and reports once', async () => {
      const bad: Item[] = [{ id: 'a1', title: 'A1', fail: true }];
      const h = harness([], { perQuery: [outer, bad, inner2] });
      const r = await h.ex.execute(
        actions([
          EACH(
            'SUBTASKS',
            [EACH('SUBTASKS', [tag('x')], { onError: 'CONTINUE' })],
            { onError: 'CONTINUE' },
          ),
        ]),
        RUN,
      );
      expect(h.log).toEqual(['attach:b1:x']);
      expect(r.error).toMatch(/1 of 2 tasks failed/);
    });

    it('the per-run action budget bounds the total across both loops', async () => {
      process.env.AUTOMATION_MAX_ACTIONS_PER_RUN = '2';
      const h = harness([], { perQuery: [outer, inner1, inner2] });
      const r = await h.ex.execute(nest(), RUN);
      expect(r.done).toBe(2);
      expect(r.error).toMatch(/limit of 2 actions/);
    });
  });
});
