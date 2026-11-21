import { NotFoundException } from '@nestjs/common';
/**
 * Step 5.6 on a real database: more triggers (comments, archive/restore, all subtasks done, overdue,
 * schedules) and more actions (create/rename/describe/estimate/classify/prioritise/date/archive/restore).
 * Original header: Step 5.2 on a real database. Rules are saved through the real AutomationsService and people change
 * tasks through the real TasksService, so every event travels the real path:
 *   service write -> activity row -> 'activity.created' -> runner -> rule -> actions (real services) -> activity -> ...
 */
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { CommentableType, CreationMode, Role } from '@prisma/client';
import { PermissionResolver } from '../../src/access-control/access-control.service';
import { PlanLimitsService } from '../../src/access-control/plan-limits.service';
import { NotificationsService } from '../../src/activity-notifications/notifications/notifications.service';
import {
  AUTOMATION_USER_EMAIL,
  AutomationActorService,
} from '../../src/automations/automation-actor.service';
import { AutomationRunnerService } from '../../src/automations/automation-runner.service';
import { ActionExecutor } from '../../src/automations/action-executor.service';
import { NotificationSseRegistry } from '../../src/activity-notifications/sse/notification-sse-registry.service';
import { AutomationNotifier } from '../../src/automations/automation-notifier.service';
import { AutomationWaitService } from '../../src/automations/automation-wait.service';
import { TaskVisibilityService } from '../../src/projects-tasks/tasks/task-visibility.service';
import { TaskQueryService } from '../../src/views/run/task-query.service';
import { AutomationsService } from '../../src/automations/automations.service';
import { WorkspaceContextLoader } from '../../src/automations/dsl/workspace-context.loader';
import { DueSweepService } from '../../src/automations/due-sweep.service';
import { AUTOMATION_LIMITS } from '../../src/automations/dsl';
import { CommentsService } from '../../src/collaboration/comments/comments.service';
import { DomainWriter } from '../../src/domain-writer/domain-writer.service';
import { ActivityService } from '../../src/events/activity.service';
import { AuditLogService } from '../../src/events/audit-log.service';
import { FeatureFlagsService } from '../../src/feature-flags/feature-flags.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { CustomFieldsService } from '../../src/projects-tasks/custom-fields/custom-fields.service';
import { TaskPlanningService } from '../../src/projects-tasks/planning/task-planning.service';
import { ProjectsService } from '../../src/projects-tasks/projects/projects.service';
import { TagsService } from '../../src/projects-tasks/tags/tags.service';
import { TaskTreeService } from '../../src/projects-tasks/tasks/task-tree.service';
import { TasksService } from '../../src/projects-tasks/tasks/tasks.service';
import { WorkflowService } from '../../src/projects-tasks/workflow/workflow.service';
import { WorkspacesService } from '../../src/tenancy/workspaces/workspaces.service';
import {
  addAccountMember,
  createAccount,
  createProject,
  createUser,
  createWorkspace,
} from './factories';
import {
  disconnectTestPrisma,
  getTestPrisma,
} from './support/prisma-test-client';
import { resetDb } from './support/reset-db';

jest.setTimeout(180_000);

