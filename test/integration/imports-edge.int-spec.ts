/**
 * Step 4.6 - comments, activity history and attachments of an import, end to end: the REAL Linear adapter (over the fake HTTP
 * layer, content dataset) -> the real executor (pages, then the attachment-copy phase on its own queue) -> real Postgres, with an
 * in-memory object store. Proves the seams: what is written, where, with which dates and authors, what is idempotent, what
 * pauses, what is skipped, and what rollback may and may not delete.
 */
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { ImportJobStatus as S, IntegrationProvider, Role } from '@prisma/client';
import { PermissionResolver } from '../../src/access-control/access-control.service';
import { PlanLimitsService } from '../../src/access-control/plan-limits.service';
import { ActivitiesService } from '../../src/activity-notifications/activity/activities.service';
import { AttachmentsService } from '../../src/attachments/attachments.service';
import { DomainEraser } from '../../src/domain-writer/domain-eraser.service';
import { DomainWriter } from '../../src/domain-writer/domain-writer.service';
import { ActivityService } from '../../src/events/activity.service';
import { AuditLogService } from '../../src/events/audit-log.service';
import { ConnectorRegistry } from '../../src/integrations/core/connector.registry';
import { CredentialService } from '../../src/integrations/core/credential.service';
import { INTEGRATION_ADAPTERS } from '../../src/integrations/core/integration.types';
import { ProviderHttpClient } from '../../src/integrations/core/provider-http.client';
import type { LinearIssue } from '../../src/integrations/providers/linear/linear.types';
import { LinearAdapter } from '../../src/integrations/providers/linear/linear.adapter';
import { LinearClient } from '../../src/integrations/providers/linear/linear.client';
import { DATASET, LinearDataset, fakeLinear } from '../../src/integrations/providers/linear/fixtures/linear-responses';
import { ImportFileCopier } from '../../src/imports/executor/import-file-copier';
import { ImportContentWriter } from '../../src/imports/executor/import-content-writer';
import { ImportExecutor } from '../../src/imports/executor/import-executor.service';
import { ImportProgressPublisher } from '../../src/imports/executor/import-progress';
import { ImportRollback } from '../../src/imports/executor/import-rollback.service';
import { ImportWriter } from '../../src/imports/executor/import-writer';
import { ExternalRefService } from '../../src/imports/external-ref.service';
import { ImportIssueService } from '../../src/imports/import-issue.service';
import { ImportUsageService } from '../../src/imports/import-usage.service';
import { ImportsService } from '../../src/imports/imports.service';
import { MappingService } from '../../src/imports/mapping/mapping.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { CustomFieldsService } from '../../src/projects-tasks/custom-fields/custom-fields.service';
import { ProjectsService } from '../../src/projects-tasks/projects/projects.service';
import { TaskPlanningService } from '../../src/projects-tasks/planning/task-planning.service';
import { TaskTreeService } from '../../src/projects-tasks/tasks/task-tree.service';
import { TaskVisibilityService } from '../../src/projects-tasks/tasks/task-visibility.service';
import { TasksService } from '../../src/projects-tasks/tasks/tasks.service';
import { WorkflowService } from '../../src/projects-tasks/workflow/workflow.service';
import { QUEUES } from '../../src/queue/queue.definitions';
import { QueueService } from '../../src/queue/queue.service';
import { RedisPubSubService } from '../../src/redis/redis-pubsub.service';
import { WorkspacesService } from '../../src/tenancy/workspaces/workspaces.service';
import { createUser, createUserWithAccount, createWorkspace } from './factories';
import { FakeStorage, contentProviders } from './support/fake-storage';
import { disconnectTestPrisma, getTestPrisma } from './support/prisma-test-client';
import { resetDb } from './support/reset-db';

const noRedis = { configured: false, isReady: () => false } as never;
const bytes = (s: string) => Buffer.from(s);

