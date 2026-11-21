import { HttpException } from '@nestjs/common';
import { Priority, Role } from '@prisma/client';
import { AUTOMATION_LIMITS as L } from '../dsl/rule.limits';
import {
  arr,
  isObject,
  literal,
  nullable,
  num,
  obj,
  oneOf,
  opt,
  req,
  str,
  at,
  int,
} from '../dsl/rule.schema';
import type { Action } from '../dsl/rule.types';
import { renderText } from '../engine/render-text';
import {
  NO_CLEAR_YET,
  PRIORITIES,
  id,
  relativeDays,
  scalar,
  statusRef,
  templateText,
  unsupportedAt,
  userRef,
} from './checks';
import { misfit } from './custom-field-typing';
import type { ActionDescriptor } from './descriptor';
import {
  days,
  relativeDate,
  resolveUsers,
  statusDto,
  statusText,
} from './action-helpers';

export type A<T extends Action['type']> = Extract<Action, { type: T }>;
/** identity; it exists so each descriptor is checked against ITS action's shape */
export const action = <T extends Action['type']>(
  d: ActionDescriptor<A<T>>,
): ActionDescriptor<A<T>> => d;

const TASK = { task: true, project: false } as const;
const base = { needs: TASK, ceiling: Role.ADMIN, portable: true } as const;

const SET_STATUS = action<'SET_STATUS'>({
  ...base,
  type: 'SET_STATUS',
  label: 'Set status',
  summary: "Moves the task to a status (the project's workflow still applies).",
  example: { type: 'SET_STATUS', status: { category: 'DONE' } },
  schema: obj({ type: req(literal('SET_STATUS')), status: req(statusRef) }),
  refs: [{ key: 'status', kind: 'status', shape: 'statusRef' }],
  async execute(a, run, x) {
    await x.tasks.update(run.taskId, statusDto(a.status), run.actorId, { ctx: x.ctx });
  },
  describe: (a) => `Move the task to ${statusText(a.status)}`,
});

const SET_PRIORITY = action<'SET_PRIORITY'>({
  ...base,
  type: 'SET_PRIORITY',
  label: 'Set priority',
  summary: 'Sets the task priority.',
  example: { type: 'SET_PRIORITY', priority: 'HIGH' },
  schema: (v, path, sink) => {
    obj({
      type: req(literal('SET_PRIORITY')),
      priority: req(nullable(oneOf(PRIORITIES, 'priority'))),
    })(v, path, sink);
    if (isObject(v) && v.priority === null)
      unsupportedAt(sink, path, 'SET_PRIORITY(clear)', NO_CLEAR_YET);
  },
  refs: [],
  async execute(a, run, x) {
    if (a.priority === null)
      throw new HttpException('Clearing a priority is not supported yet', 422);
    await x.tasks.update(
      run.taskId,
      { priority: a.priority as Priority },
      run.actorId,
      { ctx: x.ctx },
    );
  },
  describe: (a) =>
    a.priority === null
      ? 'Clear the priority'
      : `Set the priority to ${a.priority}`,
});

const ASSIGN = action<'ASSIGN'>({
  ...base,
  type: 'ASSIGN',
  label: 'Assign',
  summary:
    'Sets, adds or removes assignees. TRIGGERER and CREATOR stand for people.',
  example: { type: 'ASSIGN', mode: 'ADD', users: ['TRIGGERER'] },
  schema: (v, path, sink) => {
    obj({
      type: req(literal('ASSIGN')),
      mode: req(oneOf(['SET', 'ADD', 'REMOVE'], 'mode')),
      users: req(arr(userRef, { min: 0, max: 10 })),
    })(v, path, sink);
    if (
      isObject(v) &&
      v.mode !== 'SET' &&
      Array.isArray(v.users) &&
      v.users.length === 0
    ) {
      sink.add(
        'TOO_FEW',
        at(path, 'users'),
        'ADD and REMOVE need at least one user',
      );
    }
  },
  refs: [{ key: 'users', kind: 'user', shape: 'list' }],
  async execute(a, run, x) {
    const wanted = await resolveUsers(a.users, run, x);
    const current =
      (
        await x.prisma.task.findUnique({
          where: { id: run.taskId },
          select: { assignees: { select: { id: true } } },
        })
      )?.assignees.map((u) => u.id) ?? [];
    const next =
      a.mode === 'SET'
        ? wanted
        : a.mode === 'ADD'
          ? [...new Set([...current, ...wanted])]
          : current.filter((uid) => !wanted.includes(uid));
    if (
      next.length === current.length &&
      next.every((uid) => current.includes(uid))
    )
      return; // nothing to change
    await x.tasks.setAssignees(
      run.taskId,
      { userIds: next },
      run.actorId,
      x.ctx,
    );
  },
  describe: (a) =>
    a.mode === 'SET'
      ? `Set the assignees to ${a.users.length} ${a.users.length === 1 ? 'person' : 'people'}`
      : `${a.mode === 'ADD' ? 'Add' : 'Remove'} ${a.users.length} ${a.users.length === 1 ? 'assignee' : 'assignees'}`,
});

