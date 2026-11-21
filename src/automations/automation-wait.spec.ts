import {
  ActionExecutor,
  ActionRun,
  WaitFrame,
} from './action-executor.service';
import { WorkspaceRuleContext, checkRuleSemantics, validateRule } from './dsl';
import { TREE_LIMIT_ENV } from './dsl/rule.settings';
import type { Action, CallableRule } from './dsl/rule.types';

/** Step 5.15: WAIT. */

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

const wait = (amount = 1, unit = 'DAYS') => ({
  type: 'WAIT',
  for: { amount, unit },
});
const tag = (id: string) => ({ type: 'ADD_TAG', tagId: id });
const say = (body: string) => ({ type: 'COMMENT', body });
const high = { all: [{ field: 'PRIORITY', op: 'IN', value: ['HIGH'] }] };
const IF = (then: unknown[], extra: object = {}) => ({
  type: 'IF',
  conditions: high,
  then,
  ...extra,
});
const EACH = (body: unknown[]) => ({
  type: 'FOR_EACH',
  over: 'SUBTASKS',
  do: body,
});
const WITH = (task: string, body: unknown[]) => ({
  type: 'WITH',
  task,
  do: body,
});
const make = (as?: string) => ({
  type: 'CREATE_TASK',
  title: 'Follow {{task.title}}',
  ...(as ? { as } : {}),
});
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
const actions = (a: unknown[]) => ok(rule(a)).actions as Action[];

describe('validating WAIT', () => {
  it('takes an amount and a unit', () => {
    expect(
      validateRule(
        rule([wait(5, 'MINUTES'), wait(3, 'HOURS'), wait(2, 'DAYS')]),
      ).ok,
    ).toBe(true);
    expect(validateRule(rule([wait(0)])).ok).toBe(false);
    expect(validateRule(rule([wait(1.5)])).ok).toBe(false);
    expect(validateRule(rule([wait(1, 'WEEKS')])).ok).toBe(false);
    expect(validateRule(rule([{ type: 'WAIT' }])).ok).toBe(false);
    expect(validateRule(rule([{ ...wait(), extra: 1 }])).ok).toBe(false);
  });

  it('lasts at most 30 days by default, and follows the configuration up to the ceiling', () => {
    expect(validateRule(rule([wait(30)])).ok).toBe(true);
    expect(issues(rule([wait(31)]))).toEqual(['WAIT_TOO_LONG@/actions/0/for']);
    expect(issues(rule([wait(721, 'HOURS')]))).toEqual([
      'WAIT_TOO_LONG@/actions/0/for',
    ]);
    expect(issues(rule([wait(43_201, 'MINUTES')]))).toEqual([
      'WAIT_TOO_LONG@/actions/0/for',
    ]);
    expect(validateRule(rule([wait(43_200, 'MINUTES')])).ok).toBe(true); // exactly 30 days
    process.env.AUTOMATION_MAX_WAIT_DAYS = '365';
    expect(validateRule(rule([wait(365)])).ok).toBe(true);
    process.env.AUTOMATION_MAX_WAIT_DAYS = '1';
    expect(issues(rule([wait(2)]))).toEqual(['WAIT_TOO_LONG@/actions/0/for']);
  });

  it('is allowed at the top, in an IF branch, an else-if case and a WITH', () => {
    expect(validateRule(rule([IF([wait()])])).ok).toBe(true);
    expect(
      validateRule(
        rule([
          IF([tag('a')], { elseIf: [{ conditions: high, then: [wait()] }] }),
        ]),
      ).ok,
    ).toBe(true);
    expect(
      validateRule(rule([make('f'), WITH('f', [wait(), tag('a')])])).ok,
    ).toBe(true);
  });

  it('is allowed in a SCHEDULE rule (it needs no task)', () => {
    expect(
      validateRule(
        rule(
          [
            { type: 'CREATE_TASK', title: 'Weekly {{date}}', as: 'f' },
            wait(1, 'HOURS'),
            WITH('f', [tag('a')]),
          ],
          SCHEDULE,
        ),
      ).ok,
    ).toBe(true);
  });

  it('is refused inside a loop, however deep, at its pointer', () => {
    expect(issues(rule([EACH([wait()])]))).toEqual([
      'WAIT_IN_LOOP@/actions/0/do/0',
    ]);
    expect(issues(rule([EACH([IF([wait()])])]))).toEqual([
      'WAIT_IN_LOOP@/actions/0/do/0/then/0',
    ]);
    expect(issues(rule([EACH([make('f'), WITH('f', [wait()])])]))).toEqual([
      'WAIT_IN_LOOP@/actions/0/do/1/do/0',
    ]);
    // before or after the loop is fine
    expect(validateRule(rule([wait(), EACH([tag('a')]), wait()])).ok).toBe(
      true,
    );
  });

  it('a rule cannot call a rule that waits', () => {
    const c = (r: Partial<CallableRule>): WorkspaceRuleContext => ({
      projectIds: new Set(),
      statuses: new Map(),
      tagIds: new Set(),
      issueTypeIds: new Set(),
      iterationIds: new Set(),
      customFields: new Map(),
      validUserIds: new Set(),
      rules: new Map([
        [
          'b',
          {
            projectId: null,
            triggerType: 'CALLED',
            ruleVersion: 1,
            hasUnsupported: false,
            calls: [],
            ...r,
          },
        ],
      ]),
    });
    const r = ok(rule([{ type: 'RUN_RULE', rule: 'b' }]));
    expect(
      checkRuleSemantics(r, null, c({ hasWait: true })).map((i) => i.code),
    ).toEqual(['RUN_RULE_HAS_WAIT']);
    expect(checkRuleSemantics(r, null, c({ hasWait: false }))).toEqual([]);
  });
});

