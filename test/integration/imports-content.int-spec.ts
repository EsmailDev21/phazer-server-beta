/**
 * Step 4.6 - comments, activity history and attachments of an import, end to end: the REAL Linear adapter (over the fake HTTP
 * layer, content dataset) -> the real executor (pages, then the attachment-copy phase on its own queue) -> real Postgres, with an
 * in-memory object store. Proves the seams: what is written, where, with which dates and authors, what is idempotent, what
 * pauses, what is skipped, and what rollback may and may not delete.
 */
import { BadRequestException } from '@nestjs/common';
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
import { LinearAdapter } from '../../src/integrations/providers/linear/linear.adapter';
import { LinearClient } from '../../src/integrations/providers/linear/linear.client';
import { CONTENT_DATASET, FILE_A, FILE_B, FILE_EVIL, LinearDataset, fakeLinear } from '../../src/integrations/providers/linear/fixtures/linear-responses';
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
const ALL = { comments: true, attachments: true, history: true, keepDates: true };
const bytes = (s: string) => Buffer.from(s);

describe('Import content: comments, history, attachments (step 4.6)', () => {
  let prisma: PrismaService;
  let imports: ImportsService;
  let executor: ImportExecutor;
  let rollback: ImportRollback;
  let attachments: AttachmentsService;
  let activities: ActivitiesService;
  let storage: FakeStorage;
  let fake: ReturnType<typeof fakeLinear>;
  let data: LinearDataset;
  let intercept: ((op: string) => Response | undefined) | null = null;
  let moduleRefForCopier: () => ImportFileCopier;
  let enqueued: Array<{ queue: string; name: string; payload: { importJobId: string; attempt?: number }; jobId?: string; delayMs?: number }>;

  beforeAll(async () => {
    prisma = getTestPrisma();
    storage = new FakeStorage();
    const fetchFn = (async (url: unknown, init?: RequestInit) => (await (fake.fetch as unknown as (u: unknown, i?: RequestInit) => Promise<Response>)(url, init)).clone()) as never;
    const http = new ProviderHttpClient(noRedis, fetchFn, { bucketCapacity: 1e6, refillPerSecond: 1e6, maxRetries: 0 });
    const linear = new LinearAdapter({ get: () => undefined } as never, http, new LinearClient(http));
    const queue = {
      enqueue: async (q: string, name: string, payload: never, opts: { jobId?: string; delayMs?: number } = {}) => {
        enqueued.push({ queue: q, name, payload, jobId: opts.jobId, delayMs: opts.delayMs });
        return { id: opts.jobId ?? 'x' };
      },
    };
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
    rollback = moduleRef.get(ImportRollback);
    attachments = moduleRef.get(AttachmentsService);
    activities = moduleRef.get(ActivitiesService);
    const copierRef = moduleRef.get(ImportFileCopier);
    moduleRefForCopier = () => copierRef;
  });
  beforeEach(async () => {
    await resetDb(prisma);
    enqueued = [];
    intercept = null;
    storage.objects.clear();
    storage.deleted = [];
    storage.beforePut = null;
    data = structuredClone(CONTENT_DATASET);
    fake = fakeLinear(data, { intercept: (op) => intercept?.(op) });
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

  async function started(w: World, options: Partial<typeof ALL> = {}, teams = ['team-eng']) {
    const job = await imports.create({ connectionId: w.connection.id, workspaceId: w.workspace.id, options: { ...ALL, ...options } }, w.user.id);
    await imports.setSelection(job.id, { sources: teams.map((id) => ({ id, type: 'team' })) }, w.user.id);
    await imports.preview(job.id, w.user.id);
    await imports.start(job.id, w.user.id);
    return job.id;
  }
  const last = (id: string, name: string) => [...enqueued].reverse().find((e) => e.name === name && e.payload.importJobId === id);
  const run = (id: string) => executor.run(last(id, 'imports.run')!.payload as { importJobId: string; attempt: number });
  const files = (id: string) => executor.runFiles(last(id, 'imports.copy-files')!.payload as { importJobId: string; attempt: number });
  const row = (id: string) => prisma.importJob.findUniqueOrThrow({ where: { id } });
  const codes = async (id: string) => (await prisma.importJobIssue.findMany({ where: { importJobId: id } })).map((i) => i.code);
  const counts = async (id: string) => ((await row(id)).progress as { counts: Record<string, Record<string, number>> }).counts;
  const taskOf = (w: World, key: string) => prisma.task.findFirstOrThrow({ where: { workspaceId: w.workspace.id, title: key } });
  const LOGIN = 'Login fails on Safari';
  /** pages, then the file phase: the whole import. */
  async function importAll(w: World, options: Partial<typeof ALL> = {}) {
    const id = await started(w, options);
    await run(id);
    if (last(id, 'imports.copy-files')) await files(id);
    return id;
  }

  // ================================================================================================ the happy path

  it('pages first (comments + history written with them), then the files on the import-files queue; the job finishes from there', async () => {
    const w = await world();
    const id = await started(w);
    await run(id);
    let j = await row(id);
    expect(j.status).toBe(S.RUNNING); // not finished: files are pending
    expect(j.checkpoint).toMatchObject({ phase: 'FILES' });
    const copy = last(id, 'imports.copy-files')!;
    expect(copy.queue).toBe(QUEUES.IMPORT_FILES.name);
    expect(copy.payload.attempt).toBe(j.attempt);
    expect(await prisma.comment.count()).toBe(6);
    expect(await prisma.attachment.count()).toBe(0);
    expect(await prisma.importFileItem.count({ where: { importJobId: id, status: 'PENDING' } })).toBe(2);

    expect(await files(id)).toBe('DONE');
    j = await row(id);
    expect(j.status).toMatch(/COMPLETED/);
    expect(j.checkpoint).toBeNull();
    const c = await counts(id);
    expect(c.comment.created).toBe(6);
    expect(c.history.created).toBe(7);
    expect(c.attachment.created).toBe(2);
    expect(c.task.created).toBe(7);
  });

  it('comments: threaded one level, the matched person is the author, others are credited to the importer by name, original dates kept, nothing notified', async () => {
    const w = await world();
    await importAll(w);
    const login = await taskOf(w, LOGIN);
    const cs = await prisma.comment.findMany({ where: { targetType: 'TASK', targetId: login.id }, orderBy: { createdAt: 'asc' } });
    expect(cs.map((c) => c.createdAt.toISOString())).toEqual(['2026-02-01T11:00:00.000Z', '2026-02-01T12:00:00.000Z', '2026-02-01T13:00:00.000Z', '2026-02-01T14:00:00.000Z', '2026-02-02T09:00:00.000Z']);
    const [c1, c2, c3, c4, c5] = cs;
    expect(c1).toMatchObject({ authorId: w.ana.id, content: 'I can reproduce this on Safari 17.', parentCommentId: null });
    expect(c5.authorId).toBe(w.ana.id);
    expect(c2.parentCommentId).toBe(c1.id); // the reply
    expect(c2.editedAt?.toISOString()).toBe('2026-02-01T12:30:00.000Z');
    expect(c2.updatedAt.toISOString()).toBe('2026-02-01T12:30:00.000Z');
    for (const c of [c2, c3, c4]) expect(c.authorId).toBe(w.user.id); // no account to map to: the importer
    expect(c2.content).toMatch(/^\*\*Ben Ortiz \(via Linear\)\*\*\n\n/);
    expect(c3.content).toMatch(/^\*\*Deploy Bot \(via Linear\)\*\*/);
    expect(c4.content).toMatch(/^\*\*Cy Old \(via Linear\)\*\*/);
    expect(await prisma.activity.count({ where: { action: 'COMMENTED' } })).toBe(0);
    expect(await prisma.notification.count()).toBe(0);
    expect(await prisma.externalRef.count({ where: { externalType: 'comment' } })).toBe(6);
  });

  it('history: one IMPORTED_CHANGE per field change, original time and actor, silent, never in the workspace feed, shown on the task itself', async () => {
    const w = await world();
    await importAll(w);
    const login = await taskOf(w, LOGIN);
    const rows = await prisma.activity.findMany({ where: { targetType: 'TASK', targetId: login.id, action: 'IMPORTED_CHANGE' }, orderBy: { createdAt: 'asc' } });
    expect(rows).toHaveLength(7);
    expect(rows.every((r) => r.visibility === 'IMPORTED' && r.workspaceId === w.workspace.id)).toBe(true);
    expect(rows.map((r) => r.createdAt.toISOString())).toEqual(['2026-02-01T10:05:00.000Z', '2026-02-01T10:05:00.000Z', '2026-02-01T10:10:00.000Z', '2026-02-01T10:10:00.000Z', '2026-02-01T10:20:00.000Z', '2026-02-01T10:30:00.000Z', '2026-02-01T10:30:00.000Z']);
    const status = rows.find((r) => (r.metadata as { field: string }).field === 'status')!;
    expect(status.metadata).toMatchObject({ field: 'status', from: 'Todo', to: 'In Progress', externalId: 'h-1:status', at: '2026-02-01T10:05:00.000Z', origin: 'IMPORT', actor: { name: 'Ben Ortiz (via Linear)' } });
    expect(status.actorId).toBe(w.user.id); // Ben has no account
    expect(rows.find((r) => (r.metadata as { field: string }).field === 'priority')!.actorId).toBe(w.ana.id);
    expect(await prisma.notification.count()).toBe(0);

    const feed = await activities.list(w.user.id, { workspaceId: w.workspace.id, take: 100, skip: 0 } as never);
    expect(feed.data.filter((a) => a.action === 'IMPORTED_CHANGE')).toEqual([]); // not in the workspace feed
    const taskFeed = await activities.list(w.user.id, { workspaceId: w.workspace.id, targetType: 'TASK', targetId: login.id, take: 100, skip: 0 } as never);
    expect(taskFeed.data.filter((a) => a.action === 'IMPORTED_CHANGE')).toEqual([]); // not on the default task feed either
    const history = await activities.list(w.user.id, { workspaceId: w.workspace.id, targetType: 'TASK', targetId: login.id, includeImported: true, take: 100, skip: 0 } as never);
    expect(history.data.filter((a) => a.action === 'IMPORTED_CHANGE')).toHaveLength(7);
    await expect(activities.list(w.user.id, { workspaceId: w.workspace.id, includeImported: true, take: 10, skip: 0 } as never)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('history stamps `now` (the real time) when the job does not keep dates, but still records the source time in the metadata', async () => {
    const w = await world();
    const before = Date.now();
    await importAll(w, { keepDates: false });
    const rows = await prisma.activity.findMany({ where: { action: 'IMPORTED_CHANGE' } });
    expect(rows.length).toBe(7);
    expect(rows.every((r) => r.createdAt.getTime() >= before - 1000)).toBe(true);
    expect((rows[0].metadata as { at: string }).at).toMatch(/^2026-02-01T10:/);
    const cs = await prisma.comment.findMany();
    expect(cs.every((c) => c.createdAt.getTime() >= before - 1000)).toBe(true);
  });

  it('files: copied into storage with their bytes and hash, credited to the right person, the unsafe address is never requested, the text is not rewritten', async () => {
    const w = await world();
    await importAll(w);
    const login = await taskOf(w, LOGIN);
    const rows = await prisma.attachment.findMany({ where: { targetType: 'TASK', targetId: login.id }, orderBy: { filename: 'asc' } });
    expect(rows.map((r) => [r.filename, r.status, r.sizeBytes, r.mimeType])).toEqual([['login.png', 'CONFIRMED', 17, 'image/png'], ['screenshot.png', 'CONFIRMED', 17, 'application/pdf']]);
    expect(rows[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(storage.objects.get(rows[0].storageKey)).toEqual(bytes('AAAA-file-a-bytes'));
    expect(storage.objects.get(rows[1].storageKey)).toEqual(bytes('BBBB-file-b-bytes'));
    expect(rows[0].uploadedById).toBe(w.user.id); // Linear says nothing of who pasted a description's file: the importer
    expect(rows[1].uploadedById).toBe(w.user.id); // Ben has no account
    expect(rows.every((r) => r.confirmedAt)).toBe(true);
    expect(fake.fileCalls.map((f) => f.url).sort()).toEqual([FILE_A, FILE_B].sort());
    expect(fake.fileCalls.every((f) => f.auth === 'Bearer tok')).toBe(true);
    expect(fake.fileCalls.some((f) => f.url === FILE_EVIL)).toBe(false);
    // the copied files' links now point at OUR stable address (repointing, diagram 05 "repoint link"); the one not copied stays as it was
    expect(login.description).toContain(`![login.png](/files/${rows[0].id}/content)`);
    expect(login.description).toContain(`![login again](/files/${rows[0].id}/content)`); // every occurrence
    expect(login.description).not.toContain(FILE_A);
    expect(login.description).toContain(`![evil](${FILE_EVIL})`);
    expect(login.updatedAt.toISOString()).toBe(data.issues['team-eng'].find((i) => i.id === 'i-eng-1')!.updatedAt); // the fix-up did not touch the source's own time
    expect(login.description).toContain('**Linked in Linear**');
    expect(await prisma.externalRef.count({ where: { externalType: 'attachment' } })).toBe(2);
    expect(await prisma.attachment.count({ where: { status: 'PENDING' } })).toBe(0);
    expect(await prisma.activity.count({ where: { action: 'ATTACHMENT_ADDED' } })).toBe(0);
  });

  it('files do not use the monthly import meter (storage has its own plan limit)', async () => {
    const w = await world();
    await importAll(w);
    expect(await moduleUsed(w)).toBe(7);
  });
  const moduleUsed = async (w: World) => {
    const u = await prisma.usageMetric.findMany({ where: { accountId: w.account.id } });
    return u.reduce((n, m) => n + Number(m.value ?? 0), 0);
  };

  it('each option off writes nothing of that kind (and the files phase is skipped entirely)', async () => {
    const w = await world();
    const id = await started(w, { comments: false, attachments: false, history: false });
    await run(id);
    expect((await row(id)).status).toMatch(/COMPLETED/);
    expect(last(id, 'imports.copy-files')).toBeUndefined();
    expect(await prisma.comment.count()).toBe(0);
    expect(await prisma.activity.count({ where: { action: 'IMPORTED_CHANGE' } })).toBe(0);
    expect(await prisma.importFileItem.count()).toBe(0);
    expect(fake.fileCalls).toEqual([]);
  });

  it('an import with no files finishes at the end of the pages (no copy job)', async () => {
    const w = await world();
    const id = await started(w, { attachments: true }, ['team-ops']);
    await run(id);
    expect((await row(id)).status).toMatch(/COMPLETED/);
    expect(last(id, 'imports.copy-files')).toBeUndefined();
  });

  // ================================================================================================ idempotency / crashes

  it.each([['comments', 'writeComments'], ['history', 'writeHistory']] as const)('a crash after the tasks but during the %s: resume writes each of them exactly once', async (_k, method) => {
    const w = await world();
    const id = await started(w);
    const orig = (ImportContentWriter.prototype as never as Record<string, (...a: unknown[]) => Promise<void>>)[method];
    let thrown = false;
    jest.spyOn(ImportContentWriter.prototype as never, method as never).mockImplementation((async function (this: never, ...a: unknown[]) {
      if (!thrown) { thrown = true; throw new Error('simulated worker death'); }
      return orig.apply(this, a);
    }) as never);
    await run(id);
    expect((await row(id)).status).toBe(S.FAILED);
    await imports.resume(id, w.user.id);
    await run(id);
    await files(id);
    expect(await prisma.comment.count()).toBe(6);
    expect(await prisma.activity.count({ where: { action: 'IMPORTED_CHANGE' } })).toBe(7);
    expect(await prisma.externalRef.count({ where: { externalType: 'comment' } })).toBe(6);
    const c = await counts(id);
    expect([c.comment.created, c.history.created]).toEqual([6, 7]);
  });

  it('a second import of the same source adds nothing: tasks, comments, history and files are all found by their references', async () => {
    const w = await world();
    await importAll(w);
    const before = [await prisma.task.count(), await prisma.comment.count(), await prisma.activity.count({ where: { action: 'IMPORTED_CHANGE' } }), await prisma.attachment.count()];
    const second = await importAll(w);
    expect((await row(second)).status).toMatch(/COMPLETED/);
    expect([await prisma.task.count(), await prisma.comment.count(), await prisma.activity.count({ where: { action: 'IMPORTED_CHANGE' } }), await prisma.attachment.count()]).toEqual(before);
    expect(last(second, 'imports.copy-files')).toBeUndefined(); // no new tasks, so no new file items
  });

  it('a storage outage while copying a file PAUSES with an automatic retry; the retry reuses the reserved row and finishes with no duplicates', async () => {
    const w = await world();
    const id = await started(w);
    await run(id);
    let failed = false;
    storage.beforePut = () => { if (!failed) { failed = true; throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }); } };
    await files(id);
    const j = await row(id);
    expect(j.status).toBe(S.PAUSED);
    expect(j.pauseReason).toMatch(/network|trying again/i);
    const retry = enqueued.find((e) => e.jobId === `import-run-${id}-${j.attempt}`)!;
    expect(retry.delayMs).toBeGreaterThan(0);
    expect(await prisma.attachment.count({ where: { status: 'PENDING' } })).toBe(1); // the reservation stays
    expect((await prisma.importFileItem.findMany({ orderBy: { id: 'asc' } }))[0].attempts).toBe(1);

    await run(id); // the retry: phase FILES -> hands over to the copy queue again, same job
    expect((await row(id)).status).toBe(S.RUNNING);
    await files(id);
    expect((await row(id)).status).toMatch(/COMPLETED/);
    expect(await prisma.attachment.count()).toBe(2);
    expect(await prisma.attachment.count({ where: { status: 'CONFIRMED' } })).toBe(2);
  });

  it('a stale copy job (an older attempt) does nothing', async () => {
    const w = await world();
    const id = await started(w);
    await run(id);
    const payload = last(id, 'imports.copy-files')!.payload as { importJobId: string; attempt: number };
    expect(await executor.runFiles({ ...payload, attempt: payload.attempt - 1 })).toBe('STALE');
    expect(await prisma.attachment.count()).toBe(0);
  });

  // ================================================================================================ per-file outcomes

  it('a file gone at the source is reported and skipped; the rest of the import carries on', async () => {
    const w = await world();
    data.files![FILE_B] = { body: 'x', status: 404 };
    const id = await importAll(w);
    const j = await row(id);
    expect(j.status).toBe(S.COMPLETED_WITH_WARNINGS);
    expect(await codes(id)).toContain('ATTACHMENT_UNAVAILABLE');
    expect((await counts(id)).attachment).toMatchObject({ created: 1, failed: 1 });
    expect(await prisma.attachment.count({ where: { status: 'CONFIRMED' } })).toBe(1);
    expect(await prisma.attachment.count({ where: { status: 'PENDING' } })).toBe(0);
  });

  it('a file over the plan\'s per-file limit (size known up front) is skipped with a warning, nothing is stored or reserved', async () => {
    const w = await world();
    jest.spyOn(attachments, 'importLimits').mockResolvedValue({ maxFileSizeBytes: 10, storageBytes: 1e12 });
    const id = await importAll(w);
    expect(await codes(id)).toEqual(expect.arrayContaining(['ATTACHMENT_TOO_LARGE']));
    expect((await counts(id)).attachment).toMatchObject({ skipped: 2 });
    expect(await prisma.attachment.count()).toBe(0);
    expect(storage.objects.size).toBe(0);
    expect((await row(id)).status).toMatch(/COMPLETED/);
  });

  it('a file whose size is NOT announced is still capped while it streams, and its reservation is released', async () => {
    const w = await world();
    const orig = fake.fetch.getMockImplementation()!;
    fake.fetch.mockImplementation(async (u: unknown, i?: RequestInit) =>
      String(u) === FILE_A ? new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('A'.repeat(40))); c.close(); } }), { status: 200 }) : orig(u, i));
    jest.spyOn(attachments, 'importLimits').mockResolvedValue({ maxFileSizeBytes: 20, storageBytes: 1e12 });
    const id = await importAll(w);
    expect(await codes(id)).toContain('ATTACHMENT_TOO_LARGE');
    expect(await prisma.attachment.findMany({ where: { filename: 'login.png' } })).toEqual([]);
    expect(await prisma.attachment.count({ where: { filename: 'screenshot.png', status: 'CONFIRMED' } })).toBe(1); // FILE_B (17 bytes) fits
  });

  it('identical bytes in one account are stored ONCE: two rows, one object; the object goes with the LAST row', async () => {
    const w = await world();
    data.files![FILE_B] = { body: 'AAAA-file-a-bytes', contentType: 'image/png' };
    await importAll(w);
    const rows = await prisma.attachment.findMany();
    expect(rows).toHaveLength(2);
    expect(rows[0].storageKey).toBe(rows[1].storageKey);
    expect(rows[0].sha256).toBe(rows[1].sha256);
    expect(storage.objects.size).toBe(1);
    expect(storage.deleted).toHaveLength(1); // the redundant copy that was written first
    expect(storage.deleted[0]).not.toBe(rows[0].storageKey);

    await attachments.delete(rows[0].id);
    expect(storage.objects.has(rows[1].storageKey)).toBe(true); // the survivor still has its bytes
    await attachments.delete(rows[1].id);
    expect(storage.objects.size).toBe(0);
  });

  it('the same bytes in ANOTHER account are never shared', async () => {
    const w = await world();
    await importAll(w);
    const other = await createUserWithAccount(prisma, { role: Role.OWNER });
    const ws2 = await createWorkspace(prisma, { accountId: other.account.id });
    const t = await prisma.task.findFirstOrThrow({ where: { workspaceId: w.workspace.id } });
    const mine = await prisma.attachment.findFirstOrThrow({ where: { filename: 'login.png' } });
    void ws2; void t;
    const res = await attachments.reserveForImport({ accountId: other.account.id, taskId: t.id, uploadedById: other.user.id, filename: 'x.png', mimeType: 'image/png', sizeBytes: 17 });
    const done = await attachments.finalizeImported(res.id, { sizeBytes: 17, sha256: mine.sha256 as string });
    expect(done.deduped).toBe(false);
    expect(done.attachment.storageKey).not.toBe(mine.storageKey);
  });

  // ================================================================================================ job-level outcomes

  it('a full storage plan PAUSES the import (message for the person), reserves nothing past the limit, and resumes when there is room', async () => {
    const w = await world();
    const spy = jest.spyOn(attachments, 'importLimits').mockResolvedValue({ maxFileSizeBytes: 1e9, storageBytes: 20 }); // room for one 17-byte file
    const id = await started(w);
    await run(id);
    await files(id);
    const j = await row(id);
    expect(j.status).toBe(S.PAUSED);
    expect(j.pauseReason).toMatch(/limit/i);
    expect(await prisma.attachment.count({ where: { status: 'CONFIRMED' } })).toBe(1);
    expect(await prisma.attachment.count({ where: { status: 'PENDING' } })).toBe(0); // the refused reservation left nothing behind
    expect(await prisma.importFileItem.count({ where: { status: 'PENDING' } })).toBe(1);

    spy.mockResolvedValue({ maxFileSizeBytes: 1e9, storageBytes: 1e12 }); // the person upgraded
    await imports.resume(id, w.user.id);
    await run(id);
    await files(id);
    expect((await row(id)).status).toMatch(/COMPLETED/);
    expect(await prisma.attachment.count({ where: { status: 'CONFIRMED' } })).toBe(2);
  });

  it('a revoked token while copying PAUSES for reconnection; after reconnecting the files finish', async () => {
    const w = await world();
    data.files![FILE_A] = { body: 'x', status: 401 };
    const id = await started(w);
    await run(id);
    await files(id);
    const j = await row(id);
    expect(j.status).toBe(S.PAUSED);
    expect(j.pauseReason).toMatch(/reconnect/i);
    data.files![FILE_A] = { body: 'AAAA-file-a-bytes', contentType: 'image/png' };
    await imports.resume(id, w.user.id);
    await run(id);
    await files(id);
    expect((await row(id)).status).toMatch(/COMPLETED/);
    expect(await prisma.attachment.count({ where: { status: 'CONFIRMED' } })).toBe(2);
  });

  it('a cancel while a file is being stored leaves no reference and no confirmed row behind', async () => {
    const w = await world();
    const id = await started(w);
    await run(id);
    let first = true;
    storage.beforePut = async () => { if (first) { first = false; await imports.cancel(id, w.user.id); } };
    await files(id);
    expect((await row(id)).status).toBe(S.CANCELED);
    expect(await prisma.externalRef.count({ where: { externalType: 'attachment' } })).toBe(0);
    expect(await prisma.attachment.count({ where: { status: 'CONFIRMED' } })).toBe(0);
    expect(await prisma.importFileItem.count({ where: { status: 'DONE' } })).toBe(0);
  });

  it('links to copied files are re-pointed in the comments too, with the comment\'s own dates untouched; a file that was NOT copied keeps its source link', async () => {
    const w = await world();
    data.files![FILE_A] = { body: 'x', status: 404 }; // FILE_A is gone at the source: its link stays
    await importAll(w);
    const login = await taskOf(w, LOGIN);
    const b = await prisma.attachment.findFirstOrThrow({ where: { filename: 'screenshot.png' } });
    const reply = await prisma.comment.findFirstOrThrow({ where: { targetId: login.id, content: { contains: 'Same here' } } });
    expect(reply.content).toContain(`![screenshot.png](/files/${b.id}/content)`);
    expect(reply.content).not.toContain(FILE_B);
    expect(reply.updatedAt.toISOString()).toBe('2026-02-01T12:30:00.000Z');
    expect(reply.createdAt.toISOString()).toBe('2026-02-01T12:00:00.000Z');
    expect(login.description).toContain(FILE_A); // not copied -> still the source link
  });

  it('the re-pointed address is the configured prefix + /files/<id>/content', async () => {
    const copier = moduleRefForCopier();
    expect(copier.contentLink('abc')).toMatch(/^\/files\/abc\/content$/);
  });

  it('a provider whose top level is not a workspace (Linear) refuses the per-Space setup', async () => {
    const w = await world();
    await expect(imports.createPerSpace({ connectionId: w.connection.id, options: ALL, spaces: [{ spaceId: 'team-eng' }] }, w.user.id)).rejects.toThrow(/no level that maps to workspaces/);
  });

  // ================================================================================================ rollback

  it('rollback of an untouched import removes every comment, history row, file, object and item; a second rollback is a no-op', async () => {
    const w = await world();
    const id = await importAll(w);
    expect(storage.objects.size).toBe(2);
    await imports.rollback(id, w.user.id);
    await rollback.run({ importJobId: id });
    expect((await row(id)).status).toBe(S.ROLLED_BACK);
    expect(await prisma.task.count()).toBe(0);
    expect(await prisma.comment.count()).toBe(0);
    expect(await prisma.activity.count({ where: { action: 'IMPORTED_CHANGE' } })).toBe(0);
    expect(await prisma.attachment.count()).toBe(0);
    expect(await prisma.importFileItem.count()).toBe(0);
    expect(await prisma.externalRef.count()).toBe(0);
    expect(storage.objects.size).toBe(0);
    expect(await rollback.run({ importJobId: id })).toBe('STALE');
  });

  it('rollback never deletes what a person added: a reply to an imported comment, a new comment, a new file; those tasks stay, with the people\'s content only', async () => {
    const w = await world();
    const id = await importAll(w);
    const login = await taskOf(w, LOGIN);
    const cookie = await taskOf(w, 'Fix session cookie');
    const root = await prisma.comment.findFirstOrThrow({ where: { targetId: login.id, parentCommentId: null }, orderBy: { createdAt: 'asc' } });
    await prisma.comment.create({ data: { targetType: 'TASK', targetId: login.id, authorId: w.user.id, content: 'my own reply', parentCommentId: root.id } });
    await prisma.comment.create({ data: { targetType: 'TASK', targetId: cookie.id, authorId: w.user.id, content: 'my own note' } });
    const mine = await prisma.attachment.create({ data: { accountId: w.account.id, targetType: 'TASK', targetId: cookie.id, uploadedById: w.user.id, filename: 'mine.txt', mimeType: 'text/plain', sizeBytes: 3, storageKey: 'attachments/mine', status: 'CONFIRMED' } });
    storage.objects.set('attachments/mine', bytes('abc'));

    await imports.rollback(id, w.user.id);
    await rollback.run({ importJobId: id });
    expect((await row(id)).status).toBe(S.ROLLED_BACK);

    // the imported replies / roots without a person's reply are gone; the root somebody replied to is kept with that reply
    const left = await prisma.comment.findMany({ orderBy: { createdAt: 'asc' } });
    expect(left.map((c) => c.content)).toEqual(['I can reproduce this on Safari 17.', 'my own reply', 'my own note']);
    // their tasks are kept; every other imported task is gone
    expect((await prisma.task.findMany({ select: { title: true }, orderBy: { title: 'asc' } })).map((t) => t.title)).toEqual(['Fix session cookie', LOGIN]);
    // imported files are gone, the person's file and its bytes are not
    expect((await prisma.attachment.findMany()).map((a) => a.id)).toEqual([mine.id]);
    expect([...storage.objects.keys()]).toEqual(['attachments/mine']);
    // the history this job wrote is gone even from the tasks that stay
    expect(await prisma.activity.count({ where: { action: 'IMPORTED_CHANGE' } })).toBe(0);
    const kept = (await prisma.importJobIssue.findMany({ where: { importJobId: id, code: 'ROLLBACK_KEPT' } })).map((i) => i.message);
    expect(kept.some((m) => /replied/.test(m))).toBe(true);
    expect(kept.some((m) => /comments or files were added/.test(m))).toBe(true);
    // idempotent
    expect(await rollback.run({ importJobId: id })).toBe('STALE');
  });

  it('rollback of a deduped file keeps the object while another import row still needs it', async () => {
    const w = await world();
    data.files![FILE_B] = { body: 'AAAA-file-a-bytes', contentType: 'image/png' };
    const id = await importAll(w);
    expect(storage.objects.size).toBe(1);
    // a person's own attachment row shares the object (same bytes, e.g. their own earlier import)
    const [row0] = await prisma.attachment.findMany();
    const login = await taskOf(w, LOGIN);
    const shared = await prisma.attachment.create({ data: { accountId: w.account.id, targetType: 'TASK', targetId: login.id, uploadedById: w.user.id, filename: 'p.png', mimeType: 'image/png', sizeBytes: 17, storageKey: row0.storageKey, status: 'CONFIRMED', sha256: row0.sha256 } });
    await imports.rollback(id, w.user.id);
    await rollback.run({ importJobId: id });
    expect(storage.objects.has(shared.storageKey)).toBe(true);
    expect(await prisma.attachment.count()).toBe(1);
  });
});
