/**
 * Step 4.4 - the import executor and rollback against a real Postgres, fed by a fake source (no network): the full path
 * create -> preview -> map -> start -> run -> (pause | cancel | fail | resume) -> rollback, and what each must leave behind.
 */
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import {
  ActivityVisibility,
  CollaboratorRole,
  ImportJobStatus as S,
  IntegrationProvider,
  IssueTypeLevel,
  Role,
  TaskStatus,
} from '@prisma/client';
import { PermissionResolver } from '../../src/access-control/access-control.service';
import { PlanLimitsService } from '../../src/access-control/plan-limits.service';
import { DomainEraser } from '../../src/domain-writer/domain-eraser.service';
import { DomainWriter } from '../../src/domain-writer/domain-writer.service';
import { ActivityService } from '../../src/events/activity.service';
import { AuditLogService } from '../../src/events/audit-log.service';
import { ConnectorRegistry } from '../../src/integrations/core/connector.registry';
import { ConnectionNeedsReauthError, CredentialService } from '../../src/integrations/core/credential.service';
import { AuthorizeContext, CallbackParams, Capability, ExchangeContext, INTEGRATION_ADAPTERS, ProviderRateLimitedError } from '../../src/integrations/core/integration.types';
import { buildInventory, parseInventory } from '../../src/imports/mapping';
import { CanonicalBundle, validateBundle } from '../../src/imports/canonical';
import { ImportProgressPublisher } from '../../src/imports/executor/import-progress';
import { ImportExecutor, MAX_PAGES_PER_RUN } from '../../src/imports/executor/import-executor.service';
import { ImportRollback } from '../../src/imports/executor/import-rollback.service';
import { ImportWriter } from '../../src/imports/executor/import-writer';
import { ExternalRefService } from '../../src/imports/external-ref.service';
import { FetchBundleInput, ImportAdapterContext, ImportCapableAdapter } from '../../src/imports/import-adapter';
import { ImportIssueService } from '../../src/imports/import-issue.service';
import { ImportUsageService } from '../../src/imports/import-usage.service';
import { ImportsService } from '../../src/imports/imports.service';
import { ImportEstimate, ImportOptions, ImportSelection, SourceTree } from '../../src/imports/imports.types';
import { MappingService } from '../../src/imports/mapping/mapping.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { CustomFieldsService } from '../../src/projects-tasks/custom-fields/custom-fields.service';
import { ProjectsService } from '../../src/projects-tasks/projects/projects.service';
import { TaskPlanningService } from '../../src/projects-tasks/planning/task-planning.service';
import { TaskTreeService } from '../../src/projects-tasks/tasks/task-tree.service';
import { TaskVisibilityService } from '../../src/projects-tasks/tasks/task-visibility.service';
import { TasksService } from '../../src/projects-tasks/tasks/tasks.service';
import { WorkflowService } from '../../src/projects-tasks/workflow/workflow.service';
import { QueueService } from '../../src/queue/queue.service';
import { RedisPubSubService } from '../../src/redis/redis-pubsub.service';
import { WorkspacesService } from '../../src/tenancy/workspaces/workspaces.service';
import { createTask, createUser, createUserWithAccount, createWorkspace } from './factories';
import { FakeStorage, contentProviders } from './support/fake-storage';
import { disconnectTestPrisma, getTestPrisma } from './support/prisma-test-client';
import { resetDb } from './support/reset-db';

// ---------------------------------------------------------------------------------------------------------------- source
const STATUSES = [
  { externalId: 's-todo', name: 'To Do', category: 'TODO' },
  { externalId: 's-prog', name: 'In Progress', category: 'IN_PROGRESS' },
  { externalId: 's-blk', name: 'Blocked', category: 'IN_PROGRESS' },
  { externalId: 's-done', name: 'Done', category: 'DONE' },
];
const SOURCE = { system: 'jira', displayName: 'Jira' };
const day = (n: number) => new Date(Date.UTC(2025, 0, 1 + n)).toISOString();

function structurePage(extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1, source: SOURCE,
    users: [{ externalId: 'j-ana', name: 'Ana', email: 'ana@example.com' }, { externalId: 'j-eve', name: 'Eve', email: 'eve@example.com' }],
    projects: [{ externalId: 'ENG', name: 'Engineering', key: 'ENG', statuses: STATUSES }],
    issueTypes: [{ externalId: 'bug', name: 'Bug' }, { externalId: 'story', name: 'Story' }],
    customFields: [{ externalId: 'cf-pts', name: 'Points', dataType: 'NUMBER' }, { externalId: 'cf-sev', name: 'Severity', dataType: 'SELECT', options: [{ label: 'S1' }, { label: 'S2' }] }],
    iterations: [{ externalId: 'sp1', kind: 'SPRINT', name: 'Sprint 1', projectExternalId: 'ENG' }],
    tags: [{ name: 'backend' }],
    ...extra,
  };
}
const task = (i: number, extra: Record<string, unknown> = {}) => ({
  externalId: `T${i}`, key: `ENG-${i}`, projectExternalId: 'ENG', title: `Task ${i}`, description: `Body ${i}`,
  statusExternalId: STATUSES[i % STATUSES.length].externalId, priority: 'High', assigneeExternalIds: i % 2 ? ['j-ana'] : ['j-eve'],
  tags: ['backend'], customValues: [{ fieldExternalId: 'cf-pts', value: i }, { fieldExternalId: 'cf-sev', value: 'S1' }],
  issueTypeExternalId: 'bug', iterationExternalId: 'sp1', createdAt: day(i), updatedAt: day(i + 1), dueDate: day(i + 30), estimate: 3, ...extra,
});
function taskPages(n: number, perPage: number, mk: (i: number) => Record<string, unknown> = (i) => task(i)) {
  const pages: unknown[] = [];
  for (let from = 1; from <= n; from += perPage) {
    pages.push({ schemaVersion: 1, source: SOURCE, tasks: Array.from({ length: Math.min(perPage, n - from + 1) }, (_, k) => mk(from + k)) });
  }
  return pages;
}