const SET_DUE_DATE = action<'SET_DUE_DATE'>({
  ...base,
  type: 'SET_DUE_DATE',
  label: 'Set due date',
  summary: 'Sets the due date N days from now, or shifts the existing one.',
  example: { type: 'SET_DUE_DATE', inDays: 3 },
  schema: (v, path, sink) => {
    obj({
      type: req(literal('SET_DUE_DATE')),
      inDays: req(nullable(int({ min: -365, max: 365 }))),
      from: opt(oneOf(['NOW', 'DUE_DATE'], 'from')),
    })(v, path, sink);
    if (isObject(v) && v.inDays === null)
      unsupportedAt(sink, path, 'SET_DUE_DATE(clear)', NO_CLEAR_YET);
    relativeDays(v, path, sink);
  },
  refs: [],
  async execute(a, run, x) {
    if (a.inDays === null)
      throw new HttpException('Clearing a due date is not supported yet', 422);
    const due = await relativeDate(x, run, a.inDays, a.from);
    await x.tasks.update(
      run.taskId!,
      { dueDate: due.toISOString() },
      run.actorId,
      { ctx: x.ctx },
    );
  },
  describe: (a) =>
    a.inDays === null
      ? 'Clear the due date'
      : `Set the due date ${days(a.inDays)}${a.from === 'DUE_DATE' ? ' the current due date' : ''}`,
});

const SET_CUSTOM_FIELD = action<'SET_CUSTOM_FIELD'>({
  ...base,
  type: 'SET_CUSTOM_FIELD',
  label: 'Set custom field',
  summary:
    'Sets (or, with null, clears) a custom field value; the value must fit the field.',
  example: { type: 'SET_CUSTOM_FIELD', customFieldId: 'FIELD_ID', value: 'x' },
  schema: obj({
    type: req(literal('SET_CUSTOM_FIELD')),
    customFieldId: req(id('custom field id')),
    value: req((v, path, sink) => {
      if (v === null) return;
      if (Array.isArray(v))
        return arr(str({ max: 100, what: 'value' }), {
          min: 0,
          max: L.maxListItems,
        })(v, path, sink);
      scalar(v, path, sink);
    }),
  }),
  refs: [{ key: 'customFieldId', kind: 'customField', shape: 'one' }],
  semantic(a, at_, ctx, add) {
    const f = ctx.customFields.get(a.customFieldId);
    if (f && a.value !== null) {
      const why = misfit(f.dataType, f.options, a.value, ctx);
      if (why) add('VALUE_MISMATCH', `${at_}/value`, `The value ${why}`);
    }
  },
  async execute(a, run, x) {
    if (a.value === null)
      await x.customFields.deleteValue(run.taskId, a.customFieldId);
    else
      await x.customFields.setValue(
        run.taskId,
        a.customFieldId,
        a.value,
        x.ctx,
      );
  },
  describe: (a) =>
    a.value === null ? 'Clear a custom field' : 'Set a custom field',
});

const ADD_TAG = action<'ADD_TAG'>({
  ...base,
  type: 'ADD_TAG',
  label: 'Add tag',
  summary: 'Puts a tag on the task.',
  example: { type: 'ADD_TAG', tagId: 'TAG_ID' },
  schema: obj({ type: req(literal('ADD_TAG')), tagId: req(id('tag id')) }),
  refs: [{ key: 'tagId', kind: 'tag', shape: 'one' }],
  async execute(a, run, x) {
    await x.tags.attach(run.taskId, a.tagId, run.actorId, x.ctx);
  },
  describe: () => 'Add a tag',
});

const REMOVE_TAG = action<'REMOVE_TAG'>({
  ...base,
  type: 'REMOVE_TAG',
  label: 'Remove tag',
  summary: 'Takes a tag off the task (fine if it was not there).',
  example: { type: 'REMOVE_TAG', tagId: 'TAG_ID' },
  schema: obj({ type: req(literal('REMOVE_TAG')), tagId: req(id('tag id')) }),
  refs: [{ key: 'tagId', kind: 'tag', shape: 'one' }],
  async execute(a, run, x) {
    try {
      await x.tags.detach(run.taskId, a.tagId, run.actorId, x.ctx);
    } catch (err) {
      if (!(
        err instanceof HttpException &&
        err.getStatus() === 404 &&
        /not attached/i.test(err.message)
      ))
        throw err; // already off: fine
    }
  },
  describe: () => 'Remove a tag',
});

