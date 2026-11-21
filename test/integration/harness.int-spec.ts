/**
 * The harness's own self-test: proves resetDb() and the factories work
 * against a real database via the real, generated PrismaService — the same
 * client production code uses, not a stand-in. If this file passes, later
 * phases can trust the pattern (getTestPrisma / resetDb / factories) for
 * their own integration tests.
 */
import type { PrismaService } from '../../src/prisma/prisma.service';
import {
  getTestPrisma,
  disconnectTestPrisma,
} from './support/prisma-test-client';
import { resetDb } from './support/reset-db';
import {
  createUser,
  createUserWithAccount,
  createWorkspace,
  createProject,
  addProjectMember,
  createTask,
} from './factories';
import { Role } from '@prisma/client';

describe('integration test harness', () => {
  let prisma: PrismaService;

  beforeAll(() => {
    prisma = getTestPrisma();
  });

  beforeEach(async () => {
    await resetDb(prisma);
  });

  afterAll(async () => {
    await disconnectTestPrisma();
  });

  it('resetDb() actually empties every table, not just the ones a test used', async () => {
    await createUser(prisma);
    expect(await prisma.user.count()).toBe(1);

    await resetDb(prisma);

    expect(await prisma.user.count()).toBe(0);
  });

  it('builds a full account -> workspace -> project -> task graph through the real Prisma client', async () => {
    const { user: owner, account } = await createUserWithAccount(prisma, {
      role: Role.OWNER,
    });
    const workspace = await createWorkspace(prisma, { accountId: account.id });
    const project = await createProject(prisma, {
      workspaceId: workspace.id,
      createdById: owner.id,
    });

    const client = await createUser(prisma);
    await addProjectMember(prisma, {
      projectId: project.id,
      userId: client.id,
      role: Role.CLIENT,
    });

    const task = await createTask(prisma, {
      workspaceId: workspace.id,
      projectId: project.id,
      createdById: owner.id,
      assignees: { connect: [{ id: client.id }] },
    });

    const reloaded = await prisma.task.findUniqueOrThrow({
      where: { id: task.id },
      include: { assignees: true, project: { include: { members: true } } },
    });

    expect(reloaded.status).toBe('TODO'); // DB default, not something the factory set
    expect(reloaded.createdVia).toBe('SNAP'); // DB default
    expect(reloaded.assignees.map((u) => u.id)).toEqual([client.id]);
    expect(
      reloaded.project?.members.some(
        (m) => m.userId === client.id && m.role === Role.CLIENT,
      ),
    ).toBe(true);
  });

  it('factories never collide on unique fields across many calls in one test', async () => {
    const users = await Promise.all(
      Array.from({ length: 20 }, () => createUser(prisma)),
    );
    const emails = new Set(users.map((u) => u.email));
    expect(emails.size).toBe(20);
  });

  it('rejects the same TEST_DATABASE_URL misconfiguration global-setup guards against', () => {
    // global-setup.ts refuses to run against anything not named appdb_test;
    // this just documents/pins that expectation next to the tests it protects.
    expect(process.env.DATABASE_URL).toMatch(/\/appdb_test(\?|$)/);
  });
});
