import { FieldType, TaskStatus } from '@prisma/client';
import { ActionExecutor, ActionRun } from './action-executor.service';
import {
  WorkspaceRuleContext,
  checkRuleSemantics,
  collectReferences,
  validateRule,
} from './dsl';
import { TREE_LIMIT_ENV } from './dsl/rule.settings';

/** Step 5.14: NOTIFY, and ASSIGNEES / WATCHERS as people in any action. */

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

const notify = (users: string[], message = 'hello') => ({
  type: 'NOTIFY',
  users,
  message,
});
const rule = (
  actions: unknown[],
  trigger: unknown = { type: 'STATUS_CHANGED' },
) => ({ trigger, actions });
const ok = (input: unknown) => {
  const v = validateRule(input);
  if (v.ok === false) throw new Error(JSON.stringify(v.issues));
  return v.rule;
};
const ctx = (): WorkspaceRuleContext => ({
  projectIds: new Set(['p1']),
  statuses: new Map([['s1', { projectId: 'p1', category: TaskStatus.TODO }]]),
  tagIds: new Set(),
  issueTypeIds: new Set(),
  iterationIds: new Set(),
  customFields: new Map<
    string,
    { dataType: FieldType; options: string[] | null }
  >(),
  validUserIds: new Set(['u1', 'u2']),
});

describe('validating NOTIFY', () => {
  it('takes 1 to 10 people and a message', () => {
    expect(validateRule(rule([notify(['u1'])])).ok).toBe(true);
    expect(validateRule(rule([notify([])])).ok).toBe(false);
    expect(
      validateRule(
        rule([notify(Array.from({ length: 11 }, (_, i) => `u${i}`))]),
      ).ok,
    ).toBe(false);
    expect(validateRule(rule([{ type: 'NOTIFY', users: ['u1'] }])).ok).toBe(
      false,
    );
    expect(validateRule(rule([{ ...notify(['u1']), extra: 1 }])).ok).toBe(
      false,
    );
  });

  it('fills placeholders and refuses unknown ones, like any text', () => {
    expect(
      validateRule(
        rule([
          notify(['u1'], '{{task.key}} is {{task.status}} ({{trigger.to}})'),
        ]),
      ).ok,
    ).toBe(true);
    expect(validateRule(rule([notify(['u1'], '{{nope}}')])).ok).toBe(false);
    expect(validateRule(rule([notify(['u1'], 'x'.repeat(2001))])).ok).toBe(
      false,
    );
  });

  it('can use a captured task in its message', () => {
    expect(
      validateRule(
        rule([
          { type: 'CREATE_TASK', title: 'x', as: 'f' },
          notify(['u1'], 'See {{f.key}} for {{f.assignees}}'),
        ]),
      ).ok,
    ).toBe(true);
    expect(validateRule(rule([notify(['u1'], 'See {{f.key}}')])).ok).toBe(
      false,
    );
  });
});

describe('people tokens', () => {
  it.each(['TRIGGERER', 'CREATOR', 'ASSIGNEES', 'WATCHERS'])(
    '%s needs no lookup and is accepted in every action that takes people',
    (t) => {
      const r = ok(
        rule([
          notify([t]),
          { type: 'ASSIGN', mode: 'ADD', users: [t] },
          { type: 'CREATE_TASK', title: 'x', assignees: [t] },
          { type: 'CREATE_SUBTASK', title: 'x', assignees: [t] },
        ]),
      );
      expect(checkRuleSemantics(r, 'p1', ctx())).toEqual([]);
      expect([...collectReferences(r).userIds]).toEqual([]);
    },
  );

  it('a real id is still checked, at its pointer', () => {
    const issues = checkRuleSemantics(
      ok(rule([notify(['u1', 'ghost', 'ASSIGNEES'])])),
      'p1',
      ctx(),
    );
    expect(issues.map((i) => `${i.code}@${i.path}`)).toEqual([
      'UNKNOWN_USER@/actions/0/users/1',
    ]);
    expect(
      [
        ...collectReferences(ok(rule([notify(['u1', 'ghost'])]))).userIds,
      ].sort(),
    ).toEqual(['ghost', 'u1']);
  });

  it('conditions compare with ONE person at a time: the group tokens are not accepted there', () => {
    const r = ok({
      trigger: { type: 'STATUS_CHANGED' },
      conditions: {
        all: [{ field: 'ASSIGNEES', op: 'INCLUDES_ANY', value: ['WATCHERS'] }],
      },
      actions: [notify(['u1'])],
    });
    expect(checkRuleSemantics(r, 'p1', ctx()).map((i) => i.code)).toEqual([
      'UNKNOWN_USER',
    ]);
  });
});

// ------------------------------------------------------------------ executing ------------------
const RUN: ActionRun = {
  ruleId: 'rule1',
  writeDepth: 1,
  workspaceId: 'w1',
  projectId: 'p1',
  taskId: 'task1',
  createdById: 'creator',
  triggererId: 'trigger',
  actorId: 'sys',
  vars: { 'task.key': 'ABC-1', 'task.status': 'Done', 'trigger.to': 'Done' },
};