// ------------------------------------------------------------------ executing ------------------
const RUN: ActionRun = {
  ruleId: 'r1',
  writeDepth: 1,
  workspaceId: 'w1',
  projectId: 'p1',
  taskId: 'task1',
  createdById: 'c1',
  triggererId: 'u1',
  actorId: 'sys',
  vars: { 'task.title': 'Fix it', date: '2026-10-26' },
};

function harness(
  priority: string | null = 'HIGH',
  targets: Record<string, { name: string; actions: unknown[] }> = {},
) {
  const log: string[] = [];
  const created: Record<string, string> = {};
  let n = 0;
  const prisma = {
    task: {
      findUnique: async (q: {
        where: { id: string };
        select: Record<string, unknown>;
      }) => {
        if (q.select.workspace)
          return {
            number: 7,
            title: created[q.where.id] ?? '?',
            status: 'TODO',
            priority: null,
            dueDate: null,
            workspace: { key: 'ABC' },
            workflowStatus: { name: 'Backlog' },
            project: { name: 'Web' },
            assignees: [],
          };
        return {
          title: 'Fix it',
          status: 'TODO',
          workflowStatusId: null,
          priority,
          estimate: null,
          dueDate: null,
          startDate: null,
          createdById: 'c1',
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
    automation: {
      findFirst: async (q: { where: { id: string } }) => {
        const t = targets[q.where.id];
        return t
          ? { ruleVersion: 1, unsupported: [], conditions: {}, ...t }
          : null;
      },
    },
  };
  const domainWriter = {
    createTask: async (dto: { title: string }) => {
      const id = `new${++n}`;
      created[id] = dto.title;
      log.push(`create:${id}`);
      return { id };
    },
  };
  const tags = {
    attach: async (t: string, tagId: string) =>
      void log.push(`attach:${t}:${tagId}`),
  };
  const comments = {
    createSystemComment: async (
      _k: unknown,
      t: string,
      _a: string,
      b: string,
    ) => void log.push(`comment:${t}:${b}`),
  };
  const taskQuery = {
    run: async (i: { structural?: { id?: string } }) => {
      const id = i.structural?.id;
      return {
        items:
          id && created[id]
            ? [
                {
                  id,
                  key: `ABC-${id}`,
                  statusName: 'Backlog',
                  createdById: 'sys',
                  title: created[id],
                  projectId: 'p1',
                  parentId: null,
                  status: 'TODO',
                  workflowStatusId: null,
                  priority: null,
                  dueDate: null,
                },
              ]
            : [],
        nextCursor: null,
        scanned: 0,
        capped: false,
      };
    },
  };
  const ex = new ActionExecutor(
    prisma as never,
    {} as never,
    tags as never,
    {} as never,
    comments as never,
    domainWriter as never,
    taskQuery as never,
    {} as never,
  );
  return { ex, log };
}
/** what the database stores: plain JSON */
const stored = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const frame = (
  listPointer: string,
  from: number,
  run: Partial<ActionRun> = {},
) =>
  expect.objectContaining({
    listPointer,
    from,
    run: expect.objectContaining(run),
  });

describe('stopping at a WAIT', () => {
  it('runs what is before it, stops, and says where to carry on', async () => {
    const h = harness();
    const before = Date.now();
    const r = await h.ex.execute(
      actions([tag('a'), wait(2, 'DAYS'), tag('never')]),
      RUN,
    );
    expect(h.log).toEqual(['attach:task1:a']);
    expect(r.done).toBe(1);
    expect(r.error).toBeUndefined();
    expect(r.waiting!.pointer).toBe('/actions/1');
    expect(r.waiting!.until.getTime() - before).toBeGreaterThanOrEqual(
      2 * 86_400_000 - 5,
    );
    expect(r.waiting!.until.getTime() - before).toBeLessThan(
      2 * 86_400_000 + 5000,
    );
    expect(r.waiting!.frames).toEqual([
      frame('/actions', 2, { taskId: 'task1' }),
    ]);
  });

  it('inside an IF branch: the rest of the branch, then the rest after the IF (innermost first)', async () => {
    const h = harness('HIGH');
    const r = await h.ex.execute(
      actions([tag('a'), IF([tag('b'), wait(), tag('c')]), tag('d')]),
      RUN,
    );
    expect(h.log).toEqual(['attach:task1:a', 'attach:task1:b']);
    expect(r.waiting!.pointer).toBe('/actions/1/then/1');
    expect(r.waiting!.frames).toEqual([
      frame('/actions/1/then', 2),
      frame('/actions', 2),
    ]);
  });

  it('inside an else-if case', async () => {
    const h = harness('MEDIUM');
    const med = { all: [{ field: 'PRIORITY', op: 'IN', value: ['MEDIUM'] }] };
    const r = await h.ex.execute(
      actions([
        IF([tag('no')], {
          elseIf: [{ conditions: med, then: [wait(), tag('x')] }],
        }),
      ]),
      RUN,
    );
    expect(r.waiting!.pointer).toBe('/actions/0/elseIf/0/then/0');
    expect(r.waiting!.frames).toEqual([
      frame('/actions/0/elseIf/0/then', 1),
      frame('/actions', 1),
    ]);
  });

  it('inside a WITH: the captured task is the current one in the saved context', async () => {
    const h = harness();
    const r = await h.ex.execute(
      actions([make('f'), WITH('f', [wait(), tag('x')])]),
      RUN,
    );
    const [inner, outer] = r.waiting!.frames;
    expect(inner).toMatchObject({
      listPointer: '/actions/1/do',
      from: 1,
      run: { taskId: 'new1' },
    });
    expect(outer).toMatchObject({
      listPointer: '/actions',
      from: 2,
      run: { taskId: 'task1' },
    });
    // and the capture is in the context, so `{{f.title}}` still works after the wait
    expect(outer.run.vars['f.title']).toBe('Follow Fix it');
  });

  it('a WAIT counts for nothing and the actions after it are not run or counted', async () => {
    const h = harness();
    const r = await h.ex.execute(actions([wait(), tag('a')]), RUN);
    expect(r.done).toBe(0);
    expect(h.log).toEqual([]);
  });
});

describe('carrying on', () => {
  const resumeFrom = (r: { waiting?: { frames: WaitFrame[] } }) =>
    stored(r.waiting!.frames);

  it('finishes the branch, then what comes after the IF', async () => {
    const h = harness('HIGH');
    const snapshot = actions([
      tag('a'),
      IF([tag('b'), wait(), tag('c')]),
      tag('d'),
    ]);
    const first = await h.ex.execute(snapshot, RUN);
    h.log.length = 0;
    const r = await h.ex.resume(stored(snapshot), resumeFrom(first));
    expect(r).toEqual({ done: 2 }); // c, then d
    expect(h.log).toEqual(['attach:task1:c', 'attach:task1:d']);
  });

  it('keeps captured variables across the wait (a JSON round trip, as stored)', async () => {
    const h = harness();
    const snapshot = actions([
      make('f'),
      wait(),
      say('Back: {{f.title}} / {{f.key}}'),
      WITH('f', [tag('x')]),
    ]);
    const first = await h.ex.execute(snapshot, RUN);
    h.log.length = 0;
    await h.ex.resume(stored(snapshot), resumeFrom(first));
    expect(h.log).toEqual([
      'comment:task1:Back: Follow Fix it / ABC-7',
      'attach:new1:x',
    ]);
  });

  it('a wait inside a WITH carries on the WITH body, then the rest of the rule on the ORIGINAL task', async () => {
    const h = harness();
    const snapshot = actions([
      make('f'),
      WITH('f', [tag('1'), wait(), tag('2')]),
      tag('3'),
    ]);
    const first = await h.ex.execute(snapshot, RUN);
    h.log.length = 0;
    await h.ex.resume(stored(snapshot), resumeFrom(first));
    expect(h.log).toEqual(['attach:new1:2', 'attach:task1:3']);
  });

  it('may wait AGAIN, and the second wait still carries on the lists around it', async () => {
    const h = harness('HIGH');
    const snapshot = actions([
      IF([tag('b'), wait(), tag('c'), wait(), tag('d')]),
      tag('e'),
    ]);
    const first = await h.ex.execute(snapshot, RUN);
    expect(first.waiting!.pointer).toBe('/actions/0/then/1');
    h.log.length = 0;
    const second = await h.ex.resume(stored(snapshot), resumeFrom(first));
    expect(h.log).toEqual(['attach:task1:c']);
    expect(second.waiting!.pointer).toBe('/actions/0/then/3');
    expect(second.waiting!.frames).toEqual([
      frame('/actions/0/then', 4),
      frame('/actions', 1),
    ]);
    h.log.length = 0;
    const third = await h.ex.resume(stored(snapshot), resumeFrom(second));
    expect(third).toEqual({ done: 2 });
    expect(h.log).toEqual(['attach:task1:d', 'attach:task1:e']);
  });

  it('reports a failure against the SNAPSHOT pointers, and stops', async () => {
    const h = harness('HIGH');
    const snapshot = actions([
      IF([
        wait(),
        tag('c'),
        { type: 'SET_PRIORITY', priority: null },
        tag('never'),
      ]),
      tag('also-never'),
    ]);
    const first = await h.ex.execute(snapshot, RUN);
    const r = await h.ex.resume(stored(snapshot), resumeFrom(first));
    expect(r).toMatchObject({
      done: 1,
      failedAt: 0,
      failedPath: '/actions/0/then/2',
    });
    expect(h.log).toEqual(['attach:task1:c']);
  });

  it('refuses a saved position that no longer exists in the snapshot', async () => {
    const h = harness();
    const r = await h.ex.resume(actions([tag('a')]), [
      { listPointer: '/actions/5/then', from: 0, run: RUN },
    ]);
    expect(r.error).toMatch(/no list at \/actions\/5\/then/);
  });
});

describe('where a WAIT is refused at run time (a rule that changed since it was saved)', () => {
  it('inside a loop', async () => {
    const h = harness();
    const r = await h.ex.execute([wait() as unknown as Action], {
      ...RUN,
      inLoop: true,
    });
    expect(r.error).toBe('A Wait cannot run inside a loop');
  });

  it('inside a rule another rule called', async () => {
    const h = harness('HIGH', { b: { name: 'Sleepy', actions: [wait()] } });
    const r = await h.ex.execute(
      actions([{ type: 'RUN_RULE', rule: 'b' }]),
      RUN,
    );
    expect(r.error).toBe(
      'A Wait cannot run inside a rule that another rule called',
    );
    expect(r.failedPath).toBe('/actions/0/call/0');
  });

  it('longer than the CURRENT limit', async () => {
    process.env.AUTOMATION_MAX_WAIT_DAYS = '1';
    const h = harness();
    const r = await h.ex.execute([wait(2, 'DAYS') as unknown as Action], RUN);
    expect(r.error).toMatch(/at most 1 days/);
  });
});
