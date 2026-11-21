/**
 * Pins a representative sample of PermissionResolver.resolve()'s CURRENT
 * role matrix, exercised through the real 9-step algorithm against real DB
 * rows (not by re-reading ROLE_PERMISSIONS as data — that would just test
 * the config file against itself). Not exhaustive (the full matrix is
 * Role x ActionName, hundreds of cells) - picks the actions/roles that
 * most directly document the tiering rules, per ROLE_PERMISSIONS' own
 * class doc: OWNER > ADMIN > MEMBER > VIEWER > CLIENT, and CLIENT's
 * workspace/account-level blindness in particular.
 */
import { Test } from '@nestjs/testing';
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

describe('PermissionResolver.resolve (characterization: role matrix sample)', () => {
  let prisma: PrismaService;
  let resolver: PermissionResolver;

  beforeAll(async () => {
    prisma = getTestPrisma();
    const moduleRef = await Test.createTestingModule({
      providers: [
        // Registered directly: overrideProvider() only replaces a provider that
        // already exists in the module, and PrismaService is deliberately not
        // part of these minimal test modules.
        { provide: PrismaService, useValue: prisma },
        PermissionResolver,
        PlanLimitsService,
      ],
    }).compile();
    resolver = moduleRef.get(PermissionResolver);
  });

  beforeEach(() => resetDb(prisma));
  afterAll(() => disconnectTestPrisma());

  async function accountMemberWithRole(role: Role) {
    const { user, account } = await createUserWithAccount(prisma, { role });
    const workspace = await createWorkspace(prisma, { accountId: account.id });
    return { user, account, workspace };
  }

  it("CURRENT: OWNER can deleteAccount; ADMIN, the account's highest non-owner tier, cannot", async () => {
    const owner = await accountMemberWithRole(Role.OWNER);
    expect(
      (
        await resolver.resolve(
          owner.user.id,
          'deleteAccount',
          'ACCOUNT',
          owner.account.id,
        )
      ).allowed,
    ).toBe(true);

    const admin = await accountMemberWithRole(Role.ADMIN);
    expect(
      (
        await resolver.resolve(
          admin.user.id,
          'deleteAccount',
          'ACCOUNT',
          admin.account.id,
        )
      ).allowed,
    ).toBe(false);
  });

  it('CURRENT: OWNER and ADMIN can both editWorkspace; MEMBER cannot', async () => {
    const admin = await accountMemberWithRole(Role.ADMIN);
    expect(
      (
        await resolver.resolve(
          admin.user.id,
          'editWorkspace',
          'WORKSPACE',
          admin.workspace.id,
        )
      ).allowed,
    ).toBe(true);

    const member = await accountMemberWithRole(Role.MEMBER);
    expect(
      (
        await resolver.resolve(
          member.user.id,
          'editWorkspace',
          'WORKSPACE',
          member.workspace.id,
        )
      ).allowed,
    ).toBe(false);
  });

  it('CURRENT: MEMBER can createTask; VIEWER cannot (read-only)', async () => {
    const member = await accountMemberWithRole(Role.MEMBER);
    expect(
      (
        await resolver.resolve(
          member.user.id,
          'createTask',
          'WORKSPACE',
          member.workspace.id,
        )
      ).allowed,
    ).toBe(true);

    const viewer = await accountMemberWithRole(Role.VIEWER);
    expect(
      (
        await resolver.resolve(
          viewer.user.id,
          'createTask',
          'WORKSPACE',
          viewer.workspace.id,
        )
      ).allowed,
    ).toBe(false);
  });

  it('CURRENT: a Tier1-only CLIENT (ProjectMember, no AccountMember row) is denied a WORKSPACE-scoped action entirely', async () => {
    const { account } = await createUserWithAccount(prisma, {
      role: Role.OWNER,
    });
    const workspace = await createWorkspace(prisma, { accountId: account.id });
    const owner2 = await createUser(prisma); // separate user, becomes the project creator
    const project = await createProject(prisma, {
      workspaceId: workspace.id,
      createdById: owner2.id,
    });

    const client = await createUser(prisma);
    await addProjectMember(prisma, {
      projectId: project.id,
      userId: client.id,
      role: Role.CLIENT,
    });

    // createTask is WORKSPACE-scoped in ACTION_CONFIG — a Tier1-only
    // ProjectMember has no path to a workspace-scoped action at all,
    // regardless of role (this is the same rule task-visibility.int-spec.ts
    // pins for reads; this is the write/action-check side of it).
    const result = await resolver.resolve(
      client.id,
      'createTask',
      'WORKSPACE',
      workspace.id,
    );
    expect(result.allowed).toBe(false);
  });

  it('CURRENT: a plan-limit denial sets planLimitExceeded=true, distinct from a role denial', async () => {
    const { user, workspace } = await accountMemberWithRole(Role.OWNER);
    const project = await createProject(prisma, {
      workspaceId: workspace.id,
      createdById: user.id,
    });
    // FREE_PERSONAL caps tasks at 50/project (see plan-limits.int-spec.ts) - fill it exactly to the cap.
    for (let i = 0; i < 50; i++) {
      await createTask(prisma, {
        workspaceId: workspace.id,
        projectId: project.id,
        title: `t${i}`,
        createdById: user.id,
      });
    }
    const result = await resolver.resolve(
      user.id,
      'createTask',
      'PROJECT',
      project.id,
    );
    expect(result.allowed).toBe(false);
    expect(result.planLimitExceeded).toBe(true);
  });
});
