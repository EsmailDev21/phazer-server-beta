import { ActionExecutor, ActionRun } from './action-executor.service';
import { WorkspaceRuleContext, checkRuleSemantics, validateRule } from './dsl';
import { TREE_LIMIT_ENV } from './dsl/rule.settings';
import type { CallableRule } from './dsl/rule.types';
import { matchesTrigger } from './engine/trigger-match';

/** Step 5.14: RUN_RULE and the CALLED trigger. */

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

const call = (rule: string) => ({ type: 'RUN_RULE', rule });
const tag = (id = 't1') => ({ type: 'ADD_TAG', tagId: id });
const rule = (
  actions: unknown[],
  trigger: unknown = { type: 'STATUS_CHANGED' },
) => ({ trigger, actions });
const ok = (input: unknown) => {
  const v = validateRule(input);
  if (v.ok === false) throw new Error(JSON.stringify(v.issues));
  return v.rule;
};

describe('the CALLED trigger', () => {
  it('validates, takes nothing else, and never fires from an event', () => {
    expect(validateRule(rule([tag()], { type: 'CALLED' })).ok).toBe(true);
    expect(validateRule(rule([tag()], { type: 'CALLED', x: 1 })).ok).toBe(
      false,
    );
    for (const kind of [
      'TASK_CREATED',
      'STATUS_CHANGED',
      'FIELD_CHANGED',
      'DUE_APPROACHING',
      'COMMENT_ADDED',
      'TASK_ARCHIVED',
      'TASK_RESTORED',
      'ALL_SUBTASKS_DONE',
      'TASK_OVERDUE',
      'SCHEDULE',
    ])
      expect(matchesTrigger({ type: 'CALLED' }, { kind } as never)).toBe(false);
  });
});

describe('validating RUN_RULE', () => {
  it('needs a rule id, and nothing else', () => {
    expect(validateRule(rule([call('r1')])).ok).toBe(true);
    expect(validateRule(rule([{ type: 'RUN_RULE' }])).ok).toBe(false);
    expect(validateRule(rule([{ type: 'RUN_RULE', rule: 'bad id!' }])).ok).toBe(
      false,
    );
    expect(validateRule(rule([{ ...call('r1'), extra: 1 }])).ok).toBe(false);
  });

  it('can sit inside an IF, a loop and a WITH, and counts toward nesting like they do', () => {
    const cond = { all: [{ field: 'PRIORITY', op: 'IN', value: ['HIGH'] }] };
    expect(
      validateRule(rule([{ type: 'IF', conditions: cond, then: [call('r1')] }]))
        .ok,
    ).toBe(true);
    expect(
      validateRule(
        rule([{ type: 'FOR_EACH', over: 'SUBTASKS', do: [call('r1')] }]),
      ).ok,
    ).toBe(true);
  });

  it('is refused in a SCHEDULE rule (it works on a task)', () => {
    expect(
      validateRule(
        rule([call('r1')], { type: 'SCHEDULE', frequency: 'DAILY', hour: 1 }),
      ).ok,
    ).toBe(false);
  });
});

// ------------------------------------------------------------------ the call graph --------------
const R = (over: Partial<CallableRule> = {}): CallableRule => ({
  projectId: null,
  triggerType: 'CALLED',
  ruleVersion: 1,
  hasUnsupported: false,
  calls: [],
  ...over,
});
const ctx = (
  rules: Record<string, CallableRule>,
  selfRuleId?: string,
): WorkspaceRuleContext => ({
  projectIds: new Set(['p1', 'p2']),
  statuses: new Map(),
  tagIds: new Set(),
  issueTypeIds: new Set(),
  iterationIds: new Set(),
  customFields: new Map(),
  validUserIds: new Set(),
  rules: new Map(Object.entries(rules)),
  selfRuleId,
});
const check = (
  actions: unknown[],
  c: WorkspaceRuleContext,
  scope: string | null = null,
) =>
  checkRuleSemantics(ok(rule(actions)), scope, c).map(
    (i) => `${i.code}@${i.path}`,
  );

