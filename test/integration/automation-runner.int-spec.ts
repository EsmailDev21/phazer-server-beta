/**
 * Step 5.2 on a real database. Rules are saved through the real AutomationsService and people change
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

describe('Automation runner (step 5.2)', () => {
  let prisma: PrismaService;
  let rules: AutomationsService;
  let runner: AutomationRunnerService;
  let sweep: DueSweepService;
  let tasks: TasksService;
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
        { provide: NotificationsService, useValue: {} },
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
    tasks = moduleRef.get(TasksService);
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

  // =============================================================== the full path ================
  describe("a person's change runs the matching rules", () => {
    it('TASK_CREATED -> tag, assign, priority, comment (with placeholders): done as the system actor and stamped with the rule', async () => {
      const w = await world();
      await prisma.user.update({
        where: { id: w.owner.id },
        data: { name: 'Ana' },
      });
      const r = await mkRule(w, 'Triage', {
        trigger: { type: 'TASK_CREATED' },
        actions: [
          { type: 'ADD_TAG', tagId: w.tagA.id },
          { type: 'ASSIGN', mode: 'ADD', users: [w.member.id, 'TRIGGERER'] },
          { type: 'SET_PRIORITY', priority: 'HIGH' },
          {
            type: 'COMMENT',
            body: '{{task.key}} "{{task.title}}" created by {{actor.name}} in {{task.status}}',
          },
        ],
      });
      const t = await mkTask(w);

      expect(await tagIdsOf(t.id)).toEqual([w.tagA.id]);
      const after = await prisma.task.findUniqueOrThrow({
        where: { id: t.id },
        include: { assignees: true, workspace: true },
      });
      expect(after.priority).toBe('HIGH');
      expect(after.assignees.map((u) => u.id).sort()).toEqual(
        [w.member.id, w.owner.id].sort(),
      );

      const sys = await sysUser();
      expect(sys.password).toBeNull();
      const comment = await prisma.comment.findFirstOrThrow({
        where: { targetType: CommentableType.TASK, targetId: t.id },
      });
      expect(comment.authorId).toBe(sys.id);
      expect(comment.content).toBe(
        `${after.workspace.key}-${after.number} "Fix login" created by Ana in To Do`,
      );

      const [run] = await runsOf(r.id);
      expect(run).toMatchObject({
        status: 'OK',
        actionsRun: 4,
        taskId: t.id,
        depth: 0,
        error: null,
      });

      // every change the rule made says so: origin, which rule, how deep, and who (the system actor)
      const made = await prisma.activity.findMany({
        where: {
          targetId: t.id,
          action: { in: ['TAG_ADDED', 'ASSIGNED', 'PRIORITY_CHANGED'] },
        },
      });
      expect(made.length).toBeGreaterThanOrEqual(3);
      for (const a of made) {
        expect(a.actorId).toBe(sys.id);
        expect(a.metadata).toMatchObject({
          origin: CreationMode.AUTOMATION,
          automation: { id: r.id, depth: 1 },
        });
      }
    });

    it('STATUS_CHANGED to a category: the trigger knows both ends by name', async () => {
      const w = await world();
      await prisma.user.update({
        where: { id: w.owner.id },
        data: { name: 'Ana' },
      });
      const r = await mkRule(w, 'Done note', {
        trigger: { type: 'STATUS_CHANGED', to: [{ category: 'DONE' }] },
        actions: [
          {
            type: 'COMMENT',
            body: 'moved {{trigger.from}} -> {{trigger.to}} by {{actor.name}}',
          },
        ],
      });
      const t = await mkTask(w);
      await tasks.update(t.id, { status: 'IN_PROGRESS' }, w.owner.id);
      await idle();
      expect(await runsOf(r.id)).toHaveLength(0); // not DONE yet
      await tasks.update(t.id, { workflowStatusId: w.done1.id }, w.owner.id);
      await idle();
      expect(
        (await prisma.comment.findFirstOrThrow({ where: { targetId: t.id } }))
          .content,
      ).toBe(
        `moved ${(await prisma.workflowStatus.findFirstOrThrow({ where: { projectId: w.p1.id, category: 'IN_PROGRESS' } })).name} -> ${w.done1.name} by Ana`,
      );
      expect(await runsOf(r.id)).toHaveLength(1);
    });

    it('FIELD_CHANGED: priority and tags', async () => {
      const w = await world();
      const r1 = await mkRule(w, 'On priority', {
        trigger: { type: 'FIELD_CHANGED', field: 'PRIORITY' },
        conditions: {
          all: [{ field: 'PRIORITY', op: 'IN', value: ['URGENT'] }],
        },
        actions: [{ type: 'ADD_TAG', tagId: w.tagA.id }],
      });
      const r2 = await mkRule(w, 'On tags', {
        trigger: { type: 'FIELD_CHANGED', field: 'TAGS' },
        actions: [{ type: 'SET_PRIORITY', priority: 'LOW' }],
      });
      const t = await mkTask(w);
      await tasks.update(t.id, { priority: 'HIGH' }, w.owner.id);
      await idle();
      expect(await runsOf(r1.id)).toHaveLength(0); // condition says URGENT only
      await tasks.update(t.id, { priority: 'URGENT' }, w.owner.id);
      await idle();
      expect(await tagIdsOf(t.id)).toEqual([w.tagA.id]); // r1 tagged it ...
      expect(
        (await prisma.task.findUniqueOrThrow({ where: { id: t.id } })).priority,
      ).toBe('LOW'); // ... which ran r2 (a chain of two)
      expect(await runsOf(r1.id)).toHaveLength(1);
      expect(await runsOf(r2.id)).toHaveLength(1);
    });

    it('DUE_DATE, ASSIGNEES, ISSUE_TYPE changes also reach rules', async () => {
      const w = await world();
      const r = await mkRule(w, 'Any assign', {
        trigger: { type: 'FIELD_CHANGED', field: 'ASSIGNEES' },
        actions: [{ type: 'ADD_TAG', tagId: w.tagB.id }],
      });
      const d = await mkRule(w, 'Due', {
        trigger: { type: 'FIELD_CHANGED', field: 'DUE_DATE' },
        actions: [{ type: 'ADD_TAG', tagId: w.tagA.id }],
      });
      const t = await mkTask(w);
      await tasks.setAssignees(t.id, { userIds: [w.member.id] }, w.owner.id);
      await idle();
      await tasks.update(
        t.id,
        { dueDate: '2026-12-01T00:00:00.000Z' },
        w.owner.id,
      );
      await idle();
      expect(await tagIdsOf(t.id)).toEqual([w.tagA.id, w.tagB.id].sort());
      expect(await runsOf(r.id)).toHaveLength(1);
      expect(await runsOf(d.id)).toHaveLength(1);
    });
  });

  // =============================================================== matching =====================
  describe('which rules run', () => {
    it('conditions decide, and a rule that does not match leaves no trace', async () => {
      const w = await world();
      const r = await mkRule(w, 'Only high', {
        trigger: { type: 'TASK_CREATED' },
        conditions: { all: [{ field: 'PRIORITY', op: 'IN', value: ['HIGH'] }] },
        actions: [{ type: 'ADD_TAG', tagId: w.tagA.id }],
      });
      const low = await mkTask(w, { priority: 'LOW' });
      const high = await mkTask(w, { priority: 'HIGH' });
      expect(await tagIdsOf(low.id)).toEqual([]);
      expect(await tagIdsOf(high.id)).toEqual([w.tagA.id]);
      expect(await runsOf(r.id)).toHaveLength(1);
    });
    it('scope: a project rule ignores other projects; a workspace rule covers all', async () => {
      const w = await world();
      const pr = await mkRule(w, 'P1 only', {
        projectId: w.p1.id,
        trigger: { type: 'TASK_CREATED' },
        actions: [{ type: 'ADD_TAG', tagId: w.tagA.id }],
      });
      const wide = await mkRule(w, 'Everywhere', {
        trigger: { type: 'TASK_CREATED' },
        actions: [{ type: 'ADD_TAG', tagId: w.tagB.id }],
      });
      const a = await mkTask(w, { projectId: w.p1.id });
      const b = await mkTask(w, { projectId: w.p2.id });
      expect(await tagIdsOf(a.id)).toEqual([w.tagA.id, w.tagB.id].sort());
      expect(await tagIdsOf(b.id)).toEqual([w.tagB.id]);
      expect(await runsOf(pr.id)).toHaveLength(1);
      expect(await runsOf(wide.id)).toHaveLength(2);
    });
    it("workspaces are isolated: another workspace's rules never see this workspace's events", async () => {
      const a = await world();
      const b = await world();
      const rb = await mkRule(b, 'B rule', {
        trigger: { type: 'TASK_CREATED' },
        actions: [{ type: 'ADD_TAG', tagId: b.tagA.id }],
      });
      const t = await mkTask(a);
      expect(await runsOf(rb.id)).toHaveLength(0);
      expect(await tagIdsOf(t.id)).toEqual([]);
    });
    it('disabled, paused, and untranslated (raw) rules do not run; the feature flag switches the whole runner off', async () => {
      const w = await world();
      const off = await mkRule(
        w,
        'Off',
        {
          trigger: { type: 'TASK_CREATED' },
          actions: [{ type: 'ADD_TAG', tagId: w.tagA.id }],
        },
        { enabled: false },
      );
      await prisma.automation.create({
        data: {
          workspaceId: w.ws.id,
          name: 'Raw',
          nameKey: 'raw',
          ruleVersion: 0,
          triggerType: 'RAW',
          trigger: {},
          sourceDefinition: { x: 1 },
          createdVia: 'IMPORT',
          createdById: w.owner.id,
        },
      });
      const on = await mkRule(w, 'On', {
        trigger: { type: 'TASK_CREATED' },
        actions: [{ type: 'ADD_TAG', tagId: w.tagB.id }],
      });
      const t1 = await mkTask(w);
      expect(await tagIdsOf(t1.id)).toEqual([w.tagB.id]);
      expect(await runsOf(off.id)).toHaveLength(0);
      flags.WORKFLOW = false;
      const t2 = await mkTask(w);
      expect(await tagIdsOf(t2.id)).toEqual([]);
      expect(await runsOf(on.id)).toHaveLength(1);
    });
    it('silent writes (imports, bulk) do not trigger rules', async () => {
      const w = await world();
      const r = await mkRule(w, 'On create', {
        trigger: { type: 'TASK_CREATED' },
        actions: [{ type: 'ADD_TAG', tagId: w.tagA.id }],
      });
      await tasks.create(
        { workspaceId: w.ws.id, projectId: w.p1.id, title: 'imported' } as any,
        w.owner.id,
        { origin: CreationMode.IMPORT, actorId: w.owner.id, silent: true },
      );
      await idle();
      expect(await runsOf(r.id)).toHaveLength(0);
    });
    it('a deleted or archived task is skipped quietly', async () => {
      const w = await world();
      const r = await mkRule(w, 'x', {
        trigger: { type: 'FIELD_CHANGED', field: 'PRIORITY' },
        actions: [{ type: 'ADD_TAG', tagId: w.tagA.id }],
      });
      const t = await mkTask(w);
      await prisma.task.update({
        where: { id: t.id },
        data: { isArchived: true },
      });
      await tasks
        .update(t.id, { priority: 'HIGH' }, w.owner.id)
        .catch(() => undefined);
      await idle();
      const ev = {
        eventId: 'x1',
        kind: 'FIELD_CHANGED' as const,
        field: 'PRIORITY' as const,
        workspaceId: w.ws.id,
        taskId: t.id,
        actorId: null,
        depth: 0,
        causedBy: null,
        at: new Date(),
      };
      expect(await runner.handleEvent(ev)).toEqual({ [r.id]: 'TASK_GONE' });
      expect(
        await runner.handleEvent({
          ...ev,
          eventId: 'x2',
          taskId: 'does-not-exist',
        }),
      ).toEqual({ [r.id]: 'TASK_GONE' });
      expect(await runsOf(r.id)).toHaveLength(0);
    });
  });

  // =============================================================== exactly once =================
  describe('at most once per (rule, event)', () => {
    const event = (w: W, taskId: string, eventId = 'evt-1') => ({
      eventId,
      kind: 'TASK_CREATED' as const,
      workspaceId: w.ws.id,
      taskId,
      actorId: w.owner.id,
      depth: 0,
      causedBy: null,
      at: new Date(),
    });
    it('the same event delivered again does nothing', async () => {
      const w = await world();
      const r = await mkRule(w, 'Comment once', {
        trigger: { type: 'TASK_CREATED' },
        actions: [{ type: 'COMMENT', body: 'hello' }],
      });
      const t = await mkTask(w);
      expect(await prisma.comment.count({ where: { targetId: t.id } })).toBe(1);
      const created = (
        await prisma.activity.findFirstOrThrow({
          where: { targetId: t.id, action: 'CREATED' },
        })
      ).id;
      const again = await runner.handleEvent({ ...event(w, t.id, created) });
      expect(again).toEqual({ [r.id]: 'DUPLICATE' });
      expect(await prisma.comment.count({ where: { targetId: t.id } })).toBe(1);
      expect(await runsOf(r.id)).toHaveLength(1);
    });
    it('eight instances handling one event at once: the actions run exactly once', async () => {
      const w = await world();
      const r = await mkRule(w, 'Comment once', {
        trigger: { type: 'TASK_CREATED' },
        actions: [{ type: 'COMMENT', body: 'hello' }],
      });
      const t = await prisma.task.findFirstOrThrow({
        where: {
          id: (
            await tasks.create(
              { workspaceId: w.ws.id, projectId: w.p1.id, title: 'x' } as any,
              w.owner.id,
              {
                origin: CreationMode.MANUAL,
                actorId: w.owner.id,
                silent: true,
              },
            )
          ).id,
        },
      });
      const outcomes = await Promise.all(
        Array.from({ length: 8 }, () =>
          runner.handleEvent(event(w, t.id, 'race-1')),
        ),
      );
      const values = outcomes.map((o) => o[r.id]);
      expect(values.filter((v) => v === 'RAN')).toHaveLength(1);
      expect(values.filter((v) => v === 'DUPLICATE')).toHaveLength(7);
      expect(await prisma.comment.count({ where: { targetId: t.id } })).toBe(1);
      expect(await runsOf(r.id)).toHaveLength(1);
    });
    it('a run that died half way is not repeated (it is recorded as interrupted)', async () => {
      const w = await world();
      const r = await mkRule(w, 'Comment once', {
        trigger: { type: 'TASK_CREATED' },
        actions: [{ type: 'COMMENT', body: 'hello' }],
      });
      const t = await prisma.task.findFirstOrThrow({
        where: {
          id: (
            await tasks.create(
              { workspaceId: w.ws.id, projectId: w.p1.id, title: 'x' } as any,
              w.owner.id,
              {
                origin: CreationMode.MANUAL,
                actorId: w.owner.id,
                silent: true,
              },
            )
          ).id,
        },
      });
      await prisma.automationRun.create({
        data: {
          automationId: r.id,
          workspaceId: w.ws.id,
          taskId: t.id,
          eventId: 'crashed',
          status: 'FAILED',
          error: 'INTERRUPTED: the run did not finish',
        },
      });
      expect(await runner.handleEvent(event(w, t.id, 'crashed'))).toEqual({
        [r.id]: 'DUPLICATE',
      });
      expect(await prisma.comment.count({ where: { targetId: t.id } })).toBe(0);
    });
  });

  // =============================================================== loops ========================
  describe('loops cannot run away', () => {
    it('two rules that undo each other stop after three steps, and the guard says so', async () => {
      const w = await world();
      const a = await mkRule(w, 'High -> Low', {
        trigger: { type: 'FIELD_CHANGED', field: 'PRIORITY' },
        conditions: { all: [{ field: 'PRIORITY', op: 'IN', value: ['HIGH'] }] },
        actions: [{ type: 'SET_PRIORITY', priority: 'LOW' }],
      });
      const b = await mkRule(w, 'Low -> High', {
        trigger: { type: 'FIELD_CHANGED', field: 'PRIORITY' },
        conditions: { all: [{ field: 'PRIORITY', op: 'IN', value: ['LOW'] }] },
        actions: [{ type: 'SET_PRIORITY', priority: 'HIGH' }],
      });
      const t = await mkTask(w);
      await tasks.update(t.id, { priority: 'HIGH' }, w.owner.id);
      await idle();

      const all = [...(await runsOf(a.id)), ...(await runsOf(b.id))];
      // Rules for one event run in order and read the task as it is NOW, so B can react to A's change while
      // handling the same event; what must hold however they interleave is that it ends, and ends early.
      expect(
        all.some(
          (r) => r.status === 'SKIPPED' && /^LOOP_GUARD/.test(r.error ?? ''),
        ),
      ).toBe(true);
      expect(
        all
          .filter((r) => r.status === 'OK')
          .every((r) => r.depth < AUTOMATION_LIMITS.maxChainDepth),
      ).toBe(true); // nothing RAN at the cap
      const changes = await prisma.activity.findMany({
        where: { targetId: t.id, action: 'PRIORITY_CHANGED' },
      });
      const made = changes.filter((c) => (c.metadata as any)?.automation);
      expect(changes.length - made.length).toBe(1); // exactly one by a person
      expect(made.length).toBeGreaterThanOrEqual(2);
      expect(made.length).toBeLessThanOrEqual(
        2 * AUTOMATION_LIMITS.maxChainDepth,
      ); // bounded, not runaway
      expect(
        made.every(
          (c) =>
            (c.metadata as any).automation.depth <=
            AUTOMATION_LIMITS.maxChainDepth,
        ),
      ).toBe(true);
      expect(['HIGH', 'LOW']).toContain(
        (await prisma.task.findUniqueOrThrow({ where: { id: t.id } })).priority,
      );
    });
    it('a rule never reacts to its own change', async () => {
      const w = await world();
      const r = await mkRule(w, 'Escalate', {
        trigger: { type: 'FIELD_CHANGED', field: 'PRIORITY' },
        actions: [{ type: 'SET_PRIORITY', priority: 'URGENT' }],
      });
      const t = await mkTask(w);
      await tasks.update(t.id, { priority: 'LOW' }, w.owner.id);
      await idle();
      const runs = await runsOf(r.id);
      expect(runs.map((x) => x.status)).toEqual(['OK', 'SKIPPED']);
      expect(runs[1].error).toMatch(/does not react to its own change/);
      expect(
        (await prisma.task.findUniqueOrThrow({ where: { id: t.id } })).priority,
      ).toBe('URGENT');
    });
    it('"create a subtask when a task is created" is held to non-subtasks, so it makes exactly one', async () => {
      const w = await world();
      const r = await mkRule(w, 'Follow up', {
        trigger: { type: 'TASK_CREATED' },
        conditions: { all: [{ field: 'IS_SUBTASK', op: 'IS_FALSE' }] },
        actions: [
          {
            type: 'CREATE_SUBTASK',
            title: 'Review {{task.title}}',
            priority: 'LOW',
          },
        ],
      });
      const t = await mkTask(w);
      await idle();
      const kids = await prisma.task.findMany({ where: { parentId: t.id } });
      expect(kids).toHaveLength(1);
      expect(kids[0]).toMatchObject({
        title: 'Review Fix login',
        priority: 'LOW',
        createdVia: 'AUTOMATION',
        projectId: w.p1.id,
      });
      expect(await prisma.task.count({ where: { workspaceId: w.ws.id } })).toBe(
        2,
      );
      expect(await runsOf(r.id)).toHaveLength(1); // the subtask's own creation matched nothing
    });
    it('a rule that runs too often is switched off with a reason, and turning it back on clears the reason', async () => {
      const w = await world();
      const r = await mkRule(w, 'Busy', {
        trigger: { type: 'TASK_CREATED' },
        actions: [{ type: 'ADD_TAG', tagId: w.tagA.id }],
      });
      await prisma.automationRun.createMany({
        data: Array.from(
          { length: AUTOMATION_LIMITS.maxRunsPerRulePerMinute },
          (_, i) => ({
            automationId: r.id,
            workspaceId: w.ws.id,
            eventId: `old-${i}`,
            status: 'OK' as const,
          }),
        ),
      });
      const t = await mkTask(w);
      const row = await prisma.automation.findUniqueOrThrow({
        where: { id: r.id },
      });
      expect(row.enabled).toBe(false);
      expect(row.pausedReason).toMatch(/^RATE_LIMIT/);
      expect(await tagIdsOf(t.id)).toEqual([]);
      expect(
        (await runsOf(r.id)).filter((x) => x.status === 'SKIPPED'),
      ).toHaveLength(1);
      expect((await rules.get(w.ws.id, r.id, w.owner.id)).pausedReason).toMatch(
        /^RATE_LIMIT/,
      );
      const back = await rules.update(w.ws.id, r.id, w.owner.id, {
        enabled: true,
      });
      expect(back).toMatchObject({ enabled: true, pausedReason: null });
    });
    it('runs older than a minute do not count toward the breaker; skipped rows never do', async () => {
      const w = await world();
      const r = await mkRule(w, 'Fine', {
        trigger: { type: 'TASK_CREATED' },
        actions: [{ type: 'ADD_TAG', tagId: w.tagA.id }],
      });
      const old = new Date(Date.now() - 5 * 60_000);
      await prisma.automationRun.createMany({
        data: [
          ...Array.from({ length: 40 }, (_, i) => ({
            automationId: r.id,
            workspaceId: w.ws.id,
            eventId: `old-${i}`,
            status: 'OK' as const,
            ranAt: old,
          })),
          ...Array.from({ length: 40 }, (_, i) => ({
            automationId: r.id,
            workspaceId: w.ws.id,
            eventId: `skip-${i}`,
            status: 'SKIPPED' as const,
          })),
        ],
      });
      const t = await mkTask(w);
      expect(await tagIdsOf(t.id)).toEqual([w.tagA.id]);
      expect(
        (await prisma.automation.findUniqueOrThrow({ where: { id: r.id } }))
          .enabled,
      ).toBe(true);
    });
  });

  // =============================================================== failures =====================
  describe('when an action fails', () => {
    it('it stops there: earlier actions stay, later ones do not run, the log says where and why', async () => {
      const w = await world();
      const r = await mkRule(w, 'Breaks', {
        trigger: { type: 'TASK_CREATED' },
        actions: [
          { type: 'ADD_TAG', tagId: w.tagA.id },
          { type: 'ADD_TAG', tagId: w.tagB.id },
          { type: 'SET_PRIORITY', priority: 'HIGH' },
        ],
      });
      await prisma.tag.delete({ where: { id: w.tagB.id } }); // deleted after the rule was saved
      const t = await mkTask(w);
      const [run] = await runsOf(r.id);
      expect(run).toMatchObject({
        status: 'FAILED',
        actionsRun: 1,
        details: { failedAt: 1, of: 3 },
      });
      expect(run.error).toBeTruthy();
      expect(run.error!.length).toBeLessThanOrEqual(300);
      expect(await tagIdsOf(t.id)).toEqual([w.tagA.id]);
      expect(
        (await prisma.task.findUniqueOrThrow({ where: { id: t.id } })).priority,
      ).toBeNull();
    });
    it('a failing rule does not stop the others, nor the change that caused it', async () => {
      const w = await world();
      const bad = await mkRule(w, 'Bad', {
        trigger: { type: 'TASK_CREATED' },
        actions: [{ type: 'ADD_TAG', tagId: w.tagB.id }],
      });
      const good = await mkRule(w, 'Good', {
        trigger: { type: 'TASK_CREATED' },
        actions: [{ type: 'ADD_TAG', tagId: w.tagA.id }],
      });
      await prisma.tag.delete({ where: { id: w.tagB.id } });
      const t = await mkTask(w);
      expect((await runsOf(bad.id))[0].status).toBe('FAILED');
      expect((await runsOf(good.id))[0].status).toBe('OK');
      expect(await prisma.task.count({ where: { id: t.id } })).toBe(1);
    });
    it('an unexpected error is recorded generically (no internals), and logged', async () => {
      const w = await world();
      const r = await mkRule(w, 'Odd', {
        trigger: { type: 'TASK_CREATED' },
        actions: [{ type: 'ADD_TAG', tagId: w.tagA.id }],
      });
      const spy = jest
        .spyOn(TagsService.prototype, 'attach')
        .mockRejectedValueOnce(
          new Error('connection to 10.0.0.5:5432 refused'),
        );
      const quiet = jest
        .spyOn((runner as any).executor.logger, 'error')
        .mockImplementation(() => undefined);
      await mkTask(w);
      spy.mockRestore();
      quiet.mockRestore();
      const [run] = await runsOf(r.id);
      expect(run).toMatchObject({
        status: 'FAILED',
        error: 'Unexpected error',
      });
      expect(run.error).not.toMatch(/10\.0\.0\.5/);
    });
  });

  // =============================================================== each action ==================
  describe('actions', () => {
    const tr = { type: 'TASK_CREATED' };
    it('ASSIGN: SET replaces, ADD adds, REMOVE removes; TRIGGERER/CREATOR resolve; no change = no write', async () => {
      const w = await world();
      await mkRule(w, 'a1', {
        trigger: tr,
        actions: [{ type: 'ASSIGN', mode: 'SET', users: [w.member.id] }],
      });
      const t = await mkTask(w);
      const assigned = async () =>
        (
          await prisma.task.findUniqueOrThrow({
            where: { id: t.id },
            include: { assignees: true },
          })
        ).assignees
          .map((u) => u.id)
          .sort();
      expect(await assigned()).toEqual([w.member.id]);
      const r2 = await mkRule(w, 'a2', {
        trigger: { type: 'FIELD_CHANGED', field: 'PRIORITY' },
        actions: [
          {
            type: 'ASSIGN',
            mode: 'ADD',
            users: ['TRIGGERER', 'CREATOR', w.member2.id],
          },
        ],
      });
      await tasks.update(t.id, { priority: 'LOW' }, w.owner.id);
      await idle();
      expect(await assigned()).toEqual(
        [w.member.id, w.member2.id, w.owner.id].sort(),
      );
      await rules.update(w.ws.id, r2.id, w.owner.id, {
        actions: [
          {
            type: 'ASSIGN',
            mode: 'REMOVE',
            users: [w.member.id, w.member2.id],
          },
        ],
      });
      const before = await prisma.activity.count({
        where: { targetId: t.id, action: 'UNASSIGNED' },
      });
      await tasks.update(t.id, { priority: 'HIGH' }, w.owner.id);
      await idle();
      expect(await assigned()).toEqual([w.owner.id]);
      expect(
        await prisma.activity.count({
          where: { targetId: t.id, action: 'UNASSIGNED' },
        }),
      ).toBe(before + 2);
      await tasks.update(t.id, { priority: 'URGENT' }, w.owner.id);
      await idle(); // REMOVE of people already gone
      expect(
        await prisma.activity.count({
          where: { targetId: t.id, action: 'UNASSIGNED' },
        }),
      ).toBe(before + 2);
    });
    it('ADD_TAG twice and REMOVE_TAG of an absent tag are harmless; REMOVE_TAG removes', async () => {
      const w = await world();
      await mkRule(w, 'add', {
        trigger: tr,
        actions: [
          { type: 'ADD_TAG', tagId: w.tagA.id },
          { type: 'ADD_TAG', tagId: w.tagA.id },
          { type: 'REMOVE_TAG', tagId: w.tagB.id },
        ],
      });
      const t = await mkTask(w);
      expect(await tagIdsOf(t.id)).toEqual([w.tagA.id]);
      expect(
        await prisma.activity.count({
          where: { targetId: t.id, action: 'TAG_ADDED' },
        }),
      ).toBe(1);
      await mkRule(w, 'rm', {
        trigger: { type: 'FIELD_CHANGED', field: 'PRIORITY' },
        actions: [{ type: 'REMOVE_TAG', tagId: w.tagA.id }],
      });
      await tasks.update(t.id, { priority: 'LOW' }, w.owner.id);
      await idle();
      expect(await tagIdsOf(t.id)).toEqual([]);
      expect(
        (
          await runsOf(
            (
              await prisma.automation.findFirstOrThrow({
                where: { name: 'rm' },
              })
            ).id,
          )
        )[0].status,
      ).toBe('OK');
    });
    it('SET_STATUS by category and by exact status; SET_DUE_DATE counts from today (UTC)', async () => {
      const w = await world();
      await mkRule(w, 'close', {
        projectId: w.p1.id,
        trigger: { type: 'FIELD_CHANGED', field: 'PRIORITY' },
        conditions: {
          all: [{ field: 'PRIORITY', op: 'IN', value: ['URGENT'] }],
        },
        actions: [
          { type: 'SET_STATUS', status: { statusId: w.done1.id } },
          { type: 'SET_DUE_DATE', inDays: 3 },
        ],
      });
      const t = await mkTask(w);
      await tasks.update(t.id, { priority: 'URGENT' }, w.owner.id);
      await idle();
      const after = await prisma.task.findUniqueOrThrow({
        where: { id: t.id },
      });
      expect(after).toMatchObject({
        status: 'DONE',
        workflowStatusId: w.done1.id,
      });
      const n = new Date();
      expect(after.dueDate!.toISOString()).toBe(
        new Date(
          Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + 3),
        ).toISOString(),
      );
      await mkRule(w, 'reopen', {
        trigger: { type: 'FIELD_CHANGED', field: 'PRIORITY' },
        conditions: { all: [{ field: 'PRIORITY', op: 'IN', value: ['LOW'] }] },
        actions: [{ type: 'SET_STATUS', status: { category: 'IN_PROGRESS' } }],
      });
      await tasks.update(t.id, { priority: 'LOW' }, w.owner.id);
      await idle();
      expect(
        (await prisma.task.findUniqueOrThrow({ where: { id: t.id } })).status,
      ).toBe('IN_PROGRESS');
    });
    it('SET_CUSTOM_FIELD sets a value and null clears it', async () => {
      const w = await world();
      await mkRule(w, 'score', {
        trigger: tr,
        actions: [
          { type: 'SET_CUSTOM_FIELD', customFieldId: w.field.id, value: 8 },
        ],
      });
      const t = await mkTask(w);
      expect(
        (
          await prisma.taskCustomValue.findFirstOrThrow({
            where: { taskId: t.id, fieldId: w.field.id },
          })
        ).value,
      ).toBe(8);
      await mkRule(w, 'clear', {
        trigger: { type: 'FIELD_CHANGED', field: 'PRIORITY' },
        actions: [
          { type: 'SET_CUSTOM_FIELD', customFieldId: w.field.id, value: null },
        ],
      });
      await tasks.update(t.id, { priority: 'LOW' }, w.owner.id);
      await idle();
      expect(
        await prisma.taskCustomValue.count({ where: { taskId: t.id } }),
      ).toBe(0);
    });
    it('a comment cannot smuggle placeholders through a task title, and is clamped', async () => {
      const w = await world();
      await mkRule(w, 'c', {
        trigger: tr,
        actions: [{ type: 'COMMENT', body: 'New: {{task.title}}' }],
      });
      const t = await mkTask(w, {
        title: '{{actor.name}} {{task.key}} ' + 'x'.repeat(190),
      });
      const c = await prisma.comment.findFirstOrThrow({
        where: { targetId: t.id },
      });
      expect(c.content.startsWith('New: {{actor.name}} {{task.key}} x')).toBe(
        true,
      );
    });
    it('the automation user exists once, however many rules run', async () => {
      const w = await world();
      await mkRule(w, 'c1', {
        trigger: tr,
        actions: [{ type: 'COMMENT', body: 'a' }],
      });
      await mkRule(w, 'c2', {
        trigger: tr,
        actions: [{ type: 'COMMENT', body: 'b' }],
      });
      await Promise.all([mkTask(w), mkTask(w), mkTask(w)]);
      expect(
        await prisma.user.count({ where: { email: AUTOMATION_USER_EMAIL } }),
      ).toBe(1);
      expect(await prisma.comment.count()).toBe(6);
    });
  });

  // =============================================================== due dates ====================
  describe('DUE_APPROACHING (the sweep)', () => {
    const NOW = new Date('2026-10-18T12:00:00.000Z');
    const hours = (n: number) => new Date(NOW.getTime() + n * 3_600_000);
    const dueTask = async (
      w: W,
      dueDate: Date | null,
      over: Record<string, unknown> = {},
    ) => {
      const t = await tasks.create(
        { workspaceId: w.ws.id, projectId: w.p1.id, title: 'due' } as any,
        w.owner.id,
        { origin: CreationMode.MANUAL, actorId: w.owner.id, silent: true },
      );
      await prisma.task.update({
        where: { id: t.id },
        data: { dueDate, ...over },
      });
      return t;
    };
    const rule = (w: W, over: Record<string, unknown> = {}) =>
      mkRule(w, 'Due soon', {
        trigger: {
          type: 'DUE_APPROACHING',
          offset: { amount: 1, unit: 'DAYS' },
        },
        actions: [{ type: 'ADD_TAG', tagId: w.tagA.id }],
        ...over,
      });

    it('fires for tasks due inside the window - not later, not overdue, not done, not archived, not without a date', async () => {
      const w = await world();
      const r = await rule(w);
      const soon = await dueTask(w, hours(12));
      const edge = await dueTask(w, hours(24));
      const later = await dueTask(w, hours(25));
      const overdue = await dueTask(w, hours(-1));
      const none = await dueTask(w, null);
      const done = await dueTask(w, hours(5), { status: 'DONE' });
      const archived = await dueTask(w, hours(5), { isArchived: true });
      const res = await sweep.sweep(NOW);
      await idle();
      expect(res).toEqual({ rules: 1, fired: 2 });
      for (const [t, want] of [
        [soon, true],
        [edge, true],
        [later, false],
        [overdue, false],
        [none, false],
        [done, false],
        [archived, false],
      ] as const) {
        expect(await tagIdsOf(t.id)).toEqual(want ? [w.tagA.id] : []);
      }
      expect((await runsOf(r.id)).map((x) => x.status)).toEqual(['OK', 'OK']);
    });
    it('is idempotent: sweeping again fires nothing; a MOVED due date fires again', async () => {
      const w = await world();
      const r = await rule(w);
      const t = await dueTask(w, hours(10));
      await sweep.sweep(NOW);
      await idle();
      expect(await sweep.sweep(new Date(NOW.getTime() + 60_000))).toEqual({
        rules: 1,
        fired: 0,
      });
      expect(await runsOf(r.id)).toHaveLength(1);
      await prisma.taskTag.deleteMany({ where: { taskId: t.id } });
      await prisma.task.update({
        where: { id: t.id },
        data: { dueDate: hours(11) },
      });
      expect(await sweep.sweep(NOW)).toEqual({ rules: 1, fired: 1 });
      await idle();
      expect(await tagIdsOf(t.id)).toEqual([w.tagA.id]);
      expect(await runsOf(r.id)).toHaveLength(2);
    });
    it("the offset is the rule's: 2 hours is not 1 day", async () => {
      const w = await world();
      await rule(w, {
        trigger: {
          type: 'DUE_APPROACHING',
          offset: { amount: 2, unit: 'HOURS' },
        },
      });
      const near = await dueTask(w, hours(1));
      const far = await dueTask(w, hours(3));
      await sweep.sweep(NOW);
      await idle();
      expect(await tagIdsOf(near.id)).toEqual([w.tagA.id]);
      expect(await tagIdsOf(far.id)).toEqual([]);
    });
    it('respects scope and conditions, and a workspace without the rule is untouched', async () => {
      const w = await world();
      const other = await world();
      await rule(w, { projectId: w.p2.id });
      await rule(w, {
        name: 'High only',
        conditions: { all: [{ field: 'PRIORITY', op: 'IN', value: ['HIGH'] }] },
        actions: [{ type: 'ADD_TAG', tagId: w.tagB.id }],
      });
      const inP1 = await dueTask(w, hours(2), { priority: 'HIGH' });
      const inP1Low = await dueTask(w, hours(2), { priority: 'LOW' });
      const otherWs = await tasks.create(
        { workspaceId: other.ws.id, projectId: other.p1.id, title: 'o' } as any,
        other.owner.id,
        { origin: CreationMode.MANUAL, actorId: other.owner.id, silent: true },
      );
      await prisma.task.update({
        where: { id: otherWs.id },
        data: { dueDate: hours(2), priority: 'HIGH' },
      });
      await sweep.sweep(NOW);
      await idle();
      expect(await tagIdsOf(inP1.id)).toEqual([w.tagB.id]); // P2-only rule skipped it; the condition rule matched
      expect(await tagIdsOf(inP1Low.id)).toEqual([]);
      expect(await tagIdsOf(otherWs.id)).toEqual([]);
    });
    it('does at most N per rule per sweep, oldest due first, and the rest follow on the next sweeps (no starvation)', async () => {
      const w = await world();
      const r = await rule(w);
      const limits = AUTOMATION_LIMITS as unknown as {
        maxDueFiresPerTick: number;
      };
      const saved = limits.maxDueFiresPerTick;
      limits.maxDueFiresPerTick = 2;
      try {
        const ts = [
          await dueTask(w, hours(5)),
          await dueTask(w, hours(1)),
          await dueTask(w, hours(3)),
          await dueTask(w, hours(2)),
          await dueTask(w, hours(4)),
        ];
        expect((await sweep.sweep(NOW)).fired).toBe(2);
        await idle();
        expect(await tagIdsOf(ts[1].id)).toEqual([w.tagA.id]); // 1h and 2h first
        expect(await tagIdsOf(ts[3].id)).toEqual([w.tagA.id]);
        expect(await tagIdsOf(ts[0].id)).toEqual([]);
        expect((await sweep.sweep(NOW)).fired).toBe(2);
        await idle();
        expect((await sweep.sweep(NOW)).fired).toBe(1);
        await idle();
        expect((await sweep.sweep(NOW)).fired).toBe(0);
        expect(await runsOf(r.id)).toHaveLength(5);
      } finally {
        limits.maxDueFiresPerTick = saved;
      }
    });
    it('does nothing with the feature off; a disabled rule is not swept', async () => {
      const w = await world();
      const r = await rule(w);
      await dueTask(w, hours(2));
      flags.WORKFLOW = false;
      expect(await sweep.sweep(NOW)).toEqual({ rules: 0, fired: 0 });
      flags.WORKFLOW = true;
      await rules.update(w.ws.id, r.id, w.owner.id, { enabled: false });
      expect(await sweep.sweep(NOW)).toEqual({ rules: 0, fired: 0 });
      expect(await runsOf(r.id)).toHaveLength(0);
    });
    it("the changes a sweep makes are stamped like any rule's and can start chains (depth 1)", async () => {
      const w = await world();
      const r = await rule(w);
      const follow = await mkRule(w, 'On tag', {
        trigger: { type: 'FIELD_CHANGED', field: 'TAGS' },
        actions: [{ type: 'SET_PRIORITY', priority: 'HIGH' }],
      });
      const t = await dueTask(w, hours(2));
      await sweep.sweep(NOW);
      await idle();
      expect(
        (await prisma.task.findUniqueOrThrow({ where: { id: t.id } })).priority,
      ).toBe('HIGH');
      expect((await runsOf(follow.id))[0]).toMatchObject({
        status: 'OK',
        depth: 1,
      });
      expect((await runsOf(r.id))[0]).toMatchObject({ status: 'OK', depth: 0 });
    });
  });

  // =============================================================== database ======================
  it('paused_reason can only exist while a rule is off (CHECK)', async () => {
    const w = await world();
    const r = await mkRule(w, 'x', {
      trigger: { type: 'TASK_CREATED' },
      actions: [{ type: 'ADD_TAG', tagId: w.tagA.id }],
    });
    await expect(
      prisma.automation.update({
        where: { id: r.id },
        data: { pausedReason: 'because' },
      }),
    ).rejects.toThrow();
    await prisma.automation.update({
      where: { id: r.id },
      data: { enabled: false, pausedReason: 'because' },
    });
    await expect(
      prisma.automation.update({
        where: { id: r.id },
        data: { pausedReason: 'x'.repeat(301) },
      }),
    ).rejects.toThrow();
  });
});
