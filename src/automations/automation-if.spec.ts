import { FieldType, TaskStatus } from '@prisma/client';
import { RefWalker } from '../templates/portable/portable.refs';
import { ActionExecutor, ActionRun } from './action-executor.service';
import {
  WorkspaceRuleContext,
  checkRuleSemantics,
  collectReferences,
  validateRule,
} from './dsl';
import {
  TREE_LIMIT_DEFAULTS,
  TREE_LIMIT_ENV,
  TREE_LIMIT_HARD_MAX,
  maxJsonDepthFor,
  treeLimits,
} from './dsl/rule.settings';

/** Step 5.10: if/else inside a rule, and the numbers around it being configurable. */

const ENV_KEYS = Object.values(TREE_LIMIT_ENV); // all four, so no test leaks a setting
const saved: Record<string, string | undefined> = {};
beforeEach(() =>
  ENV_KEYS.forEach((k) => ((saved[k] = process.env[k]), delete process.env[k])),
);
afterEach(() =>
  ENV_KEYS.forEach((k) =>
    saved[k] === undefined
      ? delete process.env[k]
      : (process.env[k] = saved[k]),
  ),
);

const cond = { all: [{ field: 'PRIORITY', op: 'IN', value: ['HIGH'] }] };
const tag = (id = 't1') => ({ type: 'ADD_TAG', tagId: id });
const IF = (
  then: unknown[],
  other?: unknown[],
  conditions: unknown = cond,
) => ({
  type: 'IF',
  conditions,
  then,
  ...(other ? { else: other } : {}),
});
const rule = (
  actions: unknown[],
  trigger: unknown = { type: 'STATUS_CHANGED' },
) => ({
  trigger,
  actions,
});
/** n IFs inside one another, an action in the innermost */
const nested = (n: number): unknown => (n === 0 ? tag() : IF([nested(n - 1)]));
const codes = (r: unknown) =>
  (r as { ok: boolean; issues?: Array<{ code: string }> }).ok
    ? []
    : (r as { issues: Array<{ code: string }> }).issues.map((i) => i.code);

