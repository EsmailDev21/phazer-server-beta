/**
 * Pins PlanLimitsService.checkLimit's CURRENT edge cases — each one is a
 * real, deliberate product decision documented in billing-tiers.config.ts
 * and plan-limits.service.ts, not an obvious default. Phase 4 (imports) in
 * particular must respect every one of these, not just the happy path.
 */
import { Test } from '@nestjs/testing';
import { PlanLimitsService } from '../../../src/access-control/plan-limits.service';
import { PrismaService } from '../../../src/prisma/prisma.service';
import {
  getTestPrisma,
  disconnectTestPrisma,
} from '../support/prisma-test-client';
import { resetDb } from '../support/reset-db';
import {
  createUserWithAccount,
  createWorkspace,
  createProject,
  createTask,
} from '../factories';
import { AccountType } from '@prisma/client';

describe('PlanLimitsService.checkLimit (characterization)', () => {
  let prisma: PrismaService;
  let planLimits: PlanLimitsService;

  beforeAll(async () => {
    prisma = getTestPrisma();
    const moduleRef = await Test.createTestingModule({
      providers: [
        // Registered directly: overrideProvider() only replaces a provider that
        // already exists in the module, and PrismaService is deliberately not
        // part of these minimal test modules.
        { provide: PrismaService, useValue: prisma },
        PlanLimitsService,
      ],
    }).compile();
    planLimits = moduleRef.get(PlanLimitsService);
  });

  beforeEach(() => resetDb(prisma));
  afterAll(() => disconnectTestPrisma());

  it('CURRENT: FREE_PERSONAL allows the 50th task in a project but blocks the 51st', async () => {
    const { user, account } = await createUserWithAccount(prisma);
    // planType defaults per the schema; FREE_PERSONAL's task cap (50/project) is what's under test.
    const workspace = await createWorkspace(prisma, { accountId: account.id });
    const project = await createProject(prisma, {
      workspaceId: workspace.id,
      createdById: user.id,
    });

    for (let i = 0; i < 49; i++) {
      await createTask(prisma, {
        workspaceId: workspace.id,
        projectId: project.id,
        createdById: user.id,
      });
    }
    expect(await prisma.task.count({ where: { projectId: project.id } })).toBe(
      49,
    );
    expect(
      await planLimits.checkLimit('task', 'createTask', {
        accountId: account.id,
        projectId: project.id,
      }),
    ).toBe(true); // 49 < 50, the 50th is allowed

    await createTask(prisma, {
      workspaceId: workspace.id,
      projectId: project.id,
      createdById: user.id,
    });
    expect(
      await planLimits.checkLimit('task', 'createTask', {
        accountId: account.id,
        projectId: project.id,
      }),
    ).toBe(false); // now at 50, the 51st is blocked
  });

  it('CURRENT: an Inbox task (no projectId in context) is never blocked by the per-project task cap', async () => {
    const { account } = await createUserWithAccount(prisma);
    const workspace = await createWorkspace(prisma, { accountId: account.id });
    // No projectId passed at all - matches how TasksService.create() calls this for Inbox tasks.
    expect(
      await planLimits.checkLimit('task', 'createTask', {
        accountId: account.id,
      }),
    ).toBe(true);
    void workspace;
  });

  it('CURRENT: archived tasks do not count against the per-project task cap', async () => {
    const { user, account } = await createUserWithAccount(prisma);
    const workspace = await createWorkspace(prisma, { accountId: account.id });
    const project = await createProject(prisma, {
      workspaceId: workspace.id,
      createdById: user.id,
    });

    for (let i = 0; i < 60; i++) {
      await createTask(prisma, {
        workspaceId: workspace.id,
        projectId: project.id,
        createdById: user.id,
        isArchived: true,
      });
    }
    // 60 archived tasks exist, but none count -> still well under the 50 cap.
    expect(
      await planLimits.checkLimit('task', 'createTask', {
        accountId: account.id,
        projectId: project.id,
      }),
    ).toBe(true);
  });

  it('CURRENT: ORGANIZATION accounts are NEVER capped on tasks, at any tier', async () => {
    const { user, account } = await createUserWithAccount(prisma, {
      accountType: AccountType.ORGANIZATION,
    });
    const workspace = await createWorkspace(prisma, { accountId: account.id });
    const project = await createProject(prisma, {
      workspaceId: workspace.id,
      createdById: user.id,
    });
    for (let i = 0; i < 60; i++) {
      await createTask(prisma, {
        workspaceId: workspace.id,
        projectId: project.id,
        createdById: user.id,
      });
    }
    expect(
      await planLimits.checkLimit('task', 'createTask', {
        accountId: account.id,
        projectId: project.id,
      }),
    ).toBe(true);
  });

  it('CURRENT: "storage" is always true from this service — handled entirely inside AttachmentsService instead', async () => {
    const { account } = await createUserWithAccount(prisma);
    expect(
      await planLimits.checkLimit('storage' as any, 'createTask', {
        accountId: account.id,
      }),
    ).toBe(true);
  });
});
