import { HttpException } from '@nestjs/common';
import { CommentableType, Role } from '@prisma/client';
import { AUTOMATION_LIMITS as L } from '../dsl/rule.limits';
import { treeLimits } from '../dsl/rule.settings';
import { arr, int, literal, obj, oneOf, opt, req } from '../dsl/rule.schema';
import { renderText } from '../engine/render-text';
import {
  CHANNELS_LATER,
  captureName,
  PRIORITIES,
  id,
  statusRef,
  templateText,
  userRef,
} from './checks';
import { resolveUsers, statusDto, todayParts } from './action-helpers';
import { action } from './actions.task';

const base = { ceiling: Role.ADMIN, portable: true } as const;

const COMMENT = action<'COMMENT'>({
  ...base,
  needs: { task: true, project: false },
  type: 'COMMENT',
  label: 'Comment',
  summary: 'Posts a comment on the task (marked as written by a rule).',
  example: { type: 'COMMENT', body: 'Moved to {{task.status}}' },
  schema: obj({
    type: req(literal('COMMENT')),
    body: req(templateText(L.maxCommentLength, 'comment')),
  }),
  refs: [],
  async execute(a, run, x) {
    await x.comments.createSystemComment(
      CommentableType.TASK,
      run.taskId!,
      run.actorId,
      renderText(a.body, run.vars, L.maxCommentLength),
      x.ctx,
    );
  },
  describe: () => 'Comment on the task',
});

const CREATE_SUBTASK = action<'CREATE_SUBTASK'>({
  ...base,
  needs: { task: true, project: true },
  type: 'CREATE_SUBTASK',
  label: 'Create subtask',
  summary: 'Adds a subtask under the task.',
  example: {
    type: 'CREATE_SUBTASK',
    title: 'Review {{task.key}}',
    assignees: ['TRIGGERER'],
  },
  schema: obj({
    type: req(literal('CREATE_SUBTASK')),
    title: req(templateText(L.maxSubtaskTitleLength, 'title')),
    priority: opt(oneOf(PRIORITIES, 'priority')),
    assignees: opt(arr(userRef, { min: 1, max: 10 })),
    as: opt(captureName),
  }),
  refs: [{ key: 'assignees', kind: 'user', shape: 'list' }],
  // a rule must not create what triggers it
  ruleCheck: (rule, pointer) => {
    const guarded = (rule.conditions.all ?? []).some(
      (c) => c.field === 'IS_SUBTASK' && c.op === 'IS_FALSE',
    );
    return rule.trigger.type === 'TASK_CREATED' && !guarded
      ? [
          {
            code: 'UNBOUNDED_RECURSION',
            path: pointer,
            message:
              'Creating a subtask when a task is created repeats forever; add the condition "is a subtask: false"',
          },
        ]
      : [];
  },
  async execute(a, run, x) {
    if (!run.projectId)
      throw new HttpException(
        'A task without a project cannot have subtasks',
        422,
      );
    const created = await x.domainWriter.createTask(
      {
        workspaceId: run.workspaceId,
        projectId: run.projectId,
        parentId: run.taskId,
        title: renderText(a.title, run.vars, L.maxSubtaskTitleLength),
        ...(a.priority ? { priority: a.priority } : {}),
      } as never,
      run.actorId,
      x.ctx,
    );
    if (a.assignees && a.assignees.length > 0) {
      await x.tasks.setAssignees(
        (created as { id: string }).id,
        { userIds: await resolveUsers(a.assignees, run, x) },
        run.actorId,
        x.ctx,
      );
    }
    return { createdTaskId: (created as { id: string }).id };
  },
  describe: () => 'Create a subtask',
});

const NOTIFY_CHANNEL = action<'NOTIFY_CHANNEL'>({
  ...base,
  needs: { task: true, project: false },
  // a chat channel is an id in one workspace and means nothing in another
  portable: false,
  type: 'NOTIFY_CHANNEL',
  label: 'Notify a chat channel',
  summary:
    'Posts a message to a linked chat channel. Needs the chat integration (Phase 2).',
  example: {
    type: 'NOTIFY_CHANNEL',
    channelLinkId: 'CHANNEL_LINK_ID',
    message: '{{task.title}} is done',
  },
  schema: obj({
    type: req(literal('NOTIFY_CHANNEL')),
    channelLinkId: req(id('channel link id')),
    message: req(templateText(L.maxMessageLength, 'message')),
  }),
  unavailable: CHANNELS_LATER,
  refs: [{ key: 'channelLinkId', kind: 'channel', shape: 'one' }],
  // a rule with this can never be enabled
  async execute() {
    throw new HttpException('Chat notifications are not available yet', 422);
  },
  describe: () => 'Post to a chat channel',
});

