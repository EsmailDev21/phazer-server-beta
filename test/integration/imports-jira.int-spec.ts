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
import { JiraAdapter } from '../../src/integrations/providers/jira/jira.adapter';
import { JiraClient } from '../../src/integrations/providers/jira/jira.client';
import { CLOUD, FILE_URL, JiraDataset, dataset, fakeJira } from '../../src/integrations/providers/jira/fixtures/jira-responses';
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
const ALL = { comments: true, attachments: true, history: true, keepDates: true };
const bytes = (s: string) => Buffer.from(s);

describe('Jira import end to end (step 4.8)', () => {
  let prisma: PrismaService;
  let imports: ImportsService;
  let executor: ImportExecutor;
  let rollback: ImportRollback;
  let storage: FakeStorage;
  let fake: ReturnType<typeof fakeJira>;
  let data: JiraDataset;
  let enqueued: Array<{ queue: string; name: string; payload: { importJobId: string; attempt?: number } }>;

  beforeAll(async () => {
    prisma = getTestPrisma();
    storage = new FakeStorage();
    const fetchFn = (async (url: unknown, init?: RequestInit) => (await (fake.fetch as unknown as (u: unknown, i?: RequestInit) => Promise<Response>)(url, init)).clone()) as never;
    const http = new ProviderHttpClient(noRedis, fetchFn, { bucketCapacity: 1e6, refillPerSecond: 1e6, maxRetries: 0 });
    const cfg = { get: (k: string) => ({ JIRA_CLIENT_ID: 'x', JIRA_CLIENT_SECRET: 'y' })[k] } as never;
    const jira = new JiraAdapter(cfg, http, new JiraClient(http));
    const queue = { enqueue: async (q: string, name: string, payload: never, o: { jobId?: string } = {}) => { enqueued.push({ queue: q, name, payload }); return { id: o.jobId ?? 'x' }; } };
    const moduleRef = await Test.createTestingModule({
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: new EventEmitter2() },
        { provide: WorkspacesService, useValue: {} },
        { provide: QueueService, useValue: queue },
        { provide: CredentialService, useValue: { getAccessToken: async () => 'tok' } },
        { provide: RedisPubSubService, useValue: { publish: async () => undefined } },
        { provide: INTEGRATION_ADAPTERS, useValue: [jira] },
        ActivityService, AuditLogService, PermissionResolver, PlanLimitsService, TaskVisibilityService, TasksService, TaskTreeService, WorkflowService,
        TaskPlanningService, ProjectsService, CustomFieldsService, DomainWriter, DomainEraser, ConnectorRegistry, ActivitiesService,
        ExternalRefService, ImportIssueService, ImportUsageService, MappingService, ImportProgressPublisher, ImportWriter, ImportExecutor, ImportRollback, ImportsService,
        ...contentProviders(storage),
      ],
    }).compile();
    await moduleRef.init();
    imports = moduleRef.get(ImportsService);
    executor = moduleRef.get(ImportExecutor);
    rollback = moduleRef.get(ImportRollback);
  });
  beforeEach(async () => {
    await resetDb(prisma);
    enqueued = [];
    storage.objects.clear();
    storage.deleted = [];
    storage.beforePut = null;
    data = dataset();
    fake = fakeJira(data);
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(() => disconnectTestPrisma());

  async function world() {
    const w = await createUserWithAccount(prisma, { role: Role.OWNER });
    await prisma.account.update({ where: { id: w.account.id }, data: { planType: 'PRO_PERSONAL' as never } });
    const ana = await createUser(prisma, { email: 'ana@example.com', emailVerified: true, name: 'Ana' });
    await prisma.accountMember.create({ data: { accountId: w.account.id, userId: ana.id, role: Role.MEMBER } });
    const workspace = await createWorkspace(prisma, { accountId: w.account.id });
    const connection = await prisma.integrationConnection.create({ data: { accountId: w.account.id, provider: IntegrationProvider.JIRA, externalAccountId: CLOUD, externalAccountName: 'Acme', scopes: [], createdById: w.user.id } });
    return { ...w, ana, workspace, connection };
  }
  type World = Awaited<ReturnType<typeof world>>;

  async function started(w: World, options: Partial<typeof ALL> = {}, projects = ['10000']) {
    const job = await imports.create({ connectionId: w.connection.id, workspaceId: w.workspace.id, options: { ...ALL, ...options } }, w.user.id);
    await imports.setSelection(job.id, { sources: projects.map((id) => ({ id, type: 'project' })) }, w.user.id);
    await imports.preview(job.id, w.user.id);
    await imports.start(job.id, w.user.id);
    return job.id;
  }
  const last = (id: string, name: string) => [...enqueued].reverse().find((e) => e.name === name && e.payload.importJobId === id);
  const run = (id: string) => executor.run(last(id, 'imports.run')!.payload as { importJobId: string; attempt: number });
  const copy = (id: string) => executor.runFiles(last(id, 'imports.copy-files')!.payload as { importJobId: string; attempt: number });
  const row = (id: string) => prisma.importJob.findUniqueOrThrow({ where: { id } });
  async function importAll(w: World, options: Partial<typeof ALL> = {}, projects?: string[]) {
    const id = await started(w, options, projects);
    await run(id);
    if (last(id, 'imports.copy-files')) await copy(id);
    return id;
  }
  const task = (w: World, key: string) => prisma.task.findFirstOrThrow({ where: { workspaceId: w.workspace.id, title: key }, include: { tags: { include: { tag: true } }, issueType: true, iteration: true, assignees: true } });

  it('projects with their statuses, issue types by level, tasks with parent / epic / sub-task, people, dates, estimate, tags', async () => {
    const w = await world();
    const id = await importAll(w);
    expect((await row(id)).status).toMatch(/COMPLETED/);
    const eng = await prisma.project.findFirstOrThrow({ where: { workspaceId: w.workspace.id, name: 'Engineering' } });
    const statuses = await prisma.workflowStatus.findMany({ where: { projectId: eng.id }, orderBy: { position: 'asc' } });
    expect(statuses.map((s) => [s.name, s.category])).toEqual([['Backlog', expect.stringMatching(/TODO|BACKLOG/)], ['To Do', 'TODO'], ['In Progress', 'IN_PROGRESS'], ['Blocked', expect.stringMatching(/IN_PROGRESS|BLOCKED/)], ['Done', 'DONE']]);
    const types = await prisma.issueType.findMany({ where: { workspaceId: w.workspace.id }, orderBy: { name: 'asc' } });
    expect(types.map((t) => [t.name, t.level])).toEqual([['Bug', 'STANDARD'], ['Epic', 'EPIC'], ['Story', 'STANDARD'], ['Sub-task', 'SUBTASK']]);

    const epic = await task(w, 'Login revamp');
    const story = await task(w, 'Login form');
    const sub = await task(w, 'Form validation');
    expect(story.parentId).toBe(epic.id);
    expect(sub.parentId).toBe(story.id);
    expect(epic.issueType!.name).toBe('Epic');
    expect(epic.priority).toBe('URGENT'); // Highest
    expect(story.priority).toBe('HIGH');
    expect(story.estimate).toBe(5);
    expect(story.dueDate?.toISOString().slice(0, 10)).toBe('2026-03-01');
    expect(story.createdAt.toISOString()).toBe('2026-01-05T09:00:00.000Z');
    expect(story.assignees.map((a) => a.id)).toEqual([w.ana.id]); // Ana matches a member by e-mail
    expect(story.tags.map((t) => t.tag.name).sort()).toEqual(['Web', 'a11y', 'alpha', 'beta', 'frontend', 'version: 1.0', 'version: 1.1']);
    expect(sub.status).toBe('DONE');
  });

  it('sprints and releases become iterations; a task is in its active sprint', async () => {
    const w = await world();
    await importAll(w, { history: false });
    const its = await prisma.iteration.findMany({ where: { workspaceId: w.workspace.id }, orderBy: { name: 'asc' } });
    expect(its.map((i) => [i.name, i.kind])).toEqual([['1.0', 'MILESTONE'], ['1.1', 'MILESTONE'], ['Sprint 1', 'SPRINT'], ['Sprint 2', 'SPRINT']]);
    expect((await task(w, 'Login form')).iteration!.name).toBe('Sprint 2');
  });

  it('custom fields (text, number, date, user) and the time-tracking numbers carry their values; unmapped kinds do not appear', async () => {
    const w = await world();
    await importAll(w, { history: false });
    const fields = await prisma.customField.findMany({ where: { workspaceId: w.workspace.id }, orderBy: { name: 'asc' } });
    expect(fields.map((f) => [f.name, f.dataType])).toEqual([['Budget', 'NUMBER'], ['Customer', 'TEXT'], ['Environment type', 'TEXT'], ['Go-live', 'DATE'], ['Original estimate (hours)', 'NUMBER'], ['Owner', 'USER'], ['Platforms', 'TEXT'], ['Time spent (hours)', 'NUMBER']]);
    const story = await task(w, 'Login form');
    const values = await prisma.taskCustomValue.findMany({ where: { taskId: story.id }, include: { field: true } });
    const by = Object.fromEntries(values.map((v) => [v.field.name, v.value]));
    expect(by.Budget).toBe(1250.5);
    expect(by.Customer).toBe('Acme Corp');
    expect(by['Environment type']).toBe('staging');
    expect(by.Platforms).toBe('iOS, Web');
    expect(by['Original estimate (hours)']).toBe(2);
    expect(by['Time spent (hours)']).toBe(1);
  });

  it('links: Blocks keeps its direction, Relates / Duplicate are RELATES_TO, the duplicate also stays as text', async () => {
    const w = await world();
    await importAll(w, { history: false }, ['10000', '10001']);
    const [story, sub, dup, ops] = [await task(w, 'Login form'), await task(w, 'Form validation'), await task(w, 'Same bug'), await task(w, 'Rotate keys [urgent]')];
    const deps = await prisma.taskDependency.findMany({ where: { blockingTaskId: { in: [story.id, sub.id, dup.id, ops.id] } } });
    expect(deps.filter((d) => d.type === 'BLOCKS').map((d) => [d.blockingTaskId, d.blockedTaskId])).toEqual([[story.id, sub.id]]); // direction kept
    const pair = (d: { blockingTaskId: string; blockedTaskId: string }) => [d.blockingTaskId, d.blockedTaskId].sort().join('>');
    expect(deps.filter((d) => d.type === 'RELATES_TO').map(pair).sort()).toEqual([[story.id, dup.id].sort().join('>'), [story.id, ops.id].sort().join('>')].sort());
    expect((await prisma.task.findUniqueOrThrow({ where: { id: story.id } })).description).toContain('- duplicates ENG-4 - Same bug');
  });

  it('comments (also the ones past the first page) with their authors; the stranger is credited to the importer by name', async () => {
    const w = await world();
    await importAll(w, { history: false });
    const story = await task(w, 'Login form');
    const cs = await prisma.comment.findMany({ where: { targetId: story.id }, orderBy: { createdAt: 'asc' } });
    expect(cs).toHaveLength(5);
    expect(cs[0]).toMatchObject({ authorId: w.ana.id, content: 'First note' });
    expect(cs[2].authorId).toBe(w.user.id);
    expect(cs[2].content).toMatch(/^\*\*Stranger \(via Jira\)\*\*/);
    expect(cs[1].editedAt?.toISOString()).toBe('2026-01-06T09:30:00.000Z');
    expect(cs.every((c) => c.parentCommentId === null)).toBe(true); // Jira comments are flat
  });

  it('history from the changelog (also past the first 2): IMPORTED, original times, only on the task\'s own history', async () => {
    const w = await world();
    await importAll(w, { comments: false, attachments: false });
    const story = await task(w, 'Login form');
    const rows = await prisma.activity.findMany({ where: { targetId: story.id, action: 'IMPORTED_CHANGE' }, orderBy: { createdAt: 'asc' } });
    expect(rows.map((r) => (r.metadata as { field: string }).field)).toEqual(['status', 'assignee', 'story points', 'sprint']);
    expect(rows.every((r) => r.visibility === 'IMPORTED')).toBe(true);
    expect(rows[0].createdAt.toISOString()).toBe('2026-01-05T09:10:00.000Z');
    expect(rows[0].actorId).toBe(w.user.id); // Ben has no account
    expect(rows[1].actorId).toBe(w.ana.id);
  });

  it('attachments are copied and the file embedded in the description and in a comment now points at OUR stable address', async () => {
    const w = await world();
    const id = await importAll(w, { history: false });
    const story = await task(w, 'Login form');
    const atts = await prisma.attachment.findMany({ where: { targetId: story.id }, orderBy: { filename: 'asc' } });
    expect(atts.map((a) => [a.filename, a.status, a.sizeBytes])).toEqual([['notes.pdf', 'CONFIRMED', 9], ['shot.png', 'CONFIRMED', 12]]);
    expect(storage.objects.get(atts[1].storageKey)).toEqual(Buffer.from('PNG-bytes-11'));
    expect(fake.fileCalls.every((f) => f.auth === 'Bearer tok' && f.url.startsWith(`https://api.atlassian.com/ex/jira/${CLOUD}/`))).toBe(true);
    expect(story.description).toContain(`![shot.png](/files/${atts[1].id}/content)`);
    expect(story.description).not.toContain(FILE_URL('501'));
    const c4 = await prisma.comment.findFirstOrThrow({ where: { targetId: story.id, content: { contains: 'See the screenshot' } } });
    expect(c4.content).toContain(`/files/${atts[1].id}/content`);
    expect((await row(id)).progress).toMatchObject({ counts: { attachment: { created: 2 } } });
  });

  it('a second import adds nothing', async () => {
    const w = await world();
    await importAll(w);
    const before = [await prisma.task.count(), await prisma.comment.count(), await prisma.attachment.count(), await prisma.taskDependency.count(), await prisma.activity.count({ where: { action: 'IMPORTED_CHANGE' } })];
    await importAll(w);
    expect([await prisma.task.count(), await prisma.comment.count(), await prisma.attachment.count(), await prisma.taskDependency.count(), await prisma.activity.count({ where: { action: 'IMPORTED_CHANGE' } })]).toEqual(before);
  });

  it('a revoked token PAUSES for reconnection and a resume finishes it', async () => {
    const w = await world();
    const id = await started(w);
    let revoked = true;
    const orig = fake.fetch.getMockImplementation()!;
    fake.fetch.mockImplementation(async (u: unknown, i?: RequestInit) => (revoked && String(u).includes('/search/jql') ? new Response('{"message":"Unauthorized"}', { status: 401 }) : orig(u, i)));
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

  it('rollback removes everything: tasks, comments, history, files, objects', async () => {
    const w = await world();
    const id = await importAll(w);
    await imports.rollback(id, w.user.id);
    await rollback.run({ importJobId: id });
    expect((await row(id)).status).toBe('ROLLED_BACK');
    expect([await prisma.task.count(), await prisma.comment.count(), await prisma.attachment.count(), await prisma.activity.count({ where: { action: 'IMPORTED_CHANGE' } })]).toEqual([0, 0, 0, 0]);
    expect(storage.objects.size).toBe(0);
  });
});