function harness(
  opts: { assignees?: string[]; watchers?: string[]; taskGone?: boolean } = {},
) {
  const sent: Array<Record<string, unknown>> = [];
  const log: string[] = [];
  const prisma = {
    task: {
      findUnique: async () =>
        opts.taskGone
          ? null
          : { assignees: (opts.assignees ?? []).map((id) => ({ id })) },
    },
    watch: {
      findMany: async (q: {
        where: { targetType: string; targetId: string };
      }) => {
        log.push(`watchers of ${q.where.targetType}:${q.where.targetId}`);
        return (opts.watchers ?? []).map((userId) => ({ userId }));
      },
    },
  };
  const tasks = {
    setAssignees: async (_id: string, dto: { userIds: string[] }) =>
      void log.push(`setAssignees:${dto.userIds.join(',')}`),
  };
  const notifier = {
    notify: async (input: Record<string, unknown>) => void sent.push(input),
  };
  const ex = new ActionExecutor(
    prisma as never,
    tasks as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    notifier as never,
  );
  return { ex, sent, log };
}
const actions = (a: unknown[]) => ok(rule(a)).actions;

describe('executing NOTIFY', () => {
  it('sends the rendered message to the people, once each, with where it came from', async () => {
    const h = harness();
    const r = await h.ex.execute(
      actions([
        notify(
          ['u1', 'TRIGGERER', 'u1', 'CREATOR'],
          '{{task.key}} is now {{task.status}}',
        ),
      ]),
      RUN,
    );
    expect(r).toEqual({ done: 1 });
    expect(h.sent).toEqual([
      {
        workspaceId: 'w1',
        automationId: 'rule1',
        taskId: 'task1',
        userIds: ['u1', 'trigger', 'creator'],
        message: 'ABC-1 is now Done',
      },
    ]);
  });

  it('expands ASSIGNEES and WATCHERS from the current task, and a person in both gets ONE', async () => {
    const h = harness({ assignees: ['a1', 'both'], watchers: ['both', 'w1'] });
    await h.ex.execute(actions([notify(['ASSIGNEES', 'WATCHERS'])]), RUN);
    expect(h.sent[0].userIds).toEqual(['a1', 'both', 'w1']);
    expect(h.log).toEqual(['watchers of TASK:task1']);
  });

  it('does not look the groups up unless it is asked to', async () => {
    const h = harness({ assignees: ['a1'], watchers: ['w1'] });
    await h.ex.execute(actions([notify(['u1'])]), RUN);
    expect(h.log).toEqual([]);
  });

  it('a group with nobody in it sends nothing, and that is not a failure', async () => {
    const h = harness();
    expect(
      await h.ex.execute(actions([notify(['ASSIGNEES', 'WATCHERS'])]), RUN),
    ).toEqual({ done: 1 });
    expect(h.sent).toEqual([]);
  });

  it('a token with nobody behind it (a sweep has no triggerer) is dropped', async () => {
    const h = harness();
    await h.ex.execute(actions([notify(['TRIGGERER', 'u1'])]), {
      ...RUN,
      triggererId: null,
    });
    expect(h.sent[0].userIds).toEqual(['u1']);
  });

  it('fails, sending to NO ONE, when a group is bigger than the limit', async () => {
    process.env.AUTOMATION_MAX_NOTIFY_RECIPIENTS = '2';
    const h = harness({ watchers: ['w1', 'w2', 'w3'] });
    const r = await h.ex.execute(actions([notify(['WATCHERS'])]), RUN);
    expect(r).toMatchObject({ done: 0, failedPath: '/actions/0' });
    expect(r.error).toMatch(/notify 3 people; the limit is 2/);
    expect(h.sent).toEqual([]);
    process.env.AUTOMATION_MAX_NOTIFY_RECIPIENTS = '3';
    expect(
      (await h.ex.execute(actions([notify(['WATCHERS'])]), RUN)).error,
    ).toBeUndefined();
  });
});

describe('ASSIGNEES and WATCHERS in the other actions', () => {
  it('ASSIGN ADD WATCHERS assigns the watchers to the task', async () => {
    const h = harness({ assignees: ['a1'], watchers: ['w1', 'w2'] });
    await h.ex.execute(
      actions([{ type: 'ASSIGN', mode: 'ADD', users: ['WATCHERS'] }]),
      RUN,
    );
    expect(h.log).toContain('setAssignees:a1,w1,w2');
  });

  it('a task with no task to look at (a schedule) gives nobody for a group', async () => {
    const h = harness({ assignees: ['a1'], watchers: ['w1'] });
    await h.ex.execute(actions([notify(['ASSIGNEES', 'WATCHERS', 'u1'])]), {
      ...RUN,
      taskId: null,
    });
    expect(h.sent[0].userIds).toEqual(['u1']);
  });
});