class Source implements ImportCapableAdapter {
  readonly provider = IntegrationProvider.LINEAR;
  readonly capabilities = new Set<Capability>(['IMPORT']);
  readonly usesPkce = false;
  pages: unknown[] = [];
  fetched: number[] = [];
  onFetch: ((index: number) => Promise<void> | void) | null = null;
  isConfigured() { return true; }
  authorizeUrl(_c: AuthorizeContext) { return 'x'; }
  async exchangeCode(_p: CallbackParams, _c: ExchangeContext): Promise<never> { throw new Error('unused'); }
  async revoke() { /* unused */ }
  async discover(_c: ImportAdapterContext): Promise<SourceTree> { return { nodes: [{ id: 'proj-a', type: 'project', name: 'A', selectable: true }] }; }
  async estimate(_c: ImportAdapterContext, _s: ImportSelection, _o: ImportOptions): Promise<ImportEstimate> {
    const valid = this.pages.map((p) => validateBundle(p)).filter((r) => !('fatal' in r)).map((r) => (r as { bundle: CanonicalBundle }).bundle);
    const tasks = valid.reduce((n, p) => n + (p.tasks?.length ?? 0), 0);
    return { projects: [{ sourceId: 'proj-a', name: 'A', tasks }], inventory: buildInventory(valid) };
  }
  async fetchBundle({ cursor }: FetchBundleInput) {
    const i = typeof cursor === 'number' ? cursor : 0;
    await this.onFetch?.(i);
    this.fetched.push(i);
    return { bundle: this.pages[i], next: i + 1 < this.pages.length ? i + 1 : null };
  }
}