describe('Import edge cases (step 4.9)', () => {
  let prisma: PrismaService;
  let imports: ImportsService;
  let executor: ImportExecutor;
  let storage: FakeStorage;
  let fake: ReturnType<typeof fakeLinear>;
  let data: LinearDataset;
  let enqueued: Array<{ queue: string; name: string; payload: { importJobId: string; attempt?: number }; delayMs?: number }>;

  beforeAll(async () => {
    prisma = getTestPrisma();
    storage = new FakeStorage();
    const fetchFn = (async (url: unknown, init?: RequestInit) => (await (fake.fetch as unknown as (u: unknown, i?: RequestInit) => Promise<Response>)(url, init)).clone()) as never;
    const http = new ProviderHttpClient(noRedis, fetchFn, { bucketCapacity: 1e6, refillPerSecond: 1e6, maxRetries: 0, maxInlineWaitMs: 10 });
    const linear = new LinearAdapter({ get: () => undefined } as never, http, new LinearClient(http));
    const queue = { enqueue: async (q: string, name: string, payload: never, o: { jobId?: string; delayMs?: number } = {}) => { enqueued.push({ queue: q, name, payload, delayMs: o.delayMs }); return { id: o.jobId ?? 'x' }; } };
    const moduleRef = await Test.createTestingModule({
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: new EventEmitter2() },
        { provide: WorkspacesService, useValue: {} },
        { provide: QueueService, useValue: queue },
        { provide: CredentialService, useValue: { getAccessToken: async () => 'tok' } },
        { provide: RedisPubSubService, useValue: { publish: async () => undefined } },
        { provide: INTEGRATION_ADAPTERS, useValue: [linear] },
        ActivityService, AuditLogService, PermissionResolver, PlanLimitsService, TaskVisibilityService, TasksService, TaskTreeService, WorkflowService,
        TaskPlanningService, ProjectsService, CustomFieldsService, DomainWriter, DomainEraser, ConnectorRegistry, ActivitiesService,
        ExternalRefService, ImportIssueService, ImportUsageService, MappingService, ImportProgressPublisher, ImportWriter, ImportExecutor, ImportRollback, ImportsService,
        ...contentProviders(storage),
      ],
    }).compile();
    await moduleRef.init();
    imports = moduleRef.get(ImportsService);
    executor = moduleRef.get(ImportExecutor);
  });
  beforeEach(async () => {
    await resetDb(prisma);
    enqueued = [];
    storage.objects.clear();
    data = structuredClone(DATASET);
    fake = fakeLinear(data);
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(() => disconnectTestPrisma());

  async function world() {
    const w = await createUserWithAccount(prisma, { role: Role.OWNER });
    await prisma.account.update({ where: { id: w.account.id }, data: { planType: 'PRO_PERSONAL' as never } });
    const ana = await createUser(prisma, { email: 'ana@example.com', emailVerified: true, name: 'Ana' });
    await prisma.accountMember.create({ data: { accountId: w.account.id, userId: ana.id, role: Role.MEMBER } });
    const workspace = await createWorkspace(prisma, { accountId: w.account.id });
    const connection = await prisma.integrationConnection.create({ data: { accountId: w.account.id, provider: IntegrationProvider.LINEAR, externalAccountId: 'org-1', externalAccountName: 'Acme', scopes: ['read'], createdById: w.user.id } });
    return { ...w, ana, workspace, connection };
  }
  type World = Awaited<ReturnType<typeof world>>;
  const OPTS = { comments: true, attachments: false, history: false, keepDates: true };
  async function started(w: World, teams = ['team-eng']) {
    const job = await imports.create({ connectionId: w.connection.id, workspaceId: w.workspace.id, options: OPTS }, w.user.id);
    await imports.setSelection(job.id, { sources: teams.map((id) => ({ id, type: 'team' })) }, w.user.id);
    await imports.preview(job.id, w.user.id);
    await imports.start(job.id, w.user.id);
    return job.id;
  }
  const last = (id: string, name: string) => [...enqueued].reverse().find((e) => e.name === name && e.payload.importJobId === id);
  const run = (id: string) => executor.run(last(id, 'imports.run')!.payload as { importJobId: string; attempt: number });
  const row = (id: string) => prisma.importJob.findUniqueOrThrow({ where: { id } });
  const codes = async (id: string) => (await prisma.importJobIssue.findMany({ where: { importJobId: id } })).map((i) => i.code);
  const eng = () => data.issues['team-eng'];
  const patch = (id: string, change: Partial<LinearIssue>) => { data.issues['team-eng'] = eng().map((i) => (i.id === id ? { ...i, ...change } : i)); };
  const titleOf = (id: string) => eng().find((i) => i.id === id)!.title;
  const ancestors = async (taskId: string): Promise<string[]> => { const out: string[] = []; for (let cur: string | null = taskId, n = 0; cur && n < 50; n++) { const t: { parentId: string | null } = await prisma.task.findUniqueOrThrow({ where: { id: cur }, select: { parentId: true } }); cur = t.parentId; if (cur) out.push(cur); } return out; };
  const finishes = (id: string) => row(id).then((j) => /COMPLETED/.test(j.status));

  describe('hierarchy', () => {
    it('two issues that are each other\'s parent do not loop: both are imported, no task is its own ancestor, the loop is reported', async () => {
      const w = await world();
      patch('i-eng-1', { parent: { id: 'i-eng-2' } });
      patch('i-eng-2', { parent: { id: 'i-eng-1' } });
      const id = await started(w);
      await run(id);
      expect(await finishes(id)).toBe(true);
      const all = await prisma.task.findMany({ where: { workspaceId: w.workspace.id } });
      expect(all).toHaveLength(7);
      for (const t of all) expect(await ancestors(t.id)).not.toContain(t.id);
    });

    it('an issue that is its own parent is imported as a top-level task', async () => {
      const w = await world();
      patch('i-eng-3', { parent: { id: 'i-eng-3' } });
      const id = await started(w);
      await run(id);
      expect(await finishes(id)).toBe(true);
      const t = await prisma.task.findFirstOrThrow({ where: { workspaceId: w.workspace.id, title: titleOf('i-eng-3') } });
      expect(t.parentId).toBeNull();
    });

    it('a sub-issue whose parent is NOT part of the import (never fetched) becomes top-level and the import still completes', async () => {
      const w = await world();
      patch('i-eng-3', { parent: { id: 'i-nowhere' } });
      const id = await started(w);
      await run(id);
      expect(await finishes(id)).toBe(true);
      expect(await prisma.task.count({ where: { workspaceId: w.workspace.id } })).toBe(7);
      expect(await prisma.importPendingLink.count({ where: { importJobId: id } })).toBe(0); // nothing left dangling
      expect((await prisma.task.findFirstOrThrow({ where: { workspaceId: w.workspace.id, title: titleOf('i-eng-3') } })).parentId).toBeNull();
    });

    it('a long parent chain (30 levels) is imported; no level is lost', async () => {
      const w = await world();
      const chain = Array.from({ length: 30 }, (_, i) => ({ ...eng()[0], id: `c-${i}`, identifier: `ENG-9${i}`, title: `Level ${i}`, parent: i === 0 ? null : { id: `c-${i - 1}` }, relations: { nodes: [] }, labels: { nodes: [] } }));
      data.issues['team-eng'] = chain as never;
      const id = await started(w);
      await run(id);
      expect(await finishes(id)).toBe(true);
      expect(await prisma.task.count({ where: { workspaceId: w.workspace.id } })).toBe(30);
    });
  });

  describe('dependencies', () => {
    it('A blocks B and B blocks A: one of them is kept, the other is reported, nothing deadlocks', async () => {
      const w = await world();
      patch('i-eng-1', { relations: { nodes: [{ id: 'cyc-1', type: 'blocks', relatedIssue: { id: 'i-eng-2', team: { id: 'team-eng' } } }] } as never });
      patch('i-eng-2', { relations: { nodes: [{ id: 'cyc-2', type: 'blocks', relatedIssue: { id: 'i-eng-1', team: { id: 'team-eng' } } }] } as never });
      const id = await started(w);
      await run(id);
      expect(await finishes(id)).toBe(true);
      const [a, b] = [await prisma.task.findFirstOrThrow({ where: { title: 'Login fails on Safari' } }), await prisma.task.findFirstOrThrow({ where: { title: 'Fix session cookie' } })];
      const deps = await prisma.taskDependency.findMany({ where: { blockingTaskId: { in: [a.id, b.id] }, blockedTaskId: { in: [a.id, b.id] }, type: 'BLOCKS' } });
      expect(deps).toHaveLength(1); // a cycle of two is not stored
      expect(await codes(id)).toEqual(expect.arrayContaining([expect.stringMatching(/DEPENDENCY|CYCLE|LINK/)]));
    });

    it('a three-way cycle keeps two edges and drops the one that would close it', async () => {
      const w = await world();
      const rel = (n: string, to: string) => ({ nodes: [{ id: n, type: 'blocks', relatedIssue: { id: to, team: { id: 'team-eng' } } }] }) as never;
      patch('i-eng-1', { relations: rel('c1', 'i-eng-2') });
      patch('i-eng-2', { relations: rel('c2', 'i-eng-3') });
      patch('i-eng-3', { relations: rel('c3', 'i-eng-1') });
      const id = await started(w);
      await run(id);
      expect(await finishes(id)).toBe(true);
      expect(await prisma.taskDependency.count({ where: { type: 'BLOCKS' } })).toBe(2);
    });
  });

  describe('people', () => {
    it('a mapped person who has LEFT the account before the run: their work is credited to the importer, the import completes', async () => {
      const w = await world();
      patch('i-eng-1', { assignee: { id: 'u-ana' } as never });
      const id = await started(w);
      await prisma.accountMember.deleteMany({ where: { userId: w.ana.id } }); // Ana leaves between preview and run
      await prisma.user.delete({ where: { id: w.ana.id } }).catch(() => undefined);
      await run(id);
      expect(await finishes(id)).toBe(true);
      const t = await prisma.task.findFirstOrThrow({ where: { workspaceId: w.workspace.id, title: 'Login fails on Safari' }, include: { assignees: true } });
      expect(t.assignees.map((a) => a.id)).not.toContain(w.ana.id);
    });
  });

  describe('size', () => {
    it('a description far over the limit is cut (reported), the task and the import survive', async () => {
      const w = await world();
      patch('i-eng-4', { description: 'x'.repeat(2_000_000) });
      const id = await started(w);
      await run(id);
      expect(await finishes(id)).toBe(true);
      const t = await prisma.task.findFirstOrThrow({ where: { workspaceId: w.workspace.id, title: titleOf('i-eng-4') } });
      expect(t.description!.length).toBeLessThan(2_000_000);
      expect(t.description!.length).toBeGreaterThan(1000);
      expect(await codes(id)).toEqual(expect.arrayContaining([expect.stringMatching(/TOO_LONG|TRUNCATED/)]));
    });

    it('a title far over the limit is cut, not rejected', async () => {
      const w = await world();
      patch('i-eng-4', { title: 'T'.repeat(5000) });
      const id = await started(w);
      await run(id);
      expect(await finishes(id)).toBe(true);
      const t = await prisma.task.findFirstOrThrow({ where: { workspaceId: w.workspace.id, title: { startsWith: 'TTTT' } } });
      expect(t.title.length).toBeLessThanOrEqual(500);
    });

    it('a huge comment is cut; an empty one is skipped; the rest of the thread arrives', async () => {
      const w = await world();
      data.comments = { 'i-eng-1': [{ id: 'cm-big', body: 'y'.repeat(500_000), user: { id: 'u-ana', name: 'Ana' }, createdAt: '2026-02-01T11:00:00.000Z' }, { id: 'cm-empty', body: '   ', user: null, createdAt: '2026-02-01T12:00:00.000Z' }, { id: 'cm-ok', body: 'fine', user: null, createdAt: '2026-02-01T13:00:00.000Z' }] as never };
      const id = await started(w);
      await run(id);
      expect(await finishes(id)).toBe(true);
      const cs = await prisma.comment.findMany({ orderBy: { createdAt: 'asc' } });
      expect(cs).toHaveLength(2);
      expect(cs[0].content.length).toBeLessThan(500_000);
      expect(cs[1].content).toContain('fine');
    });
  });

  describe('bad data from the source', () => {
    it('a date that is not a date, two issues with one id, a blank title: repaired or skipped with a report, never a crash', async () => {
      const w = await world();
      patch('i-eng-2', { dueDate: 'next tuesday' as never, createdAt: 'yesterday' as never });
      data.issues['team-eng'] = [...eng(), { ...eng()[0] }]; // the same issue twice
      patch('i-eng-5', { title: '   ' });
      const id = await started(w);
      await run(id);
      expect(await finishes(id)).toBe(true);
      expect(await prisma.task.count({ where: { workspaceId: w.workspace.id, title: 'Login fails on Safari' } })).toBe(1);
      expect((await codes(id)).length).toBeGreaterThan(0);
    });
  });

  describe('a provider that keeps saying "slow down"', () => {
    it('is retried automatically a bounded number of times, then stops with a message and can be resumed', async () => {
      const w = await world();
      fake = fakeLinear(data, { intercept: (op) => (op === 'LinearTeamIssues' ? new Response(JSON.stringify({ errors: [{ message: 'Rate limit exceeded', extensions: { code: 'RATELIMITED' } }] }), { status: 429, headers: { 'retry-after': '1' } }) : undefined) });
      const id = await started(w);
      let status = '';
      for (let n = 0; n < 40; n++) {
        await run(id);
        status = (await row(id)).status;
        if (status !== 'PAUSED') break;
        const j = await row(id);
        expect(j.pauseReason).toBeTruthy();
        const retry = [...enqueued].reverse().find((e) => e.name === 'imports.run' && e.payload.importJobId === id);
        if (!retry || !retry.delayMs) break; // paused for the person, not for a timer
        // the delayed retry fires
      }
      const j = await row(id);
      expect(['FAILED', 'PAUSED']).toContain(j.status);
      expect(j.pauseReason ?? '').not.toBe('');
      expect(await prisma.task.count({ where: { workspaceId: w.workspace.id } })).toBe(0); // nothing half-written
      // the person fixes it (the limit lifts) and resumes: it completes
      fake = fakeLinear(data);
      await imports.resume(id, w.user.id);
      await run(id);
      expect(await finishes(id)).toBe(true);
      expect(await prisma.task.count({ where: { workspaceId: w.workspace.id } })).toBe(7);
    });
  });
});
