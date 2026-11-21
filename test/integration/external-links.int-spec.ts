/**
 * Step 1.5 (ADR-0007) on a real database: issue types and iterations.
 */
import { Test } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AccountType } from '@prisma/client';
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
import { CustomFieldsService } from '../../src/projects-tasks/custom-fields/custom-fields.service';
import { WorkspacesService } from '../../src/tenancy/workspaces/workspaces.service';
import { WorkspaceKeysService } from '../../src/tenancy/workspaces/workspace-keys.service';
import { getTestPrisma, disconnectTestPrisma } from './support/prisma-test-client';
import { resetDb } from './support/reset-db';
import { createUserWithAccount, createWorkspace } from './factories';
import { MAX_EXTERNAL_LINKS_IN_DETAIL } from '../../src/projects-tasks/tasks/dto/task-response.dto';

describe('ExternalLink: model + read in task detail (step 1.6)', () => {
  let prisma: PrismaService;
  let tasks: TasksService;
  let projects: ProjectsService;

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
  });
  beforeEach(() => resetDb(prisma));
  afterAll(() => disconnectTestPrisma());

  async function world() {
    const { user, account } = await createUserWithAccount(prisma, {
      accountType: AccountType.ORGANIZATION,
    });
    const ws = await createWorkspace(prisma, { accountId: account.id });
    const project = await projects.create({ workspaceId: ws.id, name: 'P' }, user.id);
    const mk = (title = 't', over: Record<string, unknown> = {}) =>
      tasks.create({ workspaceId: ws.id, title, projectId: project.id, ...over } as never, user.id);
    const link = (taskId: string, over: Record<string, unknown> = {}) =>
      prisma.externalLink.create({
        data: {
          taskId,
          provider: 'GITHUB',
          kind: 'PR',
          externalId: 'acme/api#42',
          url: 'https://github.com/acme/api/pull/42',
          title: 'Fix login',
          state: 'open',
          ...over,
        },
      });
    return { user, ws, project, mk, link };
  }
  /** What a client actually receives. */
  const wire = (d: unknown) => JSON.parse(JSON.stringify(d));

  it('a task with no links reads as an empty list and a zero count', async () => {
    const { user, mk } = await world();
    const t = await mk();
    const d = await tasks.getDetail(t.id, user.id);
    expect(d.externalLinks).toEqual([]);
    expect(d.externalLinkCount).toBe(0);
  });

  it('serialization: exactly the public fields, ISO date, null state as null; no internal columns leak', async () => {
    const { user, mk, link } = await world();
    const t = await mk();
    const row = await link(t.id, { kind: 'MESSAGE', provider: 'SLACK', externalId: 'C1/1700.1', url: 'https://acme.slack.com/archives/C1/p17001', title: 'thread', state: null });
    const d = wire(await tasks.getDetail(t.id, user.id));
    expect(d.externalLinkCount).toBe(1);
    expect(d.externalLinks).toEqual([
      {
        id: row.id,
        provider: 'SLACK',
        kind: 'MESSAGE',
        externalId: 'C1/1700.1',
        url: 'https://acme.slack.com/archives/C1/p17001',
        title: 'thread',
        state: null,
        lastSeenAt: row.lastSeenAt.toISOString(),
      },
    ]);
    expect(Object.keys(d.externalLinks[0]).sort()).toEqual(
      ['externalId', 'id', 'kind', 'lastSeenAt', 'provider', 'state', 'title', 'url'],
    );
  });

  it('newest first (by lastSeenAt), ties by id; links of other tasks and of subtasks are not mixed in', async () => {
    const { ws, user, mk, link } = await world();
    const t = await mk();
    const other = await mk('other');
    const child = await tasks.create({ workspaceId: ws.id, title: 'c', parentId: t.id } as never, user.id);
    const old = await link(t.id, { externalId: 'a', lastSeenAt: new Date('2026-01-01T00:00:00Z') });
    const fresh = await link(t.id, { externalId: 'b', kind: 'BRANCH', lastSeenAt: new Date('2026-03-01T00:00:00Z') });
    await link(other.id, { externalId: 'x' });
    await link(child.id, { externalId: 'y' });
    const d = await tasks.getDetail(t.id, user.id);
    expect(d.externalLinks.map((l) => l.id)).toEqual([fresh.id, old.id]);
    expect(d.externalLinkCount).toBe(2);
  });

  it('is capped at 50 newest; the count still says how many there really are', async () => {
    const { user, mk } = await world();
    const t = await mk();
    await prisma.externalLink.createMany({
      data: Array.from({ length: 60 }, (_, i) => ({
        taskId: t.id,
        provider: 'GITHUB' as const,
        kind: 'COMMIT' as const,
        externalId: `sha${i}`,
        url: `https://github.com/acme/api/commit/sha${i}`,
        title: `commit ${i}`,
        lastSeenAt: new Date(Date.UTC(2026, 0, 1, 0, i)),
      })),
    });
    const d = await tasks.getDetail(t.id, user.id);
    expect(d.externalLinks).toHaveLength(MAX_EXTERNAL_LINKS_IN_DETAIL);
    expect(d.externalLinkCount).toBe(60);
    expect(d.externalLinks[0].externalId).toBe('sha59'); // newest
    expect(d.externalLinks.at(-1)!.externalId).toBe('sha10');
  });

  it('a user who cannot see the task gets no detail, so no links', async () => {
    const { mk, link } = await world();
    const t = await mk();
    await link(t.id);
    const { user: stranger } = await createUserWithAccount(prisma, { accountType: AccountType.ORGANIZATION });
    await expect(tasks.getDetail(t.id, stranger.id)).rejects.toThrow();
  });

  describe('database guarantees', () => {
    it.each([
      'javascript:alert(1)',
      'data:text/html,<script>1</script>',
      'file:///etc/passwd',
      'ftp://x/y',
      '//evil.example/x',
      'github.com/acme/api/pull/1',
      '',
    ])('refuses a url that is not http(s): %p', async (url) => {
      const { mk, link } = await world();
      const t = await mk();
      await expect(link(t.id, { url })).rejects.toThrow();
    });

    it('accepts http and https in any letter case; refuses a url longer than 2048', async () => {
      const { mk, link } = await world();
      const t = await mk();
      await link(t.id, { externalId: '1', url: 'HTTPS://github.com/a/b/pull/1' });
      await link(t.id, { externalId: '2', url: 'http://git.internal/a/b/pull/2' });
      await expect(link(t.id, { externalId: '3', url: 'https://x.io/' + 'a'.repeat(2040) })).rejects.toThrow();
    });

    it('a blank externalId is refused', async () => {
      const { mk, link } = await world();
      const t = await mk();
      await expect(link(t.id, { externalId: '   ' })).rejects.toThrow();
    });

    it('(task, provider, kind, externalId) is the upsert key: a duplicate is refused, upsert updates state and lastSeenAt', async () => {
      const { mk, link } = await world();
      const t = await mk();
      const first = await link(t.id);
      await expect(link(t.id)).rejects.toThrow();
      // same external id but another kind, or another task, is a different link
      await link(t.id, { kind: 'ISSUE' });
      const other = await mk('other');
      await link(other.id);
      const key = { taskId_provider_kind_externalId: { taskId: t.id, provider: 'GITHUB' as const, kind: 'PR' as const, externalId: 'acme/api#42' } };
      const later = new Date('2030-01-01T00:00:00Z');
      const up = await prisma.externalLink.upsert({
        where: key,
        update: { state: 'merged', lastSeenAt: later },
        create: { ...key.taskId_provider_kind_externalId, url: 'https://x.io/', title: 't' },
      });
      expect(up.id).toBe(first.id);
      expect(up).toMatchObject({ state: 'merged', lastSeenAt: later });
      expect(await prisma.externalLink.count({ where: { taskId: t.id } })).toBe(2);
    });

    it('deleting the task deletes its links; archiving keeps them; deleting the project keeps them (task falls to the Inbox)', async () => {
      const { user, project, mk, link } = await world();
      const gone = await mk('gone');
      const archived = await mk('archived');
      const kept = await mk('kept');
      await link(gone.id);
      await link(archived.id);
      await link(kept.id);

      await tasks.delete(gone.id);
      expect(await prisma.externalLink.count({ where: { taskId: gone.id } })).toBe(0);

      await tasks.archive(archived.id, user.id);
      expect(await prisma.externalLink.count({ where: { taskId: archived.id } })).toBe(1);

      await projects.delete(project.id);
      expect(await prisma.externalLink.count({ where: { taskId: kept.id } })).toBe(1);
      expect((await tasks.getDetail(kept.id, user.id)).externalLinkCount).toBe(1);
    });
  });
});