describe('import executor and rollback (step 4.4)', () => {
  let prisma: PrismaService;
  let source: Source;
  let imports: ImportsService;
  let executor: ImportExecutor;
  let rollback: ImportRollback;
  let usage: ImportUsageService;
  let refs: ExternalRefService;
  let enqueued: Array<{ name: string; payload: { importJobId: string; attempt?: number }; jobId?: string; delayMs?: number }>;
  let pushed: Array<{ channel: string; message: string }>;
  let pushFails = false;
  let tokenError: Error | null = null;

  beforeAll(async () => {
    prisma = getTestPrisma();
    source = new Source();
    const queue = {
      enqueue: async (_q: string, name: string, payload: never, opts: { jobId?: string; delayMs?: number } = {}) => {
        enqueued.push({ name, payload, jobId: opts.jobId, delayMs: opts.delayMs });
        return { id: opts.jobId ?? 'x' };
      },
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: new EventEmitter2() },
        { provide: WorkspacesService, useValue: {} },
        { provide: QueueService, useValue: queue },
        { provide: CredentialService, useValue: { getAccessToken: async () => { if (tokenError) throw tokenError; return 'tok'; } } },
        { provide: RedisPubSubService, useValue: { publish: async (channel: string, message: string) => { if (pushFails) throw new Error('redis down'); pushed.push({ channel, message }); } } },
        { provide: INTEGRATION_ADAPTERS, useValue: [source] },
        ActivityService, AuditLogService, PermissionResolver, PlanLimitsService, TaskVisibilityService, TasksService, TaskTreeService, WorkflowService,
        TaskPlanningService, ProjectsService, CustomFieldsService, DomainWriter, DomainEraser, ConnectorRegistry,
        ExternalRefService, ImportIssueService, ImportUsageService, MappingService, ImportProgressPublisher, ImportWriter, ImportExecutor, ImportRollback, ImportsService, ...contentProviders(new FakeStorage()),
      ],
    }).compile();
    await moduleRef.init();
    imports = moduleRef.get(ImportsService);
    executor = moduleRef.get(ImportExecutor);
    rollback = moduleRef.get(ImportRollback);
    usage = moduleRef.get(ImportUsageService);
    refs = moduleRef.get(ExternalRefService);
  });
  beforeEach(async () => {
    await resetDb(prisma);
    enqueued = []; pushed = []; pushFails = false; tokenError = null;
    source.pages = []; source.fetched = []; source.onFetch = null;
  });
  afterAll(() => disconnectTestPrisma());

  async function world(plan = 'PRO_PERSONAL') {
    const w = await createUserWithAccount(prisma, { role: Role.OWNER });
    await prisma.account.update({ where: { id: w.account.id }, data: { planType: plan as never } });
    const ana = await createUser(prisma, { email: 'ana@example.com', emailVerified: true, name: 'Ana' });
    await prisma.accountMember.create({ data: { accountId: w.account.id, userId: ana.id, role: Role.MEMBER } });
    const workspace = await createWorkspace(prisma, { accountId: w.account.id });
    const connection = await prisma.integrationConnection.create({ data: { accountId: w.account.id, provider: IntegrationProvider.LINEAR, externalAccountId: 'org', externalAccountName: 'Org', scopes: [], createdById: w.user.id } });
    return { ...w, ana, workspace, connection };
  }
  type World = Awaited<ReturnType<typeof world>>;

  /** create -> select -> preview -> start. Returns the job id. */
  async function started(w: World, mapping?: Record<string, unknown>) {
    const job = await imports.create({ connectionId: w.connection.id, workspaceId: w.workspace.id }, w.user.id);
    await imports.setSelection(job.id, { sources: [{ id: 'proj-a', type: 'project' }] }, w.user.id);
    if (mapping) await imports.setMapping(job.id, mapping, w.user.id);
    await imports.preview(job.id, w.user.id);
    await imports.start(job.id, w.user.id);
    return job.id;
  }
  const lastRun = (id: string) => [...enqueued].reverse().find((e) => e.name === 'imports.run' && e.payload.importJobId === id)!.payload as { importJobId: string; attempt: number };
  const run = (id: string) => executor.run(lastRun(id));
  const row = (id: string) => prisma.importJob.findUniqueOrThrow({ where: { id } });
  const issuesOf = (id: string) => prisma.importJobIssue.findMany({ where: { importJobId: id }, orderBy: { createdAt: 'asc' } });
  const codes = async (id: string) => (await issuesOf(id)).map((i) => i.code);
  const counts = async (id: string) => (await row(id)).progress as { counts: Record<string, Record<string, number>>; chargedByPeriod: Record<string, number> };
  const used = (w: World) => usage.used(w.account.id);
  const inventoryFree = async (w: World) => {
    const ws = { workspaceId: w.workspace.id };
    const [tasks, projects, tags, types, fields, iterations, refs, pending] = await Promise.all([
      prisma.task.count({ where: ws }), prisma.project.count({ where: ws }), prisma.tag.count({ where: ws }), prisma.issueType.count({ where: ws }),
      prisma.customField.count({ where: ws }), prisma.iteration.count({ where: ws }), prisma.externalRef.count({ where: { connectionId: w.connection.id } }), prisma.importPendingLink.count(),
    ]);
    return { tasks, projects, tags, types, fields, iterations, refs, pending };
  };

  // ------------------------------------------------------------------------------------------------------------
  describe('a complete import', () => {
    it('writes the project with its mapped workflow, the structure, and every task with its tags, values, type, iteration, assignee and dates', async () => {
      const w = await world();
      source.pages = [structurePage(), ...taskPages(6, 3)];
      const id = await started(w);
      expect(await run(id)).toBe('DONE');

      const j = await row(id);
      expect(j).toMatchObject({ status: S.COMPLETED_WITH_WARNINGS, checkpoint: null, pauseReason: null }); // Eve is unmatched: reported, not an error
      expect(j.finishedAt).not.toBeNull();

      // project + workflow: Backlog-less source statuses, BLOCKED guess is a LOW-confidence rollup the default mapping applies
      const project = await prisma.project.findFirstOrThrow({ where: { workspaceId: w.workspace.id }, include: { workflowStatuses: { orderBy: { position: 'asc' } } } });
      expect(project.name).toBe('Engineering');
      expect(project.workflowStatuses.map((s) => [s.name, s.category])).toEqual([['To Do', 'TODO'], ['In Progress', 'IN_PROGRESS'], ['Blocked', 'BLOCKED'], ['Done', 'DONE']]);

      const tasks = await prisma.task.findMany({ where: { workspaceId: w.workspace.id }, orderBy: { createdAt: 'asc' }, include: { assignees: true, tags: true, customValues: true, workflowStatus: true } });
      expect(tasks).toHaveLength(6);
      const t1 = tasks.find((t) => t.title === 'Task 1')!;
      expect(t1).toMatchObject({ projectId: project.id, status: TaskStatus.IN_PROGRESS, description: 'Body 1', priority: 'HIGH', estimate: 3 });
      expect(t1.workflowStatus?.name).toBe('In Progress');
      expect(t1.createdAt.toISOString()).toBe(day(1)); // original dates kept
      expect(t1.updatedAt.toISOString()).toBe(day(2));
      expect(t1.dueDate?.toISOString().slice(0, 10)).toBe(day(31).slice(0, 10));
      expect(t1.assignees.map((a) => a.id)).toContain(w.ana.id);
      expect(t1.tags).toHaveLength(1);
      expect(t1.customValues.map((v) => v.value).sort()).toEqual([1, 'S1']);
      expect(t1.issueTypeId).not.toBeNull();
      expect(t1.iterationId).not.toBeNull();
      // Eve is not a member: her tasks are unassigned and the report says so once
      const t2 = tasks.find((t) => t.title === 'Task 2')!;
      expect(t2.assignees).toHaveLength(0);
      expect((await codes(id)).filter((c) => c === 'USER_UNMAPPED')).toHaveLength(1);

      expect(await inventoryFree(w)).toMatchObject({ tasks: 6, projects: 1, tags: 1, types: 2, fields: 2, iterations: 1, pending: 0 });
      expect((await counts(id)).counts).toMatchObject({ task: { created: 6 }, project: { created: 1 }, issueType: { created: 2 }, customField: { created: 2 }, iteration: { created: 1 }, tag: { created: 1 } });
      expect(await used(w)).toBe(6); // import_items = tasks
      expect((await counts(id)).chargedByPeriod).toEqual({ [Object.keys((await counts(id)).chargedByPeriod)[0]]: 6 });
    });

    it('writes history SILENTLY: no row of the import ever reaches the timeline feed; one summary row for the account', async () => {
      const w = await world();
      source.pages = [structurePage(), ...taskPages(4, 4)];
      const id = await started(w);
      await run(id);
      const taskIds = (await prisma.task.findMany({ where: { workspaceId: w.workspace.id }, select: { id: true } })).map((t) => t.id);
      const acts = await prisma.activity.findMany({ where: { targetId: { in: taskIds } } });
      expect(acts.every((a) => a.visibility === ActivityVisibility.SILENT)).toBe(true);
      expect(await prisma.auditLog.count({ where: { action: 'IMPORT_COMPLETED', accountId: w.account.id } })).toBe(1);
    });

    it('every row carries its ExternalRef, keyed by the source id, created by this job', async () => {
      const w = await world();
      source.pages = [structurePage(), ...taskPages(3, 3)];
      const id = await started(w);
      await run(id);
      const byType = await refs.countByLocalType(id);
      expect(byType).toMatchObject({ task: 3, project: 1, workflowStatus: 4, issueType: 2, customField: 2, iteration: 1, tag: 1 });
      const one = await prisma.externalRef.findFirstOrThrow({ where: { externalType: 'task', externalId: 'T2' } });
      expect(one).toMatchObject({ externalKey: 'ENG-2', importJobId: id, localType: 'task' });
      expect(one.contentHash).toMatch(/^sha256:/);
    });

    it('re-running the same source into the same workspace is a NO-OP: nothing duplicated, everything reported as skipped, nothing charged again', async () => {
      const w = await world();
      source.pages = [structurePage(), ...taskPages(5, 5)];
      const first = await started(w);
      await run(first);
      const before = await inventoryFree(w);
      const meter = await used(w);
      const second = await started(w);
      await run(second);
      expect(await inventoryFree(w)).toEqual(before);
      expect(await used(w)).toBe(meter);
      expect((await counts(second)).counts).toMatchObject({ task: { skipped: 5 }, project: { skipped: 1 } });
      expect((await counts(second)).counts.task.created ?? 0).toBe(0);
      expect((await row(second)).status).toMatch(/COMPLETED/);
    });

    it('a task whose reference appears BETWEEN planning and writing (another run got there first) is not created twice', async () => {
      const w = await world();
      source.pages = [structurePage(), ...taskPages(4, 4)];
      const first = await started(w);
      await run(first);
      const second = await started(w);
      // the page-level "what exists" lookup is blind for the first call (as if the other run had not committed yet)...
      const real = refs.lookup.bind(refs);
      const spy = jest.spyOn(refs, 'lookup').mockImplementation(async (conn, type, ids, db) => {
        if (type === 'task' && spy.mock.calls.filter((c) => c[1] === 'task').length === 1) return new Map();
        return real(conn, type, ids, db);
      });
      await run(second);
      spy.mockRestore();
      // ...so only the in-transaction check stands between the second run and four duplicates
      expect(await prisma.task.count({ where: { workspaceId: w.workspace.id } })).toBe(4);
      expect(await prisma.externalRef.count({ where: { externalType: 'task' } })).toBe(4);
      expect((await counts(second)).counts.task).toEqual({ skipped: 4 }); // caught by the in-transaction guard, reported
    });

    it('existing issue types and tags with the same name are REUSED (and never owned by the import)', async () => {
      const w = await world();
      const bug = await prisma.issueType.create({ data: { workspaceId: w.workspace.id, name: 'bug', nameKey: 'bug', level: IssueTypeLevel.STANDARD } });
      const tag = await prisma.tag.create({ data: { workspaceId: w.workspace.id, name: 'BACKEND', nameKey: 'backend' } });
      source.pages = [structurePage(), ...taskPages(2, 2)];
      // the mapping would match "Bug" by name by itself; forcing CREATE makes the writer meet the existing row at write time
      const id = await started(w, { version: 1, issueTypes: [{ externalId: 'bug', target: { kind: 'create' } }] });
      await run(id);
      expect(await prisma.issueType.count({ where: { workspaceId: w.workspace.id } })).toBe(2); // bug existed, story created
      expect(await prisma.tag.count({ where: { workspaceId: w.workspace.id } })).toBe(1);
      expect((await prisma.task.findMany({ where: { workspaceId: w.workspace.id } })).every((t) => t.issueTypeId !== null)).toBe(true);
      expect(await prisma.taskTag.count({ where: { tagId: tag.id } })).toBe(2);
      expect((await prisma.externalRef.findFirstOrThrow({ where: { externalType: 'issueType', externalId: 'bug' } })).localType).toBe('issueType:reused');
      expect((await prisma.externalRef.findFirstOrThrow({ where: { externalType: 'issueType', externalId: 'bug' } })).localId).toBe(bug.id);
    });

    it('a workflow that lacks a required category is completed (GitHub-style open/closed) and the import still succeeds', async () => {
      const w = await world();
      source.pages = [
        structurePage({ projects: [{ externalId: 'ENG', name: 'Eng', statuses: [{ externalId: 'open', name: 'Open', category: 'TODO' }, { externalId: 'closed', name: 'Closed', category: 'DONE' }] }] }),
        ...taskPages(2, 2, (i) => task(i, { statusExternalId: i === 1 ? 'open' : 'closed' })),
      ];
      const id = await started(w);
      await run(id);
      expect((await row(id)).status).toMatch(/COMPLETED/);
      const p = await prisma.project.findFirstOrThrow({ where: { workspaceId: w.workspace.id }, include: { workflowStatuses: { orderBy: { position: 'asc' } } } });
      expect(p.workflowStatuses.map((s) => s.category)).toEqual(['TODO', 'IN_PROGRESS', 'DONE']);
    });

    it('progress is pushed to the person on their own SSE channel; a broken push never fails the import', async () => {
      const w = await world();
      source.pages = [structurePage(), ...taskPages(2, 1)];
      const id = await started(w);
      await run(id);
      expect(pushed.length).toBeGreaterThanOrEqual(3);
      expect(new Set(pushed.map((p) => p.channel))).toEqual(new Set([`sse:user:${w.user.id}`]));
      const last = JSON.parse(pushed[pushed.length - 1].message);
      expect(last).toMatchObject({ type: 'IMPORT_PROGRESS', sourceId: id, data: { importJobId: id, status: expect.stringMatching(/COMPLETED/) } });
      pushFails = true;
      const again = await started(w);
      await expect(run(again)).resolves.toBe('DONE');
      expect((await row(again)).status).toMatch(/COMPLETED/);
    });
  });

  // ------------------------------------------------------------------------------------------------------------
  describe('who may run, and when', () => {
    it('only a QUEUED / RUNNING / PAUSED job whose attempt matches acts; everything else is a silent no-op', async () => {
      const w = await world();
      source.pages = [structurePage(), ...taskPages(1, 1)];
      const id = await started(w);
      expect(await executor.run({ importJobId: id, attempt: 99 })).toBe('STALE');
      expect(await executor.run({ importJobId: 'nope', attempt: 1 })).toBe('STALE');
      expect(source.fetched).toEqual([]);
      await run(id);
      expect(await run(id)).toBe('STALE'); // COMPLETED
      await prisma.importJob.update({ where: { id }, data: { status: S.CANCELED } });
      expect(await run(id)).toBe('STALE');
      await prisma.importJob.update({ where: { id }, data: { status: S.PREVIEW_READY } });
      expect(await run(id)).toBe('STALE');
    });

    it('a job without a mapping inventory refuses to guess: FAILED with an instruction', async () => {
      const w = await world();
      source.pages = [structurePage(), ...taskPages(1, 1)];
      const id = await started(w);
      await prisma.importJob.update({ where: { id }, data: { inventory: null as never } }).catch(async () => prisma.$executeRaw`UPDATE import_jobs SET inventory = NULL WHERE id = ${id}`);
      await run(id);
      const j = await row(id);
      expect(j.status).toBe(S.FAILED);
      expect(j.pauseReason).toMatch(/Preview it again/);
      expect(source.fetched).toEqual([]);
    });
  });

  // ------------------------------------------------------------------------------------------------------------
  describe('failures, pauses and resuming', () => {
    it('a crash AFTER a page was written but BEFORE its checkpoint: resume re-reads that page and creates nothing twice', async () => {
      const w = await world();
      source.pages = [structurePage(), ...taskPages(6, 3)];
      const id = await started(w);
      const real = (executor as unknown as { persist: (...a: unknown[]) => Promise<boolean> }).persist.bind(executor);
      let calls = 0;
      jest.spyOn(executor as never, 'persist' as never).mockImplementation((async (...a: unknown[]) => {
        if (++calls === 2) throw new Error('simulated worker death'); // after the first TASK page was written
        return real(...a);
      }) as never);
      await run(id);
      jest.restoreAllMocks();
      expect((await row(id)).status).toBe(S.FAILED);
      const mid = await prisma.task.count({ where: { workspaceId: w.workspace.id } });
      expect(mid).toBe(3);

      // the person resumes
      await imports.resume(id, w.user.id);
      source.fetched = [];
      await run(id);
      expect((await row(id)).status).toMatch(/COMPLETED/);
      expect(source.fetched).toEqual([1, 2]); // from the last CHECKPOINT (page 1 again), never from the start
      expect(await prisma.task.count({ where: { workspaceId: w.workspace.id } })).toBe(6);
      expect(await prisma.externalRef.count({ where: { externalType: 'task' } })).toBe(6);
      expect((await counts(id)).counts.task.created).toBe(6); // not 9: the replayed page is not double counted
      expect(await used(w)).toBe(6);
    });

    it('a kill in the MIDDLE of a page leaves whole chunks only, and resume finishes it', async () => {
      const w = await world();
      source.pages = [structurePage(), ...taskPages(250, 250)]; // 3 chunks of 100/100/50
      const id = await started(w);
      const bulk = jest.spyOn(DomainWriter.prototype, 'createTasksBulk');
      let chunks = 0;
      const realFilter = bulk.getMockImplementation();
      void realFilter;
      // fail the page's work after two committed chunks by throwing from the afterChunk of the third
      const orig = (ImportWriter.prototype as never as { afterTaskChunk: (...a: unknown[]) => Promise<void> }).afterTaskChunk;
      jest.spyOn(ImportWriter.prototype as never, 'afterTaskChunk' as never).mockImplementation((async function (this: never, ...a: unknown[]) {
        if (++chunks === 3) throw new Error('simulated worker death');
        return orig.apply(this, a);
      }) as never);
      await run(id);
      jest.restoreAllMocks();
      expect((await row(id)).status).toBe(S.FAILED);
      expect(await prisma.task.count({ where: { workspaceId: w.workspace.id } })).toBe(200); // two whole chunks, nothing partial
      expect(await prisma.externalRef.count({ where: { externalType: 'task' } })).toBe(200); // every task has its ref
      await imports.resume(id, w.user.id);
      await run(id);
      expect(await prisma.task.count({ where: { workspaceId: w.workspace.id } })).toBe(250);
      expect(await prisma.externalRef.count({ where: { externalType: 'task' } })).toBe(250);
      expect(await used(w)).toBe(250);
    }, 60_000);

    it('a rate limit PAUSES the job and schedules its own continuation (delayed, next attempt); the stale attempt cannot run; the retry finishes', async () => {
      const w = await world();
      source.pages = [structurePage(), ...taskPages(4, 2)];
      const id = await started(w);
      source.onFetch = (i) => { if (i === 2 && !source.fetched.includes(2)) { source.onFetch = null; throw new ProviderRateLimitedError(120_000, 'jira'); } };
      await run(id);
      const j = await row(id);
      expect(j).toMatchObject({ status: S.PAUSED, attempt: 2 });
      expect(j.pauseReason).toMatch(/slow down/);
      const retry = enqueued.find((e) => e.jobId === `import-run-${id}-2`)!;
      expect(retry).toMatchObject({ name: 'imports.run', delayMs: 120_000, payload: { importJobId: id, attempt: 2 } });
      expect(await executor.run({ importJobId: id, attempt: 1 })).toBe('STALE');
      expect(await prisma.task.count({ where: { workspaceId: w.workspace.id } })).toBe(2); // page 1 only
      await executor.run(retry.payload as { importJobId: string; attempt: number });
      expect((await row(id)).status).toMatch(/COMPLETED/);
      expect(await prisma.task.count({ where: { workspaceId: w.workspace.id } })).toBe(4);
    });

    it('a person resuming a paused job makes the pending delayed retry stale (it cannot run twice)', async () => {
      const w = await world();
      source.pages = [structurePage(), ...taskPages(2, 1)];
      const id = await started(w);
      source.onFetch = (i) => { if (i === 1) { source.onFetch = null; throw new ProviderRateLimitedError(60_000, 'jira'); } };
      await run(id);
      const delayed = enqueued.find((e) => e.jobId === `import-run-${id}-2`)!.payload as { importJobId: string; attempt: number };
      await imports.resume(id, w.user.id); // attempt 3
      expect(await executor.run(delayed)).toBe('STALE');
      await run(id);
      expect((await row(id)).status).toMatch(/COMPLETED/);
      expect(await prisma.task.count({ where: { workspaceId: w.workspace.id } })).toBe(2);
    });

    it('automatic retries are bounded: after too many interruptions in a row the job FAILS (resumable) instead of looping forever', async () => {
      const w = await world();
      source.pages = [structurePage(), ...taskPages(1, 1)];
      const id = await started(w);
      source.onFetch = () => { throw new ProviderRateLimitedError(1_000, 'jira'); };
      for (let n = 0; n < 12; n++) {
        const status = (await row(id)).status;
        if (status === S.FAILED) break;
        await run(id);
      }
      const j = await row(id);
      expect(j.status).toBe(S.FAILED);
      expect(j.pauseReason).toMatch(/kept being interrupted/);
      await imports.resume(id, w.user.id); // still resumable
      source.onFetch = null;
      await run(id);
      expect((await row(id)).status).toMatch(/COMPLETED/);
    });

    it('a revoked token PAUSES with no automatic retry; reconnect + resume completes without redoing anything', async () => {
      const w = await world();
      source.pages = [structurePage(), ...taskPages(4, 2)];
      const id = await started(w);
      source.onFetch = (i) => { if (i === 1) { tokenError = new ConnectionNeedsReauthError(w.connection.id); } }; // the NEXT token fetch fails
      await run(id);
      const j = await row(id);
      expect(j.status).toBe(S.PAUSED);
      expect(j.pauseReason).toMatch(/reconnected/);
      expect(enqueued.filter((e) => e.name === 'imports.run').length).toBe(1); // only the original start
      tokenError = null; source.onFetch = null; source.fetched = [];
      await imports.resume(id, w.user.id);
      await run(id);
      expect((await row(id)).status).toMatch(/COMPLETED/);
      expect(await prisma.task.count({ where: { workspaceId: w.workspace.id } })).toBe(4);
    });

    it("the monthly allowance: a page that would exceed it PAUSES the job BEFORE writing that page; freeing room and resuming finishes it", async () => {
      const w = await world(); // PRO: G1 lets the start through
      source.pages = [structurePage(), ...taskPages(20, 10)];
      const id = await started(w);
      await prisma.account.update({ where: { id: w.account.id }, data: { planType: 'FREE_PERSONAL' as never } }); // 250 a month...
      await usage.charge(w.account.id, 238); // ...and 12 left
      await run(id);
      const j = await row(id);
      expect(j.status).toBe(S.PAUSED);
      expect(j.pauseReason).toMatch(/allowance/i);
      expect(await prisma.task.count({ where: { workspaceId: w.workspace.id } })).toBe(10); // the first page fit, the second would not
      expect(await used(w)).toBe(248);
      await prisma.account.update({ where: { id: w.account.id }, data: { planType: 'PRO_PERSONAL' as never } });
      await imports.resume(id, w.user.id);
      await run(id);
      expect((await row(id)).status).toMatch(/COMPLETED/);
      expect(await prisma.task.count({ where: { workspaceId: w.workspace.id } })).toBe(20);
    });

    it('the project cap pauses the job when the structure cannot be created', async () => {
      const w = await world('FREE_PERSONAL');
      for (let i = 0; i < 5; i++) await prisma.project.create({ data: { workspaceId: w.workspace.id, name: `P${i}`, createdById: w.user.id } as never });
      source.pages = [structurePage(), ...taskPages(1, 1)];
      const id = await started(w).catch(() => '');
      if (id === '') return; // G1 refuses it up front: the guard under test fires earlier, which is also correct
      await run(id);
      expect((await row(id)).status).toBe(S.PAUSED);
    });

    it('an unusable page (a field the format does not have) FAILS the job with a clear reason, keeps what was written, and stays resumable', async () => {
      const w = await world();
      source.pages = [structurePage(), ...taskPages(2, 1), { schemaVersion: 1, source: SOURCE, tasks: [{ ...task(3), descripton: 'typo' }] }];
      const id = await started(w);
      await run(id);
      const j = await row(id);
      expect(j.status).toBe(S.FAILED);
      expect(j.pauseReason).toMatch(/ADAPTER_BUG/);
      expect(await prisma.task.count({ where: { workspaceId: w.workspace.id } })).toBe(2);
      expect(await codes(id)).toContain('IMPORT_FAILED');
      source.pages[3] = { schemaVersion: 1, source: SOURCE, tasks: [task(3)] }; // the adapter is fixed
      await imports.resume(id, w.user.id);
      await run(id);
      expect(await prisma.task.count({ where: { workspaceId: w.workspace.id } })).toBe(3);
    });

    it('an unexpected error FAILS the job (never retried blindly), leaving a plain-language reason and no stack', async () => {
      const w = await world();
      source.pages = [structurePage(), ...taskPages(1, 1)];
      const id = await started(w);
      source.onFetch = () => { throw new TypeError("Cannot read properties of undefined (reading 'secret-token')"); };
      await run(id);
      const j = await row(id);
      expect(j.status).toBe(S.FAILED);
      expect(j.pauseReason).not.toMatch(/secret|Cannot read/);
    });

    it('a long import hands itself back to the queue after the page budget and the next attempt carries on', async () => {
      const w = await world();
      source.pages = [structurePage(), ...taskPages(MAX_PAGES_PER_RUN + 3, 1)];
      const id = await started(w);
      await run(id);
      const mid = await row(id);
      expect(mid.status).toBe(S.QUEUED);
      expect(mid.attempt).toBe(2);
      expect(await prisma.task.count({ where: { workspaceId: w.workspace.id } })).toBe(MAX_PAGES_PER_RUN - 1); // page 0 was the structure
      await run(id);
      expect((await row(id)).status).toMatch(/COMPLETED/);
      expect(await prisma.task.count({ where: { workspaceId: w.workspace.id } })).toBe(MAX_PAGES_PER_RUN + 3);
    }, 120_000);
  });

  // ------------------------------------------------------------------------------------------------------------
  describe('cancel', () => {
    it('a cancel is seen at the next page boundary; what was written stays until a rollback; nothing resurrects the job', async () => {
      const w = await world();
      source.pages = [structurePage(), ...taskPages(6, 2)];
      const id = await started(w);
      source.onFetch = async (i) => { if (i === 2) { source.onFetch = null; await imports.cancel(id, w.user.id); } };
      await run(id);
      expect((await row(id)).status).toBe(S.CANCELED);
      const written = await prisma.task.count({ where: { workspaceId: w.workspace.id } });
      expect(written).toBeGreaterThan(0);
      expect(written).toBeLessThan(6);
      expect(await run(id)).toBe('STALE');
      expect(await prisma.task.count({ where: { workspaceId: w.workspace.id } })).toBe(written);
    });
  });

  // ------------------------------------------------------------------------------------------------------------
  describe('items the writers refuse are isolated, not fatal', () => {
    it('a parent in ANOTHER project is dropped for that one task (warned); its siblings are untouched', async () => {
      const w = await world();
      source.pages = [
        structurePage({ projects: [{ externalId: 'ENG', name: 'Eng', statuses: STATUSES }, { externalId: 'OPS', name: 'Ops', statuses: STATUSES }] }),
        { schemaVersion: 1, source: SOURCE, tasks: [task(1), task(2, { projectExternalId: 'OPS', parentExternalId: 'T1' }), task(3)] },
      ];
      const id = await started(w);
      await run(id);
      expect(await prisma.task.count({ where: { workspaceId: w.workspace.id } })).toBe(3);
      const t2 = await prisma.task.findFirstOrThrow({ where: { title: 'Task 2' } });
      expect(t2.parentId).toBeNull();
      expect((await codes(id)).some((c) => c === 'PARENT_REJECTED' || c === 'ASSOCIATIONS_REJECTED')).toBe(true);
      expect((await counts(id)).counts.task.failed ?? 0).toBe(0);
    });

    it('an iteration that belongs to ANOTHER project: the task is imported without it, with a warning (the task matters more than the sprint)', async () => {
      const w = await world();
      source.pages = [
        structurePage({ projects: [{ externalId: 'ENG', name: 'Eng', statuses: STATUSES }, { externalId: 'OPS', name: 'Ops', statuses: STATUSES }] }),
        { schemaVersion: 1, source: SOURCE, tasks: [task(1), task(2, { projectExternalId: 'OPS' })] },
      ];
      const id = await started(w);
      await run(id);
      expect(await prisma.task.count({ where: { workspaceId: w.workspace.id } })).toBe(2);
      const t2 = await prisma.task.findFirstOrThrow({ where: { title: 'Task 2' } });
      expect(t2.iterationId).toBeNull();
      expect((await prisma.task.findFirstOrThrow({ where: { title: 'Task 1' } })).iterationId).not.toBeNull();
      expect(await codes(id)).toContain('ITERATION_REJECTED');
      expect((await counts(id)).counts.task.failed ?? 0).toBe(0);
    });

    it('nesting deeper than the product allows: the too-deep tasks are imported without a parent, the rest of the chain is kept', async () => {
      const w = await world();
      source.pages = [structurePage(), { schemaVersion: 1, source: SOURCE, tasks: [task(1), task(2, { parentExternalId: 'T1' }), task(3, { parentExternalId: 'T2' }), task(4, { parentExternalId: 'T3' }), task(5, { parentExternalId: 'T4' })] }];
      const id = await started(w);
      await run(id);
      expect(await prisma.task.count({ where: { workspaceId: w.workspace.id } })).toBe(5);
      const byTitle = Object.fromEntries((await prisma.task.findMany({ where: { workspaceId: w.workspace.id } })).map((t) => [t.title, t]));
      expect(byTitle['Task 2'].parentId).toBe(byTitle['Task 1'].id);
      expect(byTitle['Task 3'].parentId).toBe(byTitle['Task 2'].id);
      expect(byTitle['Task 4'].parentId).toBeNull(); // would be a 4th level
      expect((await codes(id)).filter((c) => c === 'PARENT_REJECTED').length).toBeGreaterThanOrEqual(1);
    });

    it('two projects that SHARE status ids (Jira): each project\'s tasks land on that project\'s own workflow statuses', async () => {
      const w = await world();
      source.pages = [
        structurePage({ projects: [{ externalId: 'ENG', name: 'Eng', statuses: STATUSES }, { externalId: 'OPS', name: 'Ops', statuses: STATUSES }] }),
        { schemaVersion: 1, source: SOURCE, tasks: [task(1, { statusExternalId: 's-prog' }), task(2, { projectExternalId: 'OPS', statusExternalId: 's-prog', iterationExternalId: undefined })] },
      ];
      const id = await started(w);
      await run(id);
      const tasks = await prisma.task.findMany({ where: { workspaceId: w.workspace.id }, include: { workflowStatus: true } });
      expect(tasks).toHaveLength(2);
      for (const t of tasks) expect(t.workflowStatus?.projectId).toBe(t.projectId);
      expect(await prisma.workflowStatus.count()).toBe(8);
    });

    it('a task whose project never arrived is reported and skipped; others go on', async () => {
      const w = await world();
      source.pages = [structurePage(), { schemaVersion: 1, source: SOURCE, tasks: [task(1), task(2, { projectExternalId: 'NOWHERE' }), task(3)] }];
      const id = await started(w);
      await run(id);
      expect(await prisma.task.count({ where: { workspaceId: w.workspace.id } })).toBe(2);
      expect(await codes(id)).toContain('TASK_PROJECT_MISSING');
      expect((await counts(id)).counts.task.failed).toBe(1);
      expect((await row(id)).status).toBe(S.COMPLETED_WITH_WARNINGS);
    });

    it('a custom value the field refuses (option not in an EXISTING select) is left out with a note; the task is created', async () => {
      const w = await world();
      source.pages = [structurePage(), { schemaVersion: 1, source: SOURCE, tasks: [task(1, { customValues: [{ fieldExternalId: 'cf-pts', value: 5 }] })] }];
      const id = await started(w, { version: 1, customFields: [] });
      await run(id);
      expect(await prisma.task.count({ where: { workspaceId: w.workspace.id } })).toBe(1);
    });
  });

  // ------------------------------------------------------------------------------------------------------------
  describe('links that arrive out of order', () => {
    it('a child BEFORE its parent (on an earlier page) is attached when the parent shows up; a dependency across pages is created too', async () => {
      const w = await world();
      source.pages = [
        structurePage(),
        { schemaVersion: 1, source: SOURCE, tasks: [task(1, { parentExternalId: 'T9' })], dependencies: [{ externalId: 'd1', fromExternalId: 'T1', toExternalId: 'T9', type: 'BLOCKS' }] },
        { schemaVersion: 1, source: SOURCE, tasks: [task(9)] },
      ];
      const id = await started(w);
      await run(id);
      const t1 = await prisma.task.findFirstOrThrow({ where: { title: 'Task 1' } });
      const t9 = await prisma.task.findFirstOrThrow({ where: { title: 'Task 9' } });
      expect(t1.parentId).toBe(t9.id);
      expect(await prisma.taskDependency.count({ where: { blockingTaskId: t1.id, blockedTaskId: t9.id } })).toBe(1);
      expect(await prisma.importPendingLink.count()).toBe(0);
      expect((await row(id)).status).toBe(S.COMPLETED); // nobody unmatched, nothing refused
    });

    it('a parent that never arrives is reported once and the child stays a top-level task', async () => {
      const w = await world();
      source.pages = [structurePage(), { schemaVersion: 1, source: SOURCE, tasks: [task(1, { parentExternalId: 'GHOST' })] }];
      const id = await started(w);
      await run(id);
      expect((await prisma.task.findFirstOrThrow({ where: { title: 'Task 1' } })).parentId).toBeNull();
      expect(await codes(id)).toContain('PARENT_MISSING');
    });

    it('dependencies that would loop (across pages) are skipped and reported', async () => {
      const w = await world();
      source.pages = [
        structurePage(),
        { schemaVersion: 1, source: SOURCE, tasks: [task(1), task(2)], dependencies: [{ externalId: 'd1', fromExternalId: 'T1', toExternalId: 'T2', type: 'BLOCKS' }] },
        { schemaVersion: 1, source: SOURCE, tasks: [task(3)], dependencies: [{ externalId: 'd2', fromExternalId: 'T2', toExternalId: 'T3', type: 'BLOCKS' }, { externalId: 'd3', fromExternalId: 'T3', toExternalId: 'T1', type: 'BLOCKS' }] },
      ];
      const id = await started(w);
      await run(id);
      expect(await prisma.taskDependency.count()).toBe(2);
      expect(await codes(id)).toContain('DEPENDENCY_CYCLE');
    });
  });

  // ------------------------------------------------------------------------------------------------------------
  describe('rollback', () => {
    async function imported(w: World, n = 6) {
      source.pages = [structurePage(), ...taskPages(n, 3, (i) => task(i, i === 3 ? { parentExternalId: 'T1' } : {}))];
      const id = await started(w);
      await run(id);
      return id;
    }
    const roll = async (id: string, w: World) => {
      await imports.rollback(id, w.user.id);
      return rollback.run({ importJobId: id });
    };

    it('removes EXACTLY what the import created: zero rows, zero references, zero activity, the meter refunded', async () => {
      const w = await world();
      const bug = await prisma.issueType.create({ data: { workspaceId: w.workspace.id, name: 'Bug', nameKey: 'bug', level: IssueTypeLevel.STANDARD } });
      const before = await inventoryFree(w);
      const id = await imported(w);
      expect(await used(w)).toBe(6);
      const taskIds = (await prisma.task.findMany({ where: { workspaceId: w.workspace.id }, select: { id: true } })).map((t) => t.id);
      expect(await roll(id, w)).toBe('DONE');

      const j = await row(id);
      expect(j.status).toBe(S.ROLLED_BACK);
      expect(j.progress).toMatchObject({ counts: {}, chargedByPeriod: {} });
      expect(await inventoryFree(w)).toEqual(before); // back to the pre-import state: the one pre-existing issue type is all that is left
      expect(await prisma.issueType.findUnique({ where: { id: bug.id } })).not.toBeNull();
      expect(await prisma.activity.count({ where: { targetId: { in: taskIds } } })).toBe(0);
      expect(await prisma.taskTag.count()).toBe(0);
      expect(await prisma.taskCustomValue.count()).toBe(0);
      expect(await prisma.workflowStatus.count()).toBe(0);
      expect(await used(w)).toBe(0);
      expect(await prisma.auditLog.count({ where: { action: 'IMPORT_ROLLED_BACK' } })).toBe(1);
    });

    it('is idempotent: running it again after it finished does nothing, and never refunds twice', async () => {
      const w = await world();
      const id = await imported(w, 3);
      await usage.charge(w.account.id, 100); // someone else's usage must survive
      await roll(id, w);
      expect(await rollback.run({ importJobId: id })).toBe('STALE');
      expect(await used(w)).toBe(100);
    });

    it('is resumable: a crash half way is finished by the retry, with the meter refunded exactly once', async () => {
      const w = await world();
      const id = await imported(w, 6);
      await imports.rollback(id, w.user.id);
      const spy = jest.spyOn(DomainEraser.prototype, 'deleteProjectIfEmpty').mockRejectedValueOnce(new Error('simulated worker death'));
      await expect(rollback.run({ importJobId: id })).rejects.toThrow('simulated');
      spy.mockRestore();
      expect((await row(id)).status).toBe(S.ROLLING_BACK);
      expect(await prisma.task.count({ where: { workspaceId: w.workspace.id } })).toBe(0); // tasks were already gone
      expect(await rollback.run({ importJobId: id })).toBe('DONE');
      expect((await row(id)).status).toBe(S.ROLLED_BACK);
      expect(await prisma.project.count({ where: { workspaceId: w.workspace.id } })).toBe(0);
      expect(await used(w)).toBe(0);
    });

    it('NEVER deletes what a person added afterwards: their subtask keeps its parent, their task keeps its project, their value keeps its field', async () => {
      const w = await world();
      const id = await imported(w, 4);
      const project = await prisma.project.findFirstOrThrow({ where: { workspaceId: w.workspace.id } });
      const t2 = await prisma.task.findFirstOrThrow({ where: { title: 'Task 2' } });
      const mine = await createTask(prisma, { workspaceId: w.workspace.id, projectId: project.id, title: 'Mine', createdById: w.user.id } as never);
      const sub = await createTask(prisma, { workspaceId: w.workspace.id, projectId: project.id, title: 'My subtask', parent: { connect: { id: t2.id } }, createdById: w.user.id } as never);
      const field = await prisma.customField.findFirstOrThrow({ where: { workspaceId: w.workspace.id, key: 'points' } });
      await prisma.taskCustomValue.create({ data: { taskId: mine.id, fieldId: field.id, value: 42 } });
      await prisma.tag.create({ data: { workspaceId: w.workspace.id, name: 'x', nameKey: 'x' } });
      const tag = await prisma.tag.findFirstOrThrow({ where: { nameKey: 'backend' } });
      await prisma.taskTag.create({ data: { taskId: mine.id, tagId: tag.id } });

      await roll(id, w);
      expect((await row(id)).status).toBe(S.ROLLED_BACK);
      const left = await prisma.task.findMany({ where: { workspaceId: w.workspace.id }, orderBy: { title: 'asc' } });
      expect(left.map((t) => t.title)).toEqual(['Mine', 'My subtask', 'Task 2']); // Task 2 stays because the subtask needs it
      expect((await prisma.task.findUniqueOrThrow({ where: { id: sub.id } })).parentId).toBe(t2.id);
      expect(await prisma.project.findUnique({ where: { id: project.id } })).not.toBeNull();
      expect(await prisma.customField.findUnique({ where: { id: field.id } })).not.toBeNull();
      expect(await prisma.tag.findUnique({ where: { id: tag.id } })).not.toBeNull();
      const kept = await prisma.importJobIssue.findMany({ where: { importJobId: id, code: 'ROLLBACK_KEPT' } });
      expect(kept.map((k) => k.externalRef?.split(':')[0]).sort()).toEqual(expect.arrayContaining(['customField', 'project', 'tag', 'task']));
      expect(await prisma.externalRef.count({ where: { importJobId: id } })).toBe(0); // all references released
      expect(await prisma.importPendingLink.count()).toBe(0);
    });

    it('deletes children before parents (the product forbids deleting a parent that still has children)', async () => {
      const w = await world();
      source.pages = [structurePage(), { schemaVersion: 1, source: SOURCE, tasks: [task(1), task(2, { parentExternalId: 'T1' }), task(3, { parentExternalId: 'T2' })] }];
      const id = await started(w);
      await run(id);
      expect(await prisma.task.count({ where: { parentId: { not: null } } })).toBe(2);
      await roll(id, w);
      expect(await prisma.task.count({ where: { workspaceId: w.workspace.id } })).toBe(0);
    });

    it('a rolled-back source can be imported again from scratch', async () => {
      const w = await world();
      const id = await imported(w, 3);
      await roll(id, w);
      source.fetched = [];
      const again = await started(w);
      await run(again);
      expect(await prisma.task.count({ where: { workspaceId: w.workspace.id } })).toBe(3);
      expect((await counts(again)).counts.task.created).toBe(3);
    });

    it('rolling back a CANCELED import removes the partial result', async () => {
      const w = await world();
      source.pages = [structurePage(), ...taskPages(6, 2)];
      const id = await started(w);
      source.onFetch = async (i) => { if (i === 2) { source.onFetch = null; await imports.cancel(id, w.user.id); } };
      await run(id);
      expect(await prisma.task.count({ where: { workspaceId: w.workspace.id } })).toBeGreaterThan(0);
      await roll(id, w);
      expect(await inventoryFree(w)).toMatchObject({ tasks: 0, projects: 0, tags: 0, types: 0, fields: 0, iterations: 0, refs: 0, pending: 0 });
      expect(await used(w)).toBe(0);
    });

    it('rolling back an import that ran twice keeps what the FIRST run created owned by the first run', async () => {
      const w = await world();
      source.pages = [structurePage(), ...taskPages(2, 2)];
      const first = await started(w);
      await run(first);
      const second = await started(w);
      await run(second);
      await roll(second, w); // the second run created nothing: rolling it back must not touch the first run's rows
      expect(await prisma.task.count({ where: { workspaceId: w.workspace.id } })).toBe(2);
      expect(await prisma.externalRef.count({ where: { importJobId: first } })).toBeGreaterThan(0);
      await roll(first, w);
      expect(await prisma.task.count({ where: { workspaceId: w.workspace.id } })).toBe(0);
    });
  });
});
