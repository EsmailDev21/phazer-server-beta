import { ActivityAction, ActivityTargetType } from '@prisma/client';
import { Condition, Trigger } from '../dsl/rule.types';
import {
  TaskSnapshot,
  evaluateCondition,
  evaluateConditions,
} from './conditions-eval';
import {
  dueEventId,
  dueWindow,
  latestScheduleSlot,
  loopGuard,
  overdueEventId,
  overdueWindow,
  rateExceeded,
  scheduleEventId,
} from './guards';
import {
  RuleEvent,
  activityToRuleEvent,
  allSubtasksDoneEvent,
  automationOrigin,
} from './rule-event';
import { renderText } from './render-text';
import { matchesTrigger } from './trigger-match';

const act = (
  action: ActivityAction,
  metadata: unknown = null,
  over: Record<string, unknown> = {},
) => ({
  id: 'a1',
  action,
  targetType: ActivityTargetType.TASK,
  targetId: 't1',
  workspaceId: 'w1',
  actorId: 'u1',
  metadata: metadata as any,
  createdAt: new Date('2026-10-18T10:00:00Z'),
  ...over,
});

describe('activity -> rule event', () => {
  it.each([
    [ActivityAction.CREATED, 'TASK_CREATED', undefined],
    [ActivityAction.PRIORITY_CHANGED, 'FIELD_CHANGED', 'PRIORITY'],
    [ActivityAction.DUE_DATE_CHANGED, 'FIELD_CHANGED', 'DUE_DATE'],
    [ActivityAction.ASSIGNED, 'FIELD_CHANGED', 'ASSIGNEES'],
    [ActivityAction.UNASSIGNED, 'FIELD_CHANGED', 'ASSIGNEES'],
    [ActivityAction.ISSUE_TYPE_CHANGED, 'FIELD_CHANGED', 'ISSUE_TYPE'],
    [ActivityAction.ITERATION_CHANGED, 'FIELD_CHANGED', 'ITERATION'],
    [ActivityAction.TAG_ADDED, 'FIELD_CHANGED', 'TAGS'],
    [ActivityAction.TAG_REMOVED, 'FIELD_CHANGED', 'TAGS'],
    [ActivityAction.DESCRIPTION_UPDATED, 'FIELD_CHANGED', 'DESCRIPTION'],
  ])('%s -> %s %s', (action, kind, field) => {
    expect(activityToRuleEvent(act(action))).toMatchObject({
      eventId: 'a1',
      kind,
      ...(field ? { field } : {}),
      taskId: 't1',
      workspaceId: 'w1',
      actorId: 'u1',
      depth: 0,
      causedBy: null,
    });
  });

  it('a status change carries both ends; one with no destination is ignored', () => {
    const e = activityToRuleEvent(
      act(ActivityAction.STATUS_CHANGED, {
        fromStatusId: 's1',
        toStatusId: 's2',
        fromCategory: 'TODO',
        toCategory: 'DONE',
      }),
    );
    expect(e).toMatchObject({
      kind: 'STATUS_CHANGED',
      statusChange: {
        fromStatusId: 's1',
        toStatusId: 's2',
        fromCategory: 'TODO',
        toCategory: 'DONE',
      },
    });
    expect(
      activityToRuleEvent(act(ActivityAction.STATUS_CHANGED, {})),
    ).toBeNull();
    expect(
      activityToRuleEvent(
        act(ActivityAction.STATUS_CHANGED, { toStatusId: 5 }),
      ),
    ).toBeNull();
  });

  it('ignores what a rule cannot react to, and anything not about a task', () => {
    for (const a of [
      ActivityAction.COMMENTED,
      ActivityAction.MENTIONED,
      ActivityAction.PARENT_CHANGED,
      ActivityAction.DUE_DATE_APPROACHING,
      ActivityAction.REACTED,
    ]) {
      expect(activityToRuleEvent(act(a))).toBeNull();
    }
    expect(
      activityToRuleEvent(
        act(ActivityAction.CREATED, null, {
          targetType: ActivityTargetType.PROJECT,
        }),
      ),
    ).toBeNull();
  });

  it('reads who caused it from the stamped metadata; hostile or malformed stamps are ignored', () => {
    expect(
      activityToRuleEvent(
        act(ActivityAction.CREATED, { automation: { id: 'r1', depth: 2 } }),
      ),
    ).toMatchObject({ depth: 2, causedBy: 'r1' });
    for (const bad of [
      null,
      'x',
      [],
      {},
      { automation: 'r1' },
      { automation: { id: 1, depth: 1 } },
      { automation: { id: 'r', depth: -1 } },
      { automation: { id: 'r', depth: 1.5 } },
      { automation: { id: 'r', depth: 'two' } },
      { automation: { id: 'r', depth: 99 } },
      { automation: { id: '', depth: 1 } },
      { automation: { id: 'x'.repeat(65), depth: 1 } },
    ]) {
      expect(automationOrigin(bad)).toBeNull();
    }
  });
});

