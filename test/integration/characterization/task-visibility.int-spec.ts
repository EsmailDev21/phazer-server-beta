/**
 * Pins TaskVisibilityService's CURRENT rule, verbatim from its own class
 * doc (the "Sarah" example): a Tier1-only ProjectMember — no workspace-level
 * (Tier2/Tier3) access at all — sees ONLY the task(s) of the project(s)
 * they're a member of, never other projects, never Inbox tasks. Genuine
 * workspace-level access (here: AccountMember, Tier3) sees everything.
 *
 * This is exactly the rule Phase 1 subtasks/workflow-status work must not
 * quietly change.
 */
import { Test } from '@nestjs/testing';
import { TaskVisibilityService } from '../../../src/projects-tasks/tasks/task-visibility.service';
import { PermissionResolver } from '../../../src/access-control/access-control.service';
import { PlanLimitsService } from '../../../src/access-control/plan-limits.service';
import { PrismaService } from '../../../src/prisma/prisma.service';
import {
  getTestPrisma,
  disconnectTestPrisma,
} from '../support/prisma-test-client';
import { resetDb } from '../support/reset-db';
import {
  createUser,
  createUserWithAccount,
  createWorkspace,
  createProject,
  addProjectMember,
  createTask,
} from '../factories';
import { Role } from '@prisma/client';

describe('TaskVisibilityService (characterization)', () => {
  let prisma: PrismaService;
  let visibility: TaskVisibilityService;

  beforeAll(async () => {
    prisma = getTestPrisma();
    const moduleRef = await Test.createTestingModule({
      providers: [
        // Registered directly: overrideProvider() only replaces a provider that
        // already exists in the module, and PrismaService is deliberately not
        // part of these minimal test modules.
        { provide: PrismaService, useValue: prisma },
        TaskVisibilityService,
        PermissionResolver,
        PlanLimitsService,
      ],
    }).compile();
    visibility = moduleRef.get(TaskVisibilityService);
  });

  beforeEach(() => resetDb(prisma));
  afterAll(() => disconnectTestPrisma());

  async function twoProjectWorkspace() {
    const { user: owner, account } = await createUserWithAccount(prisma, {
      role: Role.OWNER,
    });
    const workspace = await createWorkspace(prisma, { accountId: account.id });
    const projectA = await createProject(prisma, {
      workspaceId: workspace.id,
      createdById: owner.id,
    });
    const projectB = await createProject(prisma, {
      workspaceId: workspace.id,
      createdById: owner.id,
    });

    const taskA = await createTask(prisma, {
      workspaceId: workspace.id,
      projectId: projectA.id,
      createdById: owner.id,
    });
    const taskB = await createTask(prisma, {
      workspaceId: workspace.id,
      projectId: projectB.id,
      createdById: owner.id,
    });
    const inboxTask = await createTask(prisma, {
      workspaceId: workspace.id,
      createdById: owner.id,
    }); // no project

    return {
      owner,
      account,
      workspace,
      projectA,
      projectB,
      taskA,
      taskB,
      inboxTask,
    };
  }

  it('CURRENT ("Sarah" rule): a Tier1-only ProjectMember sees ONLY their project\'s task, not the other project\'s, not Inbox', async () => {
    const { workspace, projectA, taskA, taskB, inboxTask } =
      await twoProjectWorkspace();
    const sarah = await createUser(prisma);
    await addProjectMember(prisma, {
      projectId: projectA.id,
      userId: sarah.id,
      role: Role.MEMBER,
    });

    expect(await visibility.canViewTask(sarah.id, taskA.id)).toBe(true);
    expect(await visibility.canViewTask(sarah.id, taskB.id)).toBe(false);
    expect(await visibility.canViewTask(sarah.id, inboxTask.id)).toBe(false);

    const where = await visibility.buildVisibleTasksWhere(sarah.id, {
      workspaceId: workspace.id,
    });
    const visible = await prisma.task.findMany({ where, select: { id: true } });
    expect(visible.map((t) => t.id).sort()).toEqual([taskA.id].sort());
  });

  it('CURRENT: this applies to ANY Tier1-only role, not just CLIENT — a Tier1-only MEMBER is scoped identically', async () => {
    const { projectA, taskA, taskB } = await twoProjectWorkspace();
    const memberOnly = await createUser(prisma);
    await addProjectMember(prisma, {
      projectId: projectA.id,
      userId: memberOnly.id,
      role: Role.MEMBER,
    });

    expect(await visibility.canViewTask(memberOnly.id, taskA.id)).toBe(true);
    expect(await visibility.canViewTask(memberOnly.id, taskB.id)).toBe(false);
  });

  it('CURRENT: genuine workspace-level access (Tier3 AccountMember) sees every task, including Inbox', async () => {
    const { account, workspace, taskA, taskB, inboxTask } =
      await twoProjectWorkspace();
    const admin = await createUser(prisma);
    await prisma.accountMember.create({
      data: { accountId: account.id, userId: admin.id, role: Role.ADMIN },
    });

    for (const t of [taskA, taskB, inboxTask]) {
      expect(await visibility.canViewTask(admin.id, t.id)).toBe(true);
    }
    const where = await visibility.buildVisibleTasksWhere(admin.id, {
      workspaceId: workspace.id,
    });
    const visible = await prisma.task.findMany({ where, select: { id: true } });
    expect(visible.map((t) => t.id).sort()).toEqual(
      [taskA.id, taskB.id, inboxTask.id].sort(),
    );
  });

  it('CURRENT: a user with NEITHER workspace-level NOR any ProjectMember row is rejected entirely', async () => {
    const { workspace, taskA } = await twoProjectWorkspace();
    const stranger = await createUser(prisma);

    expect(await visibility.canViewTask(stranger.id, taskA.id)).toBe(false);
    await expect(
      visibility.buildVisibleTasksWhere(stranger.id, {
        workspaceId: workspace.id,
      }),
    ).rejects.toThrow(/do not have access to this workspace/);
  });

  it("CURRENT: a Tier1-only member requesting a DIFFERENT project's filter is rejected, not silently emptied", async () => {
    const { projectA, projectB } = await twoProjectWorkspace();
    const sarah = await createUser(prisma);
    await addProjectMember(prisma, {
      projectId: projectA.id,
      userId: sarah.id,
      role: Role.MEMBER,
    });

    await expect(
      visibility.buildVisibleTasksWhere(sarah.id, {
        workspaceId: (
          await prisma.project.findUniqueOrThrow({ where: { id: projectB.id } })
        ).workspaceId,
        projectId: projectB.id,
      }),
    ).rejects.toThrow(/do not have access to this project/);
  });
});
