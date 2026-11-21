import { HttpException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { AUTOMATION_LIMITS as L } from '../dsl/rule.limits';
import { treeLimits } from '../dsl/rule.settings';
import {
  arr,
  at,
  int,
  isObject,
  literal,
  obj,
  oneOf,
  opt,
  req,
} from '../dsl/rule.schema';
import { evaluateConditions } from '../engine/conditions-eval';
import type { Check } from '../dsl/rule.schema';
import { actionCheck, captureName, conditionsCheck, id } from './checks';
import { enclosing } from './tree';
import { action } from './actions.task';

/** an IF / elseIf needs at least one condition */
function needsCondition(
  v: unknown,
  path: string,
  sink: Parameters<Check>[2],
): void {
  if (
    isObject(v) &&
    isObject(v.conditions) &&
    !(v.conditions.all as unknown[] | undefined)?.length &&
    !(v.conditions.any as unknown[] | undefined)?.length
  )
    sink.add(
      'MISSING',
      at(path, 'conditions'),
      'at least one condition is needed',
    );
}

/** one "else if": its own conditions and the actions to run when they are the first that hold */
const elseIfCase: Check = (v, path, sink) => {
  obj({
    conditions: req(conditionsCheck),
    then: req(arr(actionCheck, { min: 1, max: L.maxActions })),
  })(v, path, sink);
  needsCondition(v, path, sink);
};

const IF = action<'IF'>({
  needs: { task: true, project: false },
  ceiling: Role.ADMIN,
  portable: true,
  type: 'IF',
  label: 'If / else',
  summary:
    'Checks conditions when it runs (earlier actions of the rule are visible) and runs the `then` actions, or the `else` actions when it does not hold.',
  example: {
    type: 'IF',
    conditions: { all: [{ field: 'PRIORITY', op: 'IN', value: ['URGENT'] }] },
    then: [{ type: 'ADD_TAG', tagId: 'TAG_ID' }],
    elseIf: [
      {
        conditions: { all: [{ field: 'PRIORITY', op: 'IN', value: ['HIGH'] }] },
        then: [{ type: 'COMMENT', body: 'High, not urgent' }],
      },
    ],
    else: [{ type: 'COMMENT', body: 'Not urgent' }],
  },
  schema: (v, path, sink) => {
    const max = treeLimits().maxIfDepth;
    if (enclosing(path) + 1 > max) {
      sink.add(
        'IF_TOO_DEEP',
        path,
        `IF and FOR_EACH can be nested at most ${max} deep in all`,
      );
      return; // do not walk further down
    }
    obj({
      type: req(literal('IF')),
      conditions: req(conditionsCheck),
      then: req(arr(actionCheck, { min: 1, max: L.maxActions })),
      elseIf: opt(arr(elseIfCase, { min: 1, max: L.maxActions })),
      else: opt(arr(actionCheck, { min: 1, max: L.maxActions })),
    })(v, path, sink);
    needsCondition(v, path, sink);
  },
  refs: [],
  nested: {
    conditions: 'conditions',
    branches: ['then', 'else'],
    cases: 'elseIf',
  },
  async execute(a, run, x) {
    const task = await x.snapshot();
    if (!task) throw new HttpException('The task no longer exists', 422);
    const env = { now: new Date(), actorId: run.triggererId };
    if (evaluateConditions(a.conditions, task, env))
      return x.runBranch(a.then, 'then');
    // "else if": the first case that holds runs; the conditions are checked against the same moment
    for (let i = 0; i < (a.elseIf ?? []).length; i++) {
      const c = a.elseIf![i];
      if (evaluateConditions(c.conditions, task, env))
        return x.runBranch(c.then, `elseIf/${i}/then`);
    }
    await x.runBranch(a.else ?? [], 'else');
  },
  describe: (a) =>
    (a.elseIf?.length ?? 0) > 0
      ? `If the conditions hold, ${a.then.length} action${a.then.length === 1 ? '' : 's'}; else if ${a.elseIf!.length} other case${a.elseIf!.length === 1 ? '' : 's'}${a.else ? '; otherwise ' + a.else.length : ''}`
      : a.else && a.else.length > 0
        ? `If the conditions hold, ${a.then.length} action${a.then.length === 1 ? '' : 's'}; otherwise ${a.else.length}`
        : `If the conditions hold, ${a.then.length} action${a.then.length === 1 ? '' : 's'}`,
});

const FOR_EACH = action<'FOR_EACH'>({
  needs: { task: true, project: false },
  ceiling: Role.ADMIN,
  portable: true,
  type: 'FOR_EACH',
  label: 'For each task',
  summary:
    "Runs its actions once for each task it selects (the task's subtasks, siblings or parent, or every task of the project or workspace that matches `where`), with that task as the current one. Does nothing, and fails, if it would select more than the configured number of tasks.",
  example: {
    type: 'FOR_EACH',
    over: 'SUBTASKS',
    where: {
      all: [{ field: 'STATUS_CATEGORY', op: 'NOT_IN', value: ['DONE'] }],
    },
    do: [{ type: 'SET_PRIORITY', priority: 'HIGH' }],
  },
  schema: (v, path, sink) => {
    const max = treeLimits().maxIfDepth;
    if (enclosing(path) + 1 > max) {
      sink.add(
        'IF_TOO_DEEP',
        path,
        `IF and FOR_EACH can be nested at most ${max} deep in all`,
      );
      return;
    }
    obj({
      type: req(literal('FOR_EACH')),
      over: req(oneOf(['SUBTASKS', 'SIBLINGS', 'PARENT', 'QUERY'], 'selector')),
      scope: opt(oneOf(['PROJECT', 'WORKSPACE'], 'scope')),
      where: opt(conditionsCheck),
      onError: opt(oneOf(['STOP', 'CONTINUE'], 'onError')),
      do: req(arr(actionCheck, { min: 1, max: L.maxActions })),
    })(v, path, sink);
    if (isObject(v) && v.scope !== undefined && v.over !== 'QUERY')
      sink.add(
        'NOT_FOR_SELECTOR',
        at(path, 'scope'),
        'scope only applies to a FOR_EACH over QUERY',
      );
  },
  refs: [],
  nested: { conditions: 'where', branches: ['do'] },
  // a FOR_EACH over a query selects its own tasks, so it works in a SCHEDULE rule (no task)
  taskless: (a) => a.over === 'QUERY',
  semantic(a, base, _ctx, add, env) {
    // a rule that belongs to ONE project must stay in it
    if (
      a.over === 'QUERY' &&
      a.scope === 'WORKSPACE' &&
      env.scopeProjectId !== null
    )
      add(
        'SCOPE_NEEDS_WORKSPACE_RULE',
        `${base}/scope`,
        'A rule that belongs to one project cannot loop over the whole workspace; make the rule workspace-wide or use the project scope',
      );
  },
  async execute(a, _run, x) {
    await x.runLoop(a);
  },
  describe: (a) =>
    `For each ${
      a.over === 'QUERY'
        ? `task in the ${a.scope === 'WORKSPACE' ? 'workspace' : 'project'}`
        : a.over.toLowerCase().replace(/s$/, '')
    }${a.where ? ' that matches' : ''}: ${a.do.length} action${a.do.length === 1 ? '' : 's'}`,
});

const WITH = action<'WITH'>({
  // the task comes from a capture, so it needs none of its own: it works in a SCHEDULE rule too
  needs: { task: false, project: false },
  ceiling: Role.ADMIN,
  portable: true,
  type: 'WITH',
  label: 'With a captured task',
  summary:
    'Runs its actions on a task an earlier action captured with `as` (for example the one a Create task action just made): assign it, tag it, add subtasks, comment on it. Inside, that task is the current one.',
  example: {
    type: 'WITH',
    task: 'followUp',
    do: [{ type: 'ADD_TAG', tagId: 'TAG_ID' }],
  },
  exampleBefore: [
    {
      type: 'CREATE_TASK',
      title: 'Follow up on {{task.title}}',
      as: 'followUp',
    },
  ],
  schema: (v, path, sink) => {
    const max = treeLimits().maxIfDepth;
    if (enclosing(path) + 1 > max) {
      sink.add(
        'IF_TOO_DEEP',
        path,
        `IF, FOR_EACH and WITH can be nested at most ${max} deep in all`,
      );
      return;
    }
    obj({
      type: req(literal('WITH')),
      task: req(captureName),
      do: req(arr(actionCheck, { min: 1, max: L.maxActions })),
    })(v, path, sink);
  },
  refs: [],
  nested: { branches: ['do'] },
  taskless: () => true,
  async execute(a, _run, x) {
    await x.runWith(a);
  },
  describe: (a) =>
    `With "${a.task}": ${a.do.length} action${a.do.length === 1 ? '' : 's'}`,
});

const RUN_RULE = action<'RUN_RULE'>({
  needs: { task: true, project: false },
  ceiling: Role.ADMIN,
  // a rule is found by id; templates cannot carry it by name yet, so a rule that calls another is kept
  // apart from a template (with a reason) rather than translated wrongly
  portable: false,
  type: 'RUN_RULE',
  label: 'Run another rule',
  summary:
    "Runs another rule's actions on the current task, as part of this run (its trigger is ignored; if ITS conditions do not hold it does nothing). The called rule can have the 'When called' trigger so it never fires on its own. Rules cannot call themselves, directly or through others, and calls nest only so deep.",
  example: { type: 'RUN_RULE', rule: 'RULE_ID' },
  schema: obj({ type: req(literal('RUN_RULE')), rule: req(id('rule id')) }),
  refs: [{ key: 'rule', kind: 'rule', shape: 'one' }],
  // control flow: it counts what it runs, not itself
  nested: {},
  semantic(a, base, ctx, add, env) {
    const target = ctx.rules?.get(a.rule);
    if (!target) return; // "that rule does not exist" is reported by the reference check
    const at_ = `${base}/rule`;
    if (a.rule === ctx.selfRuleId)
      return add('RUN_RULE_CYCLE', at_, 'A rule cannot run itself');
    // a wait saves what is LEFT of a run, and a called rule is only part of one
    if (target.hasWait)
      add(
        'RUN_RULE_HAS_WAIT',
        at_,
        'That rule contains a Wait, which cannot run inside a rule that is called by another rule',
      );
    if (target.ruleVersion !== 1 || target.hasUnsupported)
      add(
        'RUN_RULE_UNAVAILABLE',
        at_,
        'That rule cannot be run: it is not in the current rule format, or it holds something that cannot run yet',
      );
    // a project rule may call its own project's rules or workspace-wide ones; a workspace-wide rule only
    // workspace-wide ones (it may run on a task of any project, so a project's statuses would not fit)
    if (target.projectId !== null && target.projectId !== env.scopeProjectId)
      add(
        'RUN_RULE_SCOPE',
        at_,
        env.scopeProjectId === null
          ? 'A workspace-wide rule can only run workspace-wide rules'
          : 'A project rule can only run rules of its own project or workspace-wide rules',
      );
    // the call graph: does it come back here, and how deep does it go?
    const graph = ctx.rules!;
    const deepest = (id: string, trail: ReadonlySet<string>): number => {
      if (trail.has(id)) return 0;
      let d = 0;
      for (const c of graph.get(id)?.calls ?? [])
        d = Math.max(d, 1 + deepest(c, new Set([...trail, id])));
      return d;
    };
    const reaches = (id: string, seen: Set<string>): boolean => {
      if (id === ctx.selfRuleId) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      return (graph.get(id)?.calls ?? []).some((c) => reaches(c, seen));
    };
    if (ctx.selfRuleId && reaches(a.rule, new Set()))
      return add(
        'RUN_RULE_CYCLE',
        at_,
        'That rule runs this one back (directly or through others)',
      );
    const max = treeLimits().maxCallDepth;
    if (1 + deepest(a.rule, new Set()) > max)
      add(
        'RUN_RULE_TOO_DEEP',
        at_,
        `Rules can run other rules at most ${max} deep in all`,
      );
  },
  async execute(a, _run, x) {
    await x.runRule(a);
  },
  describe: () => 'Run another rule on this task',
});

/** a wait's length in minutes */
const waitMinutes = (f: { amount: number; unit: string }): number =>
  f.amount * (f.unit === 'DAYS' ? 1440 : f.unit === 'HOURS' ? 60 : 1);

const WAIT = action<'WAIT'>({
  // it needs nothing of its own, so it works in a SCHEDULE rule too
  needs: { task: false, project: false },
  ceiling: Role.ADMIN,
  portable: true,
  type: 'WAIT',
  label: 'Wait',
  summary:
    'Pauses the rule for a while; the actions after it run when the time is up, if the rule is still on and the task still exists. It resumes within about a minute of the time. Not allowed inside a loop or a rule that another rule calls.',
  example: { type: 'WAIT', for: { amount: 2, unit: 'DAYS' } },
  schema: (v, path, sink) => {
    obj({
      type: req(literal('WAIT')),
      for: req(
        obj({
          amount: req(int({ min: 1, max: 525_600 })),
          unit: req(oneOf(['MINUTES', 'HOURS', 'DAYS'], 'unit')),
        }),
      ),
    })(v, path, sink);
    const f = isObject(v) ? v.for : undefined;
    if (
      isObject(f) &&
      typeof f.amount === 'number' &&
      typeof f.unit === 'string'
    ) {
      const max = treeLimits().maxWaitDays;
      if (waitMinutes(f as { amount: number; unit: string }) > max * 1440)
        sink.add(
          'WAIT_TOO_LONG',
          at(path, 'for'),
          `A wait can last at most ${max} days (AUTOMATION_MAX_WAIT_DAYS)`,
        );
    }
  },
  refs: [],
  // control flow: it counts what runs after it, not itself
  nested: {},
  async execute(a, _run, x) {
    await x.wait(waitMinutes(a.for) * 60_000);
  },
  describe: (a) =>
    `Wait ${a.for.amount} ${a.for.unit.toLowerCase().replace(/s$/, a.for.amount === 1 ? '' : 's')}`,
});

export const FLOW_ACTIONS = { IF, FOR_EACH, WITH, RUN_RULE, WAIT };
