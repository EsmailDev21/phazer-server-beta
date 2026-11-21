/**
 * Step 1.5 (ADR-0007) on a real database: issue types and iterations.
 */
import { Test } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AccountType, IterationKind, IterationState, TaskStatus } from '@prisma/client';
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
import { TaskPlanningService } from '../../src/projects-tasks/planning/task-planning.service';
import { IssueTypesService } from '../../src/projects-tasks/issue-types/issue-types.service';
import { IterationsService } from '../../src/projects-tasks/iterations/iterations.service';
import { CustomFieldsService } from '../../src/projects-tasks/custom-fields/custom-fields.service';
import { WorkspacesService } from '../../src/tenancy/workspaces/workspaces.service';
import { WorkspaceKeysService } from '../../src/tenancy/workspaces/workspace-keys.service';
import { getTestPrisma, disconnectTestPrisma } from './support/prisma-test-client';
import { resetDb } from './support/reset-db';
import { createUserWithAccount, createWorkspace } from './factories';

const T = TaskStatus;

describe('issue types and iterations (real database)', () => {
  let prisma: PrismaService;
  let tasks: TasksService;
  let projects: ProjectsService;
  let types: IssueTypesService;
  let iters: IterationsService;
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
        IssueTypesService,
        IterationsService,
        ProjectsService,
        CustomFieldsService,
        WorkspaceKeysService,
        WorkspacesService,
        DomainWriter,
      ],
    }).compile();
    tasks = moduleRef.get(TasksService);
    projects = moduleRef.get(ProjectsService);
    types = moduleRef.get(IssueTypesService);
    iters = moduleRef.get(IterationsService);
    writer = moduleRef.get(DomainWriter);
  });
  beforeEach(() => resetDb(prisma));
  afterAll(() => disconnectTestPrisma());

  async function world() {
    const { user, account } = await createUserWithAccount(prisma, {
      accountType: AccountType.ORGANIZATION,
    });
    const ws = await createWorkspace(prisma, { accountId: account.id });
    const project = await projects.create({ workspaceId: ws.id, name: 'P' }, user.id);
    const mk = (over: Record<string, unknown> = {}) =>
      tasks.create({ workspaceId: ws.id, title: 't', projectId: project.id, ...over } as never, user.id);
    const sprint = (over: Record<string, unknown> = {}) =>
      iters.create(ws.id, { kind: IterationKind.SPRINT, name: 'S1', ...over } as never);
    return { user, account, ws, project, mk, sprint };
  }
  const row = (id: string) => prisma.task.findUniqueOrThrow({ where: { id } });
  const acts = (id: string, action: string) =>
    prisma.activity.findMany({ where: { targetId: id, action: action as never } });
  const clientError = (e: any) => String(e?.status ?? e?.getStatus?.() ?? '');

  // --------------------------------------------------------------- issue types
  describe('issue types', () => {
    it('create / list with task counts / update / delete; names unique ignoring case; other workspace is 404', async () => {
      const { ws, user, mk } = await world();
      const bug = await types.create(ws.id, { name: '  Bug ', color: '#EF4444', level: 'STANDARD' } as never);
      expect(bug).toMatchObject({ name: 'Bug', color: '#EF4444', level: 'STANDARD', icon: null });
      await expect(types.create(ws.id, { name: 'bUG' } as never)).rejects.toThrow(/already exists/);
      await mk({ issueTypeId: bug.id });
      expect((await types.list(ws.id, user.id))[0]).toMatchObject({ name: 'Bug', taskCount: 1 });

      const upd = await types.update(ws.id, bug.id, { name: 'Defect', icon: '🐞', level: 'SUBTASK' } as never);
      expect(upd).toMatchObject({ name: 'Defect', icon: '🐞', level: 'SUBTASK' });
      expect((await types.update(ws.id, bug.id, { icon: null } as never)).icon).toBeNull();

      const { ws: otherWs } = await world();
      await expect(types.update(otherWs.id, bug.id, { name: 'x' } as never)).rejects.toThrow(/not found/i);
      await expect(types.delete(otherWs.id, bug.id)).rejects.toThrow(/not found/i);
    });

    it('caps a workspace at 50 issue types', async () => {
      const { ws } = await world();
      for (let i = 0; i < 50; i++) await types.create(ws.id, { name: `T${i}` } as never);
      await expect(types.create(ws.id, { name: 'one more' } as never)).rejects.toThrow(/at most 50/);
    });

    it('deleting a type leaves its tasks untyped, nothing else changes', async () => {
      const { ws, mk } = await world();
      const bug = await types.create(ws.id, { name: 'Bug' } as never);
      const t = await mk({ issueTypeId: bug.id, status: T.DONE });
      await types.delete(ws.id, bug.id);
      expect(await row(t.id)).toMatchObject({ issueTypeId: null, status: T.DONE });
    });

    it('a task takes a type of ITS workspace only; set, change and clear are recorded', async () => {
      const { ws, user, mk } = await world();
      const bug = await types.create(ws.id, { name: 'Bug' } as never);
      const feat = await types.create(ws.id, { name: 'Feature' } as never);
      const { ws: other } = await world();
      const foreign = await types.create(other.id, { name: 'Alien' } as never);
      await expect(mk({ issueTypeId: foreign.id })).rejects.toThrow(/does not belong/);

      const t = await mk();
      await expect(tasks.update(t.id, { issueTypeId: foreign.id }, user.id)).rejects.toThrow(/does not belong/);
      await tasks.update(t.id, { issueTypeId: bug.id }, user.id);
      await tasks.update(t.id, { issueTypeId: bug.id }, user.id); // same again: no new row
      await tasks.update(t.id, { issueTypeId: feat.id }, user.id);
      await tasks.update(t.id, { issueTypeId: null }, user.id);
      const a = await acts(t.id, 'ISSUE_TYPE_CHANGED');
      expect(a.map((x) => x.metadata)).toEqual(
        expect.arrayContaining([
          { from: null, to: bug.id },
          { from: bug.id, to: feat.id },
          { from: feat.id, to: null },
        ]),
      );
      expect(a).toHaveLength(3);
      expect((await row(t.id)).issueTypeId).toBeNull();
    });

    it('the level is only a label: any type goes on any task, root or subtask', async () => {
      const { ws, user, mk } = await world();
      const epic = await types.create(ws.id, { name: 'Epic', level: 'EPIC' } as never);
      const root = await mk();
      const child = await tasks.create({ workspaceId: ws.id, title: 'c', parentId: root.id, issueTypeId: epic.id } as never, user.id);
      expect(child.issueTypeId).toBe(epic.id);
    });
  });

  // ---------------------------------------------------------------- iterations
  describe('iterations: create, state, edit, delete', () => {
    it('create validates dates and project; scope is fixed; state starts PLANNED', async () => {
      const { ws, project, sprint } = await world();
      const it = await sprint({ startDate: '2026-03-01', endDate: '2026-03-14', goal: 'ship', projectId: project.id });
      expect(it).toMatchObject({ state: 'PLANNED', startDate: '2026-03-01', endDate: '2026-03-14', projectId: project.id, taskCount: 0 });
      await expect(sprint({ startDate: '2026-03-14', endDate: '2026-03-01' })).rejects.toThrow(/before/);
      await expect(sprint({ startDate: '2026-02-30' })).rejects.toThrow(/real calendar date/);
      const { project: foreignProject } = await world();
      await expect(sprint({ projectId: foreignProject.id })).rejects.toThrow(/does not belong/);
      await expect(
        iters.update(ws.id, it.id, { projectId: 'x' } as never),
      ).resolves.toBeDefined(); // unknown keys are stripped by the DTO pipe, never applied
      expect((await prisma.iteration.findUniqueOrThrow({ where: { id: it.id } })).projectId).toBe(project.id);
    });

    it('a milestone may have only a target date; dates can be cleared with null', async () => {
      const { ws } = await world();
      const m = await iters.create(ws.id, { kind: 'MILESTONE', name: 'Beta', endDate: '2026-06-01' } as never);
      expect(m).toMatchObject({ startDate: null, endDate: '2026-06-01' });
      const cleared = await iters.update(ws.id, m.id, { endDate: null } as never);
      expect(cleared.endDate).toBeNull();
    });

    it('start: PLANNED -> ACTIVE; illegal moves are 409; several can be active at once', async () => {
      const { ws, sprint } = await world();
      const a = await sprint({ name: 'A' });
      const b = await sprint({ name: 'B' });
      expect((await iters.start(ws.id, a.id)).state).toBe('ACTIVE');
      expect((await iters.start(ws.id, b.id)).state).toBe('ACTIVE');
      await expect(iters.start(ws.id, a.id)).rejects.toThrow(/cannot go from/);
      await expect(iters.reopen(ws.id, b.id)).rejects.toThrow(/cannot go from/);
    });

    it('delete: PLANNED/ACTIVE ok (tasks go back to the backlog); CLOSED must be reopened first', async () => {
      const { ws, mk, sprint } = await world();
      const it = await sprint();
      const t = await mk({ iterationId: it.id });
      await iters.delete(ws.id, it.id);
      expect((await row(t.id)).iterationId).toBeNull();

      const closed = await sprint({ name: 'old' });
      await iters.close(ws.id, closed.id, {});
      await expect(iters.delete(ws.id, closed.id)).rejects.toMatchObject({ response: { code: 'ITERATION_CLOSED' } });
    });

    it('caps a workspace at 1000 iterations', async () => {
      const { ws, sprint } = await world();
      await prisma.iteration.createMany({
        data: Array.from({ length: 1000 }, (_, i) => ({ id: `bulk${i}`, workspaceId: ws.id, kind: 'SPRINT' as const, name: `n${i}` })),
      });
      await expect(sprint()).rejects.toThrow(/at most 1000/);
    });
  });

  // ------------------------------------------------------------- assignment
  describe('assigning tasks', () => {
    it('workspace-wide iteration takes tasks of any project and the Inbox; a project-scoped one only its own', async () => {
      const { ws, user, project, mk, sprint } = await world();
      const other = await projects.create({ workspaceId: ws.id, name: 'Other' }, user.id);
      const wide = await sprint({ name: 'wide' });
      const scoped = await sprint({ name: 'scoped', projectId: project.id });
      const inbox = await tasks.create({ workspaceId: ws.id, title: 'i' } as never, user.id);
      const otherTask = await tasks.create({ workspaceId: ws.id, title: 'o', projectId: other.id } as never, user.id);

      await tasks.update(inbox.id, { iterationId: wide.id }, user.id);
      await tasks.update(otherTask.id, { iterationId: wide.id }, user.id);
      await expect(tasks.update(otherTask.id, { iterationId: scoped.id }, user.id)).rejects.toThrow(/another project/);
      await expect(tasks.update(inbox.id, { iterationId: scoped.id }, user.id)).rejects.toThrow(/another project/);
      await expect(mk({ iterationId: scoped.id, projectId: other.id })).rejects.toThrow(/another project/);
      const ok = await mk({ iterationId: scoped.id });
      expect(ok.iterationId).toBe(scoped.id);
    });

    it('an iteration of another workspace is a 400', async () => {
      const { mk } = await world();
      const { ws: other, sprint: _s } = await world();
      const foreign = await iters.create(other.id, { kind: 'SPRINT', name: 'x' } as never);
      await expect(mk({ iterationId: foreign.id })).rejects.toThrow(/does not belong/);
    });

    it('moves are recorded ITERATION_CHANGED; re-sending the same id writes nothing; null = backlog', async () => {
      const { user, mk, sprint } = await world();
      const a = await sprint({ name: 'A' });
      const b = await sprint({ name: 'B' });
      const t = await mk();
      await tasks.update(t.id, { iterationId: a.id }, user.id);
      await tasks.update(t.id, { iterationId: a.id }, user.id);
      await tasks.update(t.id, { iterationId: b.id }, user.id);
      await tasks.update(t.id, { iterationId: null }, user.id);
      const rows = await acts(t.id, 'ITERATION_CHANGED');
      expect(rows).toHaveLength(3);
      expect(rows.map((r) => r.metadata)).toEqual(
        expect.arrayContaining([{ from: null, to: a.id }, { from: a.id, to: b.id }, { from: b.id, to: null }]),
      );
    });

    it('a closed iteration takes no new tasks (409); leaving a task there is fine, and so is moving out', async () => {
      const { ws, user, mk, sprint } = await world();
      const a = await sprint({ name: 'A' });
      const b = await sprint({ name: 'B' });
      const stay = await mk({ iterationId: a.id, status: T.DONE });
      await iters.close(ws.id, a.id, {});
      await expect(mk({ iterationId: a.id })).rejects.toMatchObject({ response: { code: 'ITERATION_CLOSED' } });
      const t = await mk();
      await expect(tasks.update(t.id, { iterationId: a.id }, user.id)).rejects.toMatchObject({ response: { code: 'ITERATION_CLOSED' } });
      // re-sending the task's own (closed) iteration is not an error, and moving out is allowed
      await tasks.update(stay.id, { iterationId: a.id, title: 'edited' }, user.id);
      await tasks.update(stay.id, { iterationId: b.id }, user.id);
      expect((await row(stay.id)).iterationId).toBe(b.id);
    });

    it('a project move clears an iteration of the old project; workspace-wide ones stay; one count in TASK_MOVED', async () => {
      const { ws, user, project, mk, sprint } = await world();
      const target = await projects.create({ workspaceId: ws.id, name: 'T' }, user.id);
      const scoped = await sprint({ name: 'scoped', projectId: project.id });
      const wide = await sprint({ name: 'wide' });
      const a = await mk({ iterationId: scoped.id });
      const child = await tasks.create({ workspaceId: ws.id, title: 'c', parentId: a.id, iterationId: scoped.id } as never, user.id);
      const b = await mk({ iterationId: wide.id });
      await tasks.update(a.id, { projectId: target.id }, user.id);
      await tasks.update(b.id, { projectId: target.id }, user.id);
      expect((await row(a.id)).iterationId).toBeNull();
      expect((await row(child.id)).iterationId).toBeNull();
      expect((await row(b.id)).iterationId).toBe(wide.id);
      const moved = await acts(a.id, 'TASK_MOVED');
      expect(moved[0].metadata).toMatchObject({ iterationsCleared: 2 });
      expect((await acts(b.id, 'TASK_MOVED'))[0].metadata).not.toHaveProperty('iterationsCleared');
    });

    it('a move together with a new iteration validates against the NEW project', async () => {
      const { ws, user, project, mk, sprint } = await world();
      const target = await projects.create({ workspaceId: ws.id, name: 'T' }, user.id);
      const inTarget = await sprint({ projectId: target.id });
      const t = await mk();
      await tasks.update(t.id, { projectId: target.id, iterationId: inTarget.id }, user.id);
      expect(await row(t.id)).toMatchObject({ projectId: target.id, iterationId: inTarget.id });
      void project;
    });

    it('subtasks are planned independently of their parent', async () => {
      const { ws, user, mk, sprint } = await world();
      const s = await sprint();
      const parent = await mk({ iterationId: s.id });
      const child = await tasks.create({ workspaceId: ws.id, title: 'c', parentId: parent.id } as never, user.id);
      expect(child.iterationId).toBeNull();
    });

    it('deleting a project removes its own iterations; tasks fall back to the Inbox without one', async () => {
      const { project, mk, sprint, ws } = await world();
      const scoped = await sprint({ projectId: project.id });
      const t = await mk({ iterationId: scoped.id });
      await projects.delete(project.id);
      expect(await row(t.id)).toMatchObject({ projectId: null, iterationId: null });
      expect(await prisma.iteration.count({ where: { id: scoped.id } })).toBe(0);
      void ws;
    });

    it('bulk create: types/iterations validated once per distinct id; IMPORT may replay a closed iteration, MANUAL cannot', async () => {
      const { ws, user, project, sprint } = await world();
      const bug = await types.create(ws.id, { name: 'Bug' } as never);
      const closed = await sprint({ name: 'closed' });
      await iters.close(ws.id, closed.id, {});
      const open = await sprint({ name: 'open' });

      const imp = await writer.createTasksBulk(
        ws.id,
        [
          { title: 'a', projectId: project.id, issueTypeId: bug.id, iterationId: closed.id },
          { title: 'b', projectId: project.id, iterationId: open.id },
        ],
        user.id,
        { origin: 'IMPORT', actorId: user.id },
      );
      const rows = await prisma.task.findMany({ where: { id: { in: imp.createdIds } }, orderBy: { number: 'asc' } });
      expect(rows.map((r) => [r.title, r.issueTypeId === bug.id, r.iterationId === closed.id ? 'closed' : r.iterationId === open.id ? 'open' : null])).toEqual([
        ['a', true, 'closed'],
        ['b', false, 'open'],
      ]);
      await expect(
        writer.createTasksBulk(ws.id, [{ title: 'c', projectId: project.id, iterationId: closed.id }], user.id, { origin: 'INTEGRATION', actorId: user.id }),
      ).rejects.toThrow(/closed: reopen it or pick another one/); // BulkWriteError carries the cause's message
      await expect(
        writer.createTasksBulk(ws.id, [{ title: 'd', projectId: project.id, issueTypeId: 'nope' }], user.id, { origin: 'IMPORT', actorId: user.id }),
      ).rejects.toThrow(/does not belong/);
    });
  });

  // ------------------------------------------------------------------ closing
  describe('closing and reopening (decision 1: asked each time)', () => {
    async function sprintWithWork() {
      const w = await world();
      const it = await w.sprint({ name: 'S1' });
      await iters.start(w.ws.id, it.id);
      const done = await w.mk({ iterationId: it.id, status: T.DONE });
      const doing = await w.mk({ iterationId: it.id, status: T.IN_PROGRESS });
      const todo = await w.mk({ iterationId: it.id });
      const archived = await w.mk({ iterationId: it.id });
      await tasks.archive(archived.id, w.user.id);
      return { ...w, it, done, doing, todo, archived };
    }

    it('unfinished tasks and no choice: 409 with the count, and NOTHING changes', async () => {
      const { ws, it, doing } = await sprintWithWork();
      await expect(iters.close(ws.id, it.id, {})).rejects.toMatchObject({
        status: 409,
        response: { code: 'UNFINISHED_TASKS_DECISION_REQUIRED', details: { unfinishedCount: 2 } },
      });
      expect((await prisma.iteration.findUniqueOrThrow({ where: { id: it.id } })).state).toBe(IterationState.ACTIVE);
      expect((await row(doing.id)).iterationId).toBe(it.id);
    });

    it('LEAVE: everything stays; summary recorded', async () => {
      const { ws, it, doing, todo, done } = await sprintWithWork();
      const closed = await iters.close(ws.id, it.id, { action: 'LEAVE' });
      expect(closed).toMatchObject({ state: 'CLOSED' });
      expect(closed.closedAt).toBeInstanceOf(Date);
      expect(closed.closeSummary).toMatchObject({ unfinished: 2, action: 'LEAVE', movedToId: null, completed: 1 });
      for (const t of [doing, todo, done]) expect((await row(t.id)).iterationId).toBe(it.id);
    });

    it('BACKLOG: unfinished go to no iteration; Done and archived stay', async () => {
      const { ws, it, doing, todo, done, archived } = await sprintWithWork();
      await iters.close(ws.id, it.id, { action: 'BACKLOG' });
      expect((await row(doing.id)).iterationId).toBeNull();
      expect((await row(todo.id)).iterationId).toBeNull();
      expect((await row(done.id)).iterationId).toBe(it.id);
      expect((await row(archived.id)).iterationId).toBe(it.id);
      // no per-task rows for the bulk effect
      expect(await acts(doing.id, 'ITERATION_CHANGED')).toHaveLength(0);
    });

    it('MOVE: unfinished go to the target; checks on the target', async () => {
      const { ws, it, doing, todo, done, sprint, project, user } = await sprintWithWork();
      const next = await sprint({ name: 'S2' });
      const closed = await iters.close(ws.id, it.id, { action: 'MOVE', moveToIterationId: next.id });
      expect(closed.closeSummary).toMatchObject({ action: 'MOVE', movedToId: next.id, unfinished: 2 });
      expect((await row(doing.id)).iterationId).toBe(next.id);
      expect((await row(todo.id)).iterationId).toBe(next.id);
      expect((await row(done.id)).iterationId).toBe(it.id);
      void project; void user;
    });

    it('MOVE refuses: a closed target, a foreign target, a project-scoped target that does not fit', async () => {
      const { ws, it, sprint, project } = await sprintWithWork();
      const closedTarget = await sprint({ name: 'old' });
      await iters.close(ws.id, closedTarget.id, {});
      await expect(iters.close(ws.id, it.id, { action: 'MOVE', moveToIterationId: closedTarget.id })).rejects.toThrow(/closed iteration/);

      const { ws: other } = await world();
      const foreign = await iters.create(other.id, { kind: 'SPRINT', name: 'x' } as never);
      await expect(iters.close(ws.id, it.id, { action: 'MOVE', moveToIterationId: foreign.id })).rejects.toThrow(/does not belong/);

      const otherProject = await projects.create({ workspaceId: ws.id, name: 'Elsewhere' }, (await prisma.user.findFirstOrThrow()).id);
      const wrongScope = await sprint({ name: 'wrong', projectId: otherProject.id });
      await expect(iters.close(ws.id, it.id, { action: 'MOVE', moveToIterationId: wrongScope.id })).rejects.toThrow(/not in the project/);
      expect((await prisma.iteration.findUniqueOrThrow({ where: { id: it.id } })).state).toBe(IterationState.ACTIVE);
      void project;
    });

    it('closing with only Done / Canceled tasks needs no decision', async () => {
      const { ws, mk, sprint } = await world();
      const it = await sprint();
      await mk({ iterationId: it.id, status: T.DONE });
      const closed = await iters.close(ws.id, it.id, {});
      expect(closed.closeSummary).toMatchObject({ unfinished: 0, action: null, movedToId: null, completed: 1 });
    });

    it('a PLANNED iteration can be closed directly (skipped)', async () => {
      const { ws, sprint } = await world();
      const it = await sprint();
      expect((await iters.close(ws.id, it.id, {})).state).toBe('CLOSED');
    });

    it('closed = read-only: edit is 409; reopen makes it ACTIVE again, clears the close data, tasks accepted again', async () => {
      const { ws, user, mk, sprint } = await world();
      const it = await sprint();
      await iters.close(ws.id, it.id, {});
      await expect(iters.update(ws.id, it.id, { name: 'new' } as never)).rejects.toMatchObject({ response: { code: 'ITERATION_CLOSED' } });
      const reopened = await iters.reopen(ws.id, it.id);
      expect(reopened).toMatchObject({ state: 'ACTIVE', closedAt: null, closeSummary: null });
      const t = await mk();
      await tasks.update(t.id, { iterationId: it.id }, user.id);
      expect((await row(t.id)).iterationId).toBe(it.id);
      // tasks that were backlogged on an earlier close are NOT pulled back
    });

    it('reopening does not restore tasks that were moved or backlogged', async () => {
      const { ws, it, doing, sprint } = await (async () => {
        const w = await world();
        const it = await w.sprint();
        const doing = await w.mk({ iterationId: it.id, status: T.IN_PROGRESS });
        return { ...w, it, doing };
      })();
      void sprint;
      await iters.close(ws.id, it.id, { action: 'BACKLOG' });
      await iters.reopen(ws.id, it.id);
      expect((await row(doing.id)).iterationId).toBeNull();
    });

    it('detail: counts by category and leaf-only progress over the tasks IN the iteration, Canceled excluded', async () => {
      const { ws, user, project, mk, sprint } = await world();
      const it = await sprint();
      await workflowCanceled(project.id, user.id);
      const canceled = await prisma.workflowStatus.findFirstOrThrow({ where: { projectId: project.id, name: 'Canceled' } });
      await mk({ iterationId: it.id, status: T.DONE });
      await mk({ iterationId: it.id });
      await mk({ iterationId: it.id, workflowStatusId: canceled.id });
      const d = await iters.get(ws.id, it.id, user.id);
      expect(d.counts).toEqual({ TODO: 1, IN_PROGRESS: 0, BLOCKED: 0, DONE: 2 });
      expect(d.taskCount).toBe(3);
      expect(d.progress).toEqual({ done: 1, total: 2, percent: 50 });
    });

    async function workflowCanceled(projectId: string, userId: string) {
      const wf = new WorkflowService(prisma, { record: async () => undefined } as never, {} as never);
      await wf.createStatus(projectId, { name: 'Canceled', category: T.DONE, excludeFromProgress: true } as never, userId);
    }
  });

  // -------------------------------------------------------------------- lists
  describe('lists and filters', () => {
    it('iterations list by project / state / kind with task counts; tasks filter by ?iterationId and ?issueTypeId', async () => {
      const { ws, user, project, mk, sprint } = await world();
      const a = await sprint({ name: 'A', projectId: project.id });
      const b = await iters.create(ws.id, { kind: 'MILESTONE', name: 'B' } as never);
      await iters.start(ws.id, a.id);
      const bug = await types.create(ws.id, { name: 'Bug' } as never);
      const t1 = await mk({ iterationId: a.id, issueTypeId: bug.id });
      await mk({ iterationId: a.id });
      await mk();

      const byProject = await iters.list(ws.id, user.id, { projectId: project.id });
      expect(byProject.map((i) => [i.name, i.taskCount])).toEqual([['A', 2]]);
      expect((await iters.list(ws.id, user.id, { state: IterationState.ACTIVE })).map((i) => i.id)).toEqual([a.id]);
      expect((await iters.list(ws.id, user.id, { kind: IterationKind.MILESTONE })).map((i) => i.id)).toEqual([b.id]);

      const inIter = await tasks.list(user.id, { workspaceId: ws.id, iterationId: a.id, take: 50, skip: 0 } as never);
      expect(inIter.total).toBe(2);
      const typed = await tasks.list(user.id, { workspaceId: ws.id, iterationId: a.id, issueTypeId: bug.id, take: 50, skip: 0 } as never);
      expect(typed.data.map((d) => d.id)).toEqual([t1.id]);
      expect(typed.data[0]).toMatchObject({ issueTypeId: bug.id, iterationId: a.id });

      const detail = await tasks.getDetail(t1.id, user.id);
      expect(detail.issueType).toMatchObject({ id: bug.id, name: 'Bug' });
      expect(detail.iteration).toMatchObject({ id: a.id, name: 'A', state: 'ACTIVE', kind: 'SPRINT' });
    });

    it('listing needs workspace access; a stranger is refused', async () => {
      const { ws } = await world();
      const { user: stranger } = await createUserWithAccount(prisma, { accountType: AccountType.ORGANIZATION });
      await expect(iters.list(ws.id, stranger.id, {})).rejects.toThrow(/access/);
      await expect(types.list(ws.id, stranger.id)).rejects.toThrow(/access/);
    });
  });

  // ------------------------------------------------- estimate, current, velocity
  describe('estimate, current iteration and velocity (ADR-0008)', () => {
    /** Closes a sprint holding the given [status, estimate] leaves. */
    async function closedSprint(
      w: Awaited<ReturnType<typeof world>>,
      name: string,
      work: Array<[TaskStatus, number | null]>,
      extra: Record<string, unknown> = {},
    ) {
      const it = await w.sprint({ name, ...extra });
      for (const [status, estimate] of work) {
        await w.mk({ iterationId: it.id, status, estimate });
      }
      await iters.close(w.ws.id, it.id, { action: 'BACKLOG' });
      return it;
    }

    it('estimate: set on create, change, clear with null; the DB CHECK refuses negatives and > 1000', async () => {
      const { user, mk, ws, project } = await world();
      const t = await mk({ estimate: 5 });
      expect((await row(t.id)).estimate).toBe(5);
      await tasks.update(t.id, { estimate: 0.5 }, user.id);
      expect((await row(t.id)).estimate).toBe(0.5);
      await tasks.update(t.id, { estimate: null }, user.id);
      expect((await row(t.id)).estimate).toBeNull();
      const detail = await tasks.getDetail(t.id, user.id);
      expect(detail.estimate).toBeNull();
      await expect(
        prisma.task.update({ where: { id: t.id }, data: { estimate: -1 } }),
      ).rejects.toThrow();
      await expect(
        prisma.task.update({ where: { id: t.id }, data: { estimate: 1001 } }),
      ).rejects.toThrow();
      void ws; void project;
    });

    it('current: every ACTIVE iteration (several or none); planned/closed excluded; project filter = its own + workspace-wide', async () => {
      const w = await world();
      const { ws, user, project, sprint } = w;
      expect(await iters.current(ws.id, user.id, {})).toEqual([]);
      const a = await sprint({ name: 'A', startDate: '2026-03-01' });
      const b = await sprint({ name: 'B', projectId: project.id, startDate: '2026-02-01' });
      const other = await projects.create({ workspaceId: ws.id, name: 'Other' }, user.id);
      const c = await sprint({ name: 'C', projectId: other.id });
      await sprint({ name: 'planned' });
      const closed = await sprint({ name: 'closed' });
      for (const i of [a, b, c]) await iters.start(ws.id, i.id);
      await iters.close(ws.id, closed.id, {});

      const all = await iters.current(ws.id, user.id, {});
      expect(all.map((i) => i.name)).toEqual(['B', 'A', 'C']); // by start date, undated last
      const forProject = await iters.current(ws.id, user.id, { projectId: project.id });
      expect(forProject.map((i) => i.name)).toEqual(['B', 'A']);
      const { project: foreign } = await world();
      await expect(iters.current(ws.id, user.id, { projectId: foreign.id })).rejects.toThrow(/does not belong/);
    });

    it('current carries counts, progress and leaf-only points (parent not double counted, unestimated reported)', async () => {
      const { ws, user, mk, sprint } = await world();
      const it = await sprint();
      await iters.start(ws.id, it.id);
      const parent = await mk({ iterationId: it.id, estimate: 13 });
      await tasks.create({ workspaceId: ws.id, title: 'c1', parentId: parent.id, iterationId: it.id, status: T.DONE, estimate: 3 } as never, user.id);
      await tasks.create({ workspaceId: ws.id, title: 'c2', parentId: parent.id, iterationId: it.id, estimate: 5 } as never, user.id);
      await mk({ iterationId: it.id, status: T.DONE }); // done, no estimate
      const [cur] = await iters.current(ws.id, user.id, {});
      expect(cur.points).toEqual({ total: 8, done: 3, unestimated: 1 });
      expect(cur.progress).toEqual({ done: 2, total: 3, percent: 67 });
      expect(cur.counts.DONE).toBe(2);
    });

    it('velocity default: closed SPRINTs, last 6, oldest first, with the average; other kinds/states excluded', async () => {
      const w = await world();
      const { ws, user } = w;
      for (let i = 1; i <= 8; i++) {
        await closedSprint(w, `S${i}`, [[T.DONE, i], [T.DONE, 1], [T.TODO, 20]], { startDate: `2026-01-${String(i).padStart(2, '0')}` });
      }
      await iters.create(ws.id, { kind: 'CYCLE', name: 'cycle' } as never).then((c) => iters.close(ws.id, c.id, {}));
      await w.sprint({ name: 'still planned' });

      const v = await iters.velocity(ws.id, user.id, {});
      expect(v.filter).toEqual({ projectId: null, kind: 'SPRINT', state: 'CLOSED', limit: 6 });
      expect(v.iterations.map((i) => i.name)).toEqual(['S3', 'S4', 'S5', 'S6', 'S7', 'S8']);
      expect(v.iterations.at(-1)).toMatchObject({
        source: 'SNAPSHOT', completedCount: 2, completedPoints: 9, totalCount: 3, totalPoints: 29, unestimatedCompleted: 0,
      });
      // S3..S8 completed points are 4,5,6,7,8,9 -> mean 6.5; count is 2 each
      expect(v.average).toEqual({ completedCount: 2, completedPoints: 6.5 });
    });

    it('velocity filters: kind ALL / CYCLE, limit, state ACTIVE (live), project scope', async () => {
      const w = await world();
      const { ws, user, project, sprint } = w;
      const s1 = await closedSprint(w, 'S1', [[T.DONE, 3]]);
      const cyc = await iters.create(ws.id, { kind: 'CYCLE', name: 'C1' } as never);
      await w.mk({ iterationId: cyc.id, status: T.DONE, estimate: 8 });
      await iters.close(ws.id, cyc.id, {});
      const scoped = await closedSprint(w, 'P1', [[T.DONE, 2]], { projectId: project.id });

      expect((await iters.velocity(ws.id, user.id, { kind: 'ALL' })).iterations.map((i) => i.name).sort()).toEqual(['C1', 'P1', 'S1']);
      expect((await iters.velocity(ws.id, user.id, { kind: 'CYCLE' })).iterations.map((i) => i.name)).toEqual(['C1']);
      expect((await iters.velocity(ws.id, user.id, { kind: 'ALL', limit: 1 })).iterations).toHaveLength(1);

      const other = await projects.create({ workspaceId: ws.id, name: 'Other' }, user.id);
      const forOther = await iters.velocity(ws.id, user.id, { projectId: other.id });
      expect(forOther.iterations.map((i) => i.id)).toEqual([s1.id]); // workspace-wide only, not P1
      expect((await iters.velocity(ws.id, user.id, { projectId: project.id })).iterations.map((i) => i.id).sort()).toEqual([s1.id, scoped.id].sort());

      const live = await sprint({ name: 'live' });
      await iters.start(ws.id, live.id);
      await w.mk({ iterationId: live.id, status: T.DONE, estimate: 5 });
      const act = await iters.velocity(ws.id, user.id, { state: IterationState.ACTIVE });
      expect(act.iterations[0]).toMatchObject({ source: 'LIVE', completedPoints: 5, completedCount: 1 });
    });

    it('a closed iteration reports the numbers from when it closed: later edits do not rewrite history; reopen goes live; re-close re-snapshots', async () => {
      const w = await world();
      const { ws, user } = w;
      const it = await w.sprint({ name: 'S' });
      const done = await w.mk({ iterationId: it.id, status: T.DONE, estimate: 5 });
      const open = await w.mk({ iterationId: it.id, estimate: 8 });
      await iters.close(ws.id, it.id, { action: 'LEAVE' });
      const first = (await iters.velocity(ws.id, user.id, {})).iterations[0];
      expect(first).toMatchObject({ source: 'SNAPSHOT', completedPoints: 5, totalPoints: 13 });

      // the unfinished task that was LEFT behind is finished later, and the estimate changes
      await tasks.update(open.id, { status: T.DONE }, user.id);
      await tasks.update(done.id, { estimate: 100 }, user.id);
      expect((await iters.velocity(ws.id, user.id, {})).iterations[0]).toMatchObject({ source: 'SNAPSHOT', completedPoints: 5, completedCount: 1 });

      await iters.reopen(ws.id, it.id);
      expect((await iters.velocity(ws.id, user.id, { state: IterationState.ACTIVE })).iterations[0]).toMatchObject({ source: 'LIVE', completedPoints: 108 });
      await iters.close(ws.id, it.id, {});
      expect((await iters.velocity(ws.id, user.id, {})).iterations[0]).toMatchObject({ source: 'SNAPSHOT', completedPoints: 108, completedCount: 2 });
    });

    it('the snapshot is taken BEFORE unfinished tasks are moved away', async () => {
      const w = await world();
      const { ws, user } = w;
      const it = await w.sprint();
      await w.mk({ iterationId: it.id, status: T.DONE, estimate: 3 });
      await w.mk({ iterationId: it.id, estimate: 5 });
      await w.mk({ iterationId: it.id, status: T.IN_PROGRESS, estimate: 2 });
      await iters.close(ws.id, it.id, { action: 'BACKLOG' });
      expect((await iters.velocity(ws.id, user.id, {})).iterations[0]).toMatchObject({
        completedPoints: 3, totalPoints: 10, totalCount: 3, completedCount: 1,
      });
    });

    it('legacy: a closed iteration WITHOUT a snapshot falls back to a live measurement', async () => {
      const w = await world();
      const { ws, user } = w;
      const it = await w.sprint();
      await w.mk({ iterationId: it.id, status: T.DONE, estimate: 4 });
      await iters.close(ws.id, it.id, {});
      await prisma.iteration.update({ where: { id: it.id }, data: { closeSummary: { unfinished: 0, action: null, movedToId: null, completed: 1 } } });
      expect((await iters.velocity(ws.id, user.id, {})).iterations[0]).toMatchObject({ source: 'LIVE', completedPoints: 4 });
    });

    it('Canceled and archived tasks do not count; unestimated Done tasks count as work but add 0 points', async () => {
      const w = await world();
      const { ws, user, project } = w;
      const wf = new WorkflowService(prisma, { record: async () => undefined } as never, {} as never);
      await wf.createStatus(project.id, { name: 'Canceled', category: T.DONE, excludeFromProgress: true } as never, user.id);
      const canceled = await prisma.workflowStatus.findFirstOrThrow({ where: { projectId: project.id, name: 'Canceled' } });
      const it = await w.sprint();
      await w.mk({ iterationId: it.id, status: T.DONE, estimate: 3 });
      await w.mk({ iterationId: it.id, status: T.DONE }); // unestimated
      await w.mk({ iterationId: it.id, workflowStatusId: canceled.id, estimate: 50 });
      const arch = await w.mk({ iterationId: it.id, status: T.DONE, estimate: 40 });
      await tasks.archive(arch.id, user.id);
      await iters.close(ws.id, it.id, {});
      expect((await iters.velocity(ws.id, user.id, {})).iterations[0]).toMatchObject({
        completedCount: 2, completedPoints: 3, totalCount: 2, unestimatedCompleted: 1,
      });
    });

    it('empty history is an empty list with a null average', async () => {
      const { ws, user } = await world();
      expect(await iters.velocity(ws.id, user.id, {})).toMatchObject({ iterations: [], average: null });
    });

    it('both reads need workspace access', async () => {
      const { ws } = await world();
      const { user: stranger } = await createUserWithAccount(prisma, { accountType: AccountType.ORGANIZATION });
      await expect(iters.current(ws.id, stranger.id, {})).rejects.toThrow(/access/);
      await expect(iters.velocity(ws.id, stranger.id, {})).rejects.toThrow(/access/);
    });

    it('bulk create carries estimates', async () => {
      const { ws, user, project } = await world();
      const res = await writer.createTasksBulk(ws.id, [{ title: 'a', projectId: project.id, estimate: 3 }, { title: 'b', projectId: project.id }], user.id, { origin: 'IMPORT', actorId: user.id });
      const rows = await prisma.task.findMany({ where: { id: { in: res.createdIds } }, orderBy: { number: 'asc' } });
      expect(rows.map((r) => r.estimate)).toEqual([3, null]);
    });
  });

  // -------------------------------------------------------------- concurrency
  describe('concurrency', () => {
    it('assignments racing a close(BACKLOG) never leave an unfinished task in the closed iteration', async () => {
      const { ws, user, mk, sprint } = await world();
      const it = await sprint();
      await iters.start(ws.id, it.id);
      const ts = await Promise.all(Array.from({ length: 10 }, () => mk()));
      const settled = await Promise.allSettled([
        iters.close(ws.id, it.id, { action: 'BACKLOG' }),
        ...ts.map((t) => tasks.update(t.id, { iterationId: it.id }, user.id)),
      ]);
      for (const s of settled) {
        if (s.status === 'rejected') expect(clientError(s.reason)).toMatch(/^4/);
      }
      expect((await prisma.iteration.findUniqueOrThrow({ where: { id: it.id } })).state).toBe(IterationState.CLOSED);
      const stuck = await prisma.task.count({ where: { iterationId: it.id, status: { not: T.DONE }, isArchived: false } });
      expect(stuck).toBe(0);
    });

    it('two iterations closing INTO each other: no deadlock, no 500', async () => {
      const { ws, mk, sprint } = await world();
      const a = await sprint({ name: 'A' });
      const b = await sprint({ name: 'B' });
      await mk({ iterationId: a.id });
      await mk({ iterationId: b.id });
      const settled = await Promise.allSettled([
        iters.close(ws.id, a.id, { action: 'MOVE', moveToIterationId: b.id }),
        iters.close(ws.id, b.id, { action: 'MOVE', moveToIterationId: a.id }),
      ]);
      for (const s of settled) {
        if (s.status === 'rejected') expect(clientError(s.reason)).toMatch(/^4/);
      }
      expect(settled.some((s) => s.status === 'fulfilled')).toBe(true);
    });
  });
});