describe('trigger matching', () => {
  const ev = (over: Partial<RuleEvent>): RuleEvent => ({
    eventId: 'e',
    kind: 'TASK_CREATED',
    workspaceId: 'w',
    taskId: 't',
    actorId: null,
    depth: 0,
    causedBy: null,
    at: new Date(),
    ...over,
  });
  const status = (to: string, toId = 's2', from = 'TODO', fromId = 's1') =>
    ev({
      kind: 'STATUS_CHANGED',
      statusChange: {
        fromStatusId: fromId,
        toStatusId: toId,
        fromCategory: from,
        toCategory: to,
      },
    });

  it('TASK_CREATED / DUE_APPROACHING match only their own kind', () => {
    expect(matchesTrigger({ type: 'TASK_CREATED' }, ev({}))).toBe(true);
    expect(matchesTrigger({ type: 'TASK_CREATED' }, status('DONE'))).toBe(
      false,
    );
    expect(
      matchesTrigger(
        { type: 'DUE_APPROACHING', offset: { amount: 1, unit: 'DAYS' } },
        ev({ kind: 'DUE_APPROACHING' }),
      ),
    ).toBe(true);
    expect(
      matchesTrigger(
        { type: 'DUE_APPROACHING', offset: { amount: 1, unit: 'DAYS' } },
        ev({}),
      ),
    ).toBe(false);
  });
  it('STATUS_CHANGED: no filter = any change; to/from by category or exact status', () => {
    const t = (
      x: Partial<Extract<Trigger, { type: 'STATUS_CHANGED' }>>,
    ): Trigger => ({ type: 'STATUS_CHANGED', ...x });
    expect(matchesTrigger(t({}), status('DONE'))).toBe(true);
    expect(
      matchesTrigger(t({ to: [{ category: 'DONE' }] }), status('DONE')),
    ).toBe(true);
    expect(
      matchesTrigger(t({ to: [{ category: 'DONE' }] }), status('BLOCKED')),
    ).toBe(false);
    expect(
      matchesTrigger(t({ to: [{ statusId: 's2' }] }), status('DONE')),
    ).toBe(true);
    expect(
      matchesTrigger(t({ to: [{ statusId: 'sX' }] }), status('DONE')),
    ).toBe(false);
    expect(
      matchesTrigger(
        t({ from: [{ category: 'TODO' }], to: [{ category: 'DONE' }] }),
        status('DONE'),
      ),
    ).toBe(true);
    expect(
      matchesTrigger(
        t({ from: [{ category: 'BLOCKED' }], to: [{ category: 'DONE' }] }),
        status('DONE'),
      ),
    ).toBe(false); // both must hold
    expect(
      matchesTrigger(
        t({ to: [{ category: 'BLOCKED' }, { category: 'DONE' }] }),
        status('DONE'),
      ),
    ).toBe(true); // any of the list
    expect(matchesTrigger(t({}), ev({}))).toBe(false);
  });
  it('FIELD_CHANGED matches the field exactly', () => {
    expect(
      matchesTrigger(
        { type: 'FIELD_CHANGED', field: 'PRIORITY' },
        ev({ kind: 'FIELD_CHANGED', field: 'PRIORITY' }),
      ),
    ).toBe(true);
    expect(
      matchesTrigger(
        { type: 'FIELD_CHANGED', field: 'PRIORITY' },
        ev({ kind: 'FIELD_CHANGED', field: 'TAGS' }),
      ),
    ).toBe(false);
    expect(
      matchesTrigger(
        { type: 'FIELD_CHANGED', customFieldId: 'cf' },
        ev({ kind: 'FIELD_CHANGED', field: 'PRIORITY' }),
      ),
    ).toBe(false);
  });
  it('EXTERNAL_LINK_STATE_CHANGED never fires yet', () => {
    expect(
      matchesTrigger({ type: 'EXTERNAL_LINK_STATE_CHANGED' }, ev({})),
    ).toBe(false);
  });
});

