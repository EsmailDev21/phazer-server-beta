/**
 * Step 0.7 on a REAL engine: what the in-memory double in
 * src/domain-writer/domain-writer.spec.ts cannot prove. Real
 * createManyAndReturn, real transactions (commit and rollback), real
 * implicit-m2m assignee writes, real post-commit event ordering.
 */
import { TaskPlanningService } from '../../src/projects-tasks/planning/task-planning.service';
import { WorkflowService } from '../../src/projects-tasks/workflow/workflow.service';
import { Test } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AccountType } from '@prisma/client';
import {
  DomainWriter,
  BulkWriteError,
} from '../../src/domain-writer/domain-writer.service';
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
import {
  getTestPrisma,
  disconnectTestPrisma,
} from './support/prisma-test-client';
import { resetDb } from './support/reset-db';
import {
  createProject,
  createUser,
  createUserWithAccount,
  createWorkspace,
  createTask,
} from './factories';

describe('DomainWriter (real database)', () => {
  let prisma: PrismaService;
  let writer: DomainWriter;
  let emitter: EventEmitter2;
  let emitted: Array<{ targetId: string }>;

  beforeAll(async () => {
    prisma = getTestPrisma();
    emitter = new EventEmitter2();
    const moduleRef = await Test.createTestingModule({
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: emitter },
        { provide: WorkspacesService, useValue: {} },
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
        DomainWriter,
      ],
    }).compile();
    writer = moduleRef.get(DomainWriter);
  });
  beforeEach(async () => {
    await resetDb(prisma);
    emitted = [];
    emitter.removeAllListeners('activity.created');
    emitter.on('activity.created', (a) => emitted.push(a));
  });
  afterAll(() => disconnectTestPrisma());

  async function scenario(accountType: AccountType = AccountType.ORGANIZATION) {
    const { user, account } = await createUserWithAccount(prisma, {
      accountType,
    });
    const workspace = await createWorkspace(prisma, { accountId: account.id });
    const project = await createProject(prisma, {
      workspaceId: workspace.id,
      createdById: user.id,
    });
    return { user, account, workspace, project };
  }
  const items = (n: number, projectId: string) =>
    Array.from({ length: n }, (_, i) => ({ title: `T${i}`, projectId }));
  const imp = (over = {}) => ({
    origin: 'IMPORT' as const,
    actorId: null,
    importJobId: 'job1',
    ...over,
  });

  it('bulk: 250 tasks in 3 chunks, all IMPORT, all history SILENT with the job id, nothing emitted', async () => {
    const { user, workspace, project } = await scenario();
    const res = await writer.createTasksBulk(
      workspace.id,
      items(250, project.id),
      user.id,
      imp(),
    );
    expect(res.chunks).toBe(3);
    expect(
      await prisma.task.count({ where: { workspaceId: workspace.id } }),
    ).toBe(250);
    expect(await prisma.task.count({ where: { createdVia: 'IMPORT' } })).toBe(
      250,
    );
    const acts = await prisma.activity.findMany({
      where: { workspaceId: workspace.id },
    });
    expect(acts).toHaveLength(250);
    expect(acts.every((a) => a.visibility === 'SILENT')).toBe(true);
    expect(
      acts.every(
        (a) =>
          (a.metadata as any).importJobId === 'job1' &&
          (a.metadata as any).origin === 'IMPORT',
      ),
    ).toBe(true);
    expect(emitted).toHaveLength(0);
  });

  it('bulk: assignees land on the right task (matched by id, not by return order)', async () => {
    const { user, workspace, project } = await scenario();
    const other = await createUser(prisma);
    const list = items(30, project.id).map((i, n) =>
      n === 17 ? { ...i, assigneeIds: [other.id, user.id] } : i,
    );
    await writer.createTasksBulk(workspace.id, list, user.id, imp());
    const seventeen = await prisma.task.findFirst({
      where: { title: 'T17' },
      include: { assignees: true },
    });
    expect(seventeen!.assignees.map((u) => u.id).sort()).toEqual(
      [other.id, user.id].sort(),
    );
    const withAssignees = await prisma.task.count({
      where: { assignees: { some: {} } },
    });
    expect(withAssignees).toBe(1);
  });

  it('original dates are honoured by the real engine, bulk and single (the step-0.7 open question)', async () => {
    const { user, workspace, project } = await scenario();
    const when = new Date('2020-01-02T03:04:05Z');
    const ctx = imp({ keepOriginalDates: true });
    await writer.createTasksBulk(
      workspace.id,
      [
        {
          title: 'bulk-old',
          projectId: project.id,
          createdAt: when,
          updatedAt: when,
        },
      ],
      user.id,
      ctx,
    );
    await writer.createTask(
      { workspaceId: workspace.id, projectId: project.id, title: 'single-old' },
      user.id,
      ctx,
      { createdAt: when, updatedAt: when },
    );
    for (const title of ['bulk-old', 'single-old']) {
      const t = await prisma.task.findFirstOrThrow({ where: { title } });
      expect(t.createdAt).toEqual(when);
      expect(t.updatedAt).toEqual(when);
    }
  });

  it('a chunk that fails halfway rolls back everything in it - tasks, assignees AND history', async () => {
    const { user, workspace, project } = await scenario();
    const list = items(5, project.id);
    list[3] = { ...list[3], assigneeIds: ['no-such-user'] } as any;
    const err = await writer
      .createTasksBulk(workspace.id, list, user.id, imp())
      .catch((e) => e);
    expect(err).toBeInstanceOf(BulkWriteError);
    expect(await prisma.task.count()).toBe(0);
    expect(await prisma.activity.count()).toBe(0);
  });

  it('plan cap: chunks up to the limit commit, the first chunk past it writes nothing, error says where', async () => {
    const { user, workspace, project } = await scenario(AccountType.PERSONAL); // FREE_PERSONAL: 50/project
    for (let i = 0; i < 40; i++)
      await createTask(prisma, {
        workspaceId: workspace.id,
        createdById: user.id,
        projectId: project.id,
      });
    const err: BulkWriteError = await writer
      .createTasksBulk(workspace.id, items(30, project.id), user.id, imp(), {
        chunkSize: 10,
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(BulkWriteError);
    expect(err.code).toBe('PLAN_LIMIT_EXCEEDED');
    expect(err.chunkIndex).toBe(1);
    expect(err.createdIds).toHaveLength(10);
    expect(await prisma.task.count({ where: { projectId: project.id } })).toBe(
      50,
    );
  });

  it('two bulk writes into the same workspace at once both complete without losing rows', async () => {
    const { user, workspace, project } = await scenario();
    await Promise.all([
      writer.createTasksBulk(
        workspace.id,
        items(60, project.id),
        user.id,
        imp({ importJobId: 'a' }),
        { chunkSize: 20 },
      ),
      writer.createTasksBulk(
        workspace.id,
        items(60, project.id),
        user.id,
        imp({ importJobId: 'b' }),
        { chunkSize: 20 },
      ),
    ]);
    expect(
      await prisma.task.count({ where: { workspaceId: workspace.id } }),
    ).toBe(120);
  });

  it('single write: the event fires only AFTER commit, and a listener can already read the row', async () => {
    const { user, workspace, project } = await scenario();
    let seenInListener: unknown = 'not-run';
    emitter.removeAllListeners('activity.created');
    emitter.on('activity.created', async (a: { targetId: string }) => {
      seenInListener = await prisma.task.findUnique({
        where: { id: a.targetId },
      });
    });
    const task = await writer.createTask(
      { workspaceId: workspace.id, projectId: project.id, title: 'visible' },
      user.id,
      { origin: 'INTEGRATION', actorId: user.id },
    );
    await new Promise((r) => setTimeout(r, 100));
    expect((seenInListener as { id: string } | null)?.id).toBe(task.id);
  });

  it('rolled-back run(): no row, no history, no event', async () => {
    const { user, workspace, project } = await scenario();
    await expect(
      writer.run({ origin: 'INTEGRATION', actorId: user.id }, async (c) => {
        await writer['tasks'].create(
          { workspaceId: workspace.id, projectId: project.id, title: 'ghost' },
          user.id,
          c,
        );
        throw new Error('later step failed');
      }),
    ).rejects.toThrow('later step failed');
    expect(await prisma.task.count()).toBe(0);
    expect(await prisma.activity.count()).toBe(0);
    expect(emitted).toHaveLength(0);
  });
});
