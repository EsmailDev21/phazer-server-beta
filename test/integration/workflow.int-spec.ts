/**
 * Step 1.4 (ADR-0006) on a real database. One describe per decision.
 */
import { TaskPlanningService } from '../../src/projects-tasks/planning/task-planning.service';
import { Test } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AccountType, TaskStatus } from '@prisma/client';
import { DomainWriter } from '../../src/domain-writer/domain-writer.service';
import { ActivityService } from '../../src/events/activity.service';
import { AuditLogService } from '../../src/events/audit-log.service';
import { PermissionResolver } from '../../src/access-control/access-control.service';
import { PlanLimitsService } from '../../src/access-control/plan-limits.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { TasksService } from '../../src/projects-tasks/tasks/tasks.service';
import { TaskTreeService } from '../../src/projects-tasks/tasks/task-tree.service';
import { TaskVisibilityService } from '../../src/projects-tasks/tasks/task-visibility.service';
import { ProjectsService } from '../../src/projects-tasks/projects/projects.service';
import { WorkflowService } from '../../src/projects-tasks/workflow/workflow.service';
import { CustomFieldsService } from '../../src/projects-tasks/custom-fields/custom-fields.service';
import { WorkspacesService } from '../../src/tenancy/workspaces/workspaces.service';
import { WorkspaceKeysService } from '../../src/tenancy/workspaces/workspace-keys.service';
import {
  getTestPrisma,
  disconnectTestPrisma,
} from './support/prisma-test-client';
import { resetDb } from './support/reset-db';
import { createUserWithAccount, createWorkspace } from './factories';

const T = TaskStatus;

