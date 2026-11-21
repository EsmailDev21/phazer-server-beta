/**
 * Step 0.8, database level: what the unit specs cannot prove because they use
 * a Prisma double. Needs a real Postgres + generated Prisma Client
 * (`npm run test:integration`). WRITTEN, NOT EXECUTED in the sandbox that
 * produced it (no Prisma engine) - type-checked only; the migration itself was
 * verified separately on a real Postgres.
 */
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { ConflictException } from '@nestjs/common';
import { ActivityAction } from '@prisma/client';
import { TagsService } from '../../src/projects-tasks/tags/tags.service';
import { ActivityService } from '../../src/events/activity.service';
import { PermissionResolver } from '../../src/access-control/access-control.service';
import { PlanLimitsService } from '../../src/access-control/plan-limits.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import {
  getTestPrisma,
  disconnectTestPrisma,
} from './support/prisma-test-client';
import { resetDb } from './support/reset-db';
import {
  createUserWithAccount,
  createWorkspace,
  createTask,
} from './factories';

describe('TagsService (real database)', () => {
  let prisma: PrismaService;
  let tags: TagsService;

  beforeAll(async () => {
    prisma = getTestPrisma();
    const moduleRef = await Test.createTestingModule({
      providers: [
        // Registered directly: overrideProvider() only replaces a provider that
        // already exists in the module, and PrismaService is deliberately not
        // part of these minimal test modules.
        { provide: PrismaService, useValue: prisma },
        // ActivityService publishes 'activity.created' through this.
        { provide: EventEmitter2, useValue: new EventEmitter2() },
        TagsService,
        ActivityService,
        PermissionResolver,
        PlanLimitsService,
      ],
    }).compile();
    tags = moduleRef.get(TagsService);
  });
  beforeEach(() => resetDb(prisma));
  afterAll(() => disconnectTestPrisma());

  async function scenario() {
    const { user, account } = await createUserWithAccount(prisma);
    const workspace = await createWorkspace(prisma, { accountId: account.id });
    const other = await createWorkspace(prisma, { accountId: account.id });
    const task = await createTask(prisma, {
      workspaceId: workspace.id,
      createdById: user.id,
    });
    return { user, workspace, other, task };
  }

  it('names are unique case-insensitively per workspace, but not across workspaces', async () => {
    const { workspace, other } = await scenario();
    await tags.create(workspace.id, { name: 'Bug' });
    await expect(
      tags.create(workspace.id, { name: ' bUG ' }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(tags.create(other.id, { name: 'bug' })).resolves.toMatchObject(
      { name: 'bug' },
    );
  });

  it('10 concurrent creates of case-variants: exactly one wins, the rest 409', async () => {
    const { workspace } = await scenario();
    const names = Array.from({ length: 10 }, (_, i) =>
      i % 2 ? 'RACE' : 'race',
    );
    const results = await Promise.allSettled(
      names.map((name) => tags.create(workspace.id, { name })),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter(
      (r) => r.status === 'rejected',
    ) as PromiseRejectedResult[];
    expect(rejected).toHaveLength(9);
    expect(rejected.every((r) => r.reason instanceof ConflictException)).toBe(
      true,
    );
    expect(
      await prisma.tag.count({ where: { workspaceId: workspace.id } }),
    ).toBe(1);
  });

  it('attach is idempotent (one TAG_ADDED row), detach logs TAG_REMOVED, second detach 404s', async () => {
    const { user, workspace, task } = await scenario();
    const tag = await tags.create(workspace.id, { name: 'x' });
    await tags.attach(task.id, tag.id, user.id);
    await tags.attach(task.id, tag.id, user.id);
    await Promise.all([
      tags.attach(task.id, tag.id, user.id),
      tags.attach(task.id, tag.id, user.id),
    ]);
    expect(await prisma.taskTag.count({ where: { taskId: task.id } })).toBe(1);
    expect(
      await prisma.activity.count({
        where: { targetId: task.id, action: ActivityAction.TAG_ADDED },
      }),
    ).toBe(1);

    await tags.detach(task.id, tag.id, user.id);
    expect(
      await prisma.activity.count({
        where: { targetId: task.id, action: ActivityAction.TAG_REMOVED },
      }),
    ).toBe(1);
    await expect(tags.detach(task.id, tag.id, user.id)).rejects.toThrow(
      'not attached',
    );
  });

  it('a tag from another workspace cannot be attached', async () => {
    const { user, other, task } = await scenario();
    const foreign = await tags.create(other.id, { name: 'foreign' });
    await expect(tags.attach(task.id, foreign.id, user.id)).rejects.toThrow(
      'workspace',
    );
    expect(await prisma.taskTag.count()).toBe(0);
  });

  it('deleting a tag removes it from every task; list reports task counts', async () => {
    const { user, workspace, task } = await scenario();
    const task2 = await createTask(prisma, {
      workspaceId: workspace.id,
      createdById: user.id,
    });
    const tag = await tags.create(workspace.id, { name: 'gone' });
    await tags.attach(task.id, tag.id, user.id);
    await tags.attach(task2.id, tag.id, user.id);
    // userId must have workspace-level access: the account owner does.
    expect(
      (await tags.listByWorkspace(workspace.id, user.id))[0],
    ).toMatchObject({ name: 'gone', taskCount: 2 });
    await tags.delete(tag.id, user.id);
    expect(await prisma.taskTag.count()).toBe(0);
  });

  it('renaming to a case-variant of ITSELF is allowed; onto another tag is 409', async () => {
    const { user, workspace } = await scenario();
    const a = await tags.create(workspace.id, { name: 'alpha' });
    await tags.create(workspace.id, { name: 'beta' });
    await expect(
      tags.update(a.id, { name: 'Alpha' }, user.id),
    ).resolves.toMatchObject({ name: 'Alpha' });
    await expect(
      tags.update(a.id, { name: 'BETA' }, user.id),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