describe('configurable limits', () => {
  it('default to depth 3 and 30 actions', () => {
    expect(treeLimits()).toMatchObject({ maxIfDepth: 3, maxTotalActions: 30 });
    expect(TREE_LIMIT_DEFAULTS).toMatchObject({
      maxIfDepth: 3,
      maxTotalActions: 30,
    });
  });

  it('read the environment on every call', () => {
    process.env.AUTOMATION_MAX_IF_DEPTH = '2';
    process.env.AUTOMATION_MAX_TOTAL_ACTIONS = '50';
    expect(treeLimits()).toMatchObject({
      maxIfDepth: 2,
      maxTotalActions: 50,
    });
    process.env.AUTOMATION_MAX_IF_DEPTH = '4';
    expect(treeLimits().maxIfDepth).toBe(4);
  });

  it.each([
    '',
    ' ',
    'abc',
    '0',
    '-1',
    '2.5',
    '1e3',
    '6',
    '101',
    '999999999',
    'NaN',
  ])(
    'ignores the bad or out-of-range IF depth %j (the default applies, the guard is never switched off)',
    (bad) => {
      process.env.AUTOMATION_MAX_IF_DEPTH = bad;
      expect(treeLimits().maxIfDepth).toBe(TREE_LIMIT_DEFAULTS.maxIfDepth);
    },
  );

  it.each(['', ' ', 'abc', '0', '-1', '2.5', '1e3', '101', '999999999', 'NaN'])(
    'ignores the bad or out-of-range action total %j',
    (bad) => {
      process.env.AUTOMATION_MAX_TOTAL_ACTIONS = bad;
      expect(treeLimits().maxTotalActions).toBe(
        TREE_LIMIT_DEFAULTS.maxTotalActions,
      );
    },
  );

  it('accepts exactly the hard ceilings and nothing above', () => {
    process.env.AUTOMATION_MAX_IF_DEPTH = String(
      TREE_LIMIT_HARD_MAX.maxIfDepth,
    );
    process.env.AUTOMATION_MAX_TOTAL_ACTIONS = String(
      TREE_LIMIT_HARD_MAX.maxTotalActions,
    );
    process.env.AUTOMATION_MAX_FOR_EACH_ITEMS = String(
      TREE_LIMIT_HARD_MAX.maxForEachItems,
    );
    process.env.AUTOMATION_MAX_ACTIONS_PER_RUN = String(
      TREE_LIMIT_HARD_MAX.maxActionsPerRun,
    );
    process.env.AUTOMATION_MAX_WAIT_DAYS = String(
      TREE_LIMIT_HARD_MAX.maxWaitDays,
    );
    process.env.AUTOMATION_MAX_PENDING_WAITS = String(
      TREE_LIMIT_HARD_MAX.maxPendingWaits,
    );
    process.env.AUTOMATION_MAX_NOTIFY_RECIPIENTS = String(
      TREE_LIMIT_HARD_MAX.maxNotifyRecipients,
    );
    process.env.AUTOMATION_MAX_CALL_DEPTH = String(
      TREE_LIMIT_HARD_MAX.maxCallDepth,
    );
    process.env.AUTOMATION_MAX_LOOP_STEPS_PER_RUN = String(
      TREE_LIMIT_HARD_MAX.maxLoopSteps,
    );
    expect(treeLimits()).toEqual(TREE_LIMIT_HARD_MAX);
    process.env.AUTOMATION_MAX_IF_DEPTH = String(
      TREE_LIMIT_HARD_MAX.maxIfDepth + 1,
    );
    expect(treeLimits().maxIfDepth).toBe(TREE_LIMIT_DEFAULTS.maxIfDepth);
  });

  it('takes an explicit env (so a caller can pass its own)', () => {
    expect(
      treeLimits({ AUTOMATION_MAX_IF_DEPTH: '5' } as never).maxIfDepth,
    ).toBe(5);
  });

  it('JSON depth allowance never drops below 12 and grows with the IF depth (one spare level, wider for else-if)', () => {
    const limits = (maxIfDepth: number) => ({
      ...TREE_LIMIT_DEFAULTS,
      maxIfDepth,
    });
    expect(maxJsonDepthFor(12, limits(1))).toBe(13);
    expect(maxJsonDepthFor(12, limits(3))).toBe(21);
    expect(maxJsonDepthFor(12, limits(5))).toBe(29);
  });
});

describe('loop limits are configurable too', () => {
  it('default to 100 tasks per loop and 300 actions per run', () => {
    expect(treeLimits()).toMatchObject({
      maxForEachItems: 100,
      maxActionsPerRun: 300,
    });
  });
  it.each(['', 'x', '0', '-1', '1.5', '1001'])(
    'ignores the bad loop size %j',
    (bad) => {
      process.env.AUTOMATION_MAX_FOR_EACH_ITEMS = bad;
      expect(treeLimits().maxForEachItems).toBe(100);
    },
  );
  it.each(['', 'x', '0', '-1', '1.5', '2001'])(
    'ignores the bad per-run budget %j',
    (bad) => {
      process.env.AUTOMATION_MAX_ACTIONS_PER_RUN = bad;
      expect(treeLimits().maxActionsPerRun).toBe(300);
    },
  );
  it.each(['', 'x', '0', '-1', '1.5', '5001'])(
    'ignores the bad loop-step budget %j',
    (bad) => {
      process.env.AUTOMATION_MAX_LOOP_STEPS_PER_RUN = bad;
      expect(treeLimits().maxLoopSteps).toBe(500);
    },
  );
  it('accepts values up to the ceilings', () => {
    process.env.AUTOMATION_MAX_FOR_EACH_ITEMS = '1000';
    process.env.AUTOMATION_MAX_ACTIONS_PER_RUN = '7';
    expect(treeLimits()).toMatchObject({
      maxForEachItems: 1000,
      maxActionsPerRun: 7,
    });
  });
});

