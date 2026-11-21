/**
 * Step 4.5 - the REAL Linear adapter (over a fake HTTP layer serving synthetic Linear responses) driving the REAL executor,
 * mapping engine and writers against a real Postgres: create -> discover -> select -> preview -> start -> run -> rollback.
 * What this proves is the seam between the adapter and everything behind it; it does not prove Linear's real responses look
 * like the synthetic ones (nobody has called a live workspace).
 */
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { ImportJobStatus as S, IntegrationProvider, Role, TaskStatus } from '@prisma/client';
import { PermissionResolver } from '../../src/access-control/access-control.service';
import { PlanLimitsService } from '../../src/access-control/plan-limits.service';
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
import { DATASET, fakeLinear } from '../../src/integrations/providers/linear/fixtures/linear-responses';
import { ImportProgressPublisher } from '../../src/imports/executor/import-progress';
import { ImportExecutor } from '../../src/imports/executor/import-executor.service';
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
import { QueueService } from '../../src/queue/queue.service';
import { RedisPubSubService } from '../../src/redis/redis-pubsub.service';
import { WorkspacesService } from '../../src/tenancy/workspaces/workspaces.service';
import { FakeStorage, contentProviders } from './support/fake-storage';
import { createUser, createUserWithAccount, createWorkspace } from './factories';
import { disconnectTestPrisma, getTestPrisma } from './support/prisma-test-client';
import { resetDb } from './support/reset-db';

const noRedis = { configured: false, isReady: () => false } as never;
const jsonResponse = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });

describe('Linear import end to end (step 4.5)', () => {
  let prisma: PrismaService;
  let imports: ImportsService;
  let executor: ImportExecutor;
  let rollback: ImportRollback;
  let usage: ImportUsageService;
  let fake: ReturnType<typeof fakeLinear>;
  let intercept: ((op: string, vars: Record<string, unknown>) => Response | undefined) | null = null;
  let enqueued: Array<{ name: string; payload: { importJobId: string; attempt?: number }; jobId?: string; delayMs?: number }>;

  beforeAll(async () => {
    prisma = getTestPrisma();
    // The fake serves the dataset through the adapter's real HTTP client; `intercept` lets one test break a call.
    const fetchFn = (async (url: unknown, init?: RequestInit) => {
      fake ??= fakeLinear(DATASET, { intercept: (op, vars) => intercept?.(op, vars) });
      return (await (fake.fetch as unknown as (u: unknown, i?: RequestInit) => Promise<Response>)(url, init)).clone();
    }) as never;
    const http = new ProviderHttpClient(noRedis, fetchFn, { bucketCapacity: 1e6, refillPerSecond: 1e6, maxRetries: 0 });
    const linear = new LinearAdapter({ get: () => undefined } as never, http, new LinearClient(http));

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
        { provide: CredentialService, useValue: { getAccessToken: async () => 'tok' } },
        { provide: RedisPubSubService, useValue: { publish: async () => undefined } },
        { provide: INTEGRATION_ADAPTERS, useValue: [linear] },
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
  });
  beforeEach(async () => {
    await resetDb(prisma);
    enqueued = [];
    intercept = null;
    fake = fakeLinear(DATASET, { intercept: (op, vars) => intercept?.(op, vars) });
  });
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

  async function started(w: World, teams = ['team-eng', 'team-ops']) {
    const job = await imports.create({ connectionId: w.connection.id, workspaceId: w.workspace.id, options: { comments: false, attachments: false, history: false, keepDates: true } }, w.user.id);
    await imports.setSelection(job.id, { sources: teams.map((id) => ({ id, type: 'team' })) }, w.user.id);
    await imports.preview(job.id, w.user.id);
    await imports.start(job.id, w.user.id);
    return job.id;
  }
  const lastRun = (id: string) => [...enqueued].reverse().find((e) => e.name === 'imports.run' && e.payload.importJobId === id)!.payload as { importJobId: string; attempt: number };
  const run = (id: string) => executor.run(lastRun(id));
  const row = (id: string) => prisma.importJob.findUniqueOrThrow({ where: { id } });
  const issueCodes = async (id: string) => (await prisma.importJobIssue.findMany({ where: { importJobId: id } })).map((i) => i.code).sort();
  const counts = async (id: string) => ((await row(id)).progress as { counts: Record<string, Record<string, number>> }).counts;
  const everything = async (w: World) => {
    const ws = { workspaceId: w.workspace.id };
    const [tasks, projects, tags, fields, iterations, deps, statuses, refs] = await Promise.all([
      prisma.task.count({ where: ws }), prisma.project.count({ where: ws }), prisma.tag.count({ where: ws }), prisma.customField.count({ where: ws }),
      prisma.iteration.count({ where: ws }), prisma.taskDependency.count(), prisma.workflowStatus.count(), prisma.externalRef.count({ where: { connectionId: w.connection.id } }),
    ]);
    return { tasks, projects, tags, fields, iterations, deps, statuses, refs };
  };

  it('the picker lists the teams; the preview counts them and offers the mapping with Linear\'s own workflow', async () => {
    const w = await world();
    const job = await imports.create({ connectionId: w.connection.id, workspaceId: w.workspace.id }, w.user.id);
    const sources = await imports.sources(job.id, w.user.id);
    expect(sources.nodes.map((n) => [n.id, n.type, n.selectable])).toEqual([['team-eng', 'team', true], ['team-ops', 'team', true], ['team-other', 'team', true]]);
    await imports.setSelection(job.id, { sources: [{ id: 'team-eng', type: 'team' }, { id: 'team-ops', type: 'team' }] }, w.user.id);
    const preview = (await imports.preview(job.id, w.user.id)).previewSummary as { counts: Record<string, number>; plan: { blockers: unknown[] } };
    expect(preview.counts).toMatchObject({ projects: 2, tasks: 9, users: 5 });
    expect(preview.plan.blockers).toEqual([]);
    const view = await imports.getMapping(job.id, w.user.id);
    expect(JSON.stringify(view)).toContain('team-eng:s-eng-review');
  });

  it('imports both teams: a project each with its own workflow, then tasks with parent, dependencies, tags, cycles, project field, people, dates', async () => {
    const w = await world();
    const id = await started(w);
    expect(await run(id)).toBe('DONE');
    const j = await row(id);
    expect(j.status).toMatch(/COMPLETED/);
    expect(j).toMatchObject({ checkpoint: null, pauseReason: null });

    expect(await everything(w)).toMatchObject({ tasks: 9, projects: 2, fields: 1, iterations: 2, deps: 4 });

    const projects = await prisma.project.findMany({ where: { workspaceId: w.workspace.id }, include: { workflowStatuses: { orderBy: { position: 'asc' } } }, orderBy: { name: 'asc' } });
    expect(projects.map((p) => p.name)).toEqual(['Engineering', 'Operations']);
    expect(projects[0].workflowStatuses.map((s) => [s.name, s.category])).toEqual([
      ['Triage', 'TODO'], ['Backlog', 'TODO'], ['Todo', 'TODO'], ['In Progress', 'IN_PROGRESS'], ['In Review', 'IN_PROGRESS'], ['Done', 'DONE'], ['Canceled', 'DONE'], ['Duplicate', 'DONE'],
    ]);
    // the same state NAMES in Operations are that team's own rows, not Engineering's
    expect(projects[1].workflowStatuses.map((s) => s.name)).toEqual(['Backlog', 'Todo', 'In Progress', 'Done']);
    const engIds = new Set(projects[0].workflowStatuses.map((s) => s.id));
    expect(projects[1].workflowStatuses.every((s) => !engIds.has(s.id))).toBe(true);

    const tasks = await prisma.task.findMany({ where: { workspaceId: w.workspace.id }, include: { assignees: true, tags: { include: { tag: true } }, customValues: true, workflowStatus: true, iteration: true, project: true }, orderBy: { createdAt: 'asc' } });
    const by = (title: string) => tasks.find((t) => t.title === title)!;
    const login = by('Login fails on Safari');
    expect(login).toMatchObject({ status: TaskStatus.IN_PROGRESS, priority: 'URGENT', estimate: 3 });
    // the description as written in Linear, then (step 4.7b) the relations that are not links appended after it
    expect(login.description!.startsWith('## Steps\n\n1. Open **Safari**\n2. Sign in')).toBe(true);
    expect(login.workflowStatus?.name).toBe('In Progress');
    expect(login.project.name).toBe('Engineering');
    expect(login.assignees.map((a) => a.id)).toEqual([w.ana.id]); // matched on her verified e-mail
    expect(login.tags.map((t) => t.tag.name).sort()).toEqual(['Bug', 'Frontend']);
    expect(login.iteration?.name).toBe('Spring push');
    expect(login.createdAt.toISOString()).toBe('2026-02-01T10:00:00.000Z'); // Linear's dates kept
    expect(login.dueDate?.toISOString().slice(0, 10)).toBe('2026-03-10');
    expect(login.customValues.map((v) => v.value)).toEqual(['Web app']);

    const sub = by('Fix session cookie');
    expect(sub.parentId).toBe(login.id); // sub-issue -> subtask
    expect(sub.assignees).toHaveLength(0); // Ben: member e-mail not verified, not guessed

    expect(by('Old design spike')).toMatchObject({ status: TaskStatus.DONE });
    expect(by('Old design spike').archivedAt).not.toBeNull(); // Linear archived it
    expect(by('Add pagination to /v1/items').iteration?.name).toBe('Cycle 2');
    expect(by('Triage: odd crash report').tags).toHaveLength(12); // the follow-up label query
    expect(by('Rotate certificates').project.name).toBe('Operations');

    const deps = await prisma.taskDependency.findMany();
    // "Login fails" blocks "Fix session cookie" and is RELATED to the spike and a DUPLICATE of "Duplicate of login bug" (step 4.7b: both
    // RELATES_TO); "Renew domain" blocks "Rotate certificates". The relation to the team that is not imported is no link at all.
    expect(deps.map((d) => [d.blockingTaskId, d.blockedTaskId, d.type]).sort()).toEqual(
      [[login.id, sub.id, 'BLOCKS'], [login.id, by('Old design spike').id, 'RELATES_TO'], [login.id, by('Duplicate of login bug').id, 'RELATES_TO'], [by('Renew domain').id, by('Rotate certificates').id, 'BLOCKS']].sort(),
    );
    // ... and it, with the duplicate, is kept as text
    expect(login.description).toContain('**Relations in Linear**');
    expect(login.description).toContain('Marked as a duplicate of ENG-4');
    expect(await prisma.importPendingLink.count()).toBe(0);

    expect(await usage.used(w.account.id)).toBe(9);
    // the blank-titled issue was repaired by the validator and reported, not dropped
    expect(await issueCodes(id)).toContain('TITLE_EMPTY');
    expect(by('(untitled)')).toBeDefined();
  });

  it('a re-run over the same Linear data is a NO-OP (nothing duplicated, nothing charged again)', async () => {
    const w = await world();
    await run(await started(w));
    const before = await everything(w);
    const meter = await usage.used(w.account.id);
    const second = await started(w);
    await run(second);
    expect(await everything(w)).toEqual(before);
    expect(await usage.used(w.account.id)).toBe(meter);
    expect((await counts(second)).task).toEqual({ skipped: 9 });
  });

  it('a Linear rate limit mid-import PAUSES and schedules its own continuation; the retry finishes with no duplicates', async () => {
    const w = await world();
    const id = await started(w, ['team-eng']);
    let issuePages = 0;
    intercept = (op) => {
      if (op === 'LinearTeamIssues' && ++issuePages === 3) {
        intercept = null;
        return new Response(JSON.stringify({ errors: [{ message: 'Rate limit exceeded', extensions: { code: 'RATELIMITED' } }] }), { status: 400, headers: { 'x-ratelimit-requests-reset': String(Math.floor(Date.now() / 1000) + 90) } });
      }
      return undefined;
    };
    await run(id);
    const j = await row(id);
    expect(j.status).toBe(S.PAUSED);
    expect(j.pauseReason).toMatch(/slow down/);
    expect(await prisma.task.count({ where: { workspaceId: w.workspace.id } })).toBe(4); // two issue pages were already written
    const retry = enqueued.find((e) => e.jobId === `import-run-${id}-2`)!;
    expect(retry.delayMs).toBeGreaterThan(14_000); // at least the executor's base delay
    await executor.run(retry.payload as { importJobId: string; attempt: number });
    expect((await row(id)).status).toMatch(/COMPLETED/);
    expect(await prisma.task.count({ where: { workspaceId: w.workspace.id } })).toBe(7);
  });

  it('a token Linear rejects pauses the job for re-authorisation (nothing half-written is lost)', async () => {
    const w = await world();
    const id = await started(w, ['team-eng']);
    intercept = (op) => (op === 'LinearTeamIssues' ? jsonResponse({}, 401) : undefined);
    await run(id);
    const j = await row(id);
    expect(j.status).toBe(S.PAUSED);
    expect(j.pauseReason).toMatch(/reconnect/i);
  });

  it('a team deleted in Linear after the preview FAILS the job with a message (resumable), not a quietly smaller import', async () => {
    const w = await world();
    const id = await started(w, ['team-eng']);
    intercept = (op) => (op === 'LinearTeam' ? jsonResponse({ data: { team: null } }) : undefined);
    await run(id);
    expect((await row(id)).status).toBe(S.FAILED);
  });

  it('rollback removes exactly what the Linear import created and refunds the meter; importing again works', async () => {
    const w = await world();
    const before = await everything(w);
    const id = await started(w);
    await run(id);
    await imports.rollback(id, w.user.id);
    expect(await rollback.run({ importJobId: id })).toBe('DONE');
    expect((await row(id)).status).toBe(S.ROLLED_BACK);
    expect(await everything(w)).toEqual(before);
    expect(await prisma.taskDependency.count()).toBe(0);
    expect(await usage.used(w.account.id)).toBe(0);

    const again = await started(w);
    await run(again);
    expect((await everything(w)).tasks).toBe(9);
  });
});
