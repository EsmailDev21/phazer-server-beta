/**
 * Step 1.3 (ADR-0005) on a real database. One describe per decision.
 */
import { TaskPlanningService } from '../../src/projects-tasks/planning/task-planning.service';
import { WorkflowService } from '../../src/projects-tasks/workflow/workflow.service';
import { Test } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { AccountType, TaskStatus } from '@prisma/client';
import {
  BulkWriteError,
  DomainWriter,
} from '../../src/domain-writer/domain-writer.service';
import { PlanLimitExceededException } from '../../src/common/exceptions/plan-limit-exceeded.exception';
import { ActivityService } from '../../src/events/activity.service';
import { AuditLogService } from '../../src/events/audit-log.service';
import { PermissionResolver } from '../../src/access-control/access-control.service';
import { PlanLimitsService } from '../../src/access-control/plan-limits.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { TasksService } from '../../src/projects-tasks/tasks/tasks.service';
import { TaskTreeService } from '../../src/projects-tasks/tasks/task-tree.service';
import { TaskVisibilityService } from '../../src/projects-tasks/tasks/task-visibility.service';
import { ProjectsService } from '../../src/projects-tasks/projects/projects.service';
import { CustomFieldsService } from '../../src/projects-tasks/custom-fields/custom-fields.service';
import { WorkspacesService } from '../../src/tenancy/workspaces/workspaces.service';
import { WorkspaceKeysService } from '../../src/tenancy/workspaces/workspace-keys.service';
import {
  getTestPrisma,
  disconnectTestPrisma,
} from './support/prisma-test-client';
import { resetDb } from './support/reset-db';
import {
  createProject,
  createTask,
  createUser,
  createUserWithAccount,
  createWorkspace,
} from './factories';