describe('Richer automations (step 5.6)', () => {
  let prisma: PrismaService;
  let rules: AutomationsService;
  let runner: AutomationRunnerService;
  let sweep: DueSweepService;
  let notifs: NotificationsService;
  let waitSvc: AutomationWaitService;
  let tasks: TasksService;
  let comments: CommentsService;
  let emitter: EventEmitter2;
  let flags: { WORKFLOW: boolean };

  beforeAll(async () => {
    prisma = getTestPrisma();
    emitter = new EventEmitter2();
    flags = { WORKFLOW: true };
    const moduleRef = await Test.createTestingModule({
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: emitter },
        { provide: WorkspacesService, useValue: {} },
        {
          provide: FeatureFlagsService,
          useValue: {
            isEnabled: (f: string) =>
              f === 'WORKFLOW' ? flags.WORKFLOW : false,
          },
        },
        ActivityService,
        AuditLogService,
        PermissionResolver,
        PlanLimitsService,
        TaskVisibilityService,
        TasksService,
        TaskTreeService,
        WorkflowService,
        TaskPlanningService,
        ProjectsService,
        CustomFieldsService,
        TagsService,
        CommentsService,
        DomainWriter,
        WorkspaceContextLoader,
        AutomationsService,
        AutomationActorService,
        TaskQueryService,
        NotificationsService,
        // no Redis in these tests: a notification is stored, and the live push goes nowhere
        {
          provide: NotificationSseRegistry,
          useValue: { publish: async () => undefined },
        },
        AutomationNotifier,
        AutomationWaitService,
        ActionExecutor,
        AutomationRunnerService,
        DueSweepService,
      ],
    }).compile();
    rules = moduleRef.get(AutomationsService);
    runner = moduleRef.get(AutomationRunnerService);
    sweep = moduleRef.get(DueSweepService);
    notifs = moduleRef.get(NotificationsService);
    waitSvc = moduleRef.get(AutomationWaitService);
    tasks = moduleRef.get(TasksService);
    comments = moduleRef.get(CommentsService);
    // what @OnEvent does in the real app
    emitter.on('activity.created', (a) => runner.onActivity(a));
  });
  beforeEach(async () => {
    flags.WORKFLOW = true;
    await resetDb(prisma);
  });
  afterAll(() => disconnectTestPrisma());

  // ------------------------------------------------------------------ world --------------------
  async function world() {
    const account = await createAccount(prisma, {});
    const mk = async (role: Role) => {
      const u = await createUser(prisma);
      await addAccountMember(prisma, {
        accountId: account.id,
        userId: u.id,
        role,
      });
      return u;
    };
    const owner = await mk(Role.OWNER);
    const member = await mk(Role.MEMBER);
    const member2 = await mk(Role.MEMBER);
    const ws = await createWorkspace(prisma, { accountId: account.id });
    const p1 = await createProject(prisma, {
      workspaceId: ws.id,
      createdById: owner.id,
    });
    const p2 = await createProject(prisma, {
      workspaceId: ws.id,
      createdById: owner.id,
    });
    const tag = (name: string) =>
      prisma.tag.create({ data: { workspaceId: ws.id, name, nameKey: name } });
    const [tagA, tagB] = [await tag('a'), await tag('b')];
    const status = async (projectId: string, category: string) =>
      await prisma.workflowStatus.findFirstOrThrow({
        where: { projectId, category: category as any },
      });
    const field = await prisma.customField.create({
      data: {
        workspaceId: ws.id,
        key: 'score',
        name: 'score',
        dataType: 'NUMBER',
      },
    });
    return {
      account,
      owner,
      member,
      member2,
      ws,
      p1,
      p2,
      tagA,
      tagB,
      field,
      done1: await status(p1.id, 'DONE'),
      todo1: await status(p1.id, 'TODO'),
    };
  }
  type W = Awaited<ReturnType<typeof world>>;
  const mkRule = (
    w: W,
    name: string,
    rule: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ) =>
    rules.create(w.ws.id, w.owner.id, {
      name,
      enabled: true,
      ...rule,
      ...extra,
    } as any);
  const mkTask = async (w: W, over: Record<string, unknown> = {}) => {
    const t = await tasks.create(
      {
        workspaceId: w.ws.id,
        projectId: w.p1.id,
        title: 'Fix login',
        ...over,
      } as any,
      w.owner.id,
    );
    await runner.whenIdle();
    return t;
  };
  const idle = () => runner.whenIdle();
  const runsOf = (automationId: string) =>
    prisma.automationRun.findMany({
      where: { automationId },
      orderBy: [{ ranAt: 'asc' }, { id: 'asc' }],
    });
  const tagIdsOf = async (taskId: string) =>
    (await prisma.taskTag.findMany({ where: { taskId } }))
      .map((x) => x.tagId)
      .sort();
  const sysUser = () =>
    prisma.user.findUniqueOrThrow({ where: { email: AUTOMATION_USER_EMAIL } });

  // ------------------------------------------------------------------ helpers (5.6) ----------
  const person = (w: W, content: string, taskId: string, userId = w.owner.id) =>
    comments.create(
      { targetType: CommentableType.TASK, targetId: taskId, content } as any,
      userId,
    );
  const sub = async (w: W, parentId: string, title = 'sub') => {
    const t = await tasks.create(
      { workspaceId: w.ws.id, projectId: w.p1.id, parentId, title } as any,
      w.owner.id,
    );
    await idle();
    return t;
  };
  const finish = async (w: W, taskId: string) => {
    await tasks.update(
      taskId,
      { workflowStatusId: w.done1.id } as any,
      w.owner.id,
    );
    await idle();
  };
  const taskRow = (id: string) =>
    prisma.task.findUniqueOrThrow({
      where: { id },
      include: { assignees: true },
    });
  const NOW = new Date('2026-10-19T09:05:00.000Z'); // a Monday
  const hours = (n: number, from = NOW) =>
    new Date(from.getTime() + n * 3_600_000);
  const lateTask = async (
    w: W,
    due: Date | null,
    over: Record<string, unknown> = {},
  ) => {
    const t = await tasks.create(
      { workspaceId: w.ws.id, projectId: w.p1.id, title: 'late' } as any,
      w.owner.id,
      { origin: CreationMode.MANUAL, actorId: w.owner.id, silent: true },
    );
    await prisma.task.update({
      where: { id: t.id },
      data: { dueDate: due, ...over },
    });
    return t;
  };
  const noConditions = {};

  // =============================================================== comments =====================
  describe('COMMENT_ADDED', () => {
    it('reacts to what a person wrote, matching text without caring about case', async () => {
      const w = await world();
      const r = await mkRule(w, 'Urgent word', {
        trigger: { type: 'COMMENT_ADDED', contains: 'URGENT' },
        actions: [{ type: 'SET_PRIORITY', priority: 'URGENT' }],
      });
      const t = await mkTask(w);
      await person(w, 'just a note', t.id);
      await idle();
      expect((await taskRow(t.id)).priority).toBeNull();
      await person(w, 'this is Urgent, please look', t.id);
      await idle();
      expect((await taskRow(t.id)).priority).toBe('URGENT');
      expect((await runsOf(r.id)).map((x) => x.status)).toEqual(['OK']);
    });

    it("a rule's own comments do not trigger rules (people only, the default) unless a rule asks for anyone", async () => {
      const w = await world();
      await mkRule(w, 'Says urgent', {
        trigger: { type: 'TASK_CREATED' },
        actions: [{ type: 'COMMENT', body: 'urgent: {{task.title}}' }],
      });
      const people = await mkRule(w, 'People', {
        trigger: { type: 'COMMENT_ADDED', contains: 'urgent' },
        actions: [{ type: 'ADD_TAG', tagId: w.tagA.id }],
      });
      const anyone = await mkRule(w, 'Anyone', {
        trigger: { type: 'COMMENT_ADDED', contains: 'urgent', by: 'ANYONE' },
        actions: [{ type: 'ADD_TAG', tagId: w.tagB.id }],
      });
      const t = await mkTask(w);
      expect(await runsOf(people.id)).toHaveLength(0);
      expect((await runsOf(anyone.id)).map((x) => [x.status, x.depth])).toEqual(
        [['OK', 1]],
      ); // caused by a rule: one step deep
      expect(await tagIdsOf(t.id)).toEqual([w.tagB.id]);
    });

    it("two rules answering each other's comments stop (the comment carries which rule wrote it and how deep)", async () => {
      const w = await world();
      const a = await mkRule(w, 'Ping', {
        trigger: { type: 'COMMENT_ADDED', contains: 'ping', by: 'ANYONE' },
        actions: [{ type: 'COMMENT', body: 'pong' }],
      });
      const b = await mkRule(w, 'Pong', {
        trigger: { type: 'COMMENT_ADDED', contains: 'pong', by: 'ANYONE' },
        actions: [{ type: 'COMMENT', body: 'ping' }],
      });
      const t = await mkTask(w);
      await person(w, 'ping', t.id);
      await idle();
      const all = [...(await runsOf(a.id)), ...(await runsOf(b.id))];
      expect(
        all.some(
          (r) => r.status === 'SKIPPED' && /LOOP_GUARD/.test(r.error ?? ''),
        ),
      ).toBe(true);
      expect(
        await prisma.comment.count({ where: { targetId: t.id } }),
      ).toBeLessThanOrEqual(1 + AUTOMATION_LIMITS.maxChainDepth + 1);
      expect(
        all
          .filter((r) => r.status === 'OK')
          .every((r) => r.depth < AUTOMATION_LIMITS.maxChainDepth),
      ).toBe(true);
    });

    it('a comment on an ARCHIVED task still reaches rules: "reopen when someone comments"', async () => {
      const w = await world();
      await mkRule(w, 'Reopen on comment', {
        trigger: { type: 'COMMENT_ADDED' },
        actions: [{ type: 'RESTORE_TASK' }],
      });
      const t = await mkTask(w);
      await tasks.archive(t.id, w.owner.id);
      await idle();
      expect((await taskRow(t.id)).isArchived).toBe(true);
      await person(w, 'wait, one more thing', t.id);
      await idle();
      expect((await taskRow(t.id)).isArchived).toBe(false);
    });

    it('a deleted comment is not an event', async () => {
      const w = await world();
      const r = await mkRule(w, 'x', {
        trigger: { type: 'COMMENT_ADDED' },
        actions: [{ type: 'ADD_TAG', tagId: w.tagA.id }],
      });
      const t = await mkTask(w);
      const c = await person(w, 'hello', t.id);
      await prisma.comment.delete({ where: { id: c.id } });
      await idle(); // (the rule may already have run before the delete: what matters is no crash and at most one run)
      expect((await runsOf(r.id)).length).toBeLessThanOrEqual(1);
      const act = await prisma.activity.findFirstOrThrow({
        where: { targetId: t.id, action: 'COMMENTED' },
      });
      const ev = {
        eventId: 'gone-1',
        kind: 'COMMENT_ADDED' as const,
        commentId: c.id,
        workspaceId: w.ws.id,
        taskId: t.id,
        actorId: w.owner.id,
        depth: 0,
        causedBy: null,
        at: new Date(),
      };
      await prisma.automationRun.deleteMany({});
      expect(await runner.handleEvent(ev)).toEqual({});
      expect(act.id).toBeDefined();
    });
  });

  // =============================================================== archive / restore ============
  describe('TASK_ARCHIVED and TASK_RESTORED', () => {
    it('fire on the archive and on the restore', async () => {
      const w = await world();
      const a = await mkRule(w, 'On archive', {
        trigger: { type: 'TASK_ARCHIVED' },
        actions: [
          { type: 'COMMENT', body: '{{task.key}} archived on {{date}}' },
        ],
      });
      const r = await mkRule(w, 'On restore', {
        trigger: { type: 'TASK_RESTORED' },
        actions: [{ type: 'ADD_TAG', tagId: w.tagA.id }],
      });
      const t = await mkTask(w);
      await tasks.archive(t.id, w.owner.id);
      await idle();
      expect(await runsOf(a.id)).toHaveLength(1);
      expect(await runsOf(r.id)).toHaveLength(0);
      const c = await prisma.comment.findFirstOrThrow({
        where: { targetId: t.id },
      });
      expect(c.content).toMatch(
        /^[A-Z0-9]+-\d+ archived on \d{4}-\d{2}-\d{2}$/,
      );
      await tasks.restore(t.id, w.owner.id);
      await idle();
      expect(await runsOf(r.id)).toHaveLength(1);
      expect(await tagIdsOf(t.id)).toEqual([w.tagA.id]);
    });
    it('a rule that archives is stamped, so a rule watching archives does not chase it', async () => {
      const w = await world();
      const archiver = await mkRule(w, 'Archive done', {
        trigger: { type: 'FIELD_CHANGED', field: 'PRIORITY' },
        conditions: { all: [{ field: 'PRIORITY', op: 'IN', value: ['LOW'] }] },
        actions: [{ type: 'ARCHIVE_TASK' }],
      });
      const watcher = await mkRule(w, 'Watch archives', {
        trigger: { type: 'TASK_ARCHIVED' },
        actions: [{ type: 'ADD_TAG', tagId: w.tagB.id }],
      });
      const t = await mkTask(w);
      await tasks.update(t.id, { priority: 'LOW' }, w.owner.id);
      await idle();
      expect((await taskRow(t.id)).isArchived).toBe(true);
      const act = await prisma.activity.findFirstOrThrow({
        where: { targetId: t.id, action: 'ARCHIVED' },
      });
      expect(act.metadata).toMatchObject({
        origin: CreationMode.AUTOMATION,
        automation: { id: archiver.id, depth: 1 },
      });
      expect(
        (await runsOf(watcher.id)).map((x) => [x.status, x.depth]),
      ).toEqual([['OK', 1]]);
    });
  });

  // =============================================================== all subtasks done ============
  describe('ALL_SUBTASKS_DONE', () => {
    it('fires on the parent when the last open subtask is done, and again if it is reopened and finished', async () => {
      const w = await world();
      const r = await mkRule(w, 'Close parent', {
        trigger: { type: 'ALL_SUBTASKS_DONE' },
        actions: [
          { type: 'SET_STATUS', status: { category: 'DONE' } },
          {
            type: 'COMMENT',
            body: "all of {{task.title}}'s subtasks are done",
          },
        ],
      });
      const parent = await mkTask(w, { title: 'Release' });
      const [a, b, c] = [
        await sub(w, parent.id, 'a'),
        await sub(w, parent.id, 'b'),
        await sub(w, parent.id, 'c'),
      ];
      await finish(w, a.id);
      await finish(w, b.id);
      expect(await runsOf(r.id)).toHaveLength(0);
      expect((await taskRow(parent.id)).status).not.toBe('DONE');
      await finish(w, c.id);
      expect((await runsOf(r.id)).map((x) => [x.status, x.taskId])).toEqual([
        ['OK', parent.id],
      ]);
      expect((await taskRow(parent.id)).status).toBe('DONE');
      expect(
        (
          await prisma.comment.findFirstOrThrow({
            where: { targetId: parent.id },
          })
        ).content,
      ).toBe("all of Release's subtasks are done");
      await tasks.update(
        c.id,
        { workflowStatusId: w.todo1.id } as any,
        w.owner.id,
      );
      await idle();
      await finish(w, c.id);
      expect(await runsOf(r.id)).toHaveLength(2); // a new completion is a new event
    });
    it('ignores archived subtasks, a task with no parent, and rules of another workspace', async () => {
      const w = await world();
      const other = await world();
      const r = await mkRule(w, 'Close parent', {
        trigger: { type: 'ALL_SUBTASKS_DONE' },
        actions: [{ type: 'ADD_TAG', tagId: w.tagA.id }],
      });
      const ro = await mkRule(other, 'Other', {
        trigger: { type: 'ALL_SUBTASKS_DONE' },
        actions: [{ type: 'ADD_TAG', tagId: other.tagA.id }],
      });
      const parent = await mkTask(w);
      const [a, b] = [await sub(w, parent.id), await sub(w, parent.id)];
      await tasks.archive(b.id, w.owner.id);
      await idle();
      const lone = await mkTask(w, { title: 'lone' });
      await finish(w, lone.id);
      expect(await runsOf(r.id)).toHaveLength(0);
      await finish(w, a.id);
      expect(await runsOf(r.id)).toHaveLength(1); // the archived one does not hold the parent open
      expect(await runsOf(ro.id)).toHaveLength(0);
    });
    it('the event is derived once per completion even with several rules listening', async () => {
      const w = await world();
      const r1 = await mkRule(w, 'One', {
        trigger: { type: 'ALL_SUBTASKS_DONE' },
        actions: [{ type: 'ADD_TAG', tagId: w.tagA.id }],
      });
      const r2 = await mkRule(w, 'Two', {
        trigger: { type: 'ALL_SUBTASKS_DONE' },
        actions: [{ type: 'ADD_TAG', tagId: w.tagB.id }],
      });
      const parent = await mkTask(w);
      const a = await sub(w, parent.id);
      await finish(w, a.id);
      expect(await runsOf(r1.id)).toHaveLength(1);
      expect(await runsOf(r2.id)).toHaveLength(1);
      expect(await tagIdsOf(parent.id)).toEqual([w.tagA.id, w.tagB.id].sort());
    });
  });

  // =============================================================== overdue ======================
  describe('TASK_OVERDUE (the sweep)', () => {
    const overdueRule = (w: W, over: Record<string, unknown> = {}) =>
      mkRule(w, 'Overdue', {
        trigger: { type: 'TASK_OVERDUE' },
        actions: [{ type: 'ADD_TAG', tagId: w.tagA.id }],
        ...over,
      });
    it('fires for tasks that just went overdue - not future, not long-late, not done, not archived, not undated', async () => {
      const w = await world();
      const r = await overdueRule(w);
      const late = await lateTask(w, hours(-1));
      const justNow = await lateTask(w, hours(-0.01));
      const future = await lateTask(w, hours(5));
      const ancient = await lateTask(w, hours(-24 * 10));
      const done = await lateTask(w, hours(-2), { status: 'DONE' });
      const archived = await lateTask(w, hours(-2), { isArchived: true });
      const none = await lateTask(w, null);
      const res = await sweep.sweep(NOW);
      await idle();
      expect(res).toEqual({ rules: 1, fired: 2 });
      for (const [t, want] of [
        [late, true],
        [justNow, true],
        [future, false],
        [ancient, false],
        [done, false],
        [archived, false],
        [none, false],
      ] as const) {
        expect(await tagIdsOf(t.id)).toEqual(want ? [w.tagA.id] : []);
      }
      expect((await runsOf(r.id)).map((x) => x.status)).toEqual(['OK', 'OK']);
    });
    it('is idempotent; moving the due date re-arms it', async () => {
      const w = await world();
      const r = await overdueRule(w);
      const t = await lateTask(w, hours(-3));
      await sweep.sweep(NOW);
      await idle();
      expect(await sweep.sweep(hours(1, NOW))).toEqual({ rules: 1, fired: 0 });
      await prisma.taskTag.deleteMany({ where: { taskId: t.id } });
      await prisma.task.update({
        where: { id: t.id },
        data: { dueDate: hours(-2) },
      });
      expect((await sweep.sweep(NOW)).fired).toBe(1);
      await idle();
      expect(await runsOf(r.id)).toHaveLength(2);
    });
    it('afterHours waits: overdue by 30 hours fires a "24 hours late" rule, overdue by 2 does not', async () => {
      const w = await world();
      await overdueRule(w, {
        trigger: { type: 'TASK_OVERDUE', afterHours: 24 },
      });
      const a = await lateTask(w, hours(-30));
      const b = await lateTask(w, hours(-2));
      await sweep.sweep(NOW);
      await idle();
      expect(await tagIdsOf(a.id)).toEqual([w.tagA.id]);
      expect(await tagIdsOf(b.id)).toEqual([]);
      await sweep.sweep(hours(23, NOW));
      await idle(); // 25 hours after "b" went late: now it counts
      expect(await tagIdsOf(b.id)).toEqual([w.tagA.id]);
    });
    it('respects scope and conditions; escalates priority as an example of the point', async () => {
      const w = await world();
      await overdueRule(w, { projectId: w.p2.id });
      const esc = await mkRule(w, 'Escalate', {
        trigger: { type: 'TASK_OVERDUE' },
        conditions: {
          all: [{ field: 'PRIORITY', op: 'IN', value: ['MEDIUM'] }],
        },
        actions: [
          { type: 'CHANGE_PRIORITY', direction: 'UP' },
          { type: 'COMMENT', body: 'overdue since {{date}}: priority raised' },
        ],
      });
      const t = await lateTask(w, hours(-2), { priority: 'MEDIUM' });
      const low = await lateTask(w, hours(-2), { priority: 'LOW' });
      await sweep.sweep(NOW);
      await idle();
      expect((await taskRow(t.id)).priority).toBe('HIGH');
      expect((await taskRow(low.id)).priority).toBe('LOW');
      expect(await tagIdsOf(t.id)).toEqual([]); // the project-2 rule did not touch project 1
      expect((await runsOf(esc.id)).map((x) => x.taskId)).toEqual([t.id]);
    });
  });

  // =============================================================== schedule =====================
  describe('SCHEDULE', () => {
    const daily = (
      w: W,
      over: Record<string, unknown> = {},
      extra: Record<string, unknown> = {},
    ) =>
      mkRule(
        w,
        'Standup',
        {
          projectId: w.p1.id,
          trigger: { type: 'SCHEDULE', frequency: 'DAILY', hour: 9 },
          actions: [
            {
              type: 'CREATE_TASK',
              title: 'Standup {{date}}',
              priority: 'LOW',
              tags: [w.tagA.id],
            },
          ],
          ...over,
        },
        extra,
      );

    it('creates its task once for its slot, however many sweeps see it, and again the next day', async () => {
      const w = await world();
      const r = await daily(w);
      expect(await sweep.sweep(new Date('2026-10-19T08:59:00Z'))).toEqual({
        rules: 1,
        fired: 0,
      });
      await sweep.sweep(new Date('2026-10-19T09:05:00Z'));
      await idle();
      await sweep.sweep(new Date('2026-10-19T09:10:00Z'));
      await idle();
      await sweep.sweep(new Date('2026-10-19T09:55:00Z'));
      await idle();
      const titles = async () =>
        (
          await prisma.task.findMany({
            where: { workspaceId: w.ws.id },
            orderBy: { createdAt: 'asc' },
          })
        ).map((t) => t.title);
      expect(await titles()).toEqual(['Standup 2026-10-19']);
      await sweep.sweep(new Date('2026-10-20T09:00:00Z'));
      await idle();
      expect(await titles()).toEqual([
        'Standup 2026-10-19',
        'Standup 2026-10-20',
      ]);
      const runs = await runsOf(r.id);
      expect(runs.map((x) => [x.status, x.taskId, x.depth])).toEqual([
        ['OK', null, 0],
        ['OK', null, 0],
      ]);
      const made = await prisma.task.findFirstOrThrow({
        where: { workspaceId: w.ws.id, title: 'Standup 2026-10-19' },
      });
      expect(made).toMatchObject({
        projectId: w.p1.id,
        priority: 'LOW',
        createdVia: 'AUTOMATION',
      });
      expect(await tagIdsOf(made.id)).toEqual([w.tagA.id]);
      expect(made.createdById).toBe((await sysUser()).id);
    });
    it('a slot missed while the worker was down is run if recent, and not if old', async () => {
      const w = await world();
      await daily(w);
      await sweep.sweep(new Date('2026-10-19T10:40:00Z'));
      await idle(); // 1h40 late
      expect(await prisma.task.count({ where: { workspaceId: w.ws.id } })).toBe(
        1,
      );
      await sweep.sweep(new Date('2026-10-20T12:00:00Z'));
      await idle(); // 3 hours late: skipped
      expect(await prisma.task.count({ where: { workspaceId: w.ws.id } })).toBe(
        1,
      );
    });
    it('weekly and monthly', async () => {
      const w = await world();
      await daily(
        w,
        {
          name: 'x',
          trigger: {
            type: 'SCHEDULE',
            frequency: 'WEEKLY',
            hour: 8,
            weekdays: [1, 3],
          },
          actions: [{ type: 'CREATE_TASK', title: 'Weekly {{date}}' }],
        },
        { name: 'Weekly' },
      );
      await daily(
        w,
        {
          name: 'y',
          trigger: {
            type: 'SCHEDULE',
            frequency: 'MONTHLY',
            hour: 8,
            dayOfMonth: 20,
          },
          actions: [{ type: 'CREATE_TASK', title: 'Monthly {{date}}' }],
        },
        { name: 'Monthly' },
      );
      for (const iso of [
        '2026-10-19T08:05:00Z',
        '2026-10-20T08:05:00Z',
        '2026-10-21T08:05:00Z',
      ]) {
        await sweep.sweep(new Date(iso));
        await idle();
      } // Mon, Tue, Wed
      expect(
        (
          await prisma.task.findMany({
            where: { workspaceId: w.ws.id },
            orderBy: { title: 'asc' },
          })
        ).map((t) => t.title),
      ).toEqual([
        'Monthly 2026-10-20',
        'Weekly 2026-10-19',
        'Weekly 2026-10-21',
      ]);
    });
    it('eight sweeps at once make one task (the slot is the idempotency key)', async () => {
      const w = await world();
      await daily(w);
      await Promise.all(
        Array.from({ length: 8 }, () =>
          sweep.sweep(new Date('2026-10-19T09:05:00Z')),
        ),
      );
      await idle();
      expect(await prisma.task.count({ where: { workspaceId: w.ws.id } })).toBe(
        1,
      );
    });
    it('a disabled rule does not run; the feature flag switches them all off; a failing rule says why', async () => {
      const w = await world();
      const off = await daily(w, {}, { enabled: false });
      flags.WORKFLOW = false;
      expect(await sweep.sweep(new Date('2026-10-19T09:05:00Z'))).toEqual({
        rules: 0,
        fired: 0,
      });
      flags.WORKFLOW = true;
      expect(await sweep.sweep(new Date('2026-10-19T09:05:00Z'))).toEqual({
        rules: 0,
        fired: 0,
      });
      await rules.update(w.ws.id, off.id, w.owner.id, { enabled: true });
      await prisma.project
        .update({ where: { id: w.p1.id }, data: { isArchived: true } as any })
        .catch(() => undefined);
      await prisma.tag.delete({ where: { id: w.tagA.id } }); // the rule's tag is gone: the run fails, loudly
      await sweep.sweep(new Date('2026-10-19T09:05:00Z'));
      await idle();
      const [run] = await runsOf(off.id);
      expect(run).toMatchObject({ status: 'FAILED', taskId: null });
      expect(run.error).toBeTruthy();
    });
  });

  // =============================================================== more actions =================
  describe('actions', () => {
    const onPriority = (
      w: W,
      actions: unknown[],
      over: Record<string, unknown> = {},
    ) =>
      mkRule(w, 'On priority', {
        trigger: { type: 'FIELD_CHANGED', field: 'PRIORITY' },
        conditions: {
          all: [{ field: 'PRIORITY', op: 'IN', value: ['URGENT'] }],
        },
        actions,
        ...over,
      });
    const fire = async (w: W, taskId: string) => {
      await tasks.update(taskId, { priority: 'URGENT' }, w.owner.id);
      await idle();
    };

    it('CREATE_TASK from a task trigger: a new top-level task with everything asked for, in the same project, stamped', async () => {
      const w = await world();
      const r = await mkRule(w, 'Retro', {
        trigger: { type: 'STATUS_CHANGED', to: [{ category: 'DONE' }] },
        actions: [
          {
            type: 'CREATE_TASK',
            title: 'Retro for {{task.title}}',
            description: 'From {{task.key}}',
            priority: 'LOW',
            dueInDays: 3,
            tags: [w.tagA.id],
            assignees: ['TRIGGERER'],
            status: { category: 'TODO' },
          },
        ],
      });
      const t = await mkTask(w, { projectId: w.p2.id, title: 'Ship it' });
      await finish(
        {
          ...w,
          done1: await prisma.workflowStatus.findFirstOrThrow({
            where: { projectId: w.p2.id, category: 'DONE' },
          }),
        } as W,
        t.id,
      );
      const made = await prisma.task.findFirstOrThrow({
        where: { workspaceId: w.ws.id, title: 'Retro for Ship it' },
        include: { assignees: true, workspace: true },
      });
      expect(made).toMatchObject({
        projectId: w.p2.id,
        priority: 'LOW',
        status: 'TODO',
        parentId: null,
        createdVia: 'AUTOMATION',
      });
      expect(made.description).toBe(
        `From ${made.workspace.key}-${(await taskRow(t.id)).number}`,
      );
      expect(made.assignees.map((u) => u.id)).toEqual([w.owner.id]);
      expect(await tagIdsOf(made.id)).toEqual([w.tagA.id]);
      const n = new Date();
      expect(made.dueDate!.toISOString()).toBe(
        new Date(
          Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + 3),
        ).toISOString(),
      );
      const created = await prisma.activity.findFirstOrThrow({
        where: { targetId: made.id, action: 'CREATED' },
      });
      expect(created.metadata).toMatchObject({
        automation: { id: r.id, depth: 1 },
      });
    });
    it('RENAME_TASK and SET_DESCRIPTION (replace, then append twice)', async () => {
      const w = await world();
      await onPriority(w, [
        { type: 'RENAME_TASK', title: '[Urgent] {{task.title}}' },
        {
          type: 'SET_DESCRIPTION',
          text: 'Escalated on {{date}}',
          mode: 'REPLACE',
        },
        { type: 'SET_DESCRIPTION', text: 'by rule', mode: 'APPEND' },
      ]);
      const t = await mkTask(w, { title: 'Fix login', description: 'old' });
      await fire(w, t.id);
      const after = await taskRow(t.id);
      expect(after.title).toBe('[Urgent] Fix login');
      expect(after.description).toMatch(
        /^Escalated on \d{4}-\d{2}-\d{2}\n\nby rule$/,
      );
    });
    it('appending past the description limit fails that action, loudly, and keeps the text', async () => {
      const w = await world();
      const r = await onPriority(w, [
        { type: 'SET_DESCRIPTION', text: 'x'.repeat(200), mode: 'APPEND' },
      ]);
      const t = await mkTask(w, { description: 'y'.repeat(9900) });
      await fire(w, t.id);
      expect((await runsOf(r.id))[0]).toMatchObject({
        status: 'FAILED',
        error: expect.stringMatching(/longer than 10000/),
      });
      expect((await taskRow(t.id)).description).toHaveLength(9900);
    });
    it('SET_ESTIMATE, SET_ISSUE_TYPE and SET_ITERATION set and clear', async () => {
      const w = await world();
      const type = await prisma.issueType.create({
        data: {
          workspaceId: w.ws.id,
          name: 'bug',
          nameKey: 'bug',
          level: 'STANDARD',
        },
      });
      const iter = await prisma.iteration.create({
        data: {
          workspaceId: w.ws.id,
          name: 'Sprint 1',
          kind: 'SPRINT',
          startDate: new Date('2026-10-01'),
          endDate: new Date('2026-10-14'),
        } as any,
      });
      await onPriority(w, [
        { type: 'SET_ESTIMATE', estimate: 5 },
        { type: 'SET_ISSUE_TYPE', issueTypeId: type.id },
        { type: 'SET_ITERATION', iterationId: iter.id },
      ]);
      const t = await mkTask(w);
      await fire(w, t.id);
      expect(await taskRow(t.id)).toMatchObject({
        estimate: 5,
        issueTypeId: type.id,
        iterationId: iter.id,
      });
      await rules.update(
        w.ws.id,
        (
          await prisma.automation.findFirstOrThrow({
            where: { workspaceId: w.ws.id },
          })
        ).id,
        w.owner.id,
        {
          actions: [
            { type: 'SET_ESTIMATE', estimate: null },
            { type: 'SET_ISSUE_TYPE', issueTypeId: null },
            { type: 'SET_ITERATION', iterationId: null },
          ],
        },
      );
      await tasks.update(t.id, { priority: 'LOW' }, w.owner.id);
      await idle();
      await fire(w, t.id);
      expect(await taskRow(t.id)).toMatchObject({
        estimate: null,
        issueTypeId: null,
        iterationId: null,
      });
    });
    it('CHANGE_PRIORITY steps up and down, stops at the ends, and treats "none" as below LOW', async () => {
      const w = await world();
      const up = await mkRule(w, 'Up', {
        trigger: { type: 'TASK_CREATED' },
        conditions: { all: [{ field: 'IS_SUBTASK', op: 'IS_FALSE' }] },
        actions: [{ type: 'CHANGE_PRIORITY', direction: 'UP' }],
      });
      const t = await mkTask(w);
      expect((await taskRow(t.id)).priority).toBe('LOW');
      const down = await mkRule(w, 'Down', {
        trigger: { type: 'FIELD_CHANGED', field: 'DESCRIPTION' },
        actions: [{ type: 'CHANGE_PRIORITY', direction: 'DOWN' }],
      });
      const set = async (p: string | null) =>
        prisma.task.update({
          where: { id: t.id },
          data: { priority: p as any },
        });
      const step = async (dir: 'UP' | 'DOWN', from: string | null) => {
        await set(from);
        await prisma.automation.update({
          where: { id: dir === 'UP' ? up.id : down.id },
          data: {
            trigger:
              dir === 'UP'
                ? { type: 'TASK_CREATED' }
                : { type: 'FIELD_CHANGED', field: 'DESCRIPTION' },
          },
        });
        const ev = {
          eventId: `step-${dir}-${from}-${Math.random()}`,
          kind:
            dir === 'UP'
              ? ('TASK_CREATED' as const)
              : ('FIELD_CHANGED' as const),
          field: 'DESCRIPTION' as const,
          workspaceId: w.ws.id,
          taskId: t.id,
          actorId: w.owner.id,
          depth: 0,
          causedBy: null,
          at: new Date(),
        };
        await runner.handleEvent(ev);
        await idle();
        return (await taskRow(t.id)).priority;
      };
      expect(await step('UP', 'LOW')).toBe('MEDIUM');
      expect(await step('UP', 'HIGH')).toBe('URGENT');
      expect(await step('UP', 'URGENT')).toBe('URGENT');
      expect(await step('DOWN', 'URGENT')).toBe('HIGH');
      expect(await step('DOWN', 'LOW')).toBe('LOW');
      expect(await step('DOWN', null)).toBeNull();
    });
    it("SET_DUE_DATE / SET_START_DATE can count from now or shift the task's own due date", async () => {
      const w = await world();
      await onPriority(w, [
        { type: 'SET_DUE_DATE', inDays: 2, from: 'DUE_DATE' },
        { type: 'SET_START_DATE', inDays: -3, from: 'DUE_DATE' },
      ]);
      const t = await mkTask(w, { dueDate: '2026-12-10T15:30:00.000Z' });
      await fire(w, t.id);
      expect(await taskRow(t.id)).toMatchObject({
        dueDate: new Date('2026-12-12T15:30:00.000Z'),
        startDate: new Date('2026-12-09T15:30:00.000Z'),
      });
      const n = new Date();
      await rules.update(
        w.ws.id,
        (
          await prisma.automation.findFirstOrThrow({
            where: { workspaceId: w.ws.id },
          })
        ).id,
        w.owner.id,
        { actions: [{ type: 'SET_START_DATE', inDays: 0 }] },
      );
      await tasks.update(t.id, { priority: 'LOW' }, w.owner.id);
      await idle();
      await fire(w, t.id);
      expect((await taskRow(t.id)).startDate!.toISOString()).toBe(
        new Date(
          Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()),
        ).toISOString(),
      );
    });
    it('shifting a due date that is not there fails with a reason', async () => {
      const w = await world();
      const r = await onPriority(w, [
        { type: 'SET_DUE_DATE', inDays: 1, from: 'DUE_DATE' },
      ]);
      const t = await mkTask(w);
      await fire(w, t.id);
      expect((await runsOf(r.id))[0]).toMatchObject({
        status: 'FAILED',
        error: 'The task has no due date to count from',
      });
    });
    it('ARCHIVE_TASK archives with its subtasks (the same service a person uses)', async () => {
      const w = await world();
      await onPriority(w, [{ type: 'ARCHIVE_TASK' }]);
      const t = await mkTask(w);
      const child = await sub(w, t.id);
      await fire(w, t.id);
      expect((await taskRow(t.id)).isArchived).toBe(true);
      expect((await taskRow(child.id)).isArchived).toBe(true);
    });
  });

  // =============================================================== saving rules =================
  describe('saving the new rules', () => {
    it('refuses a schedule with no project, tasks with no condition, an unknown iteration; accepts the real thing', async () => {
      const w = await world();
      const codes = async (rule: Record<string, unknown>) => {
        try {
          await mkRule(w, `r${Math.random()}`, rule);
          return [];
        } catch (e: any) {
          return (e.getResponse?.().issues ?? []).map((i: any) => i.code);
        }
      };
      expect(
        await codes({
          trigger: { type: 'SCHEDULE', frequency: 'DAILY', hour: 9 },
          actions: [{ type: 'CREATE_TASK', title: 'x' }],
        }),
      ).toEqual(['SCHEDULE_NEEDS_PROJECT']);
      expect(
        await codes({
          projectId: w.p1.id,
          trigger: { type: 'SCHEDULE', frequency: 'DAILY', hour: 9 },
          actions: [{ type: 'COMMENT', body: 'x' }],
        }),
      ).toEqual(['ACTION_NEEDS_TASK']);
      expect(
        await codes({
          trigger: { type: 'TASK_CREATED' },
          actions: [{ type: 'CREATE_TASK', title: 'again' }],
        }),
      ).toEqual(['UNBOUNDED_RECURSION']);
      expect(
        await codes({
          trigger: { type: 'TASK_CREATED' },
          conditions: noConditions,
          actions: [{ type: 'SET_ITERATION', iterationId: 'nope' }],
        }),
      ).toEqual(['UNKNOWN_ITERATION']);
      expect(
        await codes({
          projectId: w.p1.id,
          trigger: {
            type: 'SCHEDULE',
            frequency: 'WEEKLY',
            hour: 9,
            weekdays: [1],
          },
          actions: [{ type: 'CREATE_TASK', title: 'Weekly' }],
        }),
      ).toEqual([]);
    });
    it('a rule that uses the new triggers can be switched on and listed by trigger type', async () => {
      const w = await world();
      await mkRule(w, 'c', {
        trigger: { type: 'COMMENT_ADDED' },
        actions: [{ type: 'ADD_TAG', tagId: w.tagA.id }],
      });
      await mkRule(w, 'o', {
        trigger: { type: 'TASK_OVERDUE' },
        actions: [{ type: 'ADD_TAG', tagId: w.tagA.id }],
      });
      expect(
        (
          await rules.list(w.ws.id, w.owner.id, {
            enabled: true,
            triggerType: 'TASK_OVERDUE',
          } as any)
        ).map((x) => x.name),
      ).toEqual(['o']);
      expect(
        (await rules.list(w.ws.id, w.owner.id, {})).every((x) => x.enabled),
      ).toBe(true);
    });
  });

  // ------------------------------------------------------------------ IF (step 5.10) ----------
  describe('IF (if / else inside a rule)', () => {
    const ifRule = (w: W, then: unknown[], other?: unknown[]) =>
      mkRule(w, 'If urgent', {
        trigger: { type: 'TASK_CREATED' },
        actions: [
          {
            type: 'IF',
            conditions: {
              all: [{ field: 'PRIORITY', op: 'IN', value: ['HIGH'] }],
            },
            then,
            ...(other ? { else: other } : {}),
          },
        ],
      });
    const withEnv = async (
      vars: Record<string, string>,
      fn: () => Promise<void>,
    ) => {
      const before = Object.fromEntries(
        Object.keys(vars).map((k) => [k, process.env[k]]),
      );
      Object.assign(process.env, vars);
      try {
        await fn();
      } finally {
        for (const [k, v] of Object.entries(before))
          v === undefined ? delete process.env[k] : (process.env[k] = v);
      }
    };

    it('runs `then` for a task that matches and `else` for one that does not; each run is OK', async () => {
      const w = await world();
      const r = await ifRule(
        w,
        [{ type: 'ADD_TAG', tagId: w.tagA.id }],
        [{ type: 'ADD_TAG', tagId: w.tagB.id }],
      );
      const hi = await mkTask(w, { title: 'hi', priority: 'HIGH' });
      const lo = await mkTask(w, { title: 'lo', priority: 'LOW' });
      expect(await tagIdsOf(hi.id)).toEqual([w.tagA.id]);
      expect(await tagIdsOf(lo.id)).toEqual([w.tagB.id]);
      const runs = await runsOf(r.id);
      expect(runs.map((x) => [x.status, x.actionsRun])).toEqual([
        ['OK', 1],
        ['OK', 1],
      ]);
    });

    it('does nothing for a task that does not match when there is no else (the run is still OK)', async () => {
      const w = await world();
      const r = await ifRule(w, [{ type: 'ADD_TAG', tagId: w.tagA.id }]);
      const lo = await mkTask(w, { priority: 'LOW' });
      expect(await tagIdsOf(lo.id)).toEqual([]);
      expect((await runsOf(r.id)).map((x) => [x.status, x.actionsRun])).toEqual(
        [['OK', 0]],
      );
    });

    it('looks at the task WHEN IT RUNS: an earlier action of the same rule changed it', async () => {
      const w = await world();
      await mkRule(w, 'Escalate then branch', {
        trigger: { type: 'TASK_CREATED' },
        actions: [
          { type: 'SET_PRIORITY', priority: 'HIGH' },
          {
            type: 'IF',
            conditions: {
              all: [{ field: 'PRIORITY', op: 'IN', value: ['HIGH'] }],
            },
            then: [{ type: 'ADD_TAG', tagId: w.tagA.id }],
            else: [{ type: 'ADD_TAG', tagId: w.tagB.id }],
          },
        ],
      });
      const t = await mkTask(w, { priority: 'LOW' });
      expect(await tagIdsOf(t.id)).toEqual([w.tagA.id]); // the stale priority (LOW) would have picked tagB
    });

    it('nested IFs choose independently', async () => {
      const w = await world();
      await mkRule(w, 'Nested', {
        trigger: { type: 'TASK_CREATED' },
        actions: [
          {
            type: 'IF',
            conditions: {
              all: [{ field: 'PRIORITY', op: 'IN', value: ['HIGH', 'URGENT'] }],
            },
            then: [
              {
                type: 'IF',
                conditions: {
                  all: [{ field: 'PRIORITY', op: 'IN', value: ['URGENT'] }],
                },
                then: [{ type: 'ADD_TAG', tagId: w.tagA.id }],
                else: [{ type: 'ADD_TAG', tagId: w.tagB.id }],
              },
            ],
          },
        ],
      });
      const urgent = await mkTask(w, { title: 'u', priority: 'URGENT' });
      const high = await mkTask(w, { title: 'h', priority: 'HIGH' });
      const low = await mkTask(w, { title: 'l', priority: 'LOW' });
      expect(await tagIdsOf(urgent.id)).toEqual([w.tagA.id]);
      expect(await tagIdsOf(high.id)).toEqual([w.tagB.id]);
      expect(await tagIdsOf(low.id)).toEqual([]);
    });

    it('a failure inside a branch fails the run and says where; what ran before it stays done', async () => {
      const w = await world();
      const r = await ifRule(w, [
        { type: 'ADD_TAG', tagId: w.tagA.id },
        { type: 'SET_DUE_DATE', inDays: 1, from: 'DUE_DATE' }, // the task has no due date
        { type: 'ADD_TAG', tagId: w.tagB.id },
      ]);
      const t = await mkTask(w, { priority: 'HIGH' });
      expect(await tagIdsOf(t.id)).toEqual([w.tagA.id]);
      const [run] = await runsOf(r.id);
      expect(run.status).toBe('FAILED');
      expect(run.actionsRun).toBe(1);
      expect(run.error).toMatch(/no due date/i);
      expect(run.details).toMatchObject({
        failedAt: 0,
        failedPath: '/actions/0/then/1',
      });
    });

    it('what an IF does is stamped like any rule write (the loop guard still sees it)', async () => {
      const w = await world();
      const r = await ifRule(w, [{ type: 'ADD_TAG', tagId: w.tagA.id }]);
      const t = await mkTask(w, { priority: 'HIGH' });
      const sys = await sysUser();
      const act = await prisma.activity.findMany({
        where: { targetId: t.id, actorId: sys.id },
      });
      expect(act.length).toBeGreaterThan(0);
      for (const a of act)
        expect(a.metadata).toMatchObject({
          origin: CreationMode.AUTOMATION,
          automation: { id: r.id, depth: 1 },
        });
    });

    it('a stored rule over the CURRENT limit does not run: the run fails clearly and nothing changes', async () => {
      const w = await world();
      const r = await ifRule(w, [
        { type: 'ADD_TAG', tagId: w.tagA.id },
        { type: 'ADD_TAG', tagId: w.tagB.id },
      ]); // 3 actions in all
      await withEnv({ AUTOMATION_MAX_TOTAL_ACTIONS: '2' }, async () => {
        const t = await mkTask(w, { priority: 'HIGH' });
        expect(await tagIdsOf(t.id)).toEqual([]);
        const [run] = await runsOf(r.id);
        expect(run.status).toBe('FAILED');
        expect(run.error).toMatch(/more actions than the current limit of 2/);
      });
    });

    describe('saving', () => {
      const codes = async (w: W, actions: unknown[]) => {
        try {
          await mkRule(w, `r${Math.random()}`, {
            trigger: { type: 'TASK_CREATED' },
            actions,
          });
          return [];
        } catch (e: any) {
          return (e.getResponse?.().issues ?? []).map(
            (i: any) => `${i.code}@${i.path}`,
          );
        }
      };
      const cond = { all: [{ field: 'PRIORITY', op: 'IN', value: ['HIGH'] }] };
      const nest = (n: number, leaf: unknown): unknown =>
        n === 0
          ? leaf
          : { type: 'IF', conditions: cond, then: [nest(n - 1, leaf)] };

      it('checks ids nested in branches and in the IF conditions against the workspace', async () => {
        const w = await world();
        expect(
          await codes(w, [
            {
              type: 'IF',
              conditions: {
                all: [{ field: 'TAGS', op: 'HAS_ANY', value: ['nope'] }],
              },
              then: [{ type: 'ADD_TAG', tagId: 'also-nope' }],
              else: [{ type: 'ADD_TAG', tagId: w.tagA.id }],
            },
          ]),
        ).toEqual([
          'UNKNOWN_TAG@/actions/0/conditions/all/0/value/0',
          'UNKNOWN_TAG@/actions/0/then/0/tagId',
        ]);
      });

      it('refuses a rule that creates what triggers it even when the creation is inside an IF', async () => {
        const w = await world();
        expect(
          await codes(w, [nest(1, { type: 'CREATE_SUBTASK', title: 's' })]),
        ).toEqual(['UNBOUNDED_RECURSION@/actions/0/then/0']);
      });

      it('allows 3 IFs inside one another by default, refuses the 4th, and follows the configuration', async () => {
        const w = await world();
        const leaf = { type: 'ADD_TAG', tagId: w.tagA.id };
        expect(await codes(w, [nest(3, leaf)])).toEqual([]);
        expect(await codes(w, [nest(4, leaf)])).toEqual([
          'IF_TOO_DEEP@/actions/0/then/0/then/0/then/0',
        ]);
        await withEnv({ AUTOMATION_MAX_IF_DEPTH: '1' }, async () => {
          expect(await codes(w, [nest(2, leaf)])).toEqual([
            'IF_TOO_DEEP@/actions/0/then/0',
          ]);
        });
        await withEnv({ AUTOMATION_MAX_IF_DEPTH: '5' }, async () => {
          expect(await codes(w, [nest(5, leaf)])).toEqual([]);
        });
      });

      it('counts every action in a rule, branches included, against AUTOMATION_MAX_TOTAL_ACTIONS', async () => {
        const w = await world();
        const tags = (n: number) =>
          Array.from({ length: n }, () => ({
            type: 'ADD_TAG',
            tagId: w.tagA.id,
          }));
        const big = [0, 1, 2].map(() => ({
          type: 'IF',
          conditions: cond,
          then: tags(10),
        })); // 33
        expect(await codes(w, big)).toEqual(['TOO_MANY_ACTIONS@/actions']);
        await withEnv({ AUTOMATION_MAX_TOTAL_ACTIONS: '40' }, async () => {
          expect(await codes(w, big)).toEqual([]);
        });
      });
    });
  });

  // ------------------------------------------------------------------ FOR_EACH (step 5.12) ----
  describe('FOR_EACH (a loop inside a rule)', () => {
    const doneTrigger = {
      type: 'STATUS_CHANGED',
      to: [{ category: 'DONE' }],
    };
    const notSub = { all: [{ field: 'IS_SUBTASK', op: 'IS_FALSE' }] };
    const open = {
      all: [{ field: 'STATUS_CATEGORY', op: 'NOT_IN', value: ['DONE'] }],
    };
    /** a parent with n subtasks (created in order) */
    const family = async (w: W, n = 3) => {
      const parent = await mkTask(w, { title: 'Parent' });
      const subs = [];
      for (let i = 1; i <= n; i++)
        subs.push(await sub(w, parent.id, `Sub ${i}`));
      return { parent, subs };
    };
    const closeParentRule = (w: W, body: unknown[], extra: object = {}) =>
      mkRule(w, 'When the parent is done', {
        trigger: doneTrigger,
        conditions: notSub,
        actions: [
          {
            type: 'FOR_EACH',
            over: 'SUBTASKS',
            where: open,
            do: body,
            ...extra,
          },
        ],
      });
    const withEnv = async (
      vars: Record<string, string>,
      fn: () => Promise<void>,
    ) => {
      const before = Object.fromEntries(
        Object.keys(vars).map((k) => [k, process.env[k]]),
      );
      Object.assign(process.env, vars);
      try {
        await fn();
      } finally {
        for (const [k, v] of Object.entries(before))
          v === undefined ? delete process.env[k] : (process.env[k] = v);
      }
    };
    const commentsOn = async (taskId: string) =>
      (await prisma.comment.findMany({ where: { targetId: taskId } })).map(
        (c) => c.content,
      );

    it('SUBTASKS: acts on each open subtask and leaves the finished one alone; each run is one OK row', async () => {
      const w = await world();
      const { parent, subs } = await family(w);
      // tasks that must NOT be touched: an unrelated open task, and the subtask of another parent
      const stranger = await mkTask(w, { title: 'Stranger' });
      const otherParent = await mkTask(w, { title: 'Other parent' });
      const otherSub = await sub(w, otherParent.id, 'Other sub');
      await finish(w, subs[0].id);
      const r = await closeParentRule(w, [
        { type: 'ADD_TAG', tagId: w.tagA.id },
      ]);
      await finish(w, parent.id);
      for (const id of [stranger.id, otherParent.id, otherSub.id])
        expect(await tagIdsOf(id)).toEqual([]);
      expect(await tagIdsOf(subs[0].id)).toEqual([]);
      expect(await tagIdsOf(subs[1].id)).toEqual([w.tagA.id]);
      expect(await tagIdsOf(subs[2].id)).toEqual([w.tagA.id]);
      const runs = (await runsOf(r.id)).filter((x) => x.status === 'OK');
      expect(runs.map((x) => x.actionsRun)).toEqual([2]);
    });

    it('placeholders are those of EACH task, not of the task the rule fired on', async () => {
      const w = await world();
      const { parent, subs } = await family(w, 2);
      await closeParentRule(w, [
        { type: 'COMMENT', body: '{{task.title}} closed with its parent' },
      ]);
      await finish(w, parent.id);
      expect(await commentsOn(subs[0].id)).toEqual([
        'Sub 1 closed with its parent',
      ]);
      expect(await commentsOn(subs[1].id)).toEqual([
        'Sub 2 closed with its parent',
      ]);
      expect(await commentsOn(parent.id)).toEqual([]);
    });

    it('SIBLINGS: the other subtasks of the same parent, not the one that fired it', async () => {
      const w = await world();
      const { subs } = await family(w);
      await mkRule(w, 'Sibling nudge', {
        trigger: doneTrigger,
        conditions: { all: [{ field: 'IS_SUBTASK', op: 'IS_TRUE' }] },
        actions: [
          {
            type: 'FOR_EACH',
            over: 'SIBLINGS',
            do: [{ type: 'ADD_TAG', tagId: w.tagB.id }],
          },
        ],
      });
      await finish(w, subs[0].id);
      expect(await tagIdsOf(subs[0].id)).toEqual([]);
      expect(await tagIdsOf(subs[1].id)).toEqual([w.tagB.id]);
      expect(await tagIdsOf(subs[2].id)).toEqual([w.tagB.id]);
    });

    it('PARENT: acts on the parent (and does nothing, successfully, for a task that has none)', async () => {
      const w = await world();
      const { parent, subs } = await family(w, 1);
      const lone = await mkTask(w, { title: 'Lone' });
      const r = await mkRule(w, 'Tell the parent', {
        trigger: doneTrigger,
        actions: [
          {
            type: 'FOR_EACH',
            over: 'PARENT',
            do: [
              { type: 'COMMENT', body: '{{task.title}} has finished a part' },
            ],
          },
        ],
      });
      await finish(w, subs[0].id);
      expect(await commentsOn(parent.id)).toEqual([
        'Parent has finished a part',
      ]);
      await finish(w, lone.id);
      expect(await commentsOn(lone.id)).toEqual([]);
      expect((await runsOf(r.id)).every((x) => x.status === 'OK')).toBe(true);
    });

    it("QUERY in a SCHEDULE rule: a weekly sweep over the project's overdue tasks", async () => {
      const w = await world();
      const long = new Date('2020-01-01');
      const far = new Date('2099-01-01');
      const late = await mkTask(w, { title: 'Late', dueDate: long });
      const fine = await mkTask(w, { title: 'Fine', dueDate: far });
      const doneLate = await mkTask(w, { title: 'Done late', dueDate: long });
      await finish(w, doneLate.id);
      const elsewhere = await mkTask(w, {
        title: 'Other project',
        dueDate: long,
        projectId: w.p2.id,
      });
      const r = await mkRule(w, 'Overdue sweep', {
        projectId: w.p1.id,
        trigger: { type: 'SCHEDULE', frequency: 'DAILY', hour: 9 },
        actions: [
          {
            type: 'FOR_EACH',
            over: 'QUERY',
            where: { all: [{ field: 'DUE_DATE', op: 'IS_OVERDUE' }] },
            do: [
              { type: 'COMMENT', body: 'Overdue: {{task.key}} {{task.title}}' },
            ],
          },
        ],
      });
      await sweep.sweep(new Date('2026-10-19T09:05:00Z'));
      await idle();
      expect((await commentsOn(late.id))[0]).toMatch(/^Overdue: .+-\d+ Late$/);
      expect(await commentsOn(fine.id)).toEqual([]);
      expect(await commentsOn(doneLate.id)).toEqual([]);
      expect(await commentsOn(elsewhere.id)).toEqual([]); // another project
      expect((await runsOf(r.id)).map((x) => [x.status, x.actionsRun])).toEqual(
        [['OK', 1]],
      );
    });

    it('QUERY with scope WORKSPACE (a workspace-wide rule) reaches every project', async () => {
      const w = await world();
      const a = await mkTask(w, {
        title: 'A',
        dueDate: new Date('2020-01-01'),
      });
      const b = await mkTask(w, {
        title: 'B',
        dueDate: new Date('2020-01-01'),
        projectId: w.p2.id,
      });
      await mkRule(w, 'Workspace tag', {
        trigger: { type: 'COMMENT_ADDED', contains: 'sweep' },
        actions: [
          {
            type: 'FOR_EACH',
            over: 'QUERY',
            scope: 'WORKSPACE',
            where: { all: [{ field: 'DUE_DATE', op: 'IS_OVERDUE' }] },
            do: [{ type: 'ADD_TAG', tagId: w.tagB.id }],
          },
        ],
      });
      await person(w, 'please sweep', a.id);
      await idle();
      expect(await tagIdsOf(a.id)).toContain(w.tagB.id);
      expect(await tagIdsOf(b.id)).toEqual([w.tagB.id]);
    });

    it('a loop with more tasks than the configured limit does NOTHING and fails the run, saying why', async () => {
      const w = await world();
      const { parent, subs } = await family(w, 3);
      const r = await closeParentRule(w, [
        { type: 'ADD_TAG', tagId: w.tagA.id },
      ]);
      await withEnv({ AUTOMATION_MAX_FOR_EACH_ITEMS: '2' }, async () => {
        await finish(w, parent.id);
      });
      for (const s of subs) expect(await tagIdsOf(s.id)).toEqual([]);
      const [run] = (await runsOf(r.id)).filter((x) => x.status === 'FAILED');
      expect(run.error).toMatch(/more than 2 tasks/);
      expect(run.actionsRun).toBe(0);
      expect(run.details).toMatchObject({ failedPath: '/actions/0' });
    });

    it('STOP (default): the first failing task ends the loop; the run says which one and where', async () => {
      const w = await world();
      const { parent, subs } = await family(w, 3);
      // only the 2nd subtask has a due date; the action needs one, so tasks 1 and 3 fail
      await prisma.task.update({
        where: { id: subs[1].id },
        data: { dueDate: new Date('2030-01-01') },
      });
      const r = await closeParentRule(w, [
        { type: 'SET_DUE_DATE', inDays: 1, from: 'DUE_DATE' },
      ]);
      await finish(w, parent.id);
      const [run] = (await runsOf(r.id)).filter((x) => x.status === 'FAILED');
      expect(run.actionsRun).toBe(0); // the very first task failed
      expect(run.details).toMatchObject({
        failedPath: '/actions/0/do/0',
        failedItem: { index: 0, taskId: subs[0].id },
      });
      expect(run.error).toMatch(/no due date/i);
    });

    it('CONTINUE: every task is tried, the good ones are done, and the run fails once naming the count', async () => {
      const w = await world();
      const { parent, subs } = await family(w, 3);
      await prisma.task.update({
        where: { id: subs[1].id },
        data: { dueDate: new Date('2030-01-01') },
      });
      const r = await closeParentRule(
        w,
        [{ type: 'SET_DUE_DATE', inDays: 1, from: 'DUE_DATE' }],
        { onError: 'CONTINUE' },
      );
      await finish(w, parent.id);
      const after = async (id: string) =>
        (await prisma.task.findUniqueOrThrow({ where: { id } })).dueDate;
      expect((await after(subs[1].id))?.toISOString().slice(0, 10)).toBe(
        '2030-01-02',
      );
      const [run] = (await runsOf(r.id)).filter((x) => x.status === 'FAILED');
      expect(run.error).toMatch(/2 of 3 tasks failed/);
      expect(run.actionsRun).toBe(1);
      expect(run.details).toMatchObject({
        failedItem: { index: 0, taskId: subs[0].id },
      });
    });

    it('a run may execute only so many actions, however a loop multiplies them', async () => {
      const w = await world();
      const { parent, subs } = await family(w, 3);
      const r = await closeParentRule(w, [
        { type: 'ADD_TAG', tagId: w.tagA.id },
      ]);
      await withEnv({ AUTOMATION_MAX_ACTIONS_PER_RUN: '2' }, async () => {
        await finish(w, parent.id);
      });
      expect(await tagIdsOf(subs[0].id)).toEqual([w.tagA.id]);
      expect(await tagIdsOf(subs[1].id)).toEqual([w.tagA.id]);
      expect(await tagIdsOf(subs[2].id)).toEqual([]);
      const [run] = (await runsOf(r.id)).filter((x) => x.status === 'FAILED');
      expect(run.error).toMatch(/limit of 2 actions/);
      expect(run.actionsRun).toBe(2);
    });

    it("an IF inside the loop looks at each task's own state", async () => {
      const w = await world();
      const parent = await mkTask(w, { title: 'Parent' });
      const hot = await sub(w, parent.id, 'hot');
      const cold = await sub(w, parent.id, 'cold');
      await prisma.task.update({
        where: { id: hot.id },
        data: { priority: 'URGENT' },
      });
      await closeParentRule(w, [
        {
          type: 'IF',
          conditions: {
            all: [{ field: 'PRIORITY', op: 'IN', value: ['URGENT'] }],
          },
          then: [{ type: 'ADD_TAG', tagId: w.tagA.id }],
          else: [{ type: 'ADD_TAG', tagId: w.tagB.id }],
        },
      ]);
      await finish(w, parent.id);
      expect(await tagIdsOf(hot.id)).toEqual([w.tagA.id]);
      expect(await tagIdsOf(cold.id)).toEqual([w.tagB.id]);
    });

    it('what the loop writes is stamped like any rule write (the loop guards still see it)', async () => {
      const w = await world();
      const { parent, subs } = await family(w, 1);
      const r = await closeParentRule(w, [
        { type: 'ADD_TAG', tagId: w.tagA.id },
      ]);
      await finish(w, parent.id);
      const sys = await sysUser();
      const act = await prisma.activity.findMany({
        where: { targetId: subs[0].id, actorId: sys.id },
      });
      expect(act.length).toBeGreaterThan(0);
      for (const a of act)
        expect(a.metadata).toMatchObject({
          origin: CreationMode.AUTOMATION,
          automation: { id: r.id },
        });
    });

    it('a loop inside a loop: for each subtask of each subtask, each task its own', async () => {
      const w = await world();
      const parent = await mkTask(w, { title: 'Grandparent' });
      const child = await sub(w, parent.id, 'Child');
      const g1 = await sub(w, child.id, 'Grandchild 1');
      const g2 = await sub(w, child.id, 'Grandchild 2');
      const r = await mkRule(w, 'Two levels down', {
        trigger: doneTrigger,
        conditions: notSub,
        actions: [
          {
            type: 'FOR_EACH',
            over: 'SUBTASKS',
            do: [
              { type: 'ADD_TAG', tagId: w.tagA.id },
              {
                type: 'FOR_EACH',
                over: 'SUBTASKS',
                do: [
                  {
                    type: 'COMMENT',
                    body: '{{task.title}} is under a finished grandparent',
                  },
                ],
              },
            ],
          },
        ],
      });
      await finish(w, parent.id);
      expect(await tagIdsOf(child.id)).toEqual([w.tagA.id]);
      expect(await commentsOn(g1.id)).toEqual([
        'Grandchild 1 is under a finished grandparent',
      ]);
      expect(await commentsOn(g2.id)).toEqual([
        'Grandchild 2 is under a finished grandparent',
      ]);
      expect(
        (await runsOf(r.id))
          .filter((x) => x.status === 'OK')
          .map((x) => x.actionsRun),
      ).toEqual([3]);
    });

    it('a nested loop failure names both levels in the run details', async () => {
      const w = await world();
      const parent = await mkTask(w, { title: 'Grandparent' });
      const child = await sub(w, parent.id, 'Child');
      const g1 = await sub(w, child.id, 'G1'); // no due date: the action below fails for it
      const r = await mkRule(w, 'Fails deep', {
        trigger: doneTrigger,
        conditions: notSub,
        actions: [
          {
            type: 'FOR_EACH',
            over: 'SUBTASKS',
            do: [
              {
                type: 'FOR_EACH',
                over: 'SUBTASKS',
                do: [{ type: 'SET_DUE_DATE', inDays: 1, from: 'DUE_DATE' }],
              },
            ],
          },
        ],
      });
      await finish(w, parent.id);
      const [run] = (await runsOf(r.id)).filter((x) => x.status === 'FAILED');
      expect(run.details).toMatchObject({
        failedPath: '/actions/0/do/0/do/0',
        failedItem: { taskId: g1.id },
        failedItems: [
          { path: '/actions/0', taskId: child.id },
          { path: '/actions/0/do/0', taskId: g1.id },
        ],
      });
    });

    it('an else-if chain picks the first case that holds, per task', async () => {
      const w = await world();
      await mkRule(w, 'Priority triage', {
        trigger: { type: 'TASK_CREATED' },
        actions: [
          {
            type: 'IF',
            conditions: {
              all: [{ field: 'PRIORITY', op: 'IN', value: ['URGENT'] }],
            },
            then: [{ type: 'ADD_TAG', tagId: w.tagA.id }],
            elseIf: [
              {
                conditions: {
                  all: [{ field: 'PRIORITY', op: 'IN', value: ['HIGH'] }],
                },
                then: [{ type: 'ADD_TAG', tagId: w.tagB.id }],
              },
            ],
            else: [{ type: 'COMMENT', body: 'routine' }],
          },
        ],
      });
      const urgent = await mkTask(w, { title: 'u', priority: 'URGENT' });
      const high = await mkTask(w, { title: 'h', priority: 'HIGH' });
      const low = await mkTask(w, { title: 'l', priority: 'LOW' });
      expect(await tagIdsOf(urgent.id)).toEqual([w.tagA.id]);
      expect(await tagIdsOf(high.id)).toEqual([w.tagB.id]);
      expect(await tagIdsOf(low.id)).toEqual([]);
      expect(await commentsOn(low.id)).toEqual(['routine']);
    });

    describe('captured variables and WITH (step 5.13)', () => {
      it('creates a follow-up, tells the original about it with the new key and assignee, and works on it', async () => {
        const w = await world();
        const original = await mkTask(w, { title: 'Ship it' });
        const r = await mkRule(w, 'Follow-up on done', {
          trigger: doneTrigger,
          conditions: notSub,
          actions: [
            {
              type: 'CREATE_TASK',
              title: '{{task.title}} follow-up',
              assignees: ['TRIGGERER'],
              as: 'follow',
            },
            {
              type: 'COMMENT',
              body: 'Created {{follow.key}} ({{follow.title}}) for {{follow.assignees}}',
            },
            {
              type: 'WITH',
              task: 'follow',
              do: [
                { type: 'ADD_TAG', tagId: w.tagA.id },
                { type: 'CREATE_SUBTASK', title: 'Prep {{follow.key}}' },
              ],
            },
          ],
        });
        await finish(w, original.id);
        const follow = await prisma.task.findFirstOrThrow({
          where: { title: 'Ship it follow-up' },
          include: { workspace: true, assignees: true },
        });
        const key = `${follow.workspace.key}-${follow.number}`;
        expect(follow.assignees).toHaveLength(1);
        expect(await commentsOn(original.id)).toEqual([
          `Created ${key} (Ship it follow-up) for ${follow.assignees[0].name}`,
        ]);
        expect(await tagIdsOf(follow.id)).toEqual([w.tagA.id]); // WITH acted on the NEW task
        expect(await tagIdsOf(original.id)).toEqual([]);
        const prep = await prisma.task.findFirstOrThrow({
          where: { parentId: follow.id },
        });
        expect(prep.title).toBe(`Prep ${key}`);
        expect(
          (await runsOf(r.id))
            .filter((x) => x.status === 'OK')
            .map((x) => x.actionsRun),
        ).toEqual([4]); // create, comment, then the WITH body: tag, subtask
      });

      it('a scheduled rule creates a task and then acts on it (no task to start from)', async () => {
        const w = await world();
        const r = await mkRule(w, 'Weekly review', {
          projectId: w.p1.id,
          trigger: { type: 'SCHEDULE', frequency: 'DAILY', hour: 9 },
          actions: [
            {
              type: 'CREATE_TASK',
              title: 'Weekly review {{date}}',
              as: 'review',
            },
            {
              type: 'WITH',
              task: 'review',
              do: [
                { type: 'ADD_TAG', tagId: w.tagB.id },
                { type: 'CREATE_SUBTASK', title: 'Prep {{review.key}}' },
                { type: 'COMMENT', body: '{{review.title}} is ready' },
              ],
            },
          ],
        });
        await sweep.sweep(new Date('2026-10-19T09:05:00Z'));
        await idle();
        const review = await prisma.task.findFirstOrThrow({
          where: { title: 'Weekly review 2026-10-19' },
          include: { workspace: true },
        });
        expect(await tagIdsOf(review.id)).toEqual([w.tagB.id]);
        expect(await commentsOn(review.id)).toEqual([
          'Weekly review 2026-10-19 is ready',
        ]);
        const prep = await prisma.task.findFirstOrThrow({
          where: { parentId: review.id },
        });
        expect(prep.title).toBe(
          `Prep ${review.workspace.key}-${review.number}`,
        );
        expect(
          (await runsOf(r.id)).map((x) => [x.status, x.actionsRun]),
        ).toEqual([['OK', 4]]);
      });

      it('inside a loop every task gets its own capture', async () => {
        const w = await world();
        const { parent, subs } = await family(w, 2);
        await mkRule(w, 'Follow-up per subtask', {
          trigger: doneTrigger,
          conditions: notSub,
          actions: [
            {
              type: 'FOR_EACH',
              over: 'SUBTASKS',
              do: [
                {
                  type: 'CREATE_TASK',
                  title: 'Follow up: {{task.title}}',
                  as: 'f',
                },
                { type: 'COMMENT', body: 'See {{f.title}}' },
              ],
            },
          ],
        });
        await finish(w, parent.id);
        expect(await commentsOn(subs[0].id)).toEqual(['See Follow up: Sub 1']);
        expect(await commentsOn(subs[1].id)).toEqual(['See Follow up: Sub 2']);
        expect(
          await prisma.task.count({
            where: { title: { startsWith: 'Follow up: ' } },
          }),
        ).toBe(2);
      });

      it('is checked when the rule is saved: used before it exists, or outside where it was captured', async () => {
        const w = await world();
        const save = async (actions: unknown[]) => {
          try {
            await mkRule(w, `r${Math.random()}`, {
              trigger: doneTrigger,
              actions,
            });
            return [];
          } catch (e: any) {
            return (e.getResponse?.().issues ?? []).map(
              (i: any) => `${i.code}@${i.path}`,
            );
          }
        };
        const create = { type: 'CREATE_TASK', title: 'x', as: 'f' };
        const say = (body: string) => ({ type: 'COMMENT', body });
        expect(await save([say('{{f.title}}'), create])).toEqual([
          'UNKNOWN_VARIABLE@/actions/0/body',
        ]);
        expect(await save([create, say('{{f.nope}}')])).toEqual([
          'UNKNOWN_VARIABLE@/actions/1/body',
        ]);
        expect(await save([create, { ...create }])).toEqual([
          'VARIABLE_EXISTS@/actions/1/as',
        ]);
        expect(
          await save([{ type: 'WITH', task: 'f', do: [say('x')] }]),
        ).toEqual(['UNKNOWN_VARIABLE@/actions/0/task']);
        const cond = {
          all: [{ field: 'PRIORITY', op: 'IN', value: ['HIGH'] }],
        };
        expect(
          await save([
            { type: 'IF', conditions: cond, then: [create] },
            say('{{f.title}}'),
          ]),
        ).toEqual(['UNKNOWN_VARIABLE@/actions/1/body']);
        expect(await save([create, say('{{f.key}} {{f.assignees}}')])).toEqual(
          [],
        );
      });
    });

    describe('saving', () => {
      const codes = async (
        w: W,
        rule: Record<string, unknown>,
        extra: Record<string, unknown> = {},
      ) => {
        try {
          await mkRule(
            w,
            `r${Math.random()}`,
            { trigger: { type: 'STATUS_CHANGED' }, ...rule },
            extra,
          );
          return [];
        } catch (e: any) {
          return (e.getResponse?.().issues ?? []).map(
            (i: any) => `${i.code}@${i.path}`,
          );
        }
      };
      const each = (over: string, body: unknown[], extra: object = {}) => ({
        type: 'FOR_EACH',
        over,
        do: body,
        ...extra,
      });

      it('checks the ids in `where` and in the body against the workspace', async () => {
        const w = await world();
        expect(
          await codes(w, {
            actions: [
              each('SUBTASKS', [{ type: 'ADD_TAG', tagId: 'nope' }], {
                where: {
                  all: [{ field: 'TAGS', op: 'HAS_ANY', value: ['nope2'] }],
                },
              }),
            ],
          }),
        ).toEqual([
          'UNKNOWN_TAG@/actions/0/where/all/0/value/0',
          'UNKNOWN_TAG@/actions/0/do/0/tagId',
        ]);
      });

      it('allows a loop inside a loop, but only within the shared depth', async () => {
        const w = await world();
        const deep = (n: number): unknown =>
          n === 0 ? { type: 'ARCHIVE_TASK' } : each('SUBTASKS', [deep(n - 1)]);
        expect(await codes(w, { actions: [deep(3)] })).toEqual([]);
        expect(await codes(w, { actions: [deep(4)] })).toEqual([
          'IF_TOO_DEEP@/actions/0/do/0/do/0/do/0',
        ]);
      });

      it('refuses a relative selector in a SCHEDULE rule but not a QUERY', async () => {
        const w = await world();
        const schedule = { type: 'SCHEDULE', frequency: 'DAILY', hour: 9 };
        expect(
          await codes(w, {
            trigger: schedule,
            projectId: w.p1.id,
            actions: [each('SUBTASKS', [{ type: 'ARCHIVE_TASK' }])],
          }),
        ).toEqual(['ACTION_NEEDS_TASK@/actions/0/type']);
        expect(
          await codes(w, {
            trigger: schedule,
            projectId: w.p1.id,
            actions: [
              each('QUERY', [{ type: 'ARCHIVE_TASK' }], { where: open }),
            ],
          }),
        ).toEqual([]);
      });

      it('keeps a project rule in its project', async () => {
        const w = await world();
        const wide = each('QUERY', [{ type: 'ARCHIVE_TASK' }], {
          scope: 'WORKSPACE',
        });
        expect(await codes(w, { projectId: w.p1.id, actions: [wide] })).toEqual(
          ['SCOPE_NEEDS_WORKSPACE_RULE@/actions/0/scope'],
        );
        expect(await codes(w, { actions: [wide] })).toEqual([]);
      });

      it('shares the nesting depth with IF', async () => {
        const w = await world();
        const cond = {
          all: [{ field: 'PRIORITY', op: 'IN', value: ['HIGH'] }],
        };
        const IF = (then: unknown[]) => ({
          type: 'IF',
          conditions: cond,
          then,
        });
        expect(
          await codes(w, {
            actions: [IF([IF([each('SUBTASKS', [{ type: 'ARCHIVE_TASK' }])])])],
          }),
        ).toEqual([]);
        expect(
          await codes(w, {
            actions: [
              IF([IF([IF([each('SUBTASKS', [{ type: 'ARCHIVE_TASK' }])])])]),
            ],
          }),
        ).toEqual(['IF_TOO_DEEP@/actions/0/then/0/then/0/then/0']);
      });
    });
  });

  // ------------------------------------------------------------------ RUN_RULE (step 5.14) ----
  describe('RUN_RULE (a rule calling another rule)', () => {
    const done = { type: 'STATUS_CHANGED', to: [{ category: 'DONE' }] };
    const notSub = { all: [{ field: 'IS_SUBTASK', op: 'IS_FALSE' }] };
    const high = { all: [{ field: 'PRIORITY', op: 'IN', value: ['HIGH'] }] };
    const issuesOf = async (p: Promise<unknown>) => {
      try {
        await p;
        return [];
      } catch (e: any) {
        return (e.getResponse?.().issues ?? []).map(
          (i: any) => `${i.code}@${i.path}`,
        );
      }
    };
    const commentsOn = async (taskId: string) =>
      (await prisma.comment.findMany({ where: { targetId: taskId } })).map(
        (c) => c.content,
      );
    /** B: a rule that only exists to be called */
    const escalate = (w: W, extra: Record<string, unknown> = {}) =>
      mkRule(w, 'Escalate', {
        trigger: { type: 'CALLED' },
        conditions: high,
        actions: [
          { type: 'ADD_TAG', tagId: w.tagA.id },
          { type: 'COMMENT', body: 'Escalated: {{task.title}}' },
        ],
        ...extra,
      });
    const caller = (w: W, target: string, name = 'When done, escalate') =>
      mkRule(w, name, {
        trigger: done,
        conditions: notSub,
        actions: [{ type: 'RUN_RULE', rule: target }],
      });

    it('runs the called rule on the task, but only when ITS conditions hold; the CALLED rule never fires on its own', async () => {
      const w = await world();
      const b = await escalate(w);
      const a = await caller(w, b.id);
      const hi = await mkTask(w, { title: 'hi', priority: 'HIGH' });
      const lo = await mkTask(w, { title: 'lo', priority: 'LOW' });
      expect(await tagIdsOf(hi.id)).toEqual([]); // creating a task did not fire the CALLED rule
      await finish(w, hi.id);
      await finish(w, lo.id);
      expect(await tagIdsOf(hi.id)).toEqual([w.tagA.id]);
      expect(await commentsOn(hi.id)).toEqual(['Escalated: hi']);
      expect(await tagIdsOf(lo.id)).toEqual([]);
      expect(await commentsOn(lo.id)).toEqual([]);
      const runs = (await runsOf(a.id)).filter((x) => x.status === 'OK');
      expect(runs.map((x) => x.actionsRun).sort()).toEqual([0, 2]);
      expect(await runsOf(b.id)).toEqual([]); // the called rule has no runs of its own
    });

    it('a called rule can be switched off (that is about events) and still be called', async () => {
      const w = await world();
      const b = await escalate(w);
      await caller(w, b.id);
      await rules.update(w.ws.id, b.id, w.owner.id, { enabled: false });
      const t = await mkTask(w, { priority: 'HIGH' });
      await finish(w, t.id);
      expect(await tagIdsOf(t.id)).toEqual([w.tagA.id]);
    });

    it('uses the called rule as it is NOW: editing it changes what its callers do', async () => {
      const w = await world();
      const b = await escalate(w);
      await caller(w, b.id);
      await rules.update(w.ws.id, b.id, w.owner.id, {
        actions: [{ type: 'ADD_TAG', tagId: w.tagB.id }],
      });
      const t = await mkTask(w, { priority: 'HIGH' });
      await finish(w, t.id);
      expect(await tagIdsOf(t.id)).toEqual([w.tagB.id]);
    });

    it('a failure inside the called rule fails the run and names that rule', async () => {
      const w = await world();
      const b = await escalate(w, {
        conditions: {},
        actions: [
          { type: 'ADD_TAG', tagId: w.tagA.id },
          { type: 'SET_DUE_DATE', inDays: 1, from: 'DUE_DATE' },
        ],
      });
      const a = await caller(w, b.id);
      const t = await mkTask(w, { priority: 'HIGH' });
      await finish(w, t.id);
      const [run] = (await runsOf(a.id)).filter((x) => x.status === 'FAILED');
      expect(run.actionsRun).toBe(1);
      expect(run.error).toMatch(/no due date/i);
      expect(run.details).toMatchObject({
        failedPath: '/actions/0/call/1',
        failedRule: { id: b.id, name: 'Escalate' },
      });
    });

    describe('saving', () => {
      it('refuses a rule that does not exist', async () => {
        const w = await world();
        expect(await issuesOf(caller(w, 'nope'))).toEqual([
          'UNKNOWN_RULE@/actions/0/rule',
        ]);
      });

      it('refuses a call that comes back: a calls b, then b is changed to call a', async () => {
        const w = await world();
        const b = await escalate(w);
        const a = await caller(w, b.id);
        expect(
          await issuesOf(
            rules.update(w.ws.id, b.id, w.owner.id, {
              actions: [{ type: 'RUN_RULE', rule: a.id }],
            }),
          ),
        ).toEqual(['RUN_RULE_CYCLE@/actions/0/rule']);
        expect(
          await issuesOf(
            rules.update(w.ws.id, a.id, w.owner.id, {
              actions: [{ type: 'RUN_RULE', rule: a.id }],
            }),
          ),
        ).toEqual(['RUN_RULE_CYCLE@/actions/0/rule']);
      });

      it('refuses chains deeper than the call depth, and follows the configuration', async () => {
        const w = await world();
        const mk = (name: string, calls?: string) =>
          mkRule(w, name, {
            trigger: { type: 'CALLED' },
            actions: calls
              ? [{ type: 'RUN_RULE', rule: calls }]
              : [{ type: 'ADD_TAG', tagId: w.tagA.id }],
          });
        const d = await mk('d');
        const c = await mk('c', d.id);
        const b = await mk('b', c.id);
        expect(await issuesOf(caller(w, b.id, 'ok: depth 3'))).toEqual([]);
        const e = await mk('e', b.id);
        expect(await issuesOf(caller(w, e.id, 'too deep'))).toEqual([
          'RUN_RULE_TOO_DEEP@/actions/0/rule',
        ]);
        process.env.AUTOMATION_MAX_CALL_DEPTH = '5';
        try {
          expect(await issuesOf(caller(w, e.id, 'now allowed'))).toEqual([]);
        } finally {
          delete process.env.AUTOMATION_MAX_CALL_DEPTH;
        }
      });

      it('keeps rules of different projects apart', async () => {
        const w = await world();
        const inP2 = await escalate(w, { projectId: w.p2.id });
        expect(
          await issuesOf(
            mkRule(
              w,
              'p1 calls p2',
              {
                trigger: done,
                actions: [{ type: 'RUN_RULE', rule: inP2.id }],
              },
              { projectId: w.p1.id },
            ),
          ),
        ).toEqual(['RUN_RULE_SCOPE@/actions/0/rule']);
        expect(
          await issuesOf(
            mkRule(w, 'workspace calls p2', {
              trigger: done,
              actions: [{ type: 'RUN_RULE', rule: inP2.id }],
            }),
          ),
        ).toEqual(['RUN_RULE_SCOPE@/actions/0/rule']);
      });

      it('a project rule can call a workspace-wide rule', async () => {
        const w = await world();
        const shared = await escalate(w);
        expect(
          await issuesOf(
            mkRule(
              w,
              'p1 uses the shared one',
              {
                trigger: done,
                actions: [{ type: 'RUN_RULE', rule: shared.id }],
              },
              { projectId: w.p1.id },
            ),
          ),
        ).toEqual([]);
      });
    });
  });

  // ------------------------------------------------------------------ NOTIFY (step 5.14) ------
  describe('NOTIFY (a rule telling people)', () => {
    const done = { type: 'STATUS_CHANGED', to: [{ category: 'DONE' }] };
    const notSub = { all: [{ field: 'IS_SUBTASK', op: 'IS_FALSE' }] };
    const watch = (w: W, taskId: string, userId: string) =>
      prisma.watch.create({
        data: { targetType: 'TASK', targetId: taskId, userId },
      });
    const assign = (taskId: string, userId: string) =>
      prisma.task.update({
        where: { id: taskId },
        data: { assignees: { connect: { id: userId } } },
      });
    const received = (userId: string) =>
      prisma.notification.findMany({
        where: { userId, type: 'AUTOMATION_MESSAGE' },
      });
    const tellRule = (
      w: W,
      users: string[],
      message = '{{task.title}} is done',
    ) =>
      mkRule(w, 'Tell people', {
        trigger: done,
        conditions: notSub,
        actions: [{ type: 'NOTIFY', users, message }],
      });

    it("notifies the assignees and watchers of the task with the rule's own text, once each", async () => {
      const w = await world();
      const t = await mkTask(w, { title: 'Ship it' });
      await assign(t.id, w.member.id);
      await assign(t.id, w.member2.id);
      await watch(w, t.id, w.member2.id); // in BOTH groups
      await watch(w, t.id, w.owner.id);
      const r = await tellRule(
        w,
        ['ASSIGNEES', 'WATCHERS'],
        '{{task.key}}: {{task.title}} is {{task.status}}',
      );
      await finish(w, t.id);
      const [m] = await prisma.automationMessage.findMany({
        where: { workspaceId: w.ws.id },
      });
      expect(m).toMatchObject({ automationId: r.id, taskId: t.id });
      expect(m.message).toMatch(/^.+-\d+: Ship it is .+$/);
      for (const u of [w.member, w.member2, w.owner]) {
        const n = await received(u.id);
        expect(n).toHaveLength(1);
        expect(n[0]).toMatchObject({
          sourceType: 'AUTOMATION_MESSAGE',
          sourceId: m.id,
          readAt: null,
        });
      }
      const run = (await runsOf(r.id)).find((x) => x.status === 'OK')!;
      expect(run.actionsRun).toBe(1);
    });

    it('the notification list carries the text and the task, so the client needs no second request', async () => {
      const w = await world();
      const t = await mkTask(w, { title: 'Ship it' });
      await assign(t.id, w.member.id);
      await tellRule(w, ['ASSIGNEES'], 'Please review {{task.title}}');
      await finish(w, t.id);
      const page = await notifs.list(w.member.id, false, {
        take: 20,
        skip: 0,
      } as any);
      expect(page.data).toHaveLength(1);
      expect(page.data[0]).toMatchObject({
        type: 'AUTOMATION_MESSAGE',
        message: 'Please review Ship it',
        taskId: t.id,
      });
    });

    it('does not tell anyone who cannot see the task (a watcher with no access, an id that lost it since the rule was saved)', async () => {
      const w = await world();
      const t = await mkTask(w, { title: 'Private' });
      const outsider = await createUser(prisma);
      await watch(w, t.id, outsider.id);
      await watch(w, t.id, w.member.id);
      // saved while member2 still had access (a rule cannot name someone who has none) ...
      const r = await tellRule(w, ['WATCHERS', w.member2.id]);
      // ... then they lose it
      await prisma.accountMember.deleteMany({
        where: { userId: w.member2.id },
      });
      await finish(w, t.id);
      expect(await received(outsider.id)).toHaveLength(0);
      expect(await received(w.member2.id)).toHaveLength(0);
      expect(await received(w.member.id)).toHaveLength(1);
      expect((await runsOf(r.id)).some((x) => x.status === 'OK')).toBe(true);
    });

    it('sends nothing, and stores nothing, when nobody can see it', async () => {
      const w = await world();
      const t = await mkTask(w, { title: 'Nobody' });
      const outsider = await createUser(prisma);
      await watch(w, t.id, outsider.id);
      await tellRule(w, ['WATCHERS']);
      await finish(w, t.id);
      expect(await prisma.automationMessage.count()).toBe(0);
      expect(
        await prisma.notification.count({
          where: { type: 'AUTOMATION_MESSAGE' },
        }),
      ).toBe(0);
    });

    it('a group bigger than the limit fails the run and tells no one', async () => {
      const w = await world();
      const t = await mkTask(w, { title: 'Popular' });
      await watch(w, t.id, w.member.id);
      await watch(w, t.id, w.member2.id);
      const r = await tellRule(w, ['WATCHERS']);
      process.env.AUTOMATION_MAX_NOTIFY_RECIPIENTS = '1';
      try {
        await finish(w, t.id);
      } finally {
        delete process.env.AUTOMATION_MAX_NOTIFY_RECIPIENTS;
      }
      const [run] = (await runsOf(r.id)).filter((x) => x.status === 'FAILED');
      expect(run.error).toMatch(/notify 2 people; the limit is 1/);
      expect(
        await prisma.notification.count({
          where: { type: 'AUTOMATION_MESSAGE' },
        }),
      ).toBe(0);
    });

    it('the text outlives the rule and the task (they only lose the link)', async () => {
      const w = await world();
      const t = await mkTask(w, { title: 'Gone soon' });
      await assign(t.id, w.member.id);
      const r = await tellRule(w, ['ASSIGNEES'], 'Remember {{task.title}}');
      await finish(w, t.id);
      await rules.remove(w.ws.id, r.id);
      await prisma.task.delete({ where: { id: t.id } });
      const [m] = await prisma.automationMessage.findMany({});
      expect(m).toMatchObject({
        automationId: null,
        taskId: null,
        message: 'Remember Gone soon',
      });
      const page = await notifs.list(w.member.id, false, {
        take: 20,
        skip: 0,
      } as any);
      expect(page.data[0]).toMatchObject({
        message: 'Remember Gone soon',
        taskId: null,
      });
    });

    it('ASSIGNEES copies the assignees onto a new task; WATCHERS can be assigned', async () => {
      const w = await world();
      const t = await mkTask(w, { title: 'Original' });
      await assign(t.id, w.member.id);
      await watch(w, t.id, w.member2.id);
      await mkRule(w, 'Hand over', {
        trigger: done,
        conditions: notSub,
        actions: [
          { type: 'CREATE_TASK', title: 'Follow-up', assignees: ['ASSIGNEES'] },
          { type: 'ASSIGN', mode: 'ADD', users: ['WATCHERS'] },
        ],
      });
      await finish(w, t.id);
      const follow = await prisma.task.findFirstOrThrow({
        where: { title: 'Follow-up' },
        include: { assignees: true },
      });
      expect(follow.assignees.map((u) => u.id)).toEqual([w.member.id]);
      const orig = await prisma.task.findUniqueOrThrow({
        where: { id: t.id },
        include: { assignees: true },
      });
      expect(orig.assignees.map((u) => u.id).sort()).toEqual(
        [w.member.id, w.member2.id].sort(),
      );
    });

    it('is checked when saved: a user that is not in the workspace is refused, the groups are not', async () => {
      const w = await world();
      const save = async (users: string[]) => {
        try {
          await tellRule(w, users);
          return [];
        } catch (e: any) {
          return (e.getResponse?.().issues ?? []).map(
            (i: any) => `${i.code}@${i.path}`,
          );
        }
      };
      const outsider = await createUser(prisma);
      expect(await save([w.member.id, outsider.id])).toEqual([
        'UNKNOWN_USER@/actions/0/users/1',
      ]);
      expect(
        await save([
          'ASSIGNEES',
          'WATCHERS',
          'TRIGGERER',
          'CREATOR',
          w.member.id,
        ]),
      ).toEqual([]);
    });
  });

  // ------------------------------------------------------------------ WAIT (step 5.15) --------
  describe('WAIT (a durable delay)', () => {
    const DAY = 86_400_000;
    const done = { type: 'STATUS_CHANGED', to: [{ category: 'DONE' }] };
    const notSub = { all: [{ field: 'IS_SUBTASK', op: 'IS_FALSE' }] };
    const wait = (amount: number, unit = 'DAYS') => ({
      type: 'WAIT',
      for: { amount, unit },
    });
    const tagAct = (id: string) => ({ type: 'ADD_TAG', tagId: id });
    const sayAct = (body: string) => ({ type: 'COMMENT', body });
    const later = (days: number) => new Date(Date.now() + days * DAY);
    const commentsOn = async (taskId: string) =>
      (await prisma.comment.findMany({ where: { targetId: taskId } })).map(
        (c) => c.content,
      );
    const waitsOf = (automationId: string) =>
      prisma.automationWait.findMany({
        where: { automationId },
        orderBy: { createdAt: 'asc' },
      });
    const rule = (
      w: W,
      actions: unknown[],
      extra: Record<string, unknown> = {},
    ) =>
      mkRule(w, `wait ${Math.random()}`, {
        trigger: done,
        conditions: notSub,
        actions,
        ...extra,
      });

    it('stops at the wait, carries on when the time is up, and the history shows both halves', async () => {
      const w = await world();
      const r = await rule(w, [
        tagAct(w.tagA.id),
        wait(2),
        tagAct(w.tagB.id),
        sayAct('two days later'),
      ]);
      const t = await mkTask(w, { title: 'Ship it' });
      await finish(w, t.id);
      expect(await tagIdsOf(t.id)).toEqual([w.tagA.id]);
      const [first] = await runsOf(r.id);
      expect(first).toMatchObject({ status: 'OK', actionsRun: 1 });
      const [pending] = await waitsOf(r.id);
      expect(pending).toMatchObject({
        status: 'PENDING',
        taskId: t.id,
        runId: first.id,
      });
      expect(pending.resumeAt.getTime()).toBeGreaterThan(
        Date.now() + 2 * DAY - 60_000,
      );
      expect(first.details).toMatchObject({
        waiting: { pointer: '/actions/1' },
      });

      expect(await waitSvc.resumeDue(later(1))).toEqual({
        resumed: 0,
        cancelled: 0,
        failed: 0,
      }); // too early
      expect(await tagIdsOf(t.id)).toEqual([w.tagA.id]);

      expect(await waitSvc.resumeDue(later(3))).toEqual({
        resumed: 1,
        cancelled: 0,
        failed: 0,
      });
      expect((await tagIdsOf(t.id)).sort()).toEqual(
        [w.tagA.id, w.tagB.id].sort(),
      );
      expect(await commentsOn(t.id)).toEqual(['two days later']);
      const runs = await prisma.automationRun.findMany({
        where: { automationId: r.id },
        orderBy: { ranAt: 'asc' },
      });
      expect(runs.map((x) => [x.status, x.actionsRun])).toEqual([
        ['OK', 1],
        ['OK', 2],
      ]);
      expect(runs[1].eventId).toBe(`wait:${pending.id}`);
      expect(runs[1].details).toMatchObject({ resumedFromWait: pending.id });
      expect((await waitsOf(r.id))[0].status).toBe('DONE');
      // nothing left to do
      expect(await waitSvc.resumeDue(later(9))).toEqual({
        resumed: 0,
        cancelled: 0,
        failed: 0,
      });
    });

    it('inside an IF branch it carries on the branch, then what comes after the IF', async () => {
      const w = await world();
      const high = { all: [{ field: 'PRIORITY', op: 'IN', value: ['HIGH'] }] };
      await rule(w, [
        {
          type: 'IF',
          conditions: high,
          then: [sayAct('1'), wait(1), sayAct('2')],
        },
        sayAct('after the IF'),
      ]);
      const t = await mkTask(w, { priority: 'HIGH' });
      await finish(w, t.id);
      expect(await commentsOn(t.id)).toEqual(['1']);
      await waitSvc.resumeDue(later(2));
      expect(await commentsOn(t.id)).toEqual(['1', '2', 'after the IF']);
    });

    it('a captured task survives the wait, and WITH can still act on it', async () => {
      const w = await world();
      await rule(w, [
        { type: 'CREATE_TASK', title: 'Follow-up for {{task.title}}', as: 'f' },
        wait(1),
        sayAct('Reminder: {{f.key}} {{f.title}}'),
        { type: 'WITH', task: 'f', do: [tagAct(w.tagA.id)] },
      ]);
      const t = await mkTask(w, { title: 'Original' });
      await finish(w, t.id);
      await waitSvc.resumeDue(later(2));
      const f = await prisma.task.findFirstOrThrow({
        where: { title: 'Follow-up for Original' },
        include: { workspace: true },
      });
      expect(await commentsOn(t.id)).toEqual([
        `Reminder: ${f.workspace.key}-${f.number} Follow-up for Original`,
      ]);
      expect(await tagIdsOf(f.id)).toEqual([w.tagA.id]);
    });

    it('carries on with the rule AS IT WAS when the wait started, not as edited since', async () => {
      const w = await world();
      const r = await rule(w, [wait(1), tagAct(w.tagA.id)]);
      const t = await mkTask(w);
      await finish(w, t.id);
      await rules.update(w.ws.id, r.id, w.owner.id, {
        actions: [wait(1), tagAct(w.tagB.id)],
      });
      await waitSvc.resumeDue(later(2));
      expect(await tagIdsOf(t.id)).toEqual([w.tagA.id]);
    });

    it('is cancelled, with the reason, when the rule has been switched off', async () => {
      const w = await world();
      const r = await rule(w, [wait(1), tagAct(w.tagA.id)]);
      const t = await mkTask(w);
      await finish(w, t.id);
      await rules.update(w.ws.id, r.id, w.owner.id, { enabled: false });
      expect(await waitSvc.resumeDue(later(2))).toEqual({
        resumed: 0,
        cancelled: 1,
        failed: 0,
      });
      expect(await tagIdsOf(t.id)).toEqual([]);
      expect(await waitsOf(r.id)).toMatchObject([
        { status: 'CANCELLED', error: 'The rule is switched off' },
      ]);
      // switching it back on does not bring the old wait back
      await rules.update(w.ws.id, r.id, w.owner.id, { enabled: true });
      await waitSvc.resumeDue(later(3));
      expect(await tagIdsOf(t.id)).toEqual([]);
    });

    it('is cancelled when the task is gone', async () => {
      const w = await world();
      const r = await rule(w, [wait(1), tagAct(w.tagA.id)]);
      const t = await mkTask(w);
      await finish(w, t.id);
      await prisma.task.delete({ where: { id: t.id } });
      expect(await waitSvc.resumeDue(later(2))).toEqual({
        resumed: 0,
        cancelled: 1,
        failed: 0,
      });
      expect(await waitsOf(r.id)).toMatchObject([
        {
          status: 'CANCELLED',
          error: 'The task no longer exists',
          taskId: null,
        },
      ]);
    });

    it('is deleted with its rule', async () => {
      const w = await world();
      const r = await rule(w, [wait(1), tagAct(w.tagA.id)]);
      const t = await mkTask(w);
      await finish(w, t.id);
      await rules.remove(w.ws.id, r.id);
      expect(
        await prisma.automationWait.count({ where: { automationId: r.id } }),
      ).toBe(0);
    });

    it('two workers at once carry it on only ONCE', async () => {
      const w = await world();
      await rule(w, [wait(1), sayAct('once')]);
      const t = await mkTask(w);
      await finish(w, t.id);
      const results = await Promise.all([
        waitSvc.resumeDue(later(2)),
        waitSvc.resumeDue(later(2)),
        waitSvc.resumeDue(later(2)),
      ]);
      expect(results.reduce((n, x) => n + x.resumed, 0)).toBe(1);
      expect(await commentsOn(t.id)).toEqual(['once']);
    });

    it('a failure after the wait fails the SECOND run, names where, and marks the wait failed', async () => {
      const w = await world();
      const r = await rule(w, [
        wait(1),
        tagAct(w.tagA.id),
        { type: 'SET_DUE_DATE', inDays: 1, from: 'DUE_DATE' },
      ]);
      const t = await mkTask(w);
      await finish(w, t.id);
      expect(await waitSvc.resumeDue(later(2))).toEqual({
        resumed: 0,
        cancelled: 0,
        failed: 1,
      });
      const second = (
        await prisma.automationRun.findMany({
          where: { automationId: r.id, eventId: { startsWith: 'wait:' } },
        })
      )[0];
      expect(second).toMatchObject({ status: 'FAILED', actionsRun: 1 });
      expect(second.error).toMatch(/no due date/i);
      expect(second.details).toMatchObject({
        failedPath: '/actions/2',
        resumedFromWait: expect.any(String),
      });
      expect((await waitsOf(r.id))[0]).toMatchObject({ status: 'FAILED' });
    });

    it('can wait again, and each wait is its own row', async () => {
      const w = await world();
      const r = await rule(w, [wait(1), sayAct('a'), wait(1), sayAct('b')]);
      const t = await mkTask(w);
      await finish(w, t.id);
      await waitSvc.resumeDue(later(2));
      expect(await commentsOn(t.id)).toEqual(['a']);
      expect((await waitsOf(r.id)).map((x) => x.status)).toEqual([
        'DONE',
        'PENDING',
      ]);
      await waitSvc.resumeDue(later(4));
      expect(await commentsOn(t.id)).toEqual(['a', 'b']);
      expect((await waitsOf(r.id)).map((x) => x.status)).toEqual([
        'DONE',
        'DONE',
      ]);
    });

    it('works in a scheduled rule: create a task, wait, then act on it', async () => {
      const w = await world();
      const r = await mkRule(w, 'Weekly', {
        projectId: w.p1.id,
        trigger: { type: 'SCHEDULE', frequency: 'DAILY', hour: 9 },
        actions: [
          { type: 'CREATE_TASK', title: 'Review {{date}}', as: 'rev' },
          wait(1, 'HOURS'),
          {
            type: 'WITH',
            task: 'rev',
            do: [tagAct(w.tagB.id), sayAct('{{rev.title}} is ready')],
          },
        ],
      });
      await sweep.sweep(new Date('2026-10-19T09:05:00Z'));
      await idle();
      const rev = await prisma.task.findFirstOrThrow({
        where: { title: 'Review 2026-10-19' },
      });
      expect(await tagIdsOf(rev.id)).toEqual([]);
      expect(
        await waitSvc.resumeDue(new Date(Date.now() + 2 * 3_600_000)),
      ).toMatchObject({ resumed: 1 });
      expect(await tagIdsOf(rev.id)).toEqual([w.tagB.id]);
      expect(await commentsOn(rev.id)).toEqual(['Review 2026-10-19 is ready']);
      expect((await waitsOf(r.id))[0].status).toBe('DONE');
    });

    it('a workspace can only have so many waits pending; the run that hits the limit fails AT the wait', async () => {
      const w = await world();
      const r = await rule(w, [wait(1), tagAct(w.tagA.id)]);
      const a = await mkTask(w, { title: 'a' });
      const b = await mkTask(w, { title: 'b' });
      process.env.AUTOMATION_MAX_PENDING_WAITS = '1';
      try {
        await finish(w, a.id);
        await finish(w, b.id);
      } finally {
        delete process.env.AUTOMATION_MAX_PENDING_WAITS;
      }
      expect(await waitsOf(r.id)).toHaveLength(1);
      const failed = (await runsOf(r.id)).filter((x) => x.status === 'FAILED');
      expect(failed).toHaveLength(1);
      expect(failed[0].error).toMatch(
        /already has 1 waits pending; the limit is 1/,
      );
      expect(failed[0].details).toMatchObject({ failedPath: '/actions/0' });
    });

    it("a burst of waits coming due does not use up the rule's per-minute allowance for NEW events", async () => {
      const w = await world();
      const r = await rule(w, [wait(1), tagAct(w.tagA.id)]);
      const limits = AUTOMATION_LIMITS as { maxRunsPerRulePerMinute: number };
      const before = limits.maxRunsPerRulePerMinute;
      limits.maxRunsPerRulePerMinute = 6;
      try {
        for (let i = 0; i < 4; i++) {
          const t = await mkTask(w, { title: `t${i}` });
          await finish(w, t.id); // 4 runs in this minute
        }
        await waitSvc.resumeDue(later(2)); // 4 more runs, carrying them on
        // a fifth NEW event: 4 reactions to events so far (limit 6), so it must run; counting the
        // carried-on halves too it would be 8 and the rule would be stopped
        const last = await mkTask(w, { title: 'last' });
        await finish(w, last.id);
      } finally {
        limits.maxRunsPerRulePerMinute = before;
      }
      const row = await prisma.automation.findUniqueOrThrow({
        where: { id: r.id },
      });
      expect(row.enabled).toBe(true);
      const fresh = (await runsOf(r.id)).filter(
        (x) => !x.eventId.startsWith('wait:'),
      );
      expect(fresh.map((x) => x.status)).toEqual([
        'OK',
        'OK',
        'OK',
        'OK',
        'OK',
      ]);
    });

    it('a wait that was being carried on when its worker died is marked failed, not run again', async () => {
      const w = await world();
      const r = await rule(w, [wait(1), tagAct(w.tagA.id)]);
      const t = await mkTask(w);
      await finish(w, t.id);
      const [row] = await waitsOf(r.id);
      await prisma.automationWait.update({
        where: { id: row.id },
        data: {
          status: 'RESUMING',
          resumedAt: new Date(Date.now() - 2 * 3_600_000),
        },
      });
      await waitSvc.resumeDue(later(2));
      expect((await waitsOf(r.id))[0]).toMatchObject({ status: 'FAILED' });
      expect((await waitsOf(r.id))[0].error).toMatch(/INTERRUPTED/);
      expect(await tagIdsOf(t.id)).toEqual([]);
    });

    describe('seeing and cancelling waits', () => {
      it('lists what a rule has in flight, and cancels one: the rest of that run never happens', async () => {
        const w = await world();
        const r = await rule(w, [wait(1), tagAct(w.tagA.id)]);
        const a = await mkTask(w, { title: 'a' });
        const b = await mkTask(w, { title: 'b' });
        await finish(w, a.id);
        await finish(w, b.id);
        const listed = await rules.listWaits(w.ws.id, r.id);
        expect(listed.total).toBe(2);
        expect(listed.data.map((x) => x.taskId).sort()).toEqual(
          [a.id, b.id].sort(),
        );
        await rules.cancelWait(w.ws.id, r.id, listed.data[0].id);
        expect((await rules.listWaits(w.ws.id, r.id)).total).toBe(1);
        await waitSvc.resumeDue(later(2));
        expect(
          (await tagIdsOf(a.id)).length + (await tagIdsOf(b.id)).length,
        ).toBe(1);
        await expect(
          rules.cancelWait(w.ws.id, r.id, listed.data[0].id),
        ).rejects.toThrow(NotFoundException);
        await expect(rules.listWaits(w.ws.id, 'nope')).rejects.toThrow(
          NotFoundException,
        );
      });
    });

    describe('saving', () => {
      const codes = async (w: W, actions: unknown[]) => {
        try {
          await rule(w, actions);
          return [];
        } catch (e: any) {
          return (e.getResponse?.().issues ?? []).map(
            (i: any) => `${i.code}@${i.path}`,
          );
        }
      };
      it('refuses a wait inside a loop, and one longer than the limit (which is configurable)', async () => {
        const w = await world();
        expect(
          await codes(w, [
            { type: 'FOR_EACH', over: 'SUBTASKS', do: [wait(1)] },
          ]),
        ).toEqual(['WAIT_IN_LOOP@/actions/0/do/0']);
        expect(await codes(w, [wait(31)])).toEqual([
          'WAIT_TOO_LONG@/actions/0/for',
        ]);
        process.env.AUTOMATION_MAX_WAIT_DAYS = '90';
        try {
          expect(await codes(w, [wait(90)])).toEqual([]);
        } finally {
          delete process.env.AUTOMATION_MAX_WAIT_DAYS;
        }
      });
      it('refuses to call a rule that waits', async () => {
        const w = await world();
        const sleepy = await mkRule(w, 'Sleepy', {
          trigger: { type: 'CALLED' },
          actions: [wait(1), tagAct(w.tagA.id)],
        });
        expect(await codes(w, [{ type: 'RUN_RULE', rule: sleepy.id }])).toEqual(
          ['RUN_RULE_HAS_WAIT@/actions/0/rule'],
        );
      });
    });
  });
});
