/**
 * Step 4.6 - comments, activity history and attachments of an import, end to end: the REAL Linear adapter (over the fake HTTP
 * layer, content dataset) -> the real executor (pages, then the attachment-copy phase on its own queue) -> real Postgres, with an
 * in-memory object store. Proves the seams: what is written, where, with which dates and authors, what is idempotent, what
 * pauses, what is skipped, and what rollback may and may not delete.
 */
import { BadRequestException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
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
import { ClickUpAdapter } from '../../src/integrations/providers/clickup/clickup.adapter';
import { ClickUpClient } from '../../src/integrations/providers/clickup/clickup.client';
import { DATASET, FILES, FILE_CDN, FILE_OK, ClickUpDataset, fakeClickUp } from '../../src/integrations/providers/clickup/fixtures/clickup-responses';
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
import { WorkspaceKeysService } from '../../src/tenancy/workspaces/workspace-keys.service';
import { WorkspacesService } from '../../src/tenancy/workspaces/workspaces.service';
import { createUser, createUserWithAccount, createWorkspace } from './factories';
import { FakeStorage, contentProviders } from './support/fake-storage';
import { disconnectTestPrisma, getTestPrisma } from './support/prisma-test-client';
import { resetDb } from './support/reset-db';

const noRedis = { configured: false, isReady: () => false } as never;
const ALL = { comments: true, attachments: true, history: false, keepDates: true };
const bytes = (s: string) => Buffer.from(s);

describe('ClickUp import end to end (step 4.7)', () => {
  let prisma: PrismaService;
  let imports: ImportsService;
  let executor: ImportExecutor;
  let rollback: ImportRollback;
  let planLimits: PlanLimitsService;
  let storage: FakeStorage;
  let fake: ReturnType<typeof fakeClickUp>;
  let files: typeof FILES;
  let enqueued: Array<{ queue: string; name: string; payload: { importJobId: string; attempt?: number } }>;

  beforeAll(async () => {
    prisma = getTestPrisma();
    storage = new FakeStorage();
    const fetchFn = (async (url: unknown, init?: RequestInit) => (await (fake.fetch as unknown as (u: unknown, i?: RequestInit) => Promise<Response>)(url, init)).clone()) as never;
    const http = new ProviderHttpClient(noRedis, fetchFn, { bucketCapacity: 1e6, refillPerSecond: 1e6, maxRetries: 0 });
    const cfg = { get: (k: string) => ({ CLICKUP_REQUESTS_PER_MINUTE: '10000', CLICKUP_CLIENT_ID: 'x', CLICKUP_CLIENT_SECRET: 'y' })[k] } as never;
    const clickup = new ClickUpAdapter(cfg, http, new ClickUpClient(http, cfg));
    const queue = { enqueue: async (q: string, name: string, payload: never, o: { jobId?: string } = {}) => { enqueued.push({ queue: q, name, payload }); return { id: o.jobId ?? 'x' }; } };
    const moduleRef = await Test.createTestingModule({
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: new EventEmitter2() },
        WorkspaceKeysService,
        WorkspacesService,
        { provide: QueueService, useValue: queue },
        { provide: CredentialService, useValue: { getAccessToken: async () => 'tok' } },
        { provide: RedisPubSubService, useValue: { publish: async () => undefined } },
        { provide: INTEGRATION_ADAPTERS, useValue: [clickup] },
        ActivityService, AuditLogService, PermissionResolver, PlanLimitsService, TaskVisibilityService, TasksService, TaskTreeService, WorkflowService,
        TaskPlanningService, ProjectsService, CustomFieldsService, DomainWriter, DomainEraser, ConnectorRegistry,
        ExternalRefService, ImportIssueService, ImportUsageService, MappingService, ImportProgressPublisher, ImportWriter, ImportExecutor, ImportRollback, ImportsService,
        ...contentProviders(storage),
      ],
    }).compile();
    await moduleRef.init();
    imports = moduleRef.get(ImportsService);
    executor = moduleRef.get(ImportExecutor);
    rollback = moduleRef.get(ImportRollback);
    planLimits = moduleRef.get(PlanLimitsService);
  });
  beforeEach(async () => {
    await resetDb(prisma);
    enqueued = [];
    storage.objects.clear();
    storage.deleted = [];
    storage.beforePut = null;
    files = structuredClone(FILES);
    fake = fakeClickUp(structuredClone(DATASET) as ClickUpDataset, { files });
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(() => disconnectTestPrisma());

  async function world() {
    const w = await createUserWithAccount(prisma, { role: Role.OWNER });
    await prisma.account.update({ where: { id: w.account.id }, data: { planType: 'PRO_PERSONAL' as never } });
    const ana = await createUser(prisma, { email: 'ana@example.com', emailVerified: true, name: 'Ana' });
    await prisma.accountMember.create({ data: { accountId: w.account.id, userId: ana.id, role: Role.MEMBER } });
    const workspace = await createWorkspace(prisma, { accountId: w.account.id });
    const connection = await prisma.integrationConnection.create({ data: { accountId: w.account.id, provider: IntegrationProvider.CLICKUP, externalAccountId: '9001', externalAccountName: 'Acme', scopes: [], createdById: w.user.id } });
    return { ...w, ana, workspace, connection };
  }
  type World = Awaited<ReturnType<typeof world>>;
  const LISTS = [['list', 'list-1'], ['list', 'list-3']] as const;

  async function started(w: World, options: Partial<typeof ALL> = {}, sources: ReadonlyArray<readonly [string, string]> = LISTS) {
    const job = await imports.create({ connectionId: w.connection.id, workspaceId: w.workspace.id, options: { ...ALL, ...options } }, w.user.id);
    await imports.setSelection(job.id, { sources: sources.map(([type, id]) => ({ id, type })) }, w.user.id);
    await imports.preview(job.id, w.user.id);
    await imports.start(job.id, w.user.id);
    return job.id;
  }
  const last = (id: string, name: string) => [...enqueued].reverse().find((e) => e.name === name && e.payload.importJobId === id);
  const run = (id: string) => executor.run(last(id, 'imports.run')!.payload as { importJobId: string; attempt: number });
  const copy = (id: string) => executor.runFiles(last(id, 'imports.copy-files')!.payload as { importJobId: string; attempt: number });
  const row = (id: string) => prisma.importJob.findUniqueOrThrow({ where: { id } });
  const codes = async (id: string) => (await prisma.importJobIssue.findMany({ where: { importJobId: id } })).map((i) => i.code);
  async function importAll(w: World, options: Partial<typeof ALL> = {}) {
    const id = await started(w, options);
    await run(id);
    if (last(id, 'imports.copy-files')) await copy(id);
    return id;
  }
  const task = (w: World, title: string) => prisma.task.findFirstOrThrow({ where: { workspaceId: w.workspace.id, title }, include: { tags: { include: { tag: true } } } });

  it('lists become projects with their own statuses; the folder is a tag; subtasks, priorities, dates and points arrive', async () => {
    const w = await world();
    const id = await importAll(w);
    expect((await row(id)).status).toMatch(/COMPLETED/);
    const projects = await prisma.project.findMany({ where: { workspaceId: w.workspace.id }, orderBy: { name: 'asc' } });
    expect(projects.map((p) => p.name)).toEqual(['Campaigns', 'Sprint Board']);

    const login = await task(w, 'Design the login page');
    expect(login.tags.map((t) => t.tag.name).sort()).toEqual(['Q3 Roadmap', 'frontend', 'ui']);
    expect(login.priority).toBe('HIGH');
    expect(login.estimate).toBe(5);
    expect(login.dueDate?.toISOString()).toBe('2026-02-02T02:40:00.000Z');
    expect(login.description).toContain('Ship it.');
    expect(login.createdAt.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    const sub = await task(w, 'Login copy');
    expect(sub.parentId).toBe(login.id);
    const api = await task(w, 'Build the login API');
    expect(api.priority).toBe('MEDIUM'); // ClickUp's "Normal"
    expect(await prisma.task.count({ where: { workspaceId: w.workspace.id } })).toBe(4); // 3 live + 1 archived
    expect((await task(w, 'Old idea')).archivedAt).not.toBeNull();
  });

  it('each ClickUp status becomes a workflow status of ITS list, rolled up to a category', async () => {
    const w = await world();
    await importAll(w);
    const sprint = await prisma.project.findFirstOrThrow({ where: { workspaceId: w.workspace.id, name: 'Sprint Board' } });
    const statuses = await prisma.workflowStatus.findMany({ where: { projectId: sprint.id }, orderBy: { position: 'asc' } });
    expect(statuses.map((s) => s.name)).toEqual(['to do', 'in progress', 'blocked', 'complete', 'closed']);
    expect(statuses.map((s) => s.category)).toEqual(['TODO', 'IN_PROGRESS', expect.stringMatching(/IN_PROGRESS|BLOCKED/), 'DONE', 'DONE']);
    const login = await task(w, 'Design the login page');
    expect(login.status).toBe('IN_PROGRESS');
    expect((await task(w, 'Login copy')).status).toBe('DONE');
  });

  it('dependencies keep their direction (depends_on is the blocker) and links become RELATES_TO', async () => {
    const w = await world();
    await importAll(w);
    const [t1, t2, t3] = [await task(w, 'Design the login page'), await task(w, 'Build the login API'), await task(w, 'Login copy')];
    const deps = await prisma.taskDependency.findMany({ where: { blockingTaskId: { in: [t1.id, t2.id, t3.id] } } });
    expect(deps.map((d) => [d.blockingTaskId, d.blockedTaskId, d.type]).sort()).toEqual([[t1.id, t2.id, 'BLOCKS'], [t1.id, t3.id, 'RELATES_TO']].sort());
  });

  it('people: the matched member is assigned; the others are reported, not invented; custom fields carry their values', async () => {
    const w = await world();
    const id = await importAll(w);
    const t1 = await task(w, 'Design the login page');
    const withAssignees = await prisma.task.findUniqueOrThrow({ where: { id: t1.id }, include: { assignees: true } });
    expect(withAssignees.assignees.map((a) => a.id)).toEqual([w.ana.id]);
    const fields = await prisma.customField.findMany({ where: { workspaceId: w.workspace.id }, orderBy: { name: 'asc' } });
    expect(fields.map((f) => [f.name, f.dataType])).toEqual([['Cost', 'NUMBER'], ['Environment', 'SELECT'], ['Owner', 'USER']]);
    const values = await prisma.taskCustomValue.findMany({ where: { taskId: t1.id }, include: { field: true } });
    const by = Object.fromEntries(values.map((v) => [v.field.name, v.value]));
    expect(by.Cost).toBe(125.5);
    expect(JSON.stringify(by.Environment)).toContain('production');
    expect(await codes(id)).toEqual(expect.not.arrayContaining(['ITEM_INVALID']));
  });

  it('comments with their replies, and the files, arrive through the 4.6 pipeline with the token sent only to ClickUp hosts', async () => {
    const w = await world();
    const id = await importAll(w);
    const t1 = await task(w, 'Design the login page');
    const cs = await prisma.comment.findMany({ where: { targetId: t1.id }, orderBy: { createdAt: 'asc' } });
    expect(cs.map((c) => c.content.replace(/^\*\*[^*]+\*\*\n\n/, ''))).toEqual(['Please add dark mode.', 'Looks good.', 'Agreed.', 'Shipped to staging.']);
    expect(cs[2].parentCommentId).toBe(cs[1].id);
    expect(cs[0].authorId).toBe(w.ana.id); // Ana matches a member by e-mail
    expect(cs[0].createdAt.toISOString()).toBe('2026-01-01T00:00:00.000Z'.replace('2026-01-01T00:00:00.000Z', new Date(1767200000000).toISOString()));
    const atts = await prisma.attachment.findMany({ where: { targetId: t1.id }, orderBy: { filename: 'asc' } });
    expect(atts.map((a) => [a.filename, a.status, a.sizeBytes])).toEqual([['design.png', 'CONFIRMED', 14], ['spec.pdf', 'CONFIRMED', 14]]);
    expect(storage.objects.get(atts[0].storageKey)).toEqual(Buffer.from('PNG-bytes-1234'));
    expect(fake.fileCalls.map((f) => f.url).sort()).toEqual([FILE_CDN, FILE_OK].sort());
    expect(fake.fileCalls.every((f) => f.auth === 'Bearer tok')).toBe(true);
    expect((await row(id)).progress).toMatchObject({ counts: { comment: { created: 4 }, attachment: { created: 2 } } });
  });

  it('history is not importable from ClickUp: the preview says so, and nothing is invented', async () => {
    const w = await world();
    const job = await imports.create({ connectionId: w.connection.id, workspaceId: w.workspace.id, options: { ...ALL, history: true } }, w.user.id);
    await imports.setSelection(job.id, { sources: [{ id: 'list-1', type: 'list' }] }, w.user.id);
    const preview = await imports.preview(job.id, w.user.id);
    expect(JSON.stringify(preview)).toContain('HISTORY_NOT_AVAILABLE');
    await imports.start(job.id, w.user.id);
    await run(job.id);
    expect(await prisma.activity.count({ where: { action: 'IMPORTED_CHANGE' } })).toBe(0);
  });

  it('a second import of the same Workspace adds nothing', async () => {
    const w = await world();
    await importAll(w);
    const before = [await prisma.task.count(), await prisma.comment.count(), await prisma.attachment.count(), await prisma.taskDependency.count()];
    await importAll(w);
    expect([await prisma.task.count(), await prisma.comment.count(), await prisma.attachment.count(), await prisma.taskDependency.count()]).toEqual(before);
  });

  it('a revoked token PAUSES the import for reconnection and a resume finishes it', async () => {
    const w = await world();
    const id = await started(w);
    let revoked = true;
    const orig = fake.fetch.getMockImplementation()!;
    fake.fetch.mockImplementation(async (u: unknown, i?: RequestInit) => (revoked && new URL(String(u)).pathname.includes('/task') ? new Response('{"err":"Token invalid"}', { status: 401 }) : orig(u, i)));
    await run(id);
    const j = await row(id);
    expect(j.status).toBe('PAUSED');
    expect(j.pauseReason).toMatch(/reconnect/i);
    revoked = false;
    await imports.resume(id, w.user.id);
    await run(id);
    if (last(id, 'imports.copy-files')) await copy(id);
    expect((await row(id)).status).toMatch(/COMPLETED/);
    expect(await prisma.task.count({ where: { workspaceId: w.workspace.id } })).toBe(4);
  });

  it('a rate limit (429 with X-RateLimit-Reset) pauses with an automatic retry, then the import completes', async () => {
    const w = await world();
    const id = await started(w);
    let limited = true;
    const orig = fake.fetch.getMockImplementation()!;
    const reset = String(Math.floor(Date.now() / 1000) + 60);
    fake.fetch.mockImplementation(async (u: unknown, i?: RequestInit) => (limited && new URL(String(u)).pathname.endsWith('/list/list-1/task') ? new Response('{"err":"Rate limit reached"}', { status: 429, headers: { 'x-ratelimit-reset': reset } }) : orig(u, i)));
    await run(id);
    expect((await row(id)).status).toBe('PAUSED');
    expect((await row(id)).pauseReason).toMatch(/slow down/i);
    limited = false;
    await imports.resume(id, w.user.id);
    await run(id);
    if (last(id, 'imports.copy-files')) await copy(id);
    expect((await row(id)).status).toMatch(/COMPLETED/);
  });

  it('rollback removes the whole ClickUp import: tasks, comments, files, objects', async () => {
    const w = await world();
    const id = await importAll(w);
    await imports.rollback(id, w.user.id);
    await rollback.run({ importJobId: id });
    expect((await row(id)).status).toBe('ROLLED_BACK');
    expect([await prisma.task.count(), await prisma.comment.count(), await prisma.attachment.count()]).toEqual([0, 0, 0]);
    expect(storage.objects.size).toBe(0);
  });

  // ================================================================================================ Space = Workspace (step 4.7b, diagram 06)

  describe('one workspace per Space', () => {
    const SPACES = [{ spaceId: 'space-1', sources: [{ id: 'list-1', type: 'list' }] }, { spaceId: 'space-2' }];
    const names = async (accountId: string) => (await prisma.workspace.findMany({ where: { accountId }, orderBy: { name: 'asc' } })).map((x) => x.name);

    it('creates a workspace named after each Space and one DRAFT job per Space, each selecting just that Space (or the lists asked for)', async () => {
      const w = await world();
      const before = await prisma.workspace.count({ where: { accountId: w.account.id } });
      const r = await imports.createPerSpace({ connectionId: w.connection.id, options: ALL, spaces: SPACES }, w.user.id);
      expect(r.map((x) => [x.spaceId, x.spaceName, x.workspaceCreated])).toEqual([['space-1', 'Engineering', true], ['space-2', 'Marketing', true]]);
      expect(await prisma.workspace.count({ where: { accountId: w.account.id } })).toBe(before + 2);
      expect((await names(w.account.id)).filter((n) => ['Engineering', 'Marketing'].includes(n))).toEqual(['Engineering', 'Marketing']);
      expect(new Set(r.map((x) => x.workspaceId)).size).toBe(2);
      expect(r[0].job).toMatchObject({ status: 'SOURCES_SELECTED', workspaceId: r[0].workspaceId, selection: { sources: [{ id: 'list-1', type: 'list' }] } });
      expect(r[1].job.selection).toEqual({ sources: [{ id: 'space-2', type: 'space' }] });
      expect((await prisma.workspace.findUniqueOrThrow({ where: { id: r[0].workspaceId } })).accountId).toBe(w.account.id);
    });

    it('an import of a Space lands ONLY in that Space\'s workspace', async () => {
      const w = await world();
      const [eng, mkt] = await imports.createPerSpace({ connectionId: w.connection.id, options: ALL, spaces: SPACES }, w.user.id);
      await imports.preview(eng.job.id, w.user.id);
      await imports.start(eng.job.id, w.user.id);
      await run(eng.job.id);
      if (last(eng.job.id, 'imports.copy-files')) await copy(eng.job.id);
      expect((await row(eng.job.id)).status).toMatch(/COMPLETED/);
      expect(await prisma.task.count({ where: { workspaceId: eng.workspaceId } })).toBe(4);
      expect(await prisma.task.count({ where: { workspaceId: mkt.workspaceId } })).toBe(0);
      expect((await prisma.project.findMany({ where: { workspaceId: eng.workspaceId } })).map((p) => p.name)).toEqual(['Sprint Board']);
    });

    it('a Space can be merged into an EXISTING workspace instead (new or merge, per Space)', async () => {
      const w = await world();
      const before = await prisma.workspace.count({ where: { accountId: w.account.id } });
      const r = await imports.createPerSpace({ connectionId: w.connection.id, options: ALL, spaces: [{ spaceId: 'space-1', workspaceId: w.workspace.id, sources: [{ id: 'list-1', type: 'list' }] }, { spaceId: 'space-2' }] }, w.user.id);
      expect(r.map((x) => [x.workspaceId === w.workspace.id, x.workspaceCreated])).toEqual([[true, false], [false, true]]);
      expect(await prisma.workspace.count({ where: { accountId: w.account.id } })).toBe(before + 1);
    });

    it('a MEMBER cannot create workspaces; nothing is created, nothing is revealed', async () => {
      const w = await world();
      const member = await createUser(prisma, { email: 'm@example.com', emailVerified: true });
      await prisma.accountMember.create({ data: { accountId: w.account.id, userId: member.id, role: Role.MEMBER } });
      const before = await prisma.workspace.count();
      await expect(imports.createPerSpace({ connectionId: w.connection.id, options: ALL, spaces: SPACES }, member.id)).rejects.toBeInstanceOf(ForbiddenException);
      expect(await prisma.workspace.count()).toBe(before);
      expect(fake.calls).toEqual([]); // the provider was not even asked
    });

    it('an existing target needs runImport on it, and must be in the connection\'s account', async () => {
      const w = await world();
      const other = await createUserWithAccount(prisma, { role: Role.OWNER });
      const foreign = await createWorkspace(prisma, { accountId: other.account.id });
      await expect(imports.createPerSpace({ connectionId: w.connection.id, options: ALL, spaces: [{ spaceId: 'space-1', workspaceId: foreign.id }] }, w.user.id)).rejects.toBeInstanceOf(NotFoundException);
      // somebody with no right to the target workspace is refused ...
      await expect(imports.createPerSpace({ connectionId: w.connection.id, options: ALL, spaces: [{ spaceId: 'space-1', workspaceId: w.workspace.id }] }, other.user.id)).rejects.toBeInstanceOf(ForbiddenException);
      // ... and someone else's connection used with their OWN workspace looks like nothing
      await expect(imports.createPerSpace({ connectionId: w.connection.id, options: ALL, spaces: [{ spaceId: 'space-1', workspaceId: foreign.id }] }, other.user.id)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('the plan\'s workspace limit is checked for ALL new workspaces before any is created', async () => {
      const w = await world();
      // the permission check asks for ONE new workspace (fine); only the importer's ask for all of them is refused
      const spy = jest.spyOn(planLimits, 'checkLimit').mockImplementation(async (_l, _a, _c, o) => (o?.additional ?? 1) <= 1);
      const before = await prisma.workspace.count();
      await expect(imports.createPerSpace({ connectionId: w.connection.id, options: ALL, spaces: SPACES }, w.user.id)).rejects.toMatchObject({ name: 'PlanLimitExceededException' });
      expect(spy).toHaveBeenCalledWith('workspace', 'createWorkspace', { accountId: w.account.id }, { additional: 2 });
      expect(await prisma.workspace.count()).toBe(before);
    });

    it.each([
      ['something that is not a Space', [{ spaceId: 'list-1' }], /not a space/],
      ['a Space that does not exist', [{ spaceId: 'nope' }], /not a space/],
      ['a list from another Space', [{ spaceId: 'space-2', sources: [{ id: 'list-1', type: 'list' }] }], /not part of/],
      ['the same Space twice', [{ spaceId: 'space-1' }, { spaceId: 'space-1' }], /only be listed once/],
      ['an unknown key', [{ spaceId: 'space-1', extra: 1 }], /each space needs/],
      ['no Spaces', [], /1 to 50/],
    ])('refuses %s with a 400 and creates nothing', async (_n, spaces, msg) => {
      const w = await world();
      const before = await prisma.workspace.count();
      await expect(imports.createPerSpace({ connectionId: w.connection.id, options: ALL, spaces }, w.user.id)).rejects.toThrow(msg);
      expect(await prisma.workspace.count()).toBe(before);
      expect(await prisma.importJob.count()).toBe(0);
    });

    it('if a job cannot be created half way, the workspaces made by this call are removed again', async () => {
      const w = await world();
      const before = await prisma.workspace.count();
      const real = imports.create.bind(imports);
      let n = 0;
      jest.spyOn(imports, 'create').mockImplementation(async (...a) => { if (++n === 2) throw new Error('boom'); return real(...a); });
      await expect(imports.createPerSpace({ connectionId: w.connection.id, options: ALL, spaces: SPACES }, w.user.id)).rejects.toThrow('boom');
      expect(await prisma.workspace.count()).toBe(before);
    });

    it('an inactive connection must be reconnected first', async () => {
      const w = await world();
      await prisma.integrationConnection.update({ where: { id: w.connection.id }, data: { status: 'NEEDS_REAUTH' as never } });
      await expect(imports.createPerSpace({ connectionId: w.connection.id, options: ALL, spaces: SPACES }, w.user.id)).rejects.toBeInstanceOf(ConflictException);
    });
  });
});