describe('validating an IF', () => {
  it('accepts then, then + else, and the example', () => {
    expect(validateRule(rule([IF([tag()])])).ok).toBe(true);
    expect(
      validateRule(rule([IF([tag()], [{ type: 'COMMENT', body: 'no' }])])).ok,
    ).toBe(true);
  });

  it('needs at least one condition, a non-empty then, and a non-empty else when given', () => {
    expect(codes(validateRule(rule([IF([tag()], undefined, {})])))).toContain(
      'MISSING',
    );
    expect(
      codes(validateRule(rule([{ type: 'IF', then: [tag()] }]))),
    ).toContain('MISSING');
    expect(validateRule(rule([IF([])])).ok).toBe(false);
    expect(validateRule(rule([IF([tag()], [])])).ok).toBe(false);
  });

  it('is strict about unknown keys and bad actions inside a branch, reporting the nested path', () => {
    const r = validateRule(rule([IF([{ type: 'ADD_TAG' }, { type: 'NOPE' }])]));
    expect(r.ok).toBe(false);
    const paths = (r as { issues: Array<{ path: string }> }).issues.map(
      (i) => i.path,
    );
    expect(paths).toEqual(
      expect.arrayContaining([
        '/actions/0/then/0/tagId',
        '/actions/0/then/1/type',
      ]),
    );
    expect(validateRule(rule([{ ...IF([tag()]), extra: 1 }])).ok).toBe(false);
  });

  it('checks the IF conditions with the rule-level condition check (bad operator refused)', () => {
    const bad = { all: [{ field: 'PRIORITY', op: 'GT', value: 3 }] };
    expect(validateRule(rule([IF([tag()], undefined, bad)])).ok).toBe(false);
  });

  it('allows 3 IFs inside one another by default and refuses the 4th, at its pointer', () => {
    expect(validateRule(rule([nested(3)])).ok).toBe(true);
    const r = validateRule(rule([nested(4)])) as {
      ok: boolean;
      issues: Array<{ code: string; path: string }>;
    };
    expect(r.ok).toBe(false);
    expect(r.issues).toEqual([
      expect.objectContaining({
        code: 'IF_TOO_DEEP',
        path: '/actions/0/then/0/then/0/then/0',
      }),
    ]);
  });

  it('follows AUTOMATION_MAX_IF_DEPTH, both ways, up to the hard ceiling', () => {
    process.env.AUTOMATION_MAX_IF_DEPTH = '1';
    expect(validateRule(rule([nested(1)])).ok).toBe(true);
    expect(codes(validateRule(rule([nested(2)])))).toEqual(['IF_TOO_DEEP']);
    process.env.AUTOMATION_MAX_IF_DEPTH = '5';
    expect(validateRule(rule([nested(5)])).ok).toBe(true);
    expect(codes(validateRule(rule([nested(6)])))).toEqual(['IF_TOO_DEEP']);
  });

  it('a deeply nested rule with long values still fits the JSON depth allowance', () => {
    process.env.AUTOMATION_MAX_IF_DEPTH = '5';
    const deepCond = { all: [{ field: 'STATUS', op: 'IN', value: ['s1'] }] };
    let node: unknown = { type: 'SET_STATUS', status: { statusId: 's1' } };
    for (let i = 0; i < 5; i++) node = IF([node], undefined, deepCond);
    expect(validateRule(rule([node])).ok).toBe(true);
  });

  it('caps the whole rule, branches and the IFs themselves included', () => {
    // 3 IFs x (1 + 10) = 33 > 30
    const big = [0, 1, 2].map(() =>
      IF(Array.from({ length: 10 }, () => tag())),
    );
    expect(codes(validateRule(rule(big)))).toEqual(['TOO_MANY_ACTIONS']);
    const ok = [0, 1].map(() => IF(Array.from({ length: 10 }, () => tag()))); // 22
    expect(validateRule(rule(ok)).ok).toBe(true);
    process.env.AUTOMATION_MAX_TOTAL_ACTIONS = '40';
    expect(validateRule(rule(big)).ok).toBe(true);
    process.env.AUTOMATION_MAX_TOTAL_ACTIONS = '5';
    expect(
      codes(validateRule(rule([IF([tag(), tag(), tag(), tag(), tag()])]))),
    ).toEqual(['TOO_MANY_ACTIONS']);
  });

  it('is not allowed in a SCHEDULE rule (it needs a task)', () => {
    const r = validateRule(
      rule([IF([{ type: 'CREATE_TASK', title: 'x' }])], {
        type: 'SCHEDULE',
        frequency: 'DAILY',
        hour: 1,
      }),
    );
    expect(codes(r)).toEqual(['ACTION_NEEDS_TASK']);
  });

  it('reports a construct that cannot run yet at its nested pointer', () => {
    const r = validateRule(
      rule([
        IF([{ type: 'NOTIFY_CHANNEL', channelLinkId: 'c', message: 'm' }]),
      ]),
    ) as { ok: true; unsupported: Array<{ path: string; construct: string }> };
    expect(r.ok).toBe(true);
    expect(r.unsupported.map((u) => u.path)).toEqual(['/actions/0/then/0']);
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
  >([['f_user', { dataType: FieldType.USER, options: null }]]),
  validUserIds: new Set(['u1']),
});
const ok = (input: unknown) => {
  const v = validateRule(input);
  if (v.ok === false) throw new Error(JSON.stringify(v.issues));
  return v.rule;
};

describe('an IF through the semantic checks', () => {
  it('collects the ids of its conditions and of every nested action', () => {
    const r = collectReferences(
      ok(
        rule([
          IF(
            [
              tag('t_then'),
              IF([{ type: 'ASSIGN', mode: 'ADD', users: ['u1', 'TRIGGERER'] }]),
            ],
            [tag('t_else')],
            { all: [{ field: 'TAGS', op: 'HAS_ANY', value: ['t_cond'] }] },
          ),
        ]),
      ),
    );
    expect([...r.tagIds].sort()).toEqual(['t_cond', 't_else', 't_then']);
    expect([...r.userIds]).toEqual(['u1']);
  });

  it('reports an unknown id at the nested pointer, in a branch and in the IF conditions', () => {
    const issues = checkRuleSemantics(
      ok(
        rule([
          IF([tag('t1'), tag('zz')], [tag('yy')], {
            all: [{ field: 'TAGS', op: 'HAS_ANY', value: ['xx'] }],
          }),
        ]),
      ),
      'p1',
      ctx(),
    );
    expect(issues.map((i) => i.path).sort()).toEqual([
      '/actions/0/conditions/all/0/value/0',
      '/actions/0/else/0/tagId',
      '/actions/0/then/1/tagId',
    ]);
  });

  it('checks a custom-field value inside a branch against its field', () => {
    const issues = checkRuleSemantics(
      ok(
        rule([
          IF([
            {
              type: 'SET_CUSTOM_FIELD',
              customFieldId: 'f_user',
              value: ['nobody'],
            },
          ]),
        ]),
      ),
      'p1',
      ctx(),
    );
    expect(issues.map((i) => `${i.code}@${i.path}`)).toEqual([
      'VALUE_MISMATCH@/actions/0/then/0/value',
    ]);
  });

  it('still refuses creating what triggers the rule, when that is inside an IF', () => {
    const issues = checkRuleSemantics(
      ok(
        rule([IF([{ type: 'CREATE_SUBTASK', title: 's' }])], {
          type: 'TASK_CREATED',
        }),
      ),
      'p1',
      ctx(),
    );
    expect(issues.map((i) => `${i.code}@${i.path}`)).toEqual([
      'UNBOUNDED_RECURSION@/actions/0/then/0',
    ]);
  });
});

describe('an IF in a template', () => {
  it('has the ids of its conditions and branches translated, at nested pointers', () => {
    const calls: string[] = [];
    const out = new RefWalker((kind, value, path) => {
      calls.push(`${kind}:${value}@${path}`);
      return `<${value}>`;
    }).rule(
      rule([
        IF([tag('a')], [IF([tag('b')])], {
          all: [{ field: 'TAGS', op: 'HAS_ANY', value: ['c'] }],
        }),
      ]),
    ) as {
      actions: Array<{
        then: Array<{ tagId: string }>;
        conditions: { all: Array<{ value: string[] }> };
      }>;
    };
    expect(calls).toEqual([
      'tag:c@/actions/0/conditions/all/0/value/0',
      'tag:a@/actions/0/then/0/tagId',
      'tag:b@/actions/0/else/0/then/0/tagId',
    ]);
    expect(out.actions[0].then[0].tagId).toBe('<a>');
    expect(out.actions[0].conditions.all[0].value[0]).toBe('<c>');
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
  vars: {},
};

function harness(initial: { priority: string | null; tags: string[] }) {
  const log: string[] = [];
  const state = { ...initial, gone: false };
  const prisma = {
    task: {
      findUnique: async () =>
        state.gone
          ? null
          : {
              status: 'TODO',
              workflowStatusId: null,
              priority: state.priority,
              estimate: null,
              dueDate: null,
              createdById: 'c1',
              issueTypeId: null,
              projectId: 'p1',
              parentId: null,
              assignees: [],
              tags: state.tags.map((tagId) => ({ tagId })),
              customValues: [],
            },
    },
  };
  const tags = {
    attach: async (_t: string, tagId: string) => {
      log.push(`attach:${tagId}`);
      state.tags.push(tagId);
    },
    detach: async (_t: string, tagId: string) =>
      void log.push(`detach:${tagId}`),
  };
  const tasks = {
    update: async (_t: string, dto: Record<string, unknown>) => {
      log.push(`update:${JSON.stringify(dto)}`);
      if (dto.priority) state.priority = dto.priority as string;
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
    tasks as never,
    tags as never,
    {} as never,
    comments as never,
    {} as never,
    {} as never, // the task query: no loop in these tests
    {} as never, // the notifier
  );
  return { ex, log, state };
}
const actions = (a: unknown[]) => ok(rule(a)).actions;

describe('executing an IF', () => {
  it('runs `then` when the conditions hold and `else` when they do not', async () => {
    const a = actions([IF([tag('yes')], [tag('no')])]);
    const hit = harness({ priority: 'HIGH', tags: [] });
    expect(await hit.ex.execute(a, RUN)).toEqual({ done: 1 });
    expect(hit.log).toEqual(['attach:yes']);
    const miss = harness({ priority: 'LOW', tags: [] });
    expect(await miss.ex.execute(a, RUN)).toEqual({ done: 1 });
    expect(miss.log).toEqual(['attach:no']);
  });

  it('does nothing when it does not hold and there is no else (and counts nothing)', async () => {
    const h = harness({ priority: 'LOW', tags: [] });
    expect(await h.ex.execute(actions([IF([tag()])]), RUN)).toEqual({
      done: 0,
    });
    expect(h.log).toEqual([]);
  });

  it('looks at the task WHEN IT RUNS: an earlier action of the same rule is visible', async () => {
    const a = actions([
      { type: 'SET_PRIORITY', priority: 'HIGH' },
      IF(
        [{ type: 'COMMENT', body: 'now high' }],
        [{ type: 'COMMENT', body: 'still low' }],
      ),
    ]);
    const h = harness({ priority: 'LOW', tags: [] });
    expect(await h.ex.execute(a, RUN)).toEqual({ done: 2 });
    expect(h.log).toEqual(['update:{"priority":"HIGH"}', 'comment:now high']);
  });

  it('counts only real actions in `done` and runs nested IFs', async () => {
    const a = actions([
      IF([
        tag('a'),
        IF([tag('b'), tag('c')], undefined, {
          all: [{ field: 'PRIORITY', op: 'IN', value: ['HIGH'] }],
        }),
      ]),
      tag('d'),
    ]);
    const h = harness({ priority: 'HIGH', tags: [] });
    expect(await h.ex.execute(a, RUN)).toEqual({ done: 4 });
    expect(h.log).toEqual(['attach:a', 'attach:b', 'attach:c', 'attach:d']);
  });

  it('stops at the first failure and says exactly where, with the top-level index', async () => {
    const a = actions([
      tag('first'),
      IF([tag('ok'), { type: 'SET_PRIORITY', priority: null }, tag('never')]),
      tag('never2'),
    ]);
    const h = harness({ priority: 'HIGH', tags: [] });
    const r = await h.ex.execute(a, RUN);
    expect(r).toMatchObject({
      done: 2,
      failedAt: 1,
      failedPath: '/actions/1/then/1',
      error: expect.stringMatching(/not supported/i),
    });
    expect(h.log).toEqual(['attach:first', 'attach:ok']);
  });

  it('a failure in a deeper branch carries the full pointer', async () => {
    const a = actions([IF([IF([{ type: 'SET_PRIORITY', priority: null }])])]);
    const r = await harness({ priority: 'HIGH', tags: [] }).ex.execute(a, RUN);
    expect(r.failedPath).toBe('/actions/0/then/0/then/0');
    expect(r.failedAt).toBe(0);
  });

  it('fails clearly when the task is gone by the time the IF runs', async () => {
    const h = harness({ priority: 'HIGH', tags: [] });
    h.state.gone = true;
    const r = await h.ex.execute(actions([IF([tag()])]), RUN);
    expect(r).toMatchObject({
      done: 0,
      failedPath: '/actions/0',
      error: 'The task no longer exists',
    });
  });

  it('refuses to run a stored rule over the CURRENT limits, and runs nothing', async () => {
    const stored = actions([IF([tag(), tag(), tag()])]); // 4 nodes
    process.env.AUTOMATION_MAX_TOTAL_ACTIONS = '3';
    const h = harness({ priority: 'HIGH', tags: [] });
    const r = await h.ex.execute(stored, RUN);
    expect(r.error).toMatch(/more actions than the current limit of 3/);
    expect(h.log).toEqual([]);
    process.env.AUTOMATION_MAX_TOTAL_ACTIONS = '4';
    expect((await h.ex.execute(stored, RUN)).error).toBeUndefined();
  });

  it('refuses a stored rule nested deeper than the CURRENT depth limit', async () => {
    const stored = actions([nested(3)]);
    process.env.AUTOMATION_MAX_IF_DEPTH = '2';
    const h = harness({ priority: 'HIGH', tags: [] });
    const r = await h.ex.execute(stored, RUN);
    expect(r.error).toMatch(/deeper than the current limit of 2/);
    expect(h.log).toEqual([]);
  });
});

describe('else if', () => {
  const when = (field: string, value: string[]) => ({
    all: [{ field, op: 'IN', value }],
  });
  const chain = (extra: object = {}) =>
    rule([
      {
        type: 'IF',
        conditions: when('PRIORITY', ['URGENT']),
        then: [tag('urgent')],
        elseIf: [
          { conditions: when('PRIORITY', ['HIGH']), then: [tag('high')] },
          { conditions: when('PRIORITY', ['MEDIUM']), then: [tag('medium')] },
        ],
        else: [tag('low')],
        ...extra,
      },
    ]);

  it('validates a full if / else if / else chain', () => {
    expect(validateRule(chain()).ok).toBe(true);
    expect(validateRule(chain({ else: undefined })).ok).toBe(true);
  });

  it('needs at least one case, each with a condition and a non-empty then', () => {
    expect(validateRule(chain({ elseIf: [] })).ok).toBe(false);
    expect(
      codes(
        validateRule(chain({ elseIf: [{ conditions: {}, then: [tag()] }] })),
      ),
    ).toContain('MISSING');
    expect(
      validateRule(chain({ elseIf: [{ conditions: cond, then: [] }] })).ok,
    ).toBe(false);
    expect(
      validateRule(
        chain({ elseIf: [{ conditions: cond, then: [tag()], x: 1 }] }),
      ).ok,
    ).toBe(false);
  });

  it('reports a bad action inside a case at its full pointer', () => {
    const r = validateRule(
      chain({ elseIf: [{ conditions: cond, then: [{ type: 'ADD_TAG' }] }] }),
    ) as { issues: Array<{ path: string }> };
    expect(r.issues.map((i) => i.path)).toEqual([
      '/actions/0/elseIf/0/then/0/tagId',
    ]);
  });

  it("does not add nesting depth: cases sit at the IF's own level", () => {
    // 3 IFs deep, each reached through an elseIf case, is still allowed at the default of 3
    let node: unknown = tag();
    for (let i = 0; i < 3; i++)
      node = {
        type: 'IF',
        conditions: cond,
        then: [tag()],
        elseIf: [{ conditions: cond, then: [node] }],
      };
    expect(validateRule(rule([node])).ok).toBe(true);
    let four: unknown = tag();
    for (let i = 0; i < 4; i++)
      four = {
        type: 'IF',
        conditions: cond,
        then: [tag()],
        elseIf: [{ conditions: cond, then: [four] }],
      };
    expect(codes(validateRule(rule([four])))).toEqual(['IF_TOO_DEEP']);
  });

  it('counts the actions inside cases in the whole-rule total', () => {
    process.env.AUTOMATION_MAX_TOTAL_ACTIONS = '4';
    expect(validateRule(chain()).ok).toBe(false); // 1 IF + 4 actions
    process.env.AUTOMATION_MAX_TOTAL_ACTIONS = '5';
    expect(validateRule(chain()).ok).toBe(true);
  });

  it('collects and checks ids in case conditions and actions, at their pointers', () => {
    const r = ok(
      rule([
        {
          type: 'IF',
          conditions: cond,
          then: [tag('t1')],
          elseIf: [
            {
              conditions: {
                all: [{ field: 'TAGS', op: 'HAS_ANY', value: ['c1'] }],
              },
              then: [tag('c2')],
            },
          ],
        },
      ]),
    );
    expect([...collectReferences(r).tagIds].sort()).toEqual(['c1', 'c2', 't1']);
    expect(
      checkRuleSemantics(r, 'p1', ctx())
        .map((i) => i.path)
        .sort(),
    ).toEqual([
      '/actions/0/elseIf/0/conditions/all/0/value/0',
      '/actions/0/elseIf/0/then/0/tagId',
    ]);
  });

  it('is translated in a template: case conditions and actions', () => {
    const calls: string[] = [];
    new RefWalker((kind, value, path) => {
      calls.push(`${kind}:${value}@${path}`);
      return value;
    }).rule(
      rule([
        {
          type: 'IF',
          conditions: cond,
          then: [tag('a')],
          elseIf: [
            {
              conditions: {
                all: [{ field: 'TAGS', op: 'HAS_ANY', value: ['b'] }],
              },
              then: [tag('c')],
            },
          ],
        },
      ]),
    );
    expect(calls).toEqual([
      'tag:a@/actions/0/then/0/tagId',
      'tag:b@/actions/0/elseIf/0/conditions/all/0/value/0',
      'tag:c@/actions/0/elseIf/0/then/0/tagId',
    ]);
  });

  describe('executing', () => {
    const pickFor = async (priority: string | null) => {
      const h = harness({ priority, tags: [] });
      const r = await h.ex.execute(actions([chain().actions[0]]), RUN);
      return { r, log: h.log };
    };
    it.each([
      ['URGENT', 'attach:urgent'],
      ['HIGH', 'attach:high'],
      ['MEDIUM', 'attach:medium'],
      ['LOW', 'attach:low'],
      [null, 'attach:low'],
    ])('priority %s runs exactly the %s branch', async (priority, expected) => {
      const { r, log } = await pickFor(priority);
      expect(r).toEqual({ done: 1 });
      expect(log).toEqual([expected]);
    });

    it('the FIRST case that holds wins, even if later ones would too', async () => {
      const h = harness({ priority: 'HIGH', tags: [] });
      const both = rule([
        {
          type: 'IF',
          conditions: when('PRIORITY', ['URGENT']),
          then: [tag('first')],
          elseIf: [
            { conditions: when('PRIORITY', ['HIGH']), then: [tag('second')] },
            {
              conditions: when('PRIORITY', ['HIGH', 'MEDIUM']),
              then: [tag('third')],
            },
          ],
        },
      ]);
      await h.ex.execute(ok(both).actions, RUN);
      expect(h.log).toEqual(['attach:second']);
    });

    it('with no else, nothing runs when no case holds', async () => {
      const h = harness({ priority: 'LOW', tags: [] });
      const r = await h.ex.execute(
        actions([chain({ else: undefined }).actions[0]]),
        RUN,
      );
      expect(r).toEqual({ done: 0 });
      expect(h.log).toEqual([]);
    });

    it('a failure inside a case is reported at the case pointer', async () => {
      const h = harness({ priority: 'HIGH', tags: [] });
      const failing = rule([
        {
          type: 'IF',
          conditions: when('PRIORITY', ['URGENT']),
          then: [tag()],
          elseIf: [
            {
              conditions: when('PRIORITY', ['HIGH']),
              then: [tag('ok'), { type: 'SET_PRIORITY', priority: null }],
            },
          ],
        },
      ]);
      const r = await h.ex.execute(ok(failing).actions, RUN);
      expect(r).toMatchObject({
        done: 1,
        failedAt: 0,
        failedPath: '/actions/0/elseIf/0/then/1',
      });
    });
  });
});