describe('conditions', () => {
  const snap = (over: Partial<TaskSnapshot> = {}): TaskSnapshot => ({
    status: 'IN_PROGRESS',
    workflowStatusId: 'ws1',
    priority: 'HIGH',
    assigneeIds: ['u1', 'u2'],
    tagIds: ['t1', 't2'],
    issueTypeId: 'it1',
    projectId: 'p1',
    estimate: 5,
    dueDate: new Date('2026-10-20T00:00:00Z'),
    parentId: null,
    createdById: 'creator',
    customValues: {},
    ...over,
  });
  const ctx = { now: new Date('2026-10-18T12:00:00Z'), actorId: 'actor' };
  const c = (
    field: string,
    op: string,
    value?: unknown,
    customFieldId?: string,
  ): Condition => ({ field, op, value, customFieldId });
  const ok = (cond: Condition, s = snap()) => evaluateCondition(cond, s, ctx);

  it.each([
    [c('STATUS_CATEGORY', 'IN', ['IN_PROGRESS', 'BLOCKED']), true],
    [c('STATUS_CATEGORY', 'IN', ['DONE']), false],
    [c('STATUS_CATEGORY', 'NOT_IN', ['DONE']), true],
    [c('STATUS', 'IN', ['ws1']), true],
    [c('STATUS', 'NOT_IN', ['ws1']), false],
    [c('PRIORITY', 'IN', ['HIGH', 'URGENT']), true],
    [c('PRIORITY', 'NOT_IN', ['LOW']), true],
    [c('PRIORITY', 'IS_SET'), true],
    [c('PRIORITY', 'IS_NOT_SET'), false],
    [c('ASSIGNEES', 'INCLUDES_ANY', ['u2', 'zz']), true],
    [c('ASSIGNEES', 'INCLUDES_NONE', ['zz']), true],
    [c('ASSIGNEES', 'INCLUDES_NONE', ['u1']), false],
    [c('ASSIGNEES', 'IS_EMPTY'), false],
    [c('ASSIGNEES', 'IS_NOT_EMPTY'), true],
    [c('TAGS', 'HAS_ANY', ['t2', 'x']), true],
    [c('TAGS', 'HAS_ALL', ['t1', 't2']), true],
    [c('TAGS', 'HAS_ALL', ['t1', 'x']), false],
    [c('TAGS', 'HAS_NONE', ['x']), true],
    [c('TAGS', 'HAS_NONE', ['t1']), false],
    [c('ISSUE_TYPE', 'IN', ['it1']), true],
    [c('ISSUE_TYPE', 'IS_SET'), true],
    [c('ISSUE_TYPE', 'NOT_IN', ['it1']), false],
    [c('PROJECT', 'IN', ['p1']), true],
    [c('PROJECT', 'NOT_IN', ['p1']), false],
    [c('ESTIMATE', 'EQ', 5), true],
    [c('ESTIMATE', 'NE', 5), false],
    [c('ESTIMATE', 'GT', 4), true],
    [c('ESTIMATE', 'GTE', 5), true],
    [c('ESTIMATE', 'LT', 5), false],
    [c('ESTIMATE', 'LTE', 5), true],
    [c('ESTIMATE', 'IS_SET'), true],
    [c('DUE_DATE', 'IS_SET'), true],
    [c('DUE_DATE', 'IS_OVERDUE'), false],
    [c('DUE_DATE', 'IS_NOT_OVERDUE'), true],
    [c('IS_SUBTASK', 'IS_FALSE'), true],
    [c('IS_SUBTASK', 'IS_TRUE'), false],
  ])('%j -> %s', (cond, expected) => expect(ok(cond)).toBe(expected));

  it('missing values: unset is "not equal", never a crash', () => {
    const empty = snap({
      priority: null,
      assigneeIds: [],
      tagIds: [],
      issueTypeId: null,
      workflowStatusId: null,
      estimate: null,
      dueDate: null,
    });
    expect(ok(c('PRIORITY', 'IN', ['HIGH']), empty)).toBe(false);
    expect(ok(c('PRIORITY', 'NOT_IN', ['HIGH']), empty)).toBe(true);
    expect(ok(c('PRIORITY', 'IS_NOT_SET'), empty)).toBe(true);
    expect(ok(c('ASSIGNEES', 'IS_EMPTY'), empty)).toBe(true);
    expect(ok(c('TAGS', 'HAS_NONE', ['t1']), empty)).toBe(true);
    expect(ok(c('TAGS', 'HAS_ALL', []), empty)).toBe(false);
    expect(ok(c('ESTIMATE', 'EQ', 5), empty)).toBe(false);
    expect(ok(c('ESTIMATE', 'NE', 5), empty)).toBe(true);
    expect(ok(c('ESTIMATE', 'GT', 0), empty)).toBe(false);
    expect(ok(c('ESTIMATE', 'IS_NOT_SET'), empty)).toBe(true);
    expect(ok(c('DUE_DATE', 'IS_NOT_SET'), empty)).toBe(true);
    expect(ok(c('DUE_DATE', 'IS_OVERDUE'), empty)).toBe(false);
    expect(ok(c('STATUS', 'NOT_IN', ['ws1']), empty)).toBe(true);
  });

  it('overdue means past due and not done', () => {
    const late = snap({ dueDate: new Date('2026-10-17T00:00:00Z') });
    expect(ok(c('DUE_DATE', 'IS_OVERDUE'), late)).toBe(true);
    expect(
      ok(c('DUE_DATE', 'IS_OVERDUE'), snap({ ...late, status: 'DONE' })),
    ).toBe(false);
    expect(
      ok(c('DUE_DATE', 'IS_NOT_OVERDUE'), snap({ ...late, status: 'DONE' })),
    ).toBe(true);
  });

  it('TRIGGERER and CREATOR resolve to people', () => {
    expect(
      ok(
        c('ASSIGNEES', 'INCLUDES_ANY', ['TRIGGERER']),
        snap({ assigneeIds: ['actor'] }),
      ),
    ).toBe(true);
    expect(ok(c('ASSIGNEES', 'INCLUDES_ANY', ['TRIGGERER']), snap())).toBe(
      false,
    );
    expect(
      ok(
        c('ASSIGNEES', 'INCLUDES_ANY', ['CREATOR']),
        snap({ assigneeIds: ['creator'] }),
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        c('ASSIGNEES', 'INCLUDES_ANY', ['TRIGGERER']),
        snap({ assigneeIds: ['actor'] }),
        { now: ctx.now, actorId: null },
      ),
    ).toBe(false); // a system event has no triggerer
  });

  describe('custom fields', () => {
    const v = (value: unknown) => snap({ customValues: { f: value } });
    const cf = (op: string, value?: unknown) => c('CUSTOM', op, value, 'f');
    it.each([
      [v(5), cf('GT', 3), true],
      [v(5), cf('LTE', 5), true],
      [v(5), cf('LT', 5), false],
      [v('5'), cf('GT', 3), false], // text is not a number
      [v('2026-10-20'), cf('LT', '2026-11-01'), true],
      [v('2026-10-20'), cf('GTE', '2026-10-21'), false],
      [v('red'), cf('EQ', 'red'), true],
      [v('red'), cf('NE', 'red'), false],
      [v('red'), cf('IN', ['red', 'blue']), true],
      [v('red'), cf('NOT_IN', ['blue']), true],
      [v('Hello World'), cf('CONTAINS', 'world'), true],
      [v(5), cf('CONTAINS', 'x'), false],
      [v(['a', 'b']), cf('HAS_ANY', ['b', 'z']), true],
      [v(['a', 'b']), cf('HAS_ALL', ['a', 'b']), true],
      [v(['a']), cf('HAS_ALL', ['a', 'b']), false],
      [v(['a']), cf('HAS_NONE', ['b']), true],
      [v(true), cf('IS_TRUE'), true],
      [v(false), cf('IS_TRUE'), false],
      [v(undefined), cf('IS_FALSE'), true],
      [v(false), cf('IS_FALSE'), true],
      [v('u1'), cf('INCLUDES_ANY', ['u1']), true],
      [v(['u1', 'u9']), cf('INCLUDES_NONE', ['u1']), false],
      [v('creator'), cf('INCLUDES_ANY', ['CREATOR']), true],
      [v(''), cf('IS_SET'), false],
      [v([]), cf('IS_SET'), false],
      [v(0), cf('IS_SET'), true],
      [v(undefined), cf('IS_NOT_SET'), true],
      [v(undefined), cf('EQ', 'red'), false],
      [v(undefined), cf('NE', 'red'), true],
      [v(undefined), cf('GT', 1), false],
      [v(undefined), cf('HAS_NONE', ['a']), true],
      [v(undefined), cf('NOT_IN', ['a']), true],
    ] as const)('%j %j -> %s', (s, cond, expected) =>
      expect(ok(cond, s)).toBe(expected),
    );
  });

  it('all / any combine: all must hold, any needs one, both = both, none = always', () => {
    const yes = c('PRIORITY', 'IN', ['HIGH']);
    const no = c('PRIORITY', 'IN', ['LOW']);
    const e = (cs: object) => evaluateConditions(cs, snap(), ctx);
    expect(e({})).toBe(true);
    expect(e({ all: [yes, yes] })).toBe(true);
    expect(e({ all: [yes, no] })).toBe(false);
    expect(e({ any: [no, yes] })).toBe(true);
    expect(e({ any: [no, no] })).toBe(false);
    expect(e({ all: [yes], any: [no, yes] })).toBe(true);
    expect(e({ all: [yes], any: [no] })).toBe(false);
    expect(e({ all: [no], any: [yes] })).toBe(false);
  });

  it('an unknown field or operator is false, not an error', () => {
    expect(ok(c('NOPE', 'IN', ['x']))).toBe(false);
    expect(ok(c('PRIORITY', 'WHATEVER'))).toBe(false);
    expect(ok(c('CUSTOM', 'EQ', 'x'))).toBe(false); // no field id
  });
});