describe('subtasks (real database)', () => {
  let prisma: PrismaService;
  let tasks: TasksService;
  let projects: ProjectsService;
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
    writer = moduleRef.get(DomainWriter);
  });
  beforeEach(() => resetDb(prisma));
  afterAll(() => disconnectTestPrisma());

  async function world(accountType: AccountType = AccountType.ORGANIZATION) {
    const { user, account } = await createUserWithAccount(prisma, {
      accountType,
    });
    const ws = await createWorkspace(prisma, { accountId: account.id });
    const project = await createProject(prisma, {
      workspaceId: ws.id,
      createdById: user.id,
    });
    const mk = (
      title: string,
      over: { parentId?: string; projectId?: string } = {},
    ) =>
      tasks.create(
        {
          workspaceId: ws.id,
          title,
          projectId: over.projectId ?? project.id,
          ...(over.parentId ? { parentId: over.parentId } : {}),
        },
        user.id,
      );
    return { user, account, ws, project, mk };
  }
  const row = (id: string) => prisma.task.findUniqueOrThrow({ where: { id } });
  const acts = (targetId: string, action: string) =>
    prisma.activity.findMany({ where: { targetId, action: action as never } });

  // ------------------------------------------------------- creation + rules
  describe('creating subtasks (decisions 1, 2, 8)', () => {
    it("creates a subtask, inherits the parent's project when none is given, and records parentId on CREATED", async () => {
      const { user, ws, project, mk } = await world();
      const root = await mk('root');
      const child = await tasks.create(
        { workspaceId: ws.id, title: 'child', parentId: root.id },
        user.id,
      ); // no projectId
      expect(child.parentId).toBe(root.id);
      expect(child.projectId).toBe(project.id);
      const created = await acts(child.id, 'CREATED');
      expect(created).toHaveLength(1);
      expect((created[0].metadata as { parentId: string }).parentId).toBe(
        root.id,
      );
      expect(child.number).toBe(2); // its own key, from the same counter
    });

    it('allows 3 levels, rejects the 4th', async () => {
      const { mk } = await world();
      const a = await mk('a');
      const b = await mk('b', { parentId: a.id });
      const c = await mk('c', { parentId: b.id });
      await expect(mk('d', { parentId: c.id })).rejects.toThrow(
        /at most 3 levels/,
      );
    });

    it("a subtask must be in its parent's project (an Inbox parent needs an Inbox child)", async () => {
      const { user, ws, project, mk } = await world();
      const other = await createProject(prisma, {
        workspaceId: ws.id,
        createdById: user.id,
      });
      const root = await mk('root');
      await expect(
        mk('x', { parentId: root.id, projectId: other.id }),
      ).rejects.toBeInstanceOf(BadRequestException);
      const inbox = await tasks.create(
        { workspaceId: ws.id, title: 'inbox' },
        user.id,
      );
      await expect(
        mk('y', { parentId: inbox.id, projectId: project.id }),
      ).rejects.toBeInstanceOf(BadRequestException);
      const inboxChild = await tasks.create(
        { workspaceId: ws.id, title: 'inbox child', parentId: inbox.id },
        user.id,
      );
      expect(inboxChild.projectId).toBeNull();
    });

    it('rejects an archived parent (400) and a missing / foreign / invisible parent (the same 404)', async () => {
      const { user, ws, mk } = await world();
      const root = await mk('root');
      await tasks.archive(root.id, user.id);
      await expect(mk('x', { parentId: root.id })).rejects.toThrow(/archived/);

      const other = await world(); // a different account's task
      const foreign = await other.mk('foreign');
      const stranger = await createUser(prisma);
      const live = await mk('live');
      for (const parentId of ['no-such-id', foreign.id]) {
        await expect(
          tasks.create({ workspaceId: ws.id, title: 'x', parentId }, user.id),
        ).rejects.toThrow('Parent task not found');
      }
      await expect(
        tasks.create(
          { workspaceId: ws.id, title: 'x', parentId: live.id },
          stranger.id,
        ),
      ).rejects.toThrow('Parent task not found');
    });

    it('an INHERITED project is still capped (the route guard cannot see it): 50th subtask ok, 51st refused', async () => {
      const { user, ws, project } = await world(AccountType.PERSONAL); // 50 per project
      const root = await tasks.create(
        { workspaceId: ws.id, projectId: project.id, title: 'root' },
        user.id,
      );
      for (let i = 0; i < 48; i++)
        await createTask(prisma, {
          workspaceId: ws.id,
          createdById: user.id,
          projectId: project.id,
        });
      await tasks.create(
        { workspaceId: ws.id, title: 'fits', parentId: root.id },
        user.id,
      ); // task #50
      await expect(
        tasks.create(
          { workspaceId: ws.id, title: 'over', parentId: root.id },
          user.id,
        ),
      ).rejects.toBeInstanceOf(PlanLimitExceededException);
    });
  });

  // ------------------------------------------------------------- reparenting
  describe('reparenting (decision 3)', () => {
    it('set, change and detach a parent; one PARENT_CHANGED {from,to} each', async () => {
      const { user, mk } = await world();
      const a = await mk('a');
      const b = await mk('b');
      const t = await mk('t');
      await tasks.update(t.id, { parentId: a.id }, user.id);
      await tasks.update(t.id, { parentId: b.id }, user.id);
      await tasks.update(t.id, { parentId: null }, user.id);
      expect((await row(t.id)).parentId).toBeNull();
      const meta = (await acts(t.id, 'PARENT_CHANGED'))
        .map((x) => x.metadata)
        .sort((x: any, y: any) => String(x.to).localeCompare(String(y.to)));
      expect(meta).toHaveLength(3);
      expect(meta).toContainEqual({ from: null, to: a.id });
      expect(meta).toContainEqual({ from: a.id, to: b.id });
      expect(meta).toContainEqual({ from: b.id, to: null });
    });

    it('an unchanged parentId is a no-op (no activity)', async () => {
      const { user, mk } = await world();
      const a = await mk('a');
      const t = await mk('t', { parentId: a.id });
      await tasks.update(t.id, { parentId: a.id, title: 'renamed' }, user.id);
      expect(await acts(t.id, 'PARENT_CHANGED')).toHaveLength(0);
    });

    it('rejects cycles: under itself, under its own child, under its own grandchild', async () => {
      const { user, mk } = await world();
      const a = await mk('a');
      const b = await mk('b', { parentId: a.id });
      const c = await mk('c', { parentId: b.id });
      for (const [id, parentId] of [
        [a.id, a.id],
        [a.id, b.id],
        [a.id, c.id],
        [b.id, c.id],
      ] as const) {
        await expect(
          tasks.update(id, { parentId }, user.id),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
    });

    it('depth counts the SUBTREE that moves: a root with children fits under a root, not under a child', async () => {
      const { user, mk } = await world();
      const x = await mk('x');
      const y = await mk('y');
      const yc = await mk('yc', { parentId: y.id });
      const r = await mk('r');
      await mk('rc', { parentId: r.id });
      await expect(
        tasks.update(r.id, { parentId: yc.id }, user.id),
      ).rejects.toThrow(/at most 3 levels/);
      await tasks.update(r.id, { parentId: x.id }, user.id); // x(0) -> r(1) -> rc(2): exactly at the limit
      expect((await row(r.id)).parentId).toBe(x.id);
    });

    it('two simultaneous opposite reparents: exactly one wins, the tree never has a cycle (20 rounds)', async () => {
      const { user, mk } = await world();
      for (let i = 0; i < 20; i++) {
        const a = await mk(`a${i}`);
        const b = await mk(`b${i}`);
        const res = await Promise.allSettled([
          tasks.update(a.id, { parentId: b.id }, user.id),
          tasks.update(b.id, { parentId: a.id }, user.id),
        ]);
        expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        const [ra, rb] = [await row(a.id), await row(b.id)];
        expect((ra.parentId === b.id) !== (rb.parentId === a.id)).toBe(true);
      }
    });

    it('the generic update spread cannot write a parent: only the validated path can (mass-assignment guard)', async () => {
      const { user, mk } = await world();
      const a = await mk('a');
      const t = await mk('t');
      await expect(
        tasks.update(t.id, { parentId: t.id } as never, user.id),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect((await row(t.id)).parentId).toBeNull();
      // and the database refuses a self-parent even if code went around it
      await expect(
        prisma.$executeRaw`UPDATE tasks SET parent_id = id WHERE id = ${a.id}`,
      ).rejects.toThrow();
    });
  });

  // ------------------------------------------------------------ project moves
  describe('moving between projects (decision 9)', () => {
    it('moving a root moves its whole subtree, with one TASK_MOVED on the root', async () => {
      const { user, ws, project, mk } = await world();
      const p2 = await createProject(prisma, {
        workspaceId: ws.id,
        createdById: user.id,
      });
      const r = await mk('r');
      const c = await mk('c', { parentId: r.id });
      const g = await mk('g', { parentId: c.id });
      await tasks.update(r.id, { projectId: p2.id }, user.id);
      for (const id of [r.id, c.id, g.id])
        expect((await row(id)).projectId).toBe(p2.id);
      const moved = await acts(r.id, 'TASK_MOVED');
      expect(moved).toHaveLength(1);
      expect(moved[0].metadata).toEqual({
        from: project.id,
        to: p2.id,
        descendants: 2,
      });
    });

    it('a subtask cannot change project on its own; detaching and moving in one request is fine', async () => {
      const { user, ws, mk } = await world();
      const p2 = await createProject(prisma, {
        workspaceId: ws.id,
        createdById: user.id,
      });
      const r = await mk('r');
      const c = await mk('c', { parentId: r.id });
      await expect(
        tasks.update(c.id, { projectId: p2.id }, user.id),
      ).rejects.toThrow(/detach it first/);
      await tasks.update(c.id, { parentId: null, projectId: p2.id }, user.id);
      const after = await row(c.id);
      expect([after.parentId, after.projectId]).toEqual([null, p2.id]);
    });

    it('re-parenting under a task in another project needs the project change in the same request', async () => {
      const { user, ws, mk } = await world();
      const p2 = await createProject(prisma, {
        workspaceId: ws.id,
        createdById: user.id,
      });
      const t = await mk('t');
      const other = await mk('other', { projectId: p2.id });
      await expect(
        tasks.update(t.id, { parentId: other.id }, user.id),
      ).rejects.toThrow(/same project/);
      await tasks.update(
        t.id,
        { parentId: other.id, projectId: p2.id },
        user.id,
      );
      expect(await row(t.id)).toMatchObject({
        parentId: other.id,
        projectId: p2.id,
      });
    });

    it("the target project's cap is checked with the SUBTREE size, and nothing moves when it fails", async () => {
      const { user, ws, project } = await world(AccountType.PERSONAL);
      const target = await createProject(prisma, {
        workspaceId: ws.id,
        createdById: user.id,
      });
      for (let i = 0; i < 48; i++)
        await createTask(prisma, {
          workspaceId: ws.id,
          createdById: user.id,
          projectId: target.id,
        });
      const r = await tasks.create(
        { workspaceId: ws.id, projectId: project.id, title: 'r' },
        user.id,
      );
      const c1 = await tasks.create(
        { workspaceId: ws.id, title: 'c1', parentId: r.id },
        user.id,
      );
      await tasks.create(
        { workspaceId: ws.id, title: 'c2', parentId: r.id },
        user.id,
      );
      await expect(
        tasks.update(r.id, { projectId: target.id }, user.id),
      ).rejects.toBeInstanceOf(PlanLimitExceededException); // 3 more -> 51
      expect((await row(r.id)).projectId).toBe(project.id);
      expect((await row(c1.id)).projectId).toBe(project.id);
      await tasks.update(
        c1.id,
        { parentId: null, projectId: target.id },
        user.id,
      ); // a single task fits (49)
      expect((await row(c1.id)).projectId).toBe(target.id);
    });
  });

  // ----------------------------------------------------------------- delete
  describe('deleting (decision 4)', () => {
    it('refuses while subtasks exist (409 with the count); ?cascade deletes the whole tree; leaves delete normally', async () => {
      const { mk } = await world();
      const r = await mk('r');
      const c = await mk('c', { parentId: r.id });
      const g = await mk('g', { parentId: c.id });
      await expect(tasks.delete(r.id)).rejects.toThrow(/2 subtask\(s\)/);
      await expect(tasks.delete(r.id)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(await prisma.task.count()).toBe(3);
      await tasks.delete(g.id); // a leaf
      expect(await prisma.task.count()).toBe(2);
      await tasks.delete(r.id, true);
      expect(await prisma.task.count()).toBe(0);
    });

    it('the DATABASE refuses to orphan a child even when code goes around the check', async () => {
      const { mk } = await world();
      const r = await mk('r');
      await mk('c', { parentId: r.id });
      await expect(
        prisma.$executeRaw`DELETE FROM tasks WHERE id = ${r.id}`,
      ).rejects.toThrow();
      expect(await prisma.task.count()).toBe(2);
    });

    it('deleting a project sends the WHOLE tree to the Inbox together (the invariant survives SetNull)', async () => {
      const { project, mk } = await world();
      const r = await mk('r');
      const c = await mk('c', { parentId: r.id });
      await prisma.project.delete({ where: { id: project.id } });
      expect((await row(r.id)).projectId).toBeNull();
      expect(await row(c.id)).toMatchObject({
        projectId: null,
        parentId: r.id,
      });
    });

    it('deleting the workspace removes whole trees (cascade is not blocked by the NO ACTION self-reference)', async () => {
      const { ws, mk } = await world();
      const r = await mk('r');
      const c = await mk('c', { parentId: r.id });
      await mk('g', { parentId: c.id });
      await prisma.workspace.delete({ where: { id: ws.id } });
      expect(await prisma.task.count()).toBe(0);
    });
  });

  // -------------------------------------------------------- archive / restore
  describe('archive and restore (decision 5)', () => {
    it('archiving a parent archives the subtree with ONE timestamp; restoring undoes exactly that', async () => {
      const { user, mk } = await world();
      const r = await mk('r');
      const c = await mk('c', { parentId: r.id });
      const g = await mk('g', { parentId: c.id });
      await tasks.archive(r.id, user.id);
      const rows = await Promise.all([r, c, g].map((t) => row(t.id)));
      expect(rows.every((x) => x.isArchived)).toBe(true);
      expect(new Set(rows.map((x) => x.archivedAt!.getTime())).size).toBe(1);
      expect((await acts(r.id, 'ARCHIVED'))[0].metadata).toEqual({
        descendants: 2,
      });
      await tasks.restore(r.id, user.id);
      for (const t of [r, c, g])
        expect(await row(t.id)).toMatchObject({
          isArchived: false,
          archivedAt: null,
        });
    });

    it('a subtask archived on its own EARLIER stays archived when the parent is restored', async () => {
      const { user, mk } = await world();
      const r = await mk('r');
      const early = await mk('early', { parentId: r.id });
      const late = await mk('late', { parentId: r.id });
      await tasks.archive(early.id, user.id);
      await new Promise((res) => setTimeout(res, 5));
      await tasks.archive(r.id, user.id);
      await tasks.restore(r.id, user.id);
      expect((await row(early.id)).isArchived).toBe(true);
      expect((await row(late.id)).isArchived).toBe(false);
      expect((await row(r.id)).isArchived).toBe(false);
    });

    it('a subtask cannot be restored while its parent is archived; re-archiving is a no-op that keeps the stamp', async () => {
      const { user, mk } = await world();
      const r = await mk('r');
      const c = await mk('c', { parentId: r.id });
      await tasks.archive(r.id, user.id);
      await expect(tasks.restore(c.id, user.id)).rejects.toThrow(
        'Restore the parent task first',
      );
      const before = (await row(r.id)).archivedAt!.getTime();
      await new Promise((res) => setTimeout(res, 5));
      await tasks.archive(r.id, user.id);
      expect((await row(r.id)).archivedAt!.getTime()).toBe(before);
      expect(await acts(r.id, 'ARCHIVED')).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------- progress
  describe('progress (decision 6)', () => {
    const done = (id: string, user: string) =>
      tasks.update(id, { status: TaskStatus.DONE }, user);

    it('a project with no subtasks is exactly done/total, as before', async () => {
      const { user, project, mk } = await world();
      const ts = [await mk('1'), await mk('2'), await mk('3'), await mk('4')];
      await done(ts[0].id, user.id);
      await done(ts[1].id, user.id);
      expect(await projects.computeProgress(project.id)).toBe(50);
    });

    it('parents are not counted: a DONE parent with one done and one open child plus an open root task = 1/3', async () => {
      const { user, project, mk } = await world();
      const p = await mk('p');
      const c1 = await mk('c1', { parentId: p.id });
      await mk('c2', { parentId: p.id });
      await mk('t3');
      await done(p.id, user.id);
      await done(c1.id, user.id);
      expect(await projects.computeProgress(project.id)).toBe(33); // leaves: c1(done) c2 t3
    });

    it('closing a parent does not move progress (it is a container), and nothing is auto-completed', async () => {
      const { user, project, mk } = await world();
      const p = await mk('p');
      const c = await mk('c', { parentId: p.id });
      await done(p.id, user.id);
      expect(await projects.computeProgress(project.id)).toBe(0);
      expect((await row(c.id)).status).not.toBe(TaskStatus.DONE);
    });

    it('an archived child does not make its parent a container; archived tasks are ignored', async () => {
      const { user, project, mk } = await world();
      const p = await mk('p');
      const c = await mk('c', { parentId: p.id });
      await done(p.id, user.id);
      await tasks.archive(c.id, user.id);
      expect(await projects.computeProgress(project.id)).toBe(100); // p is a leaf again, and DONE
    });

    it('getStats agrees with computeProgress; its counts are real task counts (parents included)', async () => {
      const { user, project, mk } = await world();
      const p = await mk('p');
      const c = await mk('c', { parentId: p.id });
      await done(c.id, user.id);
      const stats = await projects.getStats(project.id, user.id);
      expect(stats.progress).toBe(await projects.computeProgress(project.id));
      expect(stats.progress).toBe(100);
      expect(stats.total).toBe(2);
    });

    it("task detail: subtaskCount and subtaskProgress (null without subtasks), independent of the parent's own status", async () => {
      const { user, mk } = await world();
      const p = await mk('p');
      const c1 = await mk('c1', { parentId: p.id });
      const c2 = await mk('c2', { parentId: p.id });
      await mk('g', { parentId: c2.id });
      expect(await tasks.getDetail(c1.id, user.id)).toMatchObject({
        subtaskCount: 0,
        subtaskProgress: null,
        parentId: p.id,
      });
      await done(c1.id, user.id);
      const d = await tasks.getDetail(p.id, user.id);
      expect(d.subtaskCount).toBe(2);
      expect(d.subtaskProgress).toEqual({ done: 1, total: 2, percent: 50 }); // leaves: c1(done), g(open); c2 is a container
    });
  });

  // ------------------------------------------------------- list / subtree
  describe('list and subtree (decision 11)', () => {
    it('the default list returns every task (unchanged); rootsOnly and parentId filter; items carry parentId', async () => {
      const { user, ws, project, mk } = await world();
      const r = await mk('r');
      const c = await mk('c', { parentId: r.id });
      await mk('g', { parentId: c.id });
      const solo = await mk('solo');
      const q = {
        workspaceId: ws.id,
        projectId: project.id,
        take: 50,
        skip: 0,
      };
      const all = await tasks.list(user.id, q);
      expect(all.total).toBe(4);
      expect(all.data.find((t) => t.id === c.id)!.parentId).toBe(r.id);
      const roots = await tasks.list(user.id, { ...q, rootsOnly: true });
      expect(roots.data.map((t) => t.id).sort()).toEqual(
        [r.id, solo.id].sort(),
      );
      expect(roots.total).toBe(2);
      const kids = await tasks.list(user.id, { ...q, parentId: r.id });
      expect(kids.data.map((t) => t.id)).toEqual([c.id]);
      // parentId wins over rootsOnly
      expect(
        (await tasks.list(user.id, { ...q, parentId: r.id, rootsOnly: true }))
          .total,
      ).toBe(1);
    });

    it('getSubtree: flat, with depth, ordered, archived excluded; authorised exactly like getDetail: a stranger and a missing id are both 403', async () => {
      const { user, mk } = await world();
      const r = await mk('r');
      const a = await mk('a', { parentId: r.id });
      const b = await mk('b', { parentId: r.id });
      const g = await mk('g', { parentId: a.id });
      const arch = await mk('arch', { parentId: r.id });
      await tasks.archive(arch.id, user.id);
      const sub = await tasks.getSubtree(r.id, user.id);
      expect(sub.map((t) => [t.id, t.depth])).toEqual([
        [a.id, 1],
        [b.id, 1],
        [g.id, 2],
      ]);
      expect(await tasks.getSubtree(g.id, user.id)).toEqual([]);
      const stranger = await createUser(prisma);
      // Authorised exactly like GET /tasks/:id: a task you may not see and a task that
      // does not exist are INDISTINGUISHABLE (both 403), so neither endpoint leaks existence.
      await expect(tasks.getSubtree(r.id, stranger.id)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(
        tasks.getSubtree('no-such-task', user.id),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        tasks.getDetail('no-such-task', user.id),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // --------------------------------------------------------------- bulk trees
  describe('trees in bulk (decision 12)', () => {
    const ctx = { origin: 'IMPORT' as const, actorId: null };

    it('parentIndex is global: a tree spanning chunk boundaries is wired correctly, ids come back in input order', async () => {
      const { user, ws, project } = await world();
      const p = project.id;
      const items = [
        { title: 'root', projectId: p }, // 0
        { title: 'a', projectId: p, parentIndex: 0 }, // 1
        { title: 'b', projectId: p, parentIndex: 0 }, // 2
        { title: 'a1', projectId: p, parentIndex: 1 }, // 3
        { title: 'a2', projectId: p, parentIndex: 1 }, // 4  (parent in an EARLIER chunk with size 2)
        { title: 'other', projectId: p }, // 5
        { title: 'b1', projectId: p, parentIndex: 2 }, // 6
      ];
      const res = await writer.createTasksBulk(ws.id, items, user.id, ctx, {
        chunkSize: 2,
      });
      expect(res.chunks).toBe(4);
      const created = await Promise.all(res.createdIds.map(row));
      expect(created.map((t) => t.title)).toEqual(items.map((i) => i.title)); // input order
      const parentTitle = async (t: { parentId: string | null }) =>
        t.parentId ? (await row(t.parentId)).title : null;
      expect(await Promise.all(created.map(parentTitle))).toEqual([
        null,
        'root',
        'root',
        'a',
        'a',
        null,
        'b',
      ]);
      expect(new Set(created.map((t) => t.number)).size).toBe(7);
    });

    it('rejects a 4th level, a parent that comes later, both parent fields, and a project mismatch', async () => {
      const { user, ws, project } = await world();
      const p = project.id;
      const other = await createProject(prisma, {
        workspaceId: ws.id,
        createdById: user.id,
      });
      const run = (items: any[]) =>
        writer.createTasksBulk(ws.id, items, user.id, ctx);
      await expect(
        run([
          { title: 'a', projectId: p },
          { title: 'b', projectId: p, parentIndex: 0 },
          { title: 'c', projectId: p, parentIndex: 1 },
          { title: 'd', projectId: p, parentIndex: 2 },
        ]),
      ).rejects.toBeInstanceOf(BulkWriteError);
      await expect(
        run([
          { title: 'a', projectId: p, parentIndex: 1 },
          { title: 'b', projectId: p },
        ]),
      ).rejects.toThrow(/EARLIER/);
      await expect(
        run([
          { title: 'a', projectId: p },
          { title: 'b', projectId: p, parentIndex: 0, parentId: 'x' },
        ]),
      ).rejects.toThrow(/not both/);
      await expect(
        run([
          { title: 'a', projectId: p },
          { title: 'b', projectId: other.id, parentIndex: 0 },
        ]),
      ).rejects.toBeInstanceOf(BulkWriteError);
      expect(await prisma.task.count()).toBe(0); // every failure left nothing behind
    });

    it('a bulk child can hang under an EXISTING task (parentId), depth-checked against its real ancestors', async () => {
      const { user, ws, project, mk } = await world();
      const a = await mk('a');
      const b = await mk('b', { parentId: a.id });
      await writer.createTasksBulk(
        ws.id,
        [{ title: 'under-b', projectId: project.id, parentId: b.id }],
        user.id,
        ctx,
      );
      expect(
        (await prisma.task.findFirstOrThrow({ where: { title: 'under-b' } }))
          .parentId,
      ).toBe(b.id);
      const c = await prisma.task.findFirstOrThrow({
        where: { title: 'under-b' },
      });
      await expect(
        writer.createTasksBulk(
          ws.id,
          [{ title: 'too-deep', projectId: project.id, parentId: c.id }],
          user.id,
          ctx,
        ),
      ).rejects.toBeInstanceOf(BulkWriteError);
    });

    it('the plan cap counts bulk subtasks too', async () => {
      const { user, ws, project } = await world(AccountType.PERSONAL);
      for (let i = 0; i < 48; i++)
        await createTask(prisma, {
          workspaceId: ws.id,
          createdById: user.id,
          projectId: project.id,
        });
      const items = [
        { title: 'r', projectId: project.id },
        { title: 'c1', projectId: project.id, parentIndex: 0 },
        { title: 'c2', projectId: project.id, parentIndex: 0 },
      ];
      const err: BulkWriteError = await writer
        .createTasksBulk(ws.id, items, user.id, ctx)
        .catch((e) => e);
      expect(err.code).toBe('PLAN_LIMIT_EXCEEDED');
    });
  });
});