describe('workflow statuses (real database)', () => {
  let prisma: PrismaService;
  let tasks: TasksService;
  let projects: ProjectsService;
  let workflow: WorkflowService;
  let writer: DomainWriter;

  beforeAll(async () => {
    prisma = getTestPrisma();
    const moduleRef = await Test.createTestingModule({
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: new EventEmitter2() },
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
        WorkspaceKeysService,
        WorkspacesService,
        DomainWriter,
      ],
    }).compile();
    tasks = moduleRef.get(TasksService);
    projects = moduleRef.get(ProjectsService);
    workflow = moduleRef.get(WorkflowService);
    writer = moduleRef.get(DomainWriter);
  });
  beforeEach(() => resetDb(prisma));
  afterAll(() => disconnectTestPrisma());

  async function world() {
    const { user, account } = await createUserWithAccount(prisma, {
      accountType: AccountType.ORGANIZATION,
    });
    const ws = await createWorkspace(prisma, { accountId: account.id });
    // Through the real service, so seeding is what is under test everywhere.
    const project = await projects.create(
      { workspaceId: ws.id, name: 'P' },
      user.id,
    );
    const statusByName = async (projectId: string = project.id) => {
      const rows = await prisma.workflowStatus.findMany({
        where: { projectId },
      });
      return Object.fromEntries(rows.map((r) => [r.name, r]));
    };
    const mk = (over: Record<string, unknown> = {}) =>
      tasks.create(
        {
          workspaceId: ws.id,
          title: 't',
          projectId: project.id,
          ...over,
        } as never,
        user.id,
      );
    const addStatus = (
      name: string,
      category: TaskStatus,
      extra: Record<string, unknown> = {},
      projectId = project.id,
    ) =>
      workflow.createStatus(
        projectId,
        { name, category, ...extra } as never,
        user.id,
      );
    return { user, account, ws, project, mk, statusByName, addStatus };
  }

  /** The ADR-0006 invariant, checked over the WHOLE database. */
  async function expectInvariant() {
    const all = await prisma.task.findMany({
      select: {
        id: true,
        status: true,
        projectId: true,
        workflowStatus: { select: { category: true, projectId: true } },
      },
    });
    for (const t of all) {
      if (t.projectId) {
        expect({ id: t.id, hasStatus: !!t.workflowStatus }).toEqual({
          id: t.id,
          hasStatus: true,
        });
        expect(t.workflowStatus!.category).toBe(t.status);
        expect(t.workflowStatus!.projectId).toBe(t.projectId);
      } else {
        expect(t.workflowStatus).toBeNull();
      }
    }
    // Every project: one default per non-empty category, initial status is TODO.
    for (const p of await prisma.project.findMany({
      include: { workflowStatuses: true },
    })) {
      const cats = new Set(p.workflowStatuses.map((s) => s.category));
      for (const c of cats) {
        expect(
          p.workflowStatuses.filter((s) => s.category === c && s.isDefault),
        ).toHaveLength(1);
      }
      const initial = p.workflowStatuses.find(
        (s) => s.id === p.defaultWorkflowStatusId,
      );
      expect(initial?.category).toBe(T.TODO);
    }
  }
  afterEach(async () => {
    await expectInvariant();
  });
  const row = (id: string) => prisma.task.findUniqueOrThrow({ where: { id } });
  const acts = (targetId: string, action: string) =>
    prisma.activity.findMany({ where: { targetId, action: action as never } });

  // ------------------------------------------------------------- decision 2
  describe('seeding (decision 2)', () => {
    it('a new project has four statuses, one per category, each the default; initial = To Do', async () => {
      const { project, statusByName } = await world();
      const s = await statusByName();
      expect(Object.keys(s).sort()).toEqual([
        'Blocked',
        'Done',
        'In Progress',
        'To Do',
      ]);
      expect(s['To Do']).toMatchObject({
        category: T.TODO,
        position: 0,
        isDefault: true,
      });
      expect(s['Done']).toMatchObject({
        category: T.DONE,
        position: 3,
        isDefault: true,
      });
      const p = await prisma.project.findUniqueOrThrow({
        where: { id: project.id },
      });
      expect(p.defaultWorkflowStatusId).toBe(s['To Do'].id);
      expect(p.enforceTransitions).toBe(false);
    });

    it('a failed project create leaves neither project nor statuses (one transaction)', async () => {
      const { user, ws } = await world();
      const before = await prisma.workflowStatus.count();
      await expect(
        projects.create({ workspaceId: 'nope', name: 'x' }, user.id),
      ).rejects.toThrow();
      expect(await prisma.workflowStatus.count()).toBe(before);
      void ws;
    });

    it('DomainWriter project create joins its transaction and seeds too', async () => {
      const { user, ws } = await world();
      const p = await writer.createProject(
        { workspaceId: ws.id, name: 'viaWriter' },
        user.id,
        { origin: 'INTEGRATION', actorId: user.id },
      );
      expect(
        await prisma.workflowStatus.count({ where: { projectId: p.id } }),
      ).toBe(4);
    });
  });

  // ------------------------------------------------------------- decision 5
  describe('create and PATCH {status} (decision 5)', () => {
    it('no status -> the initial status; status only -> that category default', async () => {
      const { mk, statusByName } = await world();
      const s = await statusByName();
      const a = await mk();
      expect(a).toMatchObject({
        status: T.TODO,
        workflowStatusId: s['To Do'].id,
      });
      const b = await mk({ status: T.DONE });
      expect(b).toMatchObject({
        status: T.DONE,
        workflowStatusId: s['Done'].id,
      });
    });

    it('workflowStatusId sets both; disagreement and foreign ids are 400; Inbox has no workflow', async () => {
      const { mk, addStatus, ws, user } = await world();
      await addStatus('Review', T.IN_PROGRESS);
      const review = await prisma.workflowStatus.findFirstOrThrow({
        where: { name: 'Review' },
      });
      const t = await mk({ workflowStatusId: review.id });
      expect(t).toMatchObject({
        status: T.IN_PROGRESS,
        workflowStatusId: review.id,
      });
      await expect(
        mk({ status: T.DONE, workflowStatusId: review.id }),
      ).rejects.toThrow(/does not match/);

      const other = await projects.create(
        { workspaceId: ws.id, name: 'Other' },
        user.id,
      );
      const foreign = await prisma.workflowStatus.findFirstOrThrow({
        where: { projectId: other.id },
      });
      await expect(mk({ workflowStatusId: foreign.id })).rejects.toThrow(
        /does not belong/,
      );

      await expect(
        tasks.create(
          {
            workspaceId: ws.id,
            title: 'inbox',
            workflowStatusId: review.id,
          } as never,
          user.id,
        ),
      ).rejects.toThrow(/no workflow/);
      const inbox = await tasks.create(
        { workspaceId: ws.id, title: 'inbox', status: T.DONE } as never,
        user.id,
      );
      expect(inbox).toMatchObject({
        status: T.DONE,
        workflowStatusId: null,
        projectId: null,
      });
    });

    it("a subtask inherits its parent project and gets that project's initial status", async () => {
      const { mk, ws, user, statusByName } = await world();
      const root = await mk();
      const child = await tasks.create(
        { workspaceId: ws.id, title: 'c', parentId: root.id } as never,
        user.id,
      );
      expect(child.workflowStatusId).toBe((await statusByName())['To Do'].id);
    });

    it('an old client re-sending the category does NOT reset a custom status; a different category lands on the default', async () => {
      const { mk, addStatus, user } = await world();
      await addStatus('Review', T.IN_PROGRESS);
      const review = await prisma.workflowStatus.findFirstOrThrow({
        where: { name: 'Review' },
      });
      const done = await prisma.workflowStatus.findFirstOrThrow({
        where: { name: 'Done' },
      });
      const t = await mk({ workflowStatusId: review.id });
      await tasks.update(t.id, { status: T.IN_PROGRESS }, user.id);
      expect((await row(t.id)).workflowStatusId).toBe(review.id);
      expect(await acts(t.id, 'STATUS_CHANGED')).toHaveLength(0);
      await tasks.update(t.id, { status: T.DONE }, user.id);
      expect(await row(t.id)).toMatchObject({
        status: T.DONE,
        workflowStatusId: done.id,
      });
    });

    it('STATUS_CHANGED carries from/to ids and categories, also for a move inside one category', async () => {
      const { mk, addStatus, user, statusByName } = await world();
      await addStatus('Backlog', T.TODO);
      const backlog = await prisma.workflowStatus.findFirstOrThrow({
        where: { name: 'Backlog' },
      });
      const todo = (await statusByName())['To Do'];
      const t = await mk();
      await tasks.update(t.id, { workflowStatusId: backlog.id }, user.id);
      const a = await acts(t.id, 'STATUS_CHANGED');
      expect(a).toHaveLength(1);
      expect(a[0].metadata).toEqual({
        fromStatusId: todo.id,
        toStatusId: backlog.id,
        fromCategory: 'TODO',
        toCategory: 'TODO',
      });
    });

    it('an unrelated PATCH changes no status and writes no STATUS_CHANGED', async () => {
      const { mk, user } = await world();
      const t = await mk();
      await tasks.update(t.id, { title: 'renamed' }, user.id);
      expect(await acts(t.id, 'STATUS_CHANGED')).toHaveLength(0);
    });

    it('?workflowStatusId= narrows the list; detail shows the status; ?status= still filters by category', async () => {
      const { mk, addStatus, user, ws } = await world();
      await addStatus('Review', T.IN_PROGRESS);
      const review = await prisma.workflowStatus.findFirstOrThrow({
        where: { name: 'Review' },
      });
      const a = await mk({ workflowStatusId: review.id });
      await mk({ status: T.IN_PROGRESS });
      const byId = await tasks.list(user.id, {
        workspaceId: ws.id,
        workflowStatusId: review.id,
        take: 50,
        skip: 0,
      } as never);
      expect(byId.data.map((d) => d.id)).toEqual([a.id]);
      expect(byId.data[0].workflowStatusId).toBe(review.id);
      const byCat = await tasks.list(user.id, {
        workspaceId: ws.id,
        status: T.IN_PROGRESS,
        take: 50,
        skip: 0,
      } as never);
      expect(byCat.total).toBe(2);
      const detail = await tasks.getDetail(a.id, user.id);
      expect(detail.workflowStatus).toMatchObject({
        id: review.id,
        name: 'Review',
        category: 'IN_PROGRESS',
      });
    });
  });

  // ------------------------------------------------------------------- bulk
  describe('bulk create', () => {
    it('resolves statuses per item, one snapshot per project; explicit ids honoured', async () => {
      const { user, ws, project, addStatus } = await world();
      await addStatus('Review', T.IN_PROGRESS);
      const review = await prisma.workflowStatus.findFirstOrThrow({
        where: { name: 'Review' },
      });
      const res = await writer.createTasksBulk(
        ws.id,
        [
          { title: 'a', projectId: project.id },
          { title: 'b', projectId: project.id, status: T.DONE },
          { title: 'c', projectId: project.id, workflowStatusId: review.id },
          { title: 'inbox', status: T.BLOCKED },
        ],
        user.id,
        { origin: 'IMPORT', actorId: user.id },
      );
      const rows = await prisma.task.findMany({
        where: { id: { in: res.createdIds } },
        include: { workflowStatus: true },
        orderBy: { number: 'asc' },
      });
      expect(
        rows.map((r) => [r.title, r.status, r.workflowStatus?.name ?? null]),
      ).toEqual([
        ['a', 'TODO', 'To Do'],
        ['b', 'DONE', 'Done'],
        ['c', 'IN_PROGRESS', 'Review'],
        ['inbox', 'BLOCKED', null],
      ]);
    });
  });

  // ------------------------------------------------------------- decision 6
  describe('moving between projects (decision 6)', () => {
    it('name match inside the category, else the category default; the subtree moves with it', async () => {
      const { mk, addStatus, ws, user } = await world();
      await addStatus('Review', T.IN_PROGRESS);
      const review = await prisma.workflowStatus.findFirstOrThrow({
        where: { name: 'Review' },
      });
      const target = await projects.create(
        { workspaceId: ws.id, name: 'Target' },
        user.id,
      );
      await addStatus('Review', T.IN_PROGRESS, {}, target.id);
      await addStatus('QA', T.IN_PROGRESS, {}, target.id);
      const tReview = await prisma.workflowStatus.findFirstOrThrow({
        where: { projectId: target.id, name: 'Review' },
      });
      const tProg = await prisma.workflowStatus.findFirstOrThrow({
        where: { projectId: target.id, name: 'In Progress' },
      });

      const root = await mk({ workflowStatusId: review.id });
      const child = await tasks.create(
        {
          workspaceId: ws.id,
          title: 'c',
          parentId: root.id,
          status: T.IN_PROGRESS,
        } as never,
        user.id,
      );
      await addStatus('Custom', T.IN_PROGRESS);
      const custom = await prisma.workflowStatus.findFirstOrThrow({
        where: { projectId: root.projectId!, name: 'Custom' },
      });
      await tasks.update(child.id, { workflowStatusId: custom.id }, user.id);

      await tasks.update(root.id, { projectId: target.id }, user.id);
      expect(await row(root.id)).toMatchObject({
        projectId: target.id,
        status: T.IN_PROGRESS,
        workflowStatusId: tReview.id,
      });
      // no "Custom" in the target: falls back to the In Progress default there
      expect(await row(child.id)).toMatchObject({
        projectId: target.id,
        status: T.IN_PROGRESS,
        workflowStatusId: tProg.id,
      });
      // a pure move is not a status change
      expect(await acts(root.id, 'STATUS_CHANGED')).toHaveLength(0);
    });

    it("a move into a project WITHOUT the task's category (no Blocked) is refused, nothing moves", async () => {
      const { mk, ws, user, addStatus } = await world();
      const target = await projects.create(
        { workspaceId: ws.id, name: 'NoBlocked' },
        user.id,
      );
      const blocked = await prisma.workflowStatus.findFirstOrThrow({
        where: { projectId: target.id, category: T.BLOCKED },
      });
      // allowed: Blocked is optional - delete it (no tasks use it)
      await workflow.deleteStatus(target.id, blocked.id, undefined, user.id);
      const t = await mk({ status: T.BLOCKED });
      await expect(
        tasks.update(t.id, { projectId: target.id }, user.id),
      ).rejects.toThrow(/no Blocked status/);
      expect((await row(t.id)).projectId).not.toBe(target.id);
      void addStatus;
    });
  });

  // ------------------------------------------------------------- decision 7
  describe('transitions (decision 7)', () => {
    async function enforcing() {
      const w = await world();
      const s = await w.statusByName();
      await workflow.setTransitions(
        w.project.id,
        {
          transitions: [
            { fromStatusId: s['To Do'].id, toStatusId: s['In Progress'].id },
          ],
        },
        w.user.id,
      );
      await workflow.updateSettings(
        w.project.id,
        { enforceTransitions: true },
        w.user.id,
      );
      return { ...w, s };
    }

    it('allowed pair passes; forbidden pair is a 409 TRANSITION_NOT_ALLOWED with the allowed ids; row unchanged', async () => {
      const { mk, user, s } = await enforcing();
      const t = await mk();
      await expect(
        tasks.update(t.id, { status: T.DONE }, user.id),
      ).rejects.toMatchObject({
        status: 409,
        response: {
          code: 'TRANSITION_NOT_ALLOWED',
          details: { allowedStatusIds: [s['In Progress'].id] },
        },
      });
      expect((await row(t.id)).workflowStatusId).toBe(s['To Do'].id);
      await tasks.update(t.id, { status: T.IN_PROGRESS }, user.id);
      expect((await row(t.id)).status).toBe(T.IN_PROGRESS);
    });

    it('create and project moves are never restricted', async () => {
      const { mk, ws, user } = await enforcing();
      const done = await mk({ status: T.DONE });
      expect(done.status).toBe(T.DONE);
      const target = await projects.create(
        { workspaceId: ws.id, name: 'T2' },
        user.id,
      );
      await tasks.update(done.id, { projectId: target.id }, user.id);
      expect((await row(done.id)).projectId).toBe(target.id);
    });

    it('enforcing with zero transitions is refused, and so is emptying the set while enforcing', async () => {
      const { project, user } = await world();
      await expect(
        workflow.updateSettings(
          project.id,
          { enforceTransitions: true },
          user.id,
        ),
      ).rejects.toThrow(/at least one transition/);
      const e = await enforcing();
      await expect(
        workflow.setTransitions(e.project.id, { transitions: [] }, e.user.id),
      ).rejects.toThrow(/freeze/);
    });

    it('transitions are validated: same project, no self-loops; duplicates collapse', async () => {
      const { project, user, ws, statusByName } = await world();
      const s = await statusByName();
      const other = await projects.create(
        { workspaceId: ws.id, name: 'O' },
        user.id,
      );
      const foreign = await prisma.workflowStatus.findFirstOrThrow({
        where: { projectId: other.id },
      });
      await expect(
        workflow.setTransitions(
          project.id,
          {
            transitions: [
              { fromStatusId: s['To Do'].id, toStatusId: foreign.id },
            ],
          },
          user.id,
        ),
      ).rejects.toThrow(/two statuses of this project/);
      await expect(
        workflow.setTransitions(
          project.id,
          {
            transitions: [
              { fromStatusId: s['To Do'].id, toStatusId: s['To Do'].id },
            ],
          },
          user.id,
        ),
      ).rejects.toThrow(/itself/);
      const pair = { fromStatusId: s['To Do'].id, toStatusId: s['Done'].id };
      const r = await workflow.setTransitions(
        project.id,
        { transitions: [pair, pair] },
        user.id,
      );
      expect(r.transitions).toHaveLength(1);
    });

    it('deleting a status removes its transitions', async () => {
      const { project, user, addStatus, statusByName } = await world();
      await addStatus('Review', T.IN_PROGRESS);
      const s = await statusByName();
      await workflow.setTransitions(
        project.id,
        {
          transitions: [
            { fromStatusId: s['To Do'].id, toStatusId: s['Review'].id },
          ],
        },
        user.id,
      );
      await workflow.deleteStatus(
        project.id,
        s['Review'].id,
        undefined,
        user.id,
      );
      expect(
        await prisma.workflowTransition.count({
          where: { projectId: project.id },
        }),
      ).toBe(0);
    });
  });

  // ---------------------------------------------------- decisions 4, 8, 9, 11
  describe('editing the workflow', () => {
    it('create: appended or inserted, renumbered, name unique case-insensitively, colour validated by DTO', async () => {
      const { project, user, addStatus } = await world();
      await addStatus('Review', T.IN_PROGRESS, { position: 1 });
      const w = await workflow.getWorkflow(project.id, user.id);
      expect(w.statuses.map((s) => [s.name, s.position])).toEqual([
        ['To Do', 0],
        ['Review', 1],
        ['In Progress', 2],
        ['Blocked', 3],
        ['Done', 4],
      ]);
      expect(w.statuses.find((s) => s.name === 'Review')!.isDefault).toBe(
        false,
      );
      await expect(addStatus('  review ', T.TODO)).rejects.toThrow(
        /already exists/,
      );
    });

    it('isDefault: true moves the category default; default of a category cannot be cleared directly', async () => {
      const { project, user, addStatus } = await world();
      await addStatus('Review', T.IN_PROGRESS, { isDefault: true });
      const w = await workflow.getWorkflow(project.id, user.id);
      expect(
        w.statuses
          .filter((s) => s.category === T.IN_PROGRESS && s.isDefault)
          .map((s) => s.name),
      ).toEqual(['Review']);
      await expect(
        workflow.updateStatus(
          project.id,
          w.statuses[0].id,
          { isDefault: false },
          user.id,
        ),
      ).rejects.toThrow(/ANOTHER status/);
      // and a legacy PATCH now lands on Review
      const t = await tasks.create(
        {
          workspaceId: (
            await prisma.project.findUniqueOrThrow({
              where: { id: project.id },
            })
          ).workspaceId,
          title: 'x',
          projectId: project.id,
        } as never,
        user.id,
      );
      await tasks.update(t.id, { status: T.IN_PROGRESS }, user.id);
      expect(
        (
          await prisma.workflowStatus.findUniqueOrThrow({
            where: { id: (await row(t.id)).workflowStatusId! },
          })
        ).name,
      ).toBe('Review');
    });

    it('category change (decision 9): tasks follow, defaults re-elected, ONE project-level activity, no per-task rows', async () => {
      const { project, user, addStatus, mk } = await world();
      await addStatus('Review', T.IN_PROGRESS);
      const review = await prisma.workflowStatus.findFirstOrThrow({
        where: { name: 'Review' },
      });
      const a = await mk({ workflowStatusId: review.id });
      const b = await mk({ workflowStatusId: review.id });
      await workflow.updateStatus(
        project.id,
        review.id,
        { category: T.BLOCKED },
        user.id,
      );
      expect((await row(a.id)).status).toBe(T.BLOCKED);
      expect((await row(b.id)).status).toBe(T.BLOCKED);
      expect(await acts(a.id, 'STATUS_CHANGED')).toHaveLength(0);
      const wf = await prisma.activity.findMany({
        where: { targetId: project.id, action: 'WORKFLOW_CHANGED' as never },
      });
      const upd = wf.find(
        (x) =>
          (x.metadata as { op?: string })?.op === 'status_updated' &&
          (x.metadata as { tasksAffected?: number }).tasksAffected === 2,
      );
      expect(upd?.metadata).toMatchObject({
        from: 'IN_PROGRESS',
        to: 'BLOCKED',
        tasksAffected: 2,
      });
      // the old Blocked default keeps its flag; Review (moved in) must not steal it
      const blocked = await prisma.workflowStatus.findMany({
        where: { projectId: project.id, category: T.BLOCKED },
      });
      expect(blocked.filter((s) => s.isDefault)).toHaveLength(1);
      expect(blocked.find((s) => s.isDefault)!.name).toBe('Blocked');
    });

    it('category change that would empty a required category is refused and changes nothing', async () => {
      const { project, user, mk } = await world();
      const prog = await prisma.workflowStatus.findFirstOrThrow({
        where: { projectId: project.id, name: 'In Progress' },
      });
      const t = await mk({ workflowStatusId: prog.id });
      await expect(
        workflow.updateStatus(
          project.id,
          prog.id,
          { category: T.BLOCKED },
          user.id,
        ),
      ).rejects.toThrow(/at least one In Progress/);
      expect((await row(t.id)).status).toBe(T.IN_PROGRESS);
    });

    it('the initial status cannot leave TODO; another TODO status can be made initial first', async () => {
      const { project, user, addStatus } = await world();
      const todo = await prisma.workflowStatus.findFirstOrThrow({
        where: { projectId: project.id, name: 'To Do' },
      });
      await expect(
        workflow.updateStatus(
          project.id,
          todo.id,
          { category: T.DONE },
          user.id,
        ),
      ).rejects.toThrow();
      await addStatus('Backlog', T.TODO);
      const backlog = await prisma.workflowStatus.findFirstOrThrow({
        where: { name: 'Backlog' },
      });
      await expect(
        workflow.updateSettings(
          project.id,
          {
            defaultStatusId: (
              await prisma.workflowStatus.findFirstOrThrow({
                where: { projectId: project.id, name: 'Done' },
              })
            ).id,
          },
          user.id,
        ),
      ).rejects.toThrow(/To Do category/);
      await workflow.updateSettings(
        project.id,
        { defaultStatusId: backlog.id },
        user.id,
      );
      const t = await tasks.create(
        {
          workspaceId: (
            await prisma.project.findUniqueOrThrow({
              where: { id: project.id },
            })
          ).workspaceId,
          title: 'n',
          projectId: project.id,
        } as never,
        user.id,
      );
      expect(t.workflowStatusId).toBe(backlog.id);
      // now To Do may go
      await workflow.deleteStatus(project.id, todo.id, undefined, user.id);
    });

    it('delete (decision 8): needs reassignTo when used, may cross categories, recomputes, archived tasks included', async () => {
      const { project, user, addStatus, mk, statusByName } = await world();
      await addStatus('Review', T.IN_PROGRESS);
      const review = await prisma.workflowStatus.findFirstOrThrow({
        where: { name: 'Review' },
      });
      const a = await mk({ workflowStatusId: review.id });
      const arch = await mk({ workflowStatusId: review.id });
      await tasks.archive(arch.id, user.id);
      await expect(
        workflow.deleteStatus(project.id, review.id, undefined, user.id),
      ).rejects.toMatchObject({
        response: { code: 'REASSIGN_REQUIRED', details: { taskCount: 2 } },
      });
      await expect(
        workflow.deleteStatus(project.id, review.id, review.id, user.id),
      ).rejects.toThrow(/different status/);
      const done = (await statusByName())['Done'];
      await workflow.deleteStatus(project.id, review.id, done.id, user.id);
      expect(await row(a.id)).toMatchObject({
        status: T.DONE,
        workflowStatusId: done.id,
      });
      expect(await row(arch.id)).toMatchObject({
        status: T.DONE,
        workflowStatusId: done.id,
      });
      expect(
        await prisma.workflowStatus.findUnique({ where: { id: review.id } }),
      ).toBeNull();
    });

    it('delete refuses to empty a required category; deleting a category default promotes the next', async () => {
      const { project, user, addStatus, statusByName } = await world();
      const s = await statusByName();
      await expect(
        workflow.deleteStatus(project.id, s['Done'].id, undefined, user.id),
      ).rejects.toThrow(/at least one Done/);
      await addStatus('Shipped', T.DONE);
      await workflow.deleteStatus(project.id, s['Done'].id, undefined, user.id);
      const shipped = await prisma.workflowStatus.findFirstOrThrow({
        where: { name: 'Shipped' },
      });
      expect(shipped.isDefault).toBe(true);
    });

    it('BLOCKED is optional: deleting it is fine, and a legacy PATCH BLOCKED then 409s instead of inventing one', async () => {
      const { project, user, mk, statusByName } = await world();
      await workflow.deleteStatus(
        project.id,
        (await statusByName())['Blocked'].id,
        undefined,
        user.id,
      );
      const t = await mk();
      await expect(
        tasks.update(t.id, { status: T.BLOCKED }, user.id),
      ).rejects.toMatchObject({ response: { code: 'CATEGORY_HAS_NO_STATUS' } });
      expect((await row(t.id)).status).toBe(T.TODO);
    });

    it('cap: a project holds at most 30 statuses', async () => {
      const { project, addStatus } = await world();
      for (let i = 0; i < 26; i++) await addStatus(`S${i}`, T.TODO);
      await expect(addStatus('one too many', T.TODO)).rejects.toThrow(
        /at most 30/,
      );
      expect(
        await prisma.workflowStatus.count({ where: { projectId: project.id } }),
      ).toBe(30);
    });

    it('reorder: must list every status exactly once; positions renumbered; defaults unaffected', async () => {
      const { project, user, addStatus } = await world();
      await addStatus('Review', T.IN_PROGRESS);
      const w = await workflow.getWorkflow(project.id, user.id);
      const ids = w.statuses.map((s) => s.id).reverse();
      await expect(
        workflow.reorder(project.id, ids.slice(1), user.id),
      ).rejects.toThrow(/exactly once/);
      const r = await workflow.reorder(project.id, ids, user.id);
      expect(r.statuses.map((s) => s.id)).toEqual(ids);
      expect(r.statuses.map((s) => s.position)).toEqual([0, 1, 2, 3, 4]);
    });

    it('excludeFromProgress is refused outside the Done category (DB CHECK too)', async () => {
      const { project, addStatus } = await world();
      await expect(
        addStatus('Odd', T.TODO, { excludeFromProgress: true }),
      ).rejects.toThrow(/Done category/);
      await expect(
        prisma.workflowStatus.create({
          data: {
            projectId: project.id,
            name: 'x',
            nameKey: 'x',
            position: 9,
            category: T.TODO,
            excludeFromProgress: true,
          },
        }),
      ).rejects.toThrow();
    });

    it('the partial unique index refuses a second default in one category', async () => {
      const { project } = await world();
      await expect(
        prisma.workflowStatus.create({
          data: {
            projectId: project.id,
            name: 'dup',
            nameKey: 'dup',
            position: 9,
            category: T.TODO,
            isDefault: true,
          },
        }),
      ).rejects.toThrow();
    });

    it('writes are audited as WORKFLOW_CHANGED on the project', async () => {
      const { project, user, addStatus } = await world();
      await addStatus('Review', T.IN_PROGRESS);
      const wf = await prisma.activity.findMany({
        where: { targetId: project.id, action: 'WORKFLOW_CHANGED' as never },
      });
      expect(wf).toHaveLength(1);
      expect(wf[0]).toMatchObject({ targetType: 'PROJECT', actorId: user.id });
    });
  });

  // ------------------------------------------------------------ decision 10
  describe('progress with excluded statuses (decision 10)', () => {
    it('Canceled leaves both numerator and denominator; counts still show real tasks', async () => {
      const { project, user, addStatus, mk, ws } = await world();
      await addStatus('Canceled', T.DONE, { excludeFromProgress: true });
      const canceled = await prisma.workflowStatus.findFirstOrThrow({
        where: { name: 'Canceled' },
      });
      await mk({ status: T.DONE });
      await mk();
      await mk({ workflowStatusId: canceled.id });
      expect(await projects.computeProgress(project.id)).toBe(50); // 1 of 2, not 2 of 3
      const stats = await projects.getStats(project.id, user.id);
      expect(stats.counts.DONE).toBe(2); // the canceled task is still a DONE task
      void ws;
    });

    it('a parent whose subtasks are all Canceled counts as itself; an excluded parent with live children drops out', async () => {
      const { project, user, addStatus, mk, ws } = await world();
      await addStatus('Canceled', T.DONE, { excludeFromProgress: true });
      const canceled = await prisma.workflowStatus.findFirstOrThrow({
        where: { name: 'Canceled' },
      });
      const p = await mk(); // TODO
      await tasks.create(
        {
          workspaceId: ws.id,
          title: 'c',
          parentId: p.id,
          workflowStatusId: canceled.id,
        } as never,
        user.id,
      );
      expect(await projects.computeProgress(project.id)).toBe(0); // p is the only counted leaf, TODO
      await tasks.update(p.id, { status: T.DONE }, user.id);
      expect(await projects.computeProgress(project.id)).toBe(100);

      const q = await mk({ workflowStatusId: canceled.id }); // excluded parent
      await tasks.create(
        {
          workspaceId: ws.id,
          title: 'live1',
          parentId: q.id,
          status: T.DONE,
        } as never,
        user.id,
      );
      await tasks.create(
        { workspaceId: ws.id, title: 'live2', parentId: q.id } as never,
        user.id,
      );
      // counted leaves: p (DONE), live1 (DONE), live2 (TODO) -> 2 of 3
      expect(await projects.computeProgress(project.id)).toBe(67);
      const detail = await tasks.getDetail(p.id, user.id);
      expect(detail.subtaskProgress).toBeNull(); // its only subtask is excluded
    });

    it('a task with no status row (unmapped) still counts', async () => {
      const { project, ws, user } = await world();
      await prisma.task.create({
        data: {
          workspaceId: ws.id,
          projectId: project.id,
          createdById: user.id,
          number: 999,
          title: 'legacy',
          status: T.DONE,
        },
      });
      expect(await projects.computeProgress(project.id)).toBe(100);
      // heals on the next write: reading and writing tolerate the null
      await prisma.task.updateMany({
        where: { number: 999 },
        data: { status: T.DONE },
      });
      const legacy = await prisma.task.findFirstOrThrow({
        where: { number: 999 },
      });
      await tasks.update(legacy.id, { status: T.DONE }, user.id);
      expect((await row(legacy.id)).workflowStatusId).not.toBeNull();
      expect(await acts(legacy.id, 'STATUS_CHANGED')).toHaveLength(0);
    });
  });

  // ------------------------------------------------------------ project delete
  describe('deleting a project', () => {
    it('is not blocked by statuses: tasks fall back to the Inbox with no specific status', async () => {
      const { project, mk, user } = await world();
      const t = await mk({ status: T.DONE });
      await projects.delete(project.id);
      expect(await row(t.id)).toMatchObject({
        projectId: null,
        workflowStatusId: null,
        status: T.DONE,
      });
      expect(await prisma.workflowStatus.count()).toBe(0);
      void user;
    });
  });

  // -------------------------------------------------------------- concurrency
  describe('concurrency', () => {
    it('status writes racing a status delete never leave a task on a missing or foreign status', async () => {
      const { project, user, addStatus, mk, statusByName } = await world();
      await addStatus('Review', T.IN_PROGRESS);
      const review = await prisma.workflowStatus.findFirstOrThrow({
        where: { name: 'Review' },
      });
      const prog = (await statusByName())['In Progress'];
      const ts = await Promise.all(
        Array.from({ length: 12 }, () => mk({ workflowStatusId: review.id })),
      );
      const settled = await Promise.allSettled([
        workflow.deleteStatus(project.id, review.id, prog.id, user.id),
        ...ts.map((t, i) =>
          i % 2
            ? tasks.update(t.id, { workflowStatusId: review.id }, user.id)
            : tasks.update(t.id, { status: T.DONE }, user.id),
        ),
        mk({ workflowStatusId: review.id }),
      ]);
      for (const s of settled) {
        if (s.status === 'rejected') {
          // only clean 4xx outcomes: never a deadlock (40P01) or a 500
          expect(String(s.reason?.status ?? s.reason?.getStatus?.())).toMatch(
            /^4/,
          );
        }
      }
      // invariant is asserted by afterEach over the whole database
      expect(
        await prisma.workflowStatus.findUnique({ where: { id: review.id } }),
      ).toBeNull();
    });

    it('two status creates racing for the same name: one wins, the other is a clean 409', async () => {
      const { project, user } = await world();
      const r = await Promise.allSettled([
        workflow.createStatus(
          project.id,
          { name: 'Same', category: T.TODO } as never,
          user.id,
        ),
        workflow.createStatus(
          project.id,
          { name: 'same', category: T.TODO } as never,
          user.id,
        ),
      ]);
      expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
      const bad = r.find(
        (x) => x.status === 'rejected',
      ) as PromiseRejectedResult;
      expect(bad.reason.getStatus()).toBe(409);
    });
  });

  // ------------------------------------------------------------------ read
  describe('GET workflow', () => {
    it('returns statuses with task counts, settings and transitions; unknown project is 404', async () => {
      const { project, user, mk } = await world();
      await mk();
      await mk({ status: T.DONE });
      const w = await workflow.getWorkflow(project.id, user.id);
      expect(w.statuses.map((s) => [s.name, s.taskCount])).toEqual([
        ['To Do', 1],
        ['In Progress', 0],
        ['Blocked', 0],
        ['Done', 1],
      ]);
      expect(w.enforceTransitions).toBe(false);
      await expect(workflow.getWorkflow('missing', user.id)).rejects.toThrow(
        /not found/i,
      );
    });
  });
});