describe('text rendering', () => {
  const vars = {
    'task.title': 'Fix login',
    'task.key': 'TGT-7',
    'actor.name': 'Ana',
  };
  it('fills the placeholders, tolerating spaces; unknown ones are empty', () => {
    expect(
      renderText(
        '{{task.key}}: {{ task.title }} by {{actor.name}} {{nope}}!',
        vars,
      ),
    ).toBe('TGT-7: Fix login by Ana !');
  });
  it('a value is data: placeholders inside it are not expanded again, and prototype names are not variables', () => {
    expect(
      renderText('{{task.title}}', {
        'task.title': '{{actor.name}} {{task.key}}',
        'actor.name': 'X',
        'task.key': 'Y',
      }),
    ).toBe('{{actor.name}} {{task.key}}');
    expect(renderText('{{constructor}} {{__proto__}} {{toString}}', vars)).toBe(
      '  ',
    );
  });
  it('is clamped to the limit with an ellipsis', () => {
    const out = renderText(
      '{{task.title}}',
      { 'task.title': 'x'.repeat(500) },
      200,
    );
    expect(out).toHaveLength(200);
    expect(out.endsWith('…')).toBe(true);
    expect(renderText('short', vars, 200)).toBe('short');
  });
});

describe('guards', () => {
  it('a rule never reacts to its own write; a chain stops at the depth cap', () => {
    expect(loopGuard({ depth: 1, causedBy: 'r1' }, 'r1')).toBe('SELF');
    expect(loopGuard({ depth: 1, causedBy: 'r1' }, 'r2')).toBeNull();
    expect(loopGuard({ depth: 0, causedBy: null }, 'r1')).toBeNull();
    expect(loopGuard({ depth: 2, causedBy: 'r9' }, 'r1')).toBeNull();
    expect(loopGuard({ depth: 3, causedBy: 'r9' }, 'r1')).toBe('DEPTH');
    expect(loopGuard({ depth: 10, causedBy: null }, 'r1')).toBe('DEPTH');
    expect(loopGuard({ depth: 3, causedBy: 'r1' }, 'r1')).toBe('SELF'); // reported as the closer cause
  });
  it('the rate breaker trips at the allowance', () => {
    expect(rateExceeded(29)).toBe(false);
    expect(rateExceeded(30)).toBe(true);
    expect(rateExceeded(5, 5)).toBe(true);
  });
  it('the due window is [now, now+offset]; the event id changes with the due date', () => {
    const now = new Date('2026-10-18T12:00:00Z');
    expect(dueWindow(now, { amount: 2, unit: 'HOURS' })).toEqual({
      from: now,
      to: new Date('2026-10-18T14:00:00Z'),
    });
    expect(dueWindow(now, { amount: 1, unit: 'DAYS' }).to).toEqual(
      new Date('2026-10-19T12:00:00Z'),
    );
    expect(dueEventId('t', new Date('2026-10-19T00:00:00Z'))).toBe(
      'due:t:2026-10-19T00:00:00.000Z',
    );
    expect(dueEventId('t', new Date('2026-10-19T00:00:00Z'))).not.toBe(
      dueEventId('t', new Date('2026-10-20T00:00:00Z')),
    );
  });
});

