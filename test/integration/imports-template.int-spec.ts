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
import { LinearAdapter } from '../../src/integrations/providers/linear/linear.adapter';
import { LinearClient } from '../../src/integrations/providers/linear/linear.client';
import { CONTENT_DATASET, FILE_A, FILE_B, FILE_EVIL, LinearDataset, fakeLinear } from '../../src/integrations/providers/linear/fixtures/linear-responses';
import { TemplateApplyService } from '../../src/templates/apply/apply.service';
import { TemplatesModule } from '../../src/templates/templates.module';
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

describe('Import as template + report download (step 4.9)', () => {
  let prisma: PrismaService;
  let imports: ImportsService;
  let executor: ImportExecutor;
  let planLimits: PlanLimitsService;
  let applier: TemplateApplyService;
  let issues: ImportIssueService;
  let storage: FakeStorage;
  let fake: ReturnType<typeof fakeLinear>;
  let data: LinearDataset;
  let enqueued: Array<{ queue: string; name: string; payload: { importJobId: string; attempt?: number } }>;

  beforeAll(async () => {
    prisma = getTestPrisma();
    storage = new FakeStorage();
    const fetchFn = (async (url: unknown, init?: RequestInit) => (await (fake.fetch as unknown as (u: unknown, i?: RequestInit) => Promise<Response>)(url, init)).clone()) as never;
    const http = new ProviderHttpClient(noRedis, fetchFn, { bucketCapacity: 1e6, refillPerSecond: 1e6, maxRetries: 0 });
    const linear = new LinearAdapter({ get: () => undefined } as never, http, new LinearClient(http));
    const queue = { enqueue: async (q: string, name: string, payload: never, o: { jobId?: string } = {}) => { enqueued.push({ queue: q, name, payload }); return { id: o.jobId ?? 'x' }; } };
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
        TaskPlanningService, ProjectsService, CustomFieldsService, DomainWriter, DomainEraser, ConnectorRegistry, ActivitiesService, TemplateApplyService,
        ExternalRefService, ImportIssueService, ImportUsageService, MappingService, ImportProgressPublisher, ImportWriter, ImportExecutor, ImportRollback, ImportsService,
        ...contentProviders(storage),
      ],
    }).compile();
    await moduleRef.init();
    new TemplatesModule(moduleRef.get(PlanLimitsService)).onModuleInit();
    imports = moduleRef.get(ImportsService);
    executor = moduleRef.get(ImportExecutor);
    planLimits = moduleRef.get(PlanLimitsService);
    applier = moduleRef.get(TemplateApplyService);
    issues = moduleRef.get(ImportIssueService);
  });
  beforeEach(async () => {
    await resetDb(prisma);
    enqueued = [];
    storage.objects.clear();
    data = structuredClone(CONTENT_DATASET);
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

  async function previewed(w: World, teams = ['team-eng'], options: Partial<typeof ALL> = {}) {
    const job = await imports.create({ connectionId: w.connection.id, workspaceId: w.workspace.id, options: { ...ALL, ...options } }, w.user.id);
    await imports.setSelection(job.id, { sources: teams.map((id) => ({ id, type: 'team' })) }, w.user.id);
    await imports.preview(job.id, w.user.id);
    return job.id;
  }
  const last = (id: string, name: string) => [...enqueued].reverse().find((e) => e.name === name && e.payload.importJobId === id);
  const run = (id: string) => executor.run(last(id, 'imports.run')!.payload as { importJobId: string; attempt: number });
  const row = (id: string) => prisma.importJob.findUniqueOrThrow({ where: { id } });
  const blueprintOf = async (templateId: string) => {
    const v = await prisma.templateVersion.findFirstOrThrow({ where: { templateId }, orderBy: { sequence: 'desc' } });
    return (v as unknown as { blueprint: any }).blueprint;
  };
  async function asTemplate(w: World, settings: Record<string, unknown> = {}, teams?: string[], options?: Partial<typeof ALL>) {
    const id = await previewed(w, teams, options);
    await imports.startAsTemplate(id, settings, w.user.id);
    await run(id);
    return id;
  }

  it('reads the source, writes NOTHING to the workspace, and stores a PRIVATE template of this account', async () => {
    const w = await world();
    const id = await asTemplate(w, { name: 'Engineering starter' });
    const j = await row(id);
    expect(j.status).toMatch(/COMPLETED/);
    const result = j.result as { kind: string; templateId: string; build: { tasks: { included: number } } };
    expect(result.kind).toBe('TEMPLATE');
    expect(await prisma.task.count({ where: { workspaceId: w.workspace.id } })).toBe(0);
    expect(await prisma.project.count({ where: { workspaceId: w.workspace.id } })).toBe(0);
    expect(await prisma.externalRef.count()).toBe(0);
    expect(await prisma.comment.count()).toBe(0);
    expect(last(id, 'imports.copy-files')).toBeUndefined(); // no files are copied for a template
    const t = await prisma.template.findUniqueOrThrow({ where: { id: result.templateId } });
    expect(t).toMatchObject({ ownerAccountId: w.account.id, name: 'Engineering starter', visibility: 'PRIVATE' });
    expect(result.build.tasks.included).toBe(6); // the 7th is archived in Linear: left out, and said so
    expect((j.progress as any).counts.task.created).toBe(6);
  });

  it('the template is sanitized: people are roles, dates are offsets, no e-mail / id / link of the source survives', async () => {
    const w = await world();
    const id = await asTemplate(w);
    const bp = await blueprintOf(((await row(id)).result as any).templateId);
    const text = JSON.stringify(bp);
    expect(bp.meta.kind).toBe('PROJECT');
    expect(text).not.toMatch(/example\.com|src:|i-eng-|uploads\.linear\.app|linear\.app/);
    expect(text).not.toMatch(/2026-0[1-3]-\d\d/); // no absolute date
    expect(bp.projects[0].tasks.length).toBeGreaterThan(0);
    expect((bp.roles ?? []).length).toBeGreaterThan(0); // the assignees became roles
    const flat = (ts: any[]): any[] => ts.flatMap((t) => [t, ...flat(t.children ?? [])]);
    expect(flat(bp.projects[0].tasks)).toHaveLength(6);
    expect(flat(bp.projects[0].tasks).every((t) => !t.comments || t.comments.length === 0)).toBe(true); // comments are off by default
  });

  it('comments only when asked, and then without their authors (roles) or any source id', async () => {
    const w = await world();
    const id = await asTemplate(w, { includeComments: true });
    const bp = await blueprintOf(((await row(id)).result as any).templateId);
    const flat = (ts: any[]): any[] => ts.flatMap((t) => [t, ...flat(t.children ?? [])]);
    const withComments = flat(bp.projects[0].tasks).filter((t) => t.comments?.length);
    expect(withComments.length).toBeGreaterThan(0);
    expect(JSON.stringify(bp)).not.toMatch(/u-ana|u-ben|ben@|ana@/);
  });

  it('what is left out is reported: files, history, the comment switch', async () => {
    const w = await world();
    const id = await asTemplate(w);
    const codes = (await prisma.importJobIssue.findMany({ where: { importJobId: id } })).map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(['TEMPLATE_ATTACHMENTS_DROPPED', 'TEMPLATE_HISTORY_DROPPED', 'TEMPLATE_COMMENTS_OFF', 'TEMPLATE_ARCHIVED_SKIPPED']));
  });

  it('the template WORKS: applied to a new workspace it creates the imported structure (tree, statuses, tags)', async () => {
    const w = await world();
    const id = await asTemplate(w);
    const templateId = ((await row(id)).result as any).templateId as string;
    const target = await createWorkspace(prisma, { accountId: w.account.id });
    const bp = await blueprintOf(templateId);
    const roles = Object.fromEntries((bp.roles ?? []).map((r: any) => [r.key, { type: 'UNASSIGNED' }]));
    // the template asks for a start date (every date in it is an offset from that day) and, here, nobody for its roles
    await applier.apply(w.user.id, templateId, { workspaceId: target.id, roles, variables: { startDate: '2026-06-01' } } as any, { today: '2026-06-01' } as any);
    expect(await prisma.task.count({ where: { workspaceId: target.id } })).toBe(6);
    const login = await prisma.task.findFirstOrThrow({ where: { workspaceId: target.id, title: 'Login fails on Safari' } });
    const sub = await prisma.task.findFirstOrThrow({ where: { workspaceId: target.id, title: 'Fix session cookie' } });
    expect(sub.parentId).toBe(login.id);
    expect(await prisma.workflowStatus.count({ where: { project: { workspaceId: target.id } } })).toBeGreaterThan(2);
  });

  it('a credential in the source STOPS the template (nothing stored); choosing to redact lets it through without the secret', async () => {
    const w = await world();
    data.issues['team-eng'] = data.issues['team-eng'].map((i) => (i.id === 'i-eng-1' ? { ...i, description: `${i.description}\n\naws key AKIAIOSFODNN7EXAMPLE and password=hunter2hunter2` } : i));
    const blocked = await asTemplate(w, { name: 'X' });
    expect((await row(blocked)).status).toBe('FAILED');
    expect((await row(blocked)).pauseReason).toMatch(/credential/i);
    expect(await prisma.template.count()).toBe(0);

    const ok = await asTemplate(w, { name: 'X', onSecret: 'redact' });
    expect((await row(ok)).status).toMatch(/COMPLETED/);
    const bp = await blueprintOf(((await row(ok)).result as any).templateId);
    expect(JSON.stringify(bp)).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(JSON.stringify(bp)).not.toContain('hunter2hunter2');
  });

  it('who may: creating templates needs createTemplate on the account; a refusal changes nothing', async () => {
    const w = await world();
    const member = await createUser(prisma, { email: 'm@example.com', emailVerified: true });
    await prisma.accountMember.create({ data: { accountId: w.account.id, userId: member.id, role: Role.MEMBER } });
    const id = await previewed(w);
    const before = await row(id);
    await expect(imports.startAsTemplate(id, { name: 'n' }, member.id)).rejects.toBeInstanceOf(ForbiddenException);
    const after = await row(id);
    expect([after.status, JSON.stringify(after.options)]).toEqual([before.status, JSON.stringify(before.options)]);
    expect(last(id, 'imports.run')).toBeUndefined();
  });

  it('the plan\'s template limit stops it before anything runs', async () => {
    const w = await world();
    const id = await previewed(w);
    jest.spyOn(planLimits, 'checkLimit').mockImplementation(async (limit) => limit !== 'template');
    await expect(imports.startAsTemplate(id, { name: 'n' }, w.user.id)).rejects.toBeInstanceOf(ForbiddenException);
    expect((await row(id)).status).toBe('PREVIEW_READY');
  });

  it.each([
    ['an unknown setting', { name: 'n', visibility: 'PUBLIC' }, /Unknown template setting/],
    ['a name that is too long', { name: 'x'.repeat(121) }, /at most 120/],
    ['a bad category', { name: 'n', category: 'Not Valid!' }, /category/],
    ['onSecret nonsense', { name: 'n', onSecret: 'maybe' }, /onSecret/],
    ['includeComments as text', { name: 'n', includeComments: 'yes' }, /includeComments/],
  ])('refuses %s with a 400 and leaves the job as it was', async (_n, settings, msg) => {
    const w = await world();
    const id = await previewed(w);
    await expect(imports.startAsTemplate(id, settings, w.user.id)).rejects.toThrow(msg);
    expect((await row(id)).status).toBe('PREVIEW_READY');
  });

  it('only a previewed job can start; the template target can never be smuggled in through create()', async () => {
    const w = await world();
    const job = await imports.create({ connectionId: w.connection.id, workspaceId: w.workspace.id, options: ALL }, w.user.id);
    await expect(imports.startAsTemplate(job.id, { name: 'n' }, w.user.id)).rejects.toBeInstanceOf(ConflictException);
    await expect(imports.create({ connectionId: w.connection.id, workspaceId: w.workspace.id, options: { ...ALL, target: 'TEMPLATE' } as never }, w.user.id)).rejects.toThrow(/Unknown import option/);
  });

  it('a default name comes from the source when none is given', async () => {
    const w = await world();
    const id = await asTemplate(w, {});
    expect((await prisma.template.findFirstOrThrow()).name).toMatch(/Engineering/);
    expect((await row(id)).status).toMatch(/COMPLETED/);
  });

  // ================================================================================================ the downloadable report

  describe('report download', () => {
    it('CSV: a BOM, a header, one row per issue, quotes doubled; a formula-looking cell is neutralized', async () => {
      const w = await world();
      const id = await previewed(w);
      await issues.record(id, [
        { severity: 'WARN', code: 'X', externalRef: 'task:1', message: '=HYPERLINK("http://evil","x")' },
        { severity: 'INFO', code: 'Y', externalRef: null, message: 'He said "hi", then left' },
        { severity: 'ERROR', code: 'Z', externalRef: '@cmd', message: '+1 and -2' },
      ] as never);
      const f = await imports.reportDownload(id, w.user.id, 'csv');
      expect(f.filename).toBe(`import-${id}-report.csv`);
      expect(f.contentType).toMatch(/^text\/csv/);
      expect(f.body.startsWith('\uFEFF"severity","code","item","message","recorded at"')).toBe(true);
      const lines = f.body.replace('\uFEFF', '').trim().split('\r\n');
      expect(lines).toHaveLength(4);
      expect(lines.join('\n')).toContain(`"'=HYPERLINK(""http://evil"",""x"")"`); // neutralized AND quoted
      expect(lines.join('\n')).toContain('"He said ""hi"", then left"');
      expect(lines.join('\n')).toContain(`"'@cmd"`);
      expect(lines.join('\n')).toContain(`"'+1 and -2"`);
      expect(f.body.endsWith('\r\n')).toBe(true);
    });

    it('JSON: the whole report with the rows; the same permission as the on-screen report', async () => {
      const w = await world();
      const id = await previewed(w);
      await issues.record(id, [{ severity: 'WARN', code: 'X', externalRef: null, message: 'm' }] as never);
      const f = await imports.reportDownload(id, w.user.id, 'json');
      const body = JSON.parse(f.body);
      expect(f.contentType).toMatch(/^application\/json/);
      expect(body.job.id).toBe(id);
      expect(body.issueRows.map((r: any) => r.code)).toEqual(['X']);
      expect(body.truncated).toBe(false);
      const stranger = await createUserWithAccount(prisma, { role: Role.OWNER });
      await expect(imports.reportDownload(id, stranger.user.id, 'csv')).rejects.toBeInstanceOf(ForbiddenException);
      await expect(imports.reportDownload('nope', w.user.id, 'csv')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('a template build\'s report is downloadable too and lists what was left out', async () => {
      const w = await world();
      const id = await asTemplate(w);
      const f = await imports.reportDownload(id, w.user.id, 'csv');
      expect(f.body).toContain('TEMPLATE_ATTACHMENTS_DROPPED');
    });
  });
});