const CREATE_TASK = action<'CREATE_TASK'>({
  ...base,
  // the only action a SCHEDULE rule may use: it makes new work and needs somewhere to put it
  needs: { task: false, project: true },
  type: 'CREATE_TASK',
  label: 'Create task',
  summary:
    "Creates a task in the rule's project (or the triggering task's project).",
  example: {
    type: 'CREATE_TASK',
    title: 'Weekly review {{date}}',
    tags: ['TAG_ID'],
    assignees: ['CREATOR'],
    status: { category: 'TODO' },
  },
  schema: obj({
    type: req(literal('CREATE_TASK')),
    title: req(templateText(L.maxSubtaskTitleLength, 'title')),
    description: opt(templateText(L.maxDescriptionLength, 'description')),
    priority: opt(oneOf(PRIORITIES, 'priority')),
    dueInDays: opt(int({ min: 0, max: 365 })),
    tags: opt(arr(id('tag id'), { min: 1, max: 10 })),
    assignees: opt(arr(userRef, { min: 1, max: 10 })),
    status: opt(statusRef),
    as: opt(captureName),
  }),
  refs: [
    { key: 'tags', kind: 'tag', shape: 'list' },
    { key: 'assignees', kind: 'user', shape: 'list' },
    { key: 'status', kind: 'status', shape: 'statusRef' },
  ],
  // a task per task, forever (the runtime guards would stop it after one step; better refused)
  ruleCheck: (rule, pointer) => {
    const hasConditions =
      (rule.conditions.all?.length ?? 0) + (rule.conditions.any?.length ?? 0) >
      0;
    return rule.trigger.type === 'TASK_CREATED' && !hasConditions
      ? [
          {
            code: 'UNBOUNDED_RECURSION',
            path: pointer,
            message:
              'Creating a task whenever a task is created needs a condition that says WHICH tasks',
          },
        ]
      : [];
  },
  async execute(a, run, x) {
    if (!run.projectId)
      throw new HttpException('There is no project to create the task in', 422);
    const created = (await x.domainWriter.createTask(
      {
        workspaceId: run.workspaceId,
        projectId: run.projectId,
        title: renderText(a.title, run.vars, L.maxSubtaskTitleLength),
        ...(a.description
          ? {
              description: renderText(
                a.description,
                run.vars,
                L.maxDescriptionLength,
              ),
            }
          : {}),
        ...(a.priority ? { priority: a.priority } : {}),
        ...(a.dueInDays !== undefined
          ? {
              dueDate: new Date(
                Date.UTC(...todayParts(a.dueInDays)),
              ).toISOString(),
            }
          : {}),
        ...(a.status ? statusDto(a.status) : {}),
      } as never,
      run.actorId,
      x.ctx,
    )) as { id: string };
    for (const tagId of a.tags ?? [])
      await x.tags.attach(created.id, tagId, run.actorId, x.ctx);
    if (a.assignees && a.assignees.length > 0) {
      await x.tasks.setAssignees(
        created.id,
        { userIds: await resolveUsers(a.assignees, run, x) },
        run.actorId,
        x.ctx,
      );
    }
    return { createdTaskId: created.id };
  },
  describe: () => 'Create a task',
});

const NOTIFY = action<'NOTIFY'>({
  ...base,
  needs: { task: true, project: false },
  type: 'NOTIFY',
  label: 'Notify people',
  summary:
    "Sends an in-app notification with your own text ({{placeholders}} are filled in) to people: user ids, TRIGGERER, CREATOR, or the task's ASSIGNEES or WATCHERS. Only people who can see the task receive it; a group bigger than the limit makes the action fail instead of reaching some of them.",
  example: {
    type: 'NOTIFY',
    users: ['ASSIGNEES', 'WATCHERS'],
    message: '{{task.key}} {{task.title}} is now {{task.status}}',
  },
  schema: obj({
    type: req(literal('NOTIFY')),
    users: req(arr(userRef, { min: 1, max: 10 })),
    message: req(templateText(L.maxMessageLength, 'message')),
  }),
  refs: [{ key: 'users', kind: 'user', shape: 'list' }],
  async execute(a, run, x) {
    const people = await resolveUsers(a.users, run, x);
    const max = treeLimits().maxNotifyRecipients;
    if (people.length > max)
      throw new HttpException(
        `This would notify ${people.length} people; the limit is ${max} (AUTOMATION_MAX_NOTIFY_RECIPIENTS)`,
        422,
      );
    if (people.length === 0) return; // a group with nobody in it: nothing to send, not an error
    await x.notify(people, renderText(a.message, run.vars, L.maxMessageLength));
  },
  describe: (a) =>
    `Notify ${a.users.length} ${a.users.length === 1 ? 'recipient' : 'recipients'}`,
});

export const WORK_ACTIONS = {
  NOTIFY,
  COMMENT,
  CREATE_SUBTASK,
  NOTIFY_CHANNEL,
  CREATE_TASK,
};