describe('richer events (step 5.6)', () => {
  it('maps comments, archiving and restoring', () => {
    expect(
      activityToRuleEvent(act(ActivityAction.COMMENTED, { commentId: 'c1' })),
    ).toMatchObject({ kind: 'COMMENT_ADDED', commentId: 'c1', taskId: 't1' });
    expect(activityToRuleEvent(act(ActivityAction.COMMENTED, {}))).toBeNull();
    expect(
      activityToRuleEvent(act(ActivityAction.COMMENTED, { commentId: 5 })),
    ).toBeNull();
    expect(activityToRuleEvent(act(ActivityAction.ARCHIVED))).toMatchObject({
      kind: 'TASK_ARCHIVED',
    });
    expect(activityToRuleEvent(act(ActivityAction.RESTORED))).toMatchObject({
      kind: 'TASK_RESTORED',
    });
    expect(
      activityToRuleEvent(
        act(ActivityAction.COMMENTED, {
          commentId: 'c',
          automation: { id: 'r1', depth: 1 },
        }),
      ),
    ).toMatchObject({ depth: 1, causedBy: 'r1' });
  });

  describe('ALL_SUBTASKS_DONE (derived)', () => {
    const done = (over: Partial<RuleEvent> = {}): RuleEvent => ({
      eventId: 'e1',
      kind: 'STATUS_CHANGED',
      workspaceId: 'w',
      taskId: 'sub',
      actorId: 'u',
      depth: 1,
      causedBy: 'r9',
      at: new Date(),
      statusChange: {
        fromStatusId: null,
        toStatusId: 's',
        fromCategory: 'TODO',
        toCategory: 'DONE',
      },
      ...over,
    });
    it('fires on the parent when the last open subtask is done, carrying who and how deep', () => {
      expect(allSubtasksDoneEvent(done(), 'parent', 0)).toMatchObject({
        kind: 'ALL_SUBTASKS_DONE',
        taskId: 'parent',
        eventId: 'subs:parent:e1',
        actorId: 'u',
        depth: 1,
        causedBy: 'r9',
        statusChange: undefined,
      });
    });
    it('not while another is open, not without a parent, not for other changes', () => {
      expect(allSubtasksDoneEvent(done(), 'parent', 1)).toBeNull();
      expect(allSubtasksDoneEvent(done(), null, 0)).toBeNull();
      expect(
        allSubtasksDoneEvent(
          done({
            statusChange: {
              fromStatusId: null,
              toStatusId: 's',
              fromCategory: 'TODO',
              toCategory: 'IN_PROGRESS',
            },
          }),
          'parent',
          0,
        ),
      ).toBeNull();
      expect(
        allSubtasksDoneEvent(
          done({ kind: 'FIELD_CHANGED', statusChange: undefined }),
          'parent',
          0,
        ),
      ).toBeNull();
    });
    it('each completing event has its own key, so one parent can be re-completed after reopening', () => {
      expect(
        allSubtasksDoneEvent(done({ eventId: 'e2' }), 'parent', 0)!.eventId,
      ).not.toBe(allSubtasksDoneEvent(done(), 'parent', 0)!.eventId);
    });
  });

  describe('trigger matching', () => {
    const ev = (over: Partial<RuleEvent>): RuleEvent => ({
      eventId: 'e',
      kind: 'COMMENT_ADDED',
      workspaceId: 'w',
      taskId: 't',
      actorId: 'u',
      depth: 0,
      causedBy: null,
      at: new Date(),
      comment: { text: 'Please check the Deploy plan', byAutomation: false },
      ...over,
    });
    it('COMMENT_ADDED: by default people only; contains is case-insensitive', () => {
      expect(matchesTrigger({ type: 'COMMENT_ADDED' }, ev({}))).toBe(true);
      expect(
        matchesTrigger(
          { type: 'COMMENT_ADDED' },
          ev({ comment: { text: 'x', byAutomation: true } }),
        ),
      ).toBe(false);
      expect(
        matchesTrigger(
          { type: 'COMMENT_ADDED', by: 'ANYONE' },
          ev({ comment: { text: 'x', byAutomation: true } }),
        ),
      ).toBe(true);
      expect(
        matchesTrigger(
          { type: 'COMMENT_ADDED', contains: 'deploy PLAN' },
          ev({}),
        ),
      ).toBe(true);
      expect(
        matchesTrigger({ type: 'COMMENT_ADDED', contains: 'rollback' }, ev({})),
      ).toBe(false);
      expect(
        matchesTrigger({ type: 'COMMENT_ADDED' }, ev({ comment: undefined })),
      ).toBe(false); // text not loaded: no guess
      expect(
        matchesTrigger({ type: 'COMMENT_ADDED' }, ev({ kind: 'TASK_CREATED' })),
      ).toBe(false);
    });
    it.each([
      ['TASK_ARCHIVED'],
      ['TASK_RESTORED'],
      ['ALL_SUBTASKS_DONE'],
      ['TASK_OVERDUE'],
      ['SCHEDULE'],
    ] as const)('%s matches only its own kind', (kind) => {
      expect(
        matchesTrigger(
          { type: kind } as Trigger,
          ev({ kind, comment: undefined }),
        ),
      ).toBe(true);
      expect(
        matchesTrigger(
          { type: kind } as Trigger,
          ev({ kind: 'TASK_CREATED', comment: undefined }),
        ),
      ).toBe(false);
    });
  });

  describe('SCHEDULE slots', () => {
    const at = (iso: string) => new Date(iso);
    const daily = (hour: number) => ({
      type: 'SCHEDULE' as const,
      frequency: 'DAILY' as const,
      hour,
    });
    it('a daily slot is the top of its hour, picked up for the catch-up window and then no more', () => {
      expect(latestScheduleSlot(daily(9), at('2026-10-19T09:00:00Z'))).toEqual(
        at('2026-10-19T09:00:00Z'),
      );
      expect(latestScheduleSlot(daily(9), at('2026-10-19T09:41:00Z'))).toEqual(
        at('2026-10-19T09:00:00Z'),
      );
      expect(latestScheduleSlot(daily(9), at('2026-10-19T10:59:59Z'))).toEqual(
        at('2026-10-19T09:00:00Z'),
      ); // still within 2 hours
      expect(
        latestScheduleSlot(daily(9), at('2026-10-19T11:00:00Z')),
      ).toBeNull(); // too old
      expect(
        latestScheduleSlot(daily(9), at('2026-10-19T08:59:59Z')),
      ).toBeNull(); // not yet
    });
    it('the same slot gives the same key however many sweeps see it', () => {
      const a = latestScheduleSlot(daily(9), at('2026-10-19T09:05:00Z'))!;
      const b = latestScheduleSlot(daily(9), at('2026-10-19T09:10:00Z'))!;
      expect(scheduleEventId(a)).toBe(scheduleEventId(b));
      expect(scheduleEventId(a)).not.toBe(
        scheduleEventId(
          latestScheduleSlot(daily(9), at('2026-10-20T09:05:00Z'))!,
        ),
      );
    });
    it('weekly uses ISO weekdays (1 = Monday ... 7 = Sunday) in UTC', () => {
      const wk = {
        type: 'SCHEDULE' as const,
        frequency: 'WEEKLY' as const,
        hour: 8,
        weekdays: [1, 7],
      };
      expect(latestScheduleSlot(wk, at('2026-10-19T08:10:00Z'))).not.toBeNull(); // Monday 19 Oct 2026
      expect(latestScheduleSlot(wk, at('2026-10-25T08:10:00Z'))).not.toBeNull(); // Sunday
      expect(latestScheduleSlot(wk, at('2026-10-20T08:10:00Z'))).toBeNull(); // Tuesday
    });
    it('monthly fires on its day of the month; a slot crossing midnight belongs to the day it was for', () => {
      const m = {
        type: 'SCHEDULE' as const,
        frequency: 'MONTHLY' as const,
        hour: 23,
        dayOfMonth: 28,
      };
      expect(latestScheduleSlot(m, at('2026-10-28T23:30:00Z'))).toEqual(
        at('2026-10-28T23:00:00Z'),
      );
      expect(latestScheduleSlot(m, at('2026-10-29T00:30:00Z'))).toEqual(
        at('2026-10-28T23:00:00Z'),
      ); // caught up after midnight
      expect(latestScheduleSlot(m, at('2026-10-27T23:30:00Z'))).toBeNull();
      expect(latestScheduleSlot(m, at('2026-02-28T23:10:00Z'))).not.toBeNull(); // every month has a 28th
    });
    it("hour 0 on the first of the month is caught up from the previous evening's clock", () => {
      expect(latestScheduleSlot(daily(0), at('2026-11-01T00:20:00Z'))).toEqual(
        at('2026-11-01T00:00:00Z'),
      );
      expect(latestScheduleSlot(daily(23), at('2026-11-01T00:20:00Z'))).toEqual(
        at('2026-10-31T23:00:00Z'),
      );
    });
  });

  describe('overdue window', () => {
    const now = new Date('2026-10-19T12:00:00Z');
    it('is [now - after - 7 days, now - after]', () => {
      const w = overdueWindow(now, 0);
      expect(w.to).toEqual(now);
      expect(w.from).toEqual(new Date('2026-10-12T12:00:00Z'));
      expect(overdueWindow(now, 24).to).toEqual(
        new Date('2026-10-18T12:00:00Z'),
      );
    });
    it('its key changes with the due date', () => {
      expect(overdueEventId('t', new Date('2026-10-18T00:00:00Z'))).toBe(
        'overdue:t:2026-10-18T00:00:00.000Z',
      );
      expect(overdueEventId('t', new Date('2026-10-18T00:00:00Z'))).not.toBe(
        overdueEventId('t', new Date('2026-10-19T00:00:00Z')),
      );
    });
  });
});