const RENAME_TASK = action<'RENAME_TASK'>({
  ...base,
  type: 'RENAME_TASK',
  label: 'Rename task',
  summary: 'Changes the title; {{placeholders}} are filled in.',
  example: { type: 'RENAME_TASK', title: '{{task.title}} (reviewed)' },
  schema: obj({
    type: req(literal('RENAME_TASK')),
    title: req(templateText(L.maxSubtaskTitleLength, 'title')),
  }),
  refs: [],
  async execute(a, run, x) {
    await x.tasks.update(
      run.taskId!,
      { title: renderText(a.title, run.vars, L.maxSubtaskTitleLength) },
      run.actorId,
      { ctx: x.ctx },
    );
  },
  describe: () => 'Rename the task',
});

const SET_DESCRIPTION = action<'SET_DESCRIPTION'>({
  ...base,
  type: 'SET_DESCRIPTION',
  label: 'Set description',
  summary:
    'Replaces the description, or appends to it (at most 10000 characters in all).',
  example: {
    type: 'SET_DESCRIPTION',
    text: 'Checked on {{date}}',
    mode: 'APPEND',
  },
  schema: obj({
    type: req(literal('SET_DESCRIPTION')),
    text: req(templateText(L.maxDescriptionLength, 'text')),
    mode: req(oneOf(['REPLACE', 'APPEND'], 'mode')),
  }),
  refs: [],
  async execute(a, run, x) {
    const text = renderText(a.text, run.vars, L.maxDescriptionLength);
    let next = text;
    if (a.mode === 'APPEND') {
      const current =
        (
          await x.prisma.task.findUnique({
            where: { id: run.taskId! },
            select: { description: true },
          })
        )?.description ?? '';
      next = current ? `${current}\n\n${text}` : text;
      if (next.length > 10_000)
        throw new HttpException(
          'The description would be longer than 10000 characters',
          422,
        );
    }
    await x.tasks.update(
      run.taskId!,
      { description: next },
      run.actorId,
      { ctx: x.ctx },
    );
  },
  describe: (a) =>
    a.mode === 'APPEND'
      ? 'Append to the description'
      : 'Replace the description',
});

const SET_ESTIMATE = action<'SET_ESTIMATE'>({
  ...base,
  type: 'SET_ESTIMATE',
  label: 'Set estimate',
  summary: 'Sets the estimate (null clears it).',
  example: { type: 'SET_ESTIMATE', estimate: 3 },
  schema: obj({
    type: req(literal('SET_ESTIMATE')),
    estimate: req(nullable(num({ min: 0, max: L.maxEstimate }))),
  }),
  refs: [],
  async execute(a, run, x) {
    await x.tasks.update(
      run.taskId!,
      { estimate: a.estimate },
      run.actorId,
      { ctx: x.ctx },
    );
  },
  describe: (a) =>
    a.estimate === null
      ? 'Clear the estimate'
      : `Set the estimate to ${a.estimate}`,
});

const SET_ISSUE_TYPE = action<'SET_ISSUE_TYPE'>({
  ...base,
  type: 'SET_ISSUE_TYPE',
  label: 'Set issue type',
  summary: 'Sets the issue type (null clears it).',
  example: { type: 'SET_ISSUE_TYPE', issueTypeId: 'ISSUE_TYPE_ID' },
  schema: obj({
    type: req(literal('SET_ISSUE_TYPE')),
    issueTypeId: req(nullable(id('issue type id'))),
  }),
  refs: [{ key: 'issueTypeId', kind: 'issueType', shape: 'one' }],
  async execute(a, run, x) {
    await x.tasks.update(
      run.taskId!,
      { issueTypeId: a.issueTypeId },
      run.actorId,
      { ctx: x.ctx },
    );
  },
  describe: (a) =>
    a.issueTypeId === null ? 'Clear the issue type' : 'Set the issue type',
});