describe('RUN_RULE against the workspace', () => {
  it('refuses a rule that does not exist, at the pointer', () => {
    expect(check([call('nope')], ctx({}))).toEqual([
      'UNKNOWN_RULE@/actions/0/rule',
    ]);
  });

  it('accepts a rule that exists and can run', () => {
    expect(check([call('b')], ctx({ b: R() }))).toEqual([]);
  });

  it('refuses a rule calling itself', () => {
    expect(check([call('me')], ctx({ me: R() }, 'me'))).toEqual([
      'RUN_RULE_CYCLE@/actions/0/rule',
    ]);
  });

  it('refuses a call that comes back, directly or through others', () => {
    expect(check([call('b')], ctx({ b: R({ calls: ['me'] }) }, 'me'))).toEqual([
      'RUN_RULE_CYCLE@/actions/0/rule',
    ]);
    expect(
      check(
        [call('b')],
        ctx(
          {
            b: R({ calls: ['c'] }),
            c: R({ calls: ['d'] }),
            d: R({ calls: ['me'] }),
          },
          'me',
        ),
      ),
    ).toEqual(['RUN_RULE_CYCLE@/actions/0/rule']);
  });

  it('survives a cycle that is already in the data (it does not loop forever)', () => {
    expect(
      check(
        [call('b')],
        ctx({ b: R({ calls: ['c'] }), c: R({ calls: ['b'] }) }, 'me'),
      ),
    ).toEqual([]);
  });

  it('allows chains up to the call depth (3 by default) and refuses longer ones', () => {
    // me -> b -> c -> d : depth 3
    const three = { b: R({ calls: ['c'] }), c: R({ calls: ['d'] }), d: R() };
    expect(check([call('b')], ctx(three, 'me'))).toEqual([]);
    // me -> b -> c -> d -> e : depth 4
    const four = { ...three, d: R({ calls: ['e'] }), e: R() };
    expect(check([call('b')], ctx(four, 'me'))).toEqual([
      'RUN_RULE_TOO_DEEP@/actions/0/rule',
    ]);
    process.env.AUTOMATION_MAX_CALL_DEPTH = '4';
    expect(check([call('b')], ctx(four, 'me'))).toEqual([]);
    process.env.AUTOMATION_MAX_CALL_DEPTH = '1';
    expect(
      check([call('b')], ctx({ b: R({ calls: ['c'] }), c: R() }, 'me')),
    ).toEqual(['RUN_RULE_TOO_DEEP@/actions/0/rule']);
  });

  it('a rule that cannot run (old format, or unsupported parts) cannot be called', () => {
    expect(check([call('b')], ctx({ b: R({ ruleVersion: 0 }) }))).toEqual([
      'RUN_RULE_UNAVAILABLE@/actions/0/rule',
    ]);
    expect(check([call('b')], ctx({ b: R({ hasUnsupported: true }) }))).toEqual(
      ['RUN_RULE_UNAVAILABLE@/actions/0/rule'],
    );
  });

  describe('scope', () => {
    it('a workspace-wide rule may only call workspace-wide rules', () => {
      expect(
        check([call('b')], ctx({ b: R({ projectId: 'p1' }) }), null),
      ).toEqual(['RUN_RULE_SCOPE@/actions/0/rule']);
      expect(
        check([call('b')], ctx({ b: R({ projectId: null }) }), null),
      ).toEqual([]);
    });
    it("a project rule may call its own project's rules and workspace-wide ones, not another project's", () => {
      expect(
        check([call('b')], ctx({ b: R({ projectId: 'p1' }) }), 'p1'),
      ).toEqual([]);
      expect(
        check([call('b')], ctx({ b: R({ projectId: null }) }), 'p1'),
      ).toEqual([]);
      expect(
        check([call('b')], ctx({ b: R({ projectId: 'p2' }) }), 'p1'),
      ).toEqual(['RUN_RULE_SCOPE@/actions/0/rule']);
    });
  });

  it('is found inside an IF, a loop and a WITH, at the nested pointer', () => {
    const cond = { all: [{ field: 'PRIORITY', op: 'IN', value: ['HIGH'] }] };
    const found = checkRuleSemantics(
      ok(
        rule([
          { type: 'IF', conditions: cond, then: [call('nope')] },
          { type: 'FOR_EACH', over: 'SUBTASKS', do: [call('nope')] },
        ]),
      ),
      null,
      ctx({}),
    ).map((i) => i.path);
    expect(found).toEqual(['/actions/0/then/0/rule', '/actions/1/do/0/rule']);
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
  vars: { 'task.title': 'Fix it' },
};

interface Target {
  name: string;
  ruleVersion?: number;
  unsupported?: unknown[];
  conditions?: unknown;
  actions: unknown[];
}
function harness(
  targets: Record<string, Target>,
  priority: string | null = 'HIGH',
) {
  const log: string[] = [];
  const asked: string[] = [];
  const prisma = {
    task: {
      findUnique: async () => ({
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
      }),
    },
    automation: {
      findFirst: async (q: { where: { id: string } }) => {
        asked.push(q.where.id);
        const t = targets[q.where.id];
        return t
          ? { ruleVersion: 1, unsupported: [], conditions: {}, ...t }
          : null;
      },
    },
  };
  const tags = {
    attach: async (_t: string, tagId: string) => {
      if (tagId === 'boom') throw new Error('boom');
      log.push(`attach:${tagId}`);
    },
  };
  const comments = {
    createSystemComment: async (
      _k: unknown,
      _t: string,
      _a: string,
      body: string,
    ) => void log.push(`comment:${body}`),
  };
  const ex = new ActionExecutor(
    prisma as never,
    {} as never,
    tags as never,
    {} as never,
    comments as never,
    {} as never,
    {} as never,
    {} as never, // the notifier
  );
  return { ex, log, asked };
}
const actions = (a: unknown[]) => ok(rule(a)).actions;
const high = { all: [{ field: 'PRIORITY', op: 'IN', value: ['HIGH'] }] };

describe('executing RUN_RULE', () => {
  it("runs the called rule's actions on the current task, inside this run", async () => {
    const h = harness({
      b: {
        name: 'Escalate',
        actions: [
          tag('x'),
          { type: 'COMMENT', body: 'escalated {{task.title}}' },
        ],
      },
    });
    const r = await h.ex.execute(
      actions([tag('before'), call('b'), tag('after')]),
      RUN,
    );
    expect(r).toEqual({ done: 4 }); // the call itself is not an action: what it runs is
    expect(h.log).toEqual([
      'attach:before',
      'attach:x',
      'comment:escalated Fix it',
      'attach:after',
    ]);
  });

  it("checks the called rule's OWN conditions and does nothing, successfully, when they do not hold", async () => {
    const targets = {
      b: { name: 'Escalate', conditions: high, actions: [tag('x')] },
    };
    const yes = harness(targets, 'HIGH');
    expect(await yes.ex.execute(actions([call('b')]), RUN)).toEqual({
      done: 1,
    });
    expect(yes.log).toEqual(['attach:x']);
    const no = harness(targets, 'LOW');
    expect(
      await no.ex.execute(actions([call('b'), tag('after')]), RUN),
    ).toEqual({ done: 1 });
    expect(no.log).toEqual(['attach:after']);
  });

  it('can be called from inside an IF branch and a loop-free WITH-less list alike', async () => {
    const h = harness({ b: { name: 'B', actions: [tag('x')] } });
    const r = await h.ex.execute(
      actions([{ type: 'IF', conditions: high, then: [call('b')] }]),
      RUN,
    );
    expect(r).toEqual({ done: 1 });
  });

  it('a failure inside the called rule is reported at the call, naming the rule', async () => {
    const h = harness({
      b: { name: 'Escalate', actions: [tag('ok'), tag('boom'), tag('never')] },
    });
    const r = await h.ex.execute(actions([tag('first'), call('b')]), RUN);
    expect(r).toMatchObject({
      done: 2,
      failedAt: 1,
      failedPath: '/actions/1/call/1',
      failedRule: { id: 'b', name: 'Escalate' },
    });
    expect(h.log).toEqual(['attach:first', 'attach:ok']);
  });

  it('names the INNERMOST rule when rules call rules', async () => {
    const h = harness({
      b: { name: 'Outer', actions: [call('c')] },
      c: { name: 'Inner', actions: [tag('boom')] },
    });
    const r = await h.ex.execute(actions([call('b')]), RUN);
    expect(r).toMatchObject({
      failedPath: '/actions/0/call/0/call/0',
      failedRule: { id: 'c', name: 'Inner' },
    });
  });

  it("shares the run budget: the called rule's actions count against the caller's limit", async () => {
    process.env.AUTOMATION_MAX_ACTIONS_PER_RUN = '3';
    const h = harness({
      b: { name: 'B', actions: [tag('1'), tag('2'), tag('3')] },
    });
    const r = await h.ex.execute(actions([tag('first'), call('b')]), RUN);
    expect(r.done).toBe(3);
    expect(r.error).toMatch(/limit of 3 actions/);
  });

  describe('guards at run time (the data may have changed since it was saved)', () => {
    it('stops a call chain that is deeper than the CURRENT limit', async () => {
      const h = harness({
        b: { name: 'B', actions: [call('c')] },
        c: { name: 'C', actions: [call('d')] },
        d: { name: 'D', actions: [call('e')] },
        e: { name: 'E', actions: [tag('x')] },
      });
      const r = await h.ex.execute(actions([call('b')]), RUN);
      expect(r.error).toMatch(/more than 3 deep/);
      expect(h.log).toEqual([]);
    });

    it('stops a cycle that got into the data (a calls b calls a), instead of running forever', async () => {
      const h = harness({
        a: { name: 'A', actions: [tag('x'), call('b')] },
        b: { name: 'B', actions: [call('a')] },
      });
      const r = await h.ex.execute(actions([call('a')]), RUN);
      expect(r.error).toMatch(/more than 3 deep/);
      expect(h.log.length).toBeLessThanOrEqual(3);
    });

    it('fails clearly when the called rule is gone, or cannot run', async () => {
      const gone = harness({});
      expect((await gone.ex.execute(actions([call('b')]), RUN)).error).toBe(
        'The rule to run no longer exists',
      );
      const old = harness({ b: { name: 'Old', ruleVersion: 0, actions: [] } });
      expect((await old.ex.execute(actions([call('b')]), RUN)).error).toMatch(
        /"Old" cannot be run/,
      );
      const unsupported = harness({
        b: { name: 'Half', unsupported: [{ path: '/x' }], actions: [tag()] },
      });
      expect(
        (await unsupported.ex.execute(actions([call('b')]), RUN)).error,
      ).toMatch(/"Half" cannot be run/);
    });

    it('fails when there is no task to run it on', async () => {
      const h = harness({ b: { name: 'B', actions: [tag()] } });
      const r = await h.ex.execute(actions([call('b')]), {
        ...RUN,
        taskId: null,
      });
      expect(r.error).toBe('The task no longer exists');
    });
  });
});