const SET_ITERATION = action<'SET_ITERATION'>({
  ...base,
  type: 'SET_ITERATION',
  label: 'Set iteration',
  summary: 'Puts the task in an iteration (null takes it out).',
  example: { type: 'SET_ITERATION', iterationId: 'ITERATION_ID' },
  schema: obj({
    type: req(literal('SET_ITERATION')),
    iterationId: req(nullable(id('iteration id'))),
  }),
  refs: [{ key: 'iterationId', kind: 'iteration', shape: 'one' }],
  async execute(a, run, x) {
    await x.tasks.update(
      run.taskId!,
      { iterationId: a.iterationId },
      run.actorId,
      { ctx: x.ctx },
    );
  },
  describe: (a) =>
    a.iterationId === null
      ? 'Take the task out of its iteration'
      : 'Set the iteration',
});

const CHANGE_PRIORITY = action<'CHANGE_PRIORITY'>({
  ...base,
  type: 'CHANGE_PRIORITY',
  label: 'Raise or lower priority',
  summary: 'Moves the priority one step up or down; the ends stay put.',
  example: { type: 'CHANGE_PRIORITY', direction: 'UP' },
  schema: obj({
    type: req(literal('CHANGE_PRIORITY')),
    direction: req(oneOf(['UP', 'DOWN'], 'direction')),
  }),
  refs: [],
  async execute(a, run, x) {
    const order: Priority[] = [
      Priority.LOW,
      Priority.MEDIUM,
      Priority.HIGH,
      Priority.URGENT,
    ];
    const current =
      (
        await x.prisma.task.findUnique({
          where: { id: run.taskId! },
          select: { priority: true },
        })
      )?.priority ?? null;
    // no priority counts as "below LOW": UP gives LOW, DOWN stays unset; the ends stay put
    const cur = current === null ? -1 : order.indexOf(current);
    const next = Math.max(
      -1,
      Math.min(order.length - 1, cur + (a.direction === 'UP' ? 1 : -1)),
    );
    if (next === cur || next < 0) return;
    await x.tasks.update(
      run.taskId!,
      { priority: order[next] },
      run.actorId,
      { ctx: x.ctx },
    );
  },
  describe: (a) =>
    `${a.direction === 'UP' ? 'Raise' : 'Lower'} the priority one step`,
});

const SET_START_DATE = action<'SET_START_DATE'>({
  ...base,
  type: 'SET_START_DATE',
  label: 'Set start date',
  summary: 'Sets the start date N days from now, or shifts the due date.',
  example: { type: 'SET_START_DATE', inDays: 1 },
  schema: (v, path, sink) => {
    obj({
      type: req(literal('SET_START_DATE')),
      inDays: req(int({ min: -365, max: 365 })),
      from: opt(oneOf(['NOW', 'DUE_DATE'], 'from')),
    })(v, path, sink);
    relativeDays(v, path, sink);
  },
  refs: [],
  async execute(a, run, x) {
    const start = await relativeDate(x, run, a.inDays, a.from);
    await x.tasks.update(
      run.taskId!,
      { startDate: start.toISOString() },
      run.actorId,
      { ctx: x.ctx },
    );
  },
  describe: (a) =>
    `Set the start date ${days(a.inDays)}${a.from === 'DUE_DATE' ? ' the due date' : ''}`,
});

const ARCHIVE_TASK = action<'ARCHIVE_TASK'>({
  ...base,
  type: 'ARCHIVE_TASK',
  label: 'Archive task',
  summary: 'Archives the task (rules archive, they never delete).',
  example: { type: 'ARCHIVE_TASK' },
  schema: obj({ type: req(literal('ARCHIVE_TASK')) }),
  refs: [],
  async execute(_a, run, x) {
    await x.tasks.archive(run.taskId!, run.actorId, x.ctx);
  },
  describe: () => 'Archive the task',
});

const RESTORE_TASK = action<'RESTORE_TASK'>({
  ...base,
  type: 'RESTORE_TASK',
  label: 'Restore task',
  summary: 'Brings an archived task back.',
  example: { type: 'RESTORE_TASK' },
  schema: obj({ type: req(literal('RESTORE_TASK')) }),
  refs: [],
  async execute(_a, run, x) {
    await x.tasks.restore(run.taskId!, run.actorId, x.ctx);
  },
  describe: () => 'Restore the task',
});

export const TASK_ACTIONS = {
  SET_STATUS,
  SET_PRIORITY,
  ASSIGN,
  SET_DUE_DATE,
  SET_CUSTOM_FIELD,
  ADD_TAG,
  REMOVE_TAG,
  RENAME_TASK,
  SET_DESCRIPTION,
  SET_ESTIMATE,
  SET_ISSUE_TYPE,
  SET_ITERATION,
  CHANGE_PRIORITY,
  SET_START_DATE,
  ARCHIVE_TASK,
  RESTORE_TASK,
};
