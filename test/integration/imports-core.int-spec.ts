/**
 * Step 4.1 - import core against a real Postgres: job lifecycle and its guards, preflight (G1), race-safe
 * transitions, queue/transaction coupling, ExternalRef idempotency, issue cap, and the monthly meter.
 * A FakeAdapter stands in for a provider (no network); the queue is a recording fake.
 */
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import {
  AccountType,
  ImportIssueSeverity,
  ImportJobStatus as S,
  IntegrationConnectionStatus,
  IntegrationProvider,
  Role,
} from '@prisma/client';
import { PermissionResolver } from '../../src/access-control/access-control.service';
import { PlanLimitsService, usagePeriod } from '../../src/access-control/plan-limits.service';
import { AuditLogService } from '../../src/events/audit-log.service';
import { ConnectorRegistry } from '../../src/integrations/core/connector.registry';
import {
  ConnectionNeedsReauthError,
  CredentialService,
} from '../../src/integrations/core/credential.service';
import {
  AuthorizeContext,
  CallbackParams,
  Capability,
  ConnectorAdapter,
  ExchangeContext,
  INTEGRATION_ADAPTERS,
  ProviderRateLimitedError,
} from '../../src/integrations/core/integration.types';
import { ExternalRefService } from '../../src/imports/external-ref.service';
import { ImportAdapterContext, ImportCapableAdapter } from '../../src/imports/import-adapter';
import { ImportIssueService, ISSUES_TRUNCATED } from '../../src/imports/import-issue.service';
import { ImportUsageService } from '../../src/imports/import-usage.service';
import { ImportsService } from '../../src/imports/imports.service';
import { MappingService } from '../../src/imports/mapping/mapping.service';
import {
  ImportEstimate,
  ImportOptions,
  ImportSelection,
  SourceTree,
} from '../../src/imports/imports.types';
import { IMPORT_LIMITS } from '../../src/imports/imports.validation';
import { WorkspacesService } from '../../src/tenancy/workspaces/workspaces.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { QueueService } from '../../src/queue/queue.service';
import { createUserWithAccount, createUser, createWorkspace } from './factories';
import { disconnectTestPrisma, getTestPrisma } from './support/prisma-test-client';
import { resetDb } from './support/reset-db';

class FakeImportAdapter implements ImportCapableAdapter {
  readonly provider = IntegrationProvider.LINEAR;
  readonly capabilities = new Set<Capability>(['IMPORT']);
  readonly usesPkce = false;
  tree: SourceTree = {
    nodes: [
      { id: 'team-1', type: 'team', name: 'Team', selectable: false },
      { id: 'proj-a', type: 'project', name: 'Alpha', parentId: 'team-1', selectable: true },
      { id: 'proj-b', type: 'project', name: 'Beta', parentId: 'team-1', selectable: true },
    ],
  };
  estimate_: ImportEstimate = {
    projects: [
      { sourceId: 'proj-a', name: 'Alpha', tasks: 10 },
      { sourceId: 'proj-b', name: 'Beta', tasks: 5 },
    ],
    comments: 7,
    attachments: 2,
    attachmentBytes: 1234,
    users: 3,
  };
  failWith: Error | null = null;
  lastCtx: ImportAdapterContext | null = null;
  estimateCalls = 0;
  isConfigured() { return true; }
  authorizeUrl(_c: AuthorizeContext) { return 'https://fake'; }
  async exchangeCode(_p: CallbackParams, _c: ExchangeContext): Promise<never> { throw new Error('unused'); }
  async revoke() { /* unused */ }
  async fetchBundle(): Promise<never> { throw new Error('unused'); }
  async discover(ctx: ImportAdapterContext) {
    this.lastCtx = ctx;
    if (this.failWith) throw this.failWith;
    return this.tree;
  }
  async estimate(ctx: ImportAdapterContext, _s: ImportSelection, _o: ImportOptions) {
    this.lastCtx = ctx;
    this.estimateCalls++;
    if (this.failWith) throw this.failWith;
    return this.estimate_;
  }
}

class FakeNotifyAdapter implements ConnectorAdapter {
  readonly provider = IntegrationProvider.DISCORD;
  readonly capabilities = new Set<Capability>(['NOTIFY']);
  readonly usesPkce = false;
  isConfigured() { return true; }
  authorizeUrl() { return 'x'; }
  async exchangeCode(): Promise<never> { throw new Error('unused'); }
  async revoke() { /* unused */ }
}

describe('import core (step 4.1)', () => {
  let prisma: PrismaService;
  let adapter: FakeImportAdapter;
  let imports: ImportsService;
  let refs: ExternalRefService;
  let issues: ImportIssueService;
  let usage: ImportUsageService;
  let planLimits: PlanLimitsService;
  let enqueued: Array<{ queue: string; name: string; payload: unknown; jobId?: string }>;
  let enqueueFails = false;
  let tokenError: Error | null = null;

  beforeAll(async () => {
    prisma = getTestPrisma();
    adapter = new FakeImportAdapter();
    const queue = {
      enqueue: async (queue: string, name: string, payload: unknown, opts: { jobId?: string } = {}) => {
        if (enqueueFails) throw new Error('redis down');
        enqueued.push({ queue, name, payload, jobId: opts.jobId });
        return { id: opts.jobId ?? 'x' };
      },
    };
    const credentials = {
      getAccessToken: async () => {
        if (tokenError) throw tokenError;
        return 'live-token';
      },
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: WorkspacesService, useValue: {} },
        { provide: EventEmitter2, useValue: new EventEmitter2() },
        { provide: QueueService, useValue: queue },
        { provide: CredentialService, useValue: credentials },
        { provide: INTEGRATION_ADAPTERS, useValue: [adapter, new FakeNotifyAdapter()] },
        AuditLogService, PermissionResolver, PlanLimitsService, ConnectorRegistry,
        ExternalRefService, ImportIssueService, ImportUsageService, MappingService, ImportsService,
      ],
    }).compile();
    await moduleRef.init();
    imports = moduleRef.get(ImportsService);
    refs = moduleRef.get(ExternalRefService);
    issues = moduleRef.get(ImportIssueService);
    usage = moduleRef.get(ImportUsageService);
    planLimits = moduleRef.get(PlanLimitsService);
  });
  beforeEach(async () => {
    await resetDb(prisma);
    enqueued = []; enqueueFails = false; tokenError = null;
    adapter.failWith = null; adapter.estimateCalls = 0;
    adapter.estimate_ = {
      projects: [{ sourceId: 'proj-a', name: 'Alpha', tasks: 10 }, { sourceId: 'proj-b', name: 'Beta', tasks: 5 }],
      comments: 7, attachments: 2, attachmentBytes: 1234, users: 3,
    };
  });
  afterAll(() => disconnectTestPrisma());

  /** An owner, their account (on `plan`), a workspace, and an ACTIVE Linear connection. */
  async function world(plan: string = 'PRO_PERSONAL') {
    const w = await createUserWithAccount(prisma, { role: Role.OWNER });
    await prisma.account.update({ where: { id: w.account.id }, data: { planType: plan as never } });
    const workspace = await createWorkspace(prisma, { accountId: w.account.id });
    const connection = await prisma.integrationConnection.create({
      data: {
        accountId: w.account.id, provider: IntegrationProvider.LINEAR, externalAccountId: `org-${Math.random().toString(36).slice(2, 10)}`,
        externalAccountName: 'Org One', scopes: ['read'], createdById: w.user.id,
      },
    });
    return { ...w, workspace, connection };
  }
  type World = Awaited<ReturnType<typeof world>>;

  const SEL = { sources: [{ id: 'proj-a', type: 'project' }, { id: 'proj-b', type: 'project' }] };
  async function newJob(w: World) {
    return imports.create({ connectionId: w.connection.id, workspaceId: w.workspace.id }, w.user.id);
  }
  /** DRAFT -> PREVIEW_READY. */
  async function previewed(w: World) {
    const job = await newJob(w);
    await imports.setSelection(job.id, SEL, w.user.id);
    await imports.preview(job.id, w.user.id);
    return job.id;
  }
  const statusOf = async (id: string) => (await prisma.importJob.findUniqueOrThrow({ where: { id } })).status;
  const force = (id: string, status: S, extra: object = {}) =>
    prisma.importJob.update({ where: { id }, data: { status, ...extra } });

  // ------------------------------------------------------------------------------------------
  describe('create', () => {
    it('makes a DRAFT with default options and returns a view without checkpoint / credentials', async () => {
      const w = await world();
      const job = await newJob(w);
      expect(job).toMatchObject({
        status: 'DRAFT', connectionId: w.connection.id, workspaceId: w.workspace.id, provider: 'LINEAR',
        options: { comments: true, attachments: true, history: true, keepDates: true },
      });
      expect(Object.keys(job)).not.toContain('checkpoint');
      expect(Object.keys(job)).not.toContain('mappingConfig');
    });

    it('stores explicit options; an unknown option is a 400 and creates nothing', async () => {
      const w = await world();
      const job = await imports.create({ connectionId: w.connection.id, workspaceId: w.workspace.id, options: { attachments: false } }, w.user.id);
      expect(job.options).toMatchObject({ attachments: false, comments: true });
      await expect(
        imports.create({ connectionId: w.connection.id, workspaceId: w.workspace.id, options: { nope: true } }, w.user.id),
      ).rejects.toThrow('Unknown import option');
      expect(await prisma.importJob.count()).toBe(1);
    });

    it("another account's connection is a 404 (indistinguishable from a missing one)", async () => {
      const a = await world();
      const b = await world();
      await expect(imports.create({ connectionId: b.connection.id, workspaceId: a.workspace.id }, a.user.id)).rejects.toThrow('Connection not found');
      await expect(imports.create({ connectionId: 'nope', workspaceId: a.workspace.id }, a.user.id)).rejects.toThrow('Connection not found');
    });

    it('a connection that needs re-auth is a 409; a provider with no IMPORT adapter is a 422', async () => {
      const w = await world();
      await prisma.integrationConnection.update({ where: { id: w.connection.id }, data: { status: IntegrationConnectionStatus.NEEDS_REAUTH } });
      await expect(newJob(w)).rejects.toThrow('must be reconnected');
      const discord = await prisma.integrationConnection.create({
        data: { accountId: w.account.id, provider: IntegrationProvider.DISCORD, externalAccountId: 'g', externalAccountName: 'G', scopes: [], createdById: w.user.id },
      });
      await expect(imports.create({ connectionId: discord.id, workspaceId: w.workspace.id }, w.user.id)).rejects.toThrow('cannot be used to import');
    });

    it('someone with no access to the workspace cannot create (403) or read (403) a job', async () => {
      const w = await world();
      const outsider = await createUser(prisma);
      await expect(imports.create({ connectionId: w.connection.id, workspaceId: w.workspace.id }, outsider.id)).rejects.toThrow(/permission|cannot run imports|access|allowed/i);
      const job = await newJob(w);
      await expect(imports.get(job.id, outsider.id)).rejects.toThrow(/permission|cannot run imports|access|allowed/i);
      await expect(imports.start(job.id, outsider.id)).rejects.toThrow(/permission|cannot run imports|access|allowed/i);
    });

    it('unknown job = 404; list returns the workspace\'s jobs newest first', async () => {
      const w = await world();
      await expect(imports.get('missing', w.user.id)).rejects.toThrow('Import not found');
      const a = await newJob(w); const b = await newJob(w);
      expect((await imports.list(w.workspace.id)).map((j) => j.id)).toEqual([b.id, a.id]);
    });
  });

  // ------------------------------------------------------------------------------------------
  describe('setup: sources, selection, mapping, preview', () => {
    it('sources calls the provider with a LIVE token, never the stored credential', async () => {
      const w = await world();
      const job = await newJob(w);
      const tree = await imports.sources(job.id, w.user.id);
      expect(tree.nodes).toHaveLength(3);
      expect(adapter.lastCtx).toEqual({ connectionId: w.connection.id, externalAccountId: w.connection.externalAccountId, accessToken: 'live-token' });
    });

    it('selection: must be selectable nodes of the provider tree (else 400); a valid one moves DRAFT -> SOURCES_SELECTED', async () => {
      const w = await world();
      const job = await newJob(w);
      await expect(imports.setSelection(job.id, { sources: [{ id: 'ghost', type: 'project' }] }, w.user.id)).rejects.toThrow('Not selectable');
      await expect(imports.setSelection(job.id, { sources: [{ id: 'team-1', type: 'team' }] }, w.user.id)).rejects.toThrow('Not selectable');
      expect(await statusOf(job.id)).toBe('DRAFT');
      const v = await imports.setSelection(job.id, SEL, w.user.id);
      expect(v.status).toBe('SOURCES_SELECTED');
      expect(v.selection).toEqual(SEL);
    });

    it('mapping is validated strictly (4.3), stored normalised, and moves to MAPPING; GET returns it', async () => {
      const w = await world();
      const job = await newJob(w);
      await expect(imports.setMapping(job.id, { version: 1 }, w.user.id)).rejects.toThrow(/no longer|DRAFT/); // nothing selected yet
      await imports.setSelection(job.id, SEL, w.user.id);
      const v = await imports.setMapping(job.id, { version: 1, matchByEmail: false }, w.user.id);
      expect(v.status).toBe('MAPPING');
      expect(await imports.getMapping(job.id, w.user.id)).toMatchObject({ mappingConfig: { version: 1, matchByEmail: false }, hasInventory: false });
      await expect(imports.setMapping(job.id, { big: 'x' }, w.user.id)).rejects.toMatchObject({ response: { problems: expect.arrayContaining([expect.objectContaining({ code: 'INVALID_SHAPE' })]) } });
      expect(await statusOf(job.id)).toBe('MAPPING'); // a refused save changes nothing
    });

    it('preview needs a selection; stores counts + plan impact, no blockers on a roomy plan; makes no writes to the workspace', async () => {
      const w = await world();
      const job = await newJob(w);
      await expect(imports.preview(job.id, w.user.id)).rejects.toThrow('Choose what to import');
      await imports.setSelection(job.id, SEL, w.user.id);
      const v = await imports.preview(job.id, w.user.id);
      expect(v.status).toBe('PREVIEW_READY');
      expect(v.previewSummary).toMatchObject({
        counts: { projects: 2, tasks: 15, comments: 7, attachments: 2, attachmentBytes: 1234, users: 3 },
        plan: { importItems: 15, blockers: [] },
      });
      expect(await prisma.project.count()).toBe(0);
      expect(await prisma.task.count()).toBe(0);
    });

    it('editing the selection or mapping after a preview invalidates it (summary cleared, status steps back)', async () => {
      const w = await world();
      const id = await previewed(w);
      let v = await imports.setMapping(id, { version: 1, matchByEmail: false }, w.user.id);
      expect(v.status).toBe('MAPPING'); expect(v.previewSummary).toBeNull();
      await imports.preview(id, w.user.id);
      v = await imports.setSelection(id, { sources: [{ id: 'proj-a', type: 'project' }] }, w.user.id);
      expect(v.status).toBe('SOURCES_SELECTED'); expect(v.previewSummary).toBeNull();
      expect((await imports.getMapping(id, w.user.id)).mappingConfig).toEqual({ version: 1, matchByEmail: false }); // mapping kept
    });

    it('provider errors: rate limited -> 503, needs re-auth -> 409 (nothing changes)', async () => {
      const w = await world();
      const job = await newJob(w);
      adapter.failWith = new ProviderRateLimitedError(60_000, 'linear');
      await expect(imports.sources(job.id, w.user.id)).rejects.toThrow('not answering');
      adapter.failWith = null; tokenError = new ConnectionNeedsReauthError(w.connection.id);
      await expect(imports.sources(job.id, w.user.id)).rejects.toThrow('Reconnect');
      expect(await statusOf(job.id)).toBe('DRAFT');
    });

    it('a connection that went NEEDS_REAUTH after the job was created blocks provider calls with 409', async () => {
      const w = await world();
      const job = await newJob(w);
      await prisma.integrationConnection.update({ where: { id: w.connection.id }, data: { status: 'NEEDS_REAUTH' } });
      await expect(imports.sources(job.id, w.user.id)).rejects.toThrow('Reconnect');
    });
  });

  // ------------------------------------------------------------------------------------------
  describe('G1 preflight', () => {
    it('FREE_PERSONAL: per-project task cap (50) and project cap (5) block, naming the source project', async () => {
      const w = await world('FREE_PERSONAL');
      adapter.estimate_ = { projects: [{ sourceId: 'proj-a', name: 'Alpha', tasks: 51 }, { sourceId: 'proj-b', name: 'Beta', tasks: 5 }] };
      const id = await previewed(w);
      const blockers = (await imports.get(id, w.user.id)).previewSummary as { plan: { blockers: Array<{ code: string; sourceId?: string }> } };
      expect(blockers.plan.blockers).toEqual([expect.objectContaining({ code: 'TASK_LIMIT', sourceId: 'proj-a' })]);

      adapter.estimate_ = { projects: Array.from({ length: 6 }, (_, i) => ({ sourceId: `p${i}`, name: `P${i}`, tasks: 1 })) };
      await imports.preview(id, w.user.id);
      const codes = ((await imports.get(id, w.user.id)).previewSummary as { plan: { blockers: Array<{ code: string }> } }).plan.blockers.map((b) => b.code);
      expect(codes).toContain('PROJECT_LIMIT');
    });

    it('ORGANIZATION accounts have no per-project task cap', async () => {
      const w = await createUserWithAccount(prisma, { role: Role.OWNER, accountType: AccountType.ORGANIZATION });
      await prisma.account.update({ where: { id: w.account.id }, data: { planType: 'STARTER_ORG' as never } });
      const workspace = await createWorkspace(prisma, { accountId: w.account.id });
      const connection = await prisma.integrationConnection.create({
        data: { accountId: w.account.id, provider: 'LINEAR', externalAccountId: 'o', externalAccountName: 'O', scopes: [], createdById: w.user.id },
      });
      adapter.estimate_ = { projects: [{ sourceId: 'proj-a', name: 'Alpha', tasks: 500 }] };
      const job = await imports.create({ connectionId: connection.id, workspaceId: workspace.id }, w.user.id);
      await imports.setSelection(job.id, { sources: [{ id: 'proj-a', type: 'project' }] }, w.user.id);
      const v = await imports.preview(job.id, w.user.id);
      expect((v.previewSummary as { plan: { blockers: unknown[] } }).plan.blockers).toEqual([]);
    });

    it("the monthly allowance: this month's usage + the import must fit (FREE_PERSONAL = 250)", async () => {
      const w = await world('FREE_PERSONAL');
      await usage.charge(w.account.id, 240);
      const id = await previewed(w); // 15 tasks -> 255 > 250
      const s = (await imports.get(id, w.user.id)).previewSummary as { plan: { blockers: Array<{ code: string }> } };
      expect(s.plan.blockers.map((b) => b.code)).toEqual(['IMPORT_ITEMS_LIMIT']);
      await expect(imports.start(id, w.user.id)).rejects.toMatchObject({ response: { blockers: [expect.objectContaining({ code: 'IMPORT_ITEMS_LIMIT' })] } });
      expect(await statusOf(id)).toBe('PREVIEW_READY');
      expect(enqueued).toHaveLength(0);
    });

    it('start RE-RUNS G1 from the stored preview: upgrading the plan after the preview unblocks it with no new provider call', async () => {
      const w = await world('FREE_PERSONAL');
      await usage.charge(w.account.id, 245);
      const id = await previewed(w);
      await expect(imports.start(id, w.user.id)).rejects.toThrow(/blocked/);
      await prisma.account.update({ where: { id: w.account.id }, data: { planType: 'PRO_PERSONAL' as never } });
      const calls = adapter.estimateCalls;
      const v = await imports.start(id, w.user.id);
      expect(v.status).toBe('QUEUED');
      expect(adapter.estimateCalls).toBe(calls);
    });

    it('nothing to import is a blocker', async () => {
      const w = await world();
      adapter.estimate_ = { projects: [] };
      const id = await previewed(w);
      const s = (await imports.get(id, w.user.id)).previewSummary as { plan: { blockers: Array<{ code: string }> } };
      expect(s.plan.blockers.map((b) => b.code)).toEqual(['NOTHING_TO_IMPORT']);
    });
  });

  // ------------------------------------------------------------------------------------------
  describe('start / cancel / resume / rollback / delete', () => {
    it('start: PREVIEW_READY -> QUEUED, attempt 1, ONE imports.run job with a deterministic id, one IMPORT_STARTED audit row', async () => {
      const w = await world();
      const id = await previewed(w);
      const v = await imports.start(id, w.user.id);
      expect(v.status).toBe('QUEUED');
      expect(v.startedAt).not.toBeNull();
      expect(enqueued).toEqual([{ queue: 'imports', name: 'imports.run', payload: { importJobId: id, attempt: 1 }, jobId: `import-run-${id}-1` }]);
      const audit = await prisma.auditLog.findMany({ where: { action: 'IMPORT_STARTED', accountId: w.account.id } });
      expect(audit).toHaveLength(1);
      expect(audit[0].metadata).toMatchObject({ importJobId: id, resumed: false, provider: 'LINEAR' });
    });

    it('start requires a preview; before that it is a 409 and nothing is enqueued', async () => {
      const w = await world();
      const job = await newJob(w);
      await expect(imports.start(job.id, w.user.id)).rejects.toThrow('Preview the import');
      await imports.setSelection(job.id, SEL, w.user.id);
      await expect(imports.start(job.id, w.user.id)).rejects.toThrow('Preview the import');
      expect(enqueued).toHaveLength(0);
    });

    it('two concurrent starts: exactly one wins, exactly one job is enqueued', async () => {
      const w = await world();
      const id = await previewed(w);
      const r = await Promise.allSettled([imports.start(id, w.user.id), imports.start(id, w.user.id), imports.start(id, w.user.id)]);
      expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
      expect(r.filter((x) => x.status === 'rejected')).toHaveLength(2);
      expect(enqueued).toHaveLength(1);
      expect((await prisma.importJob.findUniqueOrThrow({ where: { id } })).attempt).toBe(1);
    });

    it('queue down: start fails and the status flip ROLLS BACK (still PREVIEW_READY, attempt 0, no audit row); retry then works', async () => {
      const w = await world();
      const id = await previewed(w);
      enqueueFails = true;
      await expect(imports.start(id, w.user.id)).rejects.toThrow('redis down');
      const row = await prisma.importJob.findUniqueOrThrow({ where: { id } });
      expect(row).toMatchObject({ status: 'PREVIEW_READY', attempt: 0, startedAt: null });
      expect(await prisma.auditLog.count({ where: { action: 'IMPORT_STARTED' } })).toBe(0);
      enqueueFails = false;
      expect((await imports.start(id, w.user.id)).status).toBe('QUEUED');
    });

    it('once started, selection / mapping / preview / sources / delete are refused (409)', async () => {
      const w = await world();
      const id = await previewed(w);
      await imports.start(id, w.user.id);
      await expect(imports.setSelection(id, SEL, w.user.id)).rejects.toThrow('no longer');
      await expect(imports.setMapping(id, { version: 1 }, w.user.id)).rejects.toThrow('no longer');
      await expect(imports.preview(id, w.user.id)).rejects.toThrow('Choose what to import');
      await expect(imports.sources(id, w.user.id)).rejects.toThrow('only available while setting up');
      await expect(imports.delete(id, w.user.id)).rejects.toThrow('has not started');
    });

    it('delete removes a setup job (and only that)', async () => {
      const w = await world();
      const job = await newJob(w);
      await imports.delete(job.id, w.user.id);
      expect(await prisma.importJob.count()).toBe(0);
    });

    it('cancel: QUEUED / RUNNING / PAUSED -> CANCELED with finishedAt; anything else is a 409', async () => {
      const w = await world();
      for (const from of [S.QUEUED, S.RUNNING, S.PAUSED]) {
        const id = await previewed(w);
        await force(id, from);
        const v = await imports.cancel(id, w.user.id);
        expect(v.status).toBe('CANCELED'); expect(v.finishedAt).not.toBeNull();
      }
      const id = await previewed(w);
      await expect(imports.cancel(id, w.user.id)).rejects.toThrow('Only a queued, running or paused');
      await force(id, S.COMPLETED);
      await expect(imports.cancel(id, w.user.id)).rejects.toThrow('Only a queued, running or paused');
    });

    it('resume: FAILED / PAUSED -> QUEUED with a NEW attempt and a NEW jobId (BullMQ would swallow a reused one); audit says resumed', async () => {
      const w = await world();
      const id = await previewed(w);
      await imports.start(id, w.user.id);
      await force(id, S.FAILED, { pauseReason: 'boom' });
      const v = await imports.resume(id, w.user.id);
      expect(v.status).toBe('QUEUED'); expect(v.pauseReason).toBeNull();
      await force(id, S.PAUSED);
      await imports.resume(id, w.user.id);
      expect(enqueued.map((e) => e.jobId)).toEqual([`import-run-${id}-1`, `import-run-${id}-2`, `import-run-${id}-3`]);
      const audits = await prisma.auditLog.findMany({ where: { action: 'IMPORT_STARTED' }, orderBy: { createdAt: 'asc' } });
      expect(audits.map((a) => (a.metadata as { resumed: boolean }).resumed)).toEqual([false, true, true]);
    });

    it('resume refuses when the connection needs re-auth, and for a job that is not paused/failed', async () => {
      const w = await world();
      const id = await previewed(w);
      await imports.start(id, w.user.id);
      await expect(imports.resume(id, w.user.id)).rejects.toThrow('Only a paused or failed');
      await force(id, S.PAUSED);
      await prisma.integrationConnection.update({ where: { id: w.connection.id }, data: { status: 'NEEDS_REAUTH' } });
      await expect(imports.resume(id, w.user.id)).rejects.toThrow('Reconnect');
      expect(await statusOf(id)).toBe('PAUSED');
    });

    it('rollback: COMPLETED / WARNINGS / FAILED / CANCELED -> ROLLING_BACK + one imports.rollback job; RUNNING and QUEUED are refused', async () => {
      const w = await world();
      for (const from of [S.COMPLETED, S.COMPLETED_WITH_WARNINGS, S.FAILED, S.CANCELED]) {
        const id = await previewed(w);
        await force(id, from);
        expect((await imports.rollback(id, w.user.id)).status).toBe('ROLLING_BACK');
        expect(enqueued.at(-1)).toMatchObject({ name: 'imports.rollback', payload: { importJobId: id }, jobId: `import-rollback-${id}` });
      }
      for (const from of [S.RUNNING, S.QUEUED, S.PAUSED, S.PREVIEW_READY, S.ROLLED_BACK]) {
        const id = await previewed(w);
        await force(id, from);
        await expect(imports.rollback(id, w.user.id)).rejects.toThrow('cannot be rolled back');
      }
    });

    it('re-requesting a rollback re-enqueues with the SAME jobId (recovers a lost queue entry, cannot double up); queue down leaves the status alone', async () => {
      const w = await world();
      const id = await previewed(w);
      await force(id, S.COMPLETED);
      enqueueFails = true;
      await expect(imports.rollback(id, w.user.id)).rejects.toThrow('redis down');
      expect(await statusOf(id)).toBe('COMPLETED');
      enqueueFails = false;
      await imports.rollback(id, w.user.id);
      await imports.rollback(id, w.user.id);
      expect(enqueued.map((e) => e.jobId)).toEqual([`import-rollback-${id}`, `import-rollback-${id}`]);
    });
  });

  // ------------------------------------------------------------------------------------------
  describe('report and issues', () => {
    it('report: issue counts by severity + rows created by type', async () => {
      const w = await world();
      const id = await previewed(w);
      await issues.record(id, [
        { severity: ImportIssueSeverity.WARN, code: 'USER_UNMAPPED', externalRef: 'user:u1', message: 'm' },
        { severity: ImportIssueSeverity.ERROR, code: 'BAD_ITEM', message: 'm' },
        { severity: ImportIssueSeverity.WARN, code: 'USER_UNMAPPED', externalRef: 'user:u2', message: 'm' },
      ]);
      await refs.upsertMany(w.connection.id, id, [
        { externalType: 'issue', externalId: '1', localType: 'task', localId: 't1' },
        { externalType: 'issue', externalId: '2', localType: 'task', localId: 't2' },
        { externalType: 'project', externalId: 'p', localType: 'project', localId: 'pr' },
      ]);
      const r = await imports.report(id, w.user.id);
      expect(r.issues).toEqual({ INFO: 0, WARN: 2, ERROR: 1 });
      expect(r.created).toEqual({ task: 2, project: 1 });
      expect(r.job.id).toBe(id);
    });

    it('issues are keyset-paged and filterable by severity', async () => {
      const w = await world();
      const id = await previewed(w);
      await issues.record(id, Array.from({ length: 5 }, (_, i) => ({ severity: i < 3 ? ImportIssueSeverity.WARN : ImportIssueSeverity.ERROR, code: `C${i}`, message: 'm' })));
      const p1 = await imports.issuePage(id, w.user.id, { take: 2 });
      expect(p1.items).toHaveLength(2); expect(p1.nextCursor).not.toBeNull();
      const p2 = await imports.issuePage(id, w.user.id, { take: 2, after: p1.nextCursor! });
      const p3 = await imports.issuePage(id, w.user.id, { take: 2, after: p2.nextCursor! });
      expect([...p1.items, ...p2.items, ...p3.items].map((i) => i.code).sort()).toEqual(['C0', 'C1', 'C2', 'C3', 'C4']);
      expect(p3.nextCursor).toBeNull();
      const errs = await imports.issuePage(id, w.user.id, { severity: ImportIssueSeverity.ERROR });
      expect(errs.items.map((i) => i.code).sort()).toEqual(['C3', 'C4']);
    });

    it(`issues are capped at ${IMPORT_LIMITS.maxIssuesPerJob} per job; one ISSUES_TRUNCATED marker says so, later calls add nothing`, async () => {
      const w = await world();
      const id = await previewed(w);
      const many = Array.from({ length: IMPORT_LIMITS.maxIssuesPerJob + 50 }, (_, i) => ({ severity: ImportIssueSeverity.INFO, code: 'X', message: `m${i}` }));
      await issues.record(id, many);
      expect(await prisma.importJobIssue.count({ where: { importJobId: id } })).toBe(IMPORT_LIMITS.maxIssuesPerJob + 1);
      expect(await prisma.importJobIssue.count({ where: { importJobId: id, code: ISSUES_TRUNCATED } })).toBe(1);
      await issues.record(id, many.slice(0, 10));
      expect(await prisma.importJobIssue.count({ where: { importJobId: id } })).toBe(IMPORT_LIMITS.maxIssuesPerJob + 1);
    });

    it('over-long messages / codes / refs are cut, not rejected', async () => {
      const w = await world();
      const id = await previewed(w);
      await issues.record(id, [{ severity: ImportIssueSeverity.WARN, code: 'C'.repeat(500), externalRef: 'r'.repeat(900), message: 'm'.repeat(5000) }]);
      const row = await prisma.importJobIssue.findFirstOrThrow({ where: { importJobId: id } });
      expect([row.code.length, row.externalRef!.length, row.message.length]).toEqual([80, 300, 1000]);
    });
  });

  // ------------------------------------------------------------------------------------------
  describe('ExternalRef', () => {
    it('upsertMany creates, and a re-run with other values KEEPS the original job + local id but refreshes the hash (idempotency key)', async () => {
      const w = await world();
      const job1 = await previewed(w);
      const job2 = await previewed(w);
      const first = await refs.upsertMany(w.connection.id, job1, [
        { externalType: 'issue', externalId: 'A', externalKey: 'ENG-1', localType: 'task', localId: 't-1', contentHash: 'h1' },
      ]);
      expect(first[0]).toMatchObject({ inserted: true, localId: 't-1', importJobId: job1, contentHash: 'h1' });
      const again = await refs.upsertMany(w.connection.id, job2, [
        { externalType: 'issue', externalId: 'A', localType: 'task', localId: 'SOMETHING-ELSE', contentHash: 'h2' },
      ]);
      expect(again[0]).toMatchObject({ inserted: false, localId: 't-1', importJobId: job1, contentHash: 'h2' });
      const row = await prisma.externalRef.findFirstOrThrow({ where: { externalId: 'A' } });
      expect(row.externalKey).toBe('ENG-1'); // not blanked by a call that had no key
      expect(await prisma.externalRef.count()).toBe(1);
    });

    it('uniqueness is per (connection, type, externalId): the same id under another type or connection is a different ref', async () => {
      const w = await world();
      const other = await prisma.integrationConnection.create({
        data: { accountId: w.account.id, provider: 'LINEAR', externalAccountId: 'org-2', externalAccountName: 'O2', scopes: [], createdById: w.user.id },
      });
      const j = await previewed(w);
      const j2 = (await prisma.importJob.create({ data: { connectionId: other.id, workspaceId: w.workspace.id, createdById: w.user.id, options: {} } })).id;
      await refs.upsertMany(w.connection.id, j, [
        { externalType: 'issue', externalId: '1', localType: 'task', localId: 'a' },
        { externalType: 'comment', externalId: '1', localType: 'comment', localId: 'b' },
      ]);
      await refs.upsertMany(other.id, j2, [{ externalType: 'issue', externalId: '1', localType: 'task', localId: 'c' }]);
      expect(await prisma.externalRef.count()).toBe(3);
    });

    it('a batch with the same ref twice is refused up front (it would silently lose one)', async () => {
      const w = await world();
      const j = await previewed(w);
      await expect(
        refs.upsertMany(w.connection.id, j, [
          { externalType: 'issue', externalId: '1', localType: 'task', localId: 'a' },
          { externalType: 'issue', externalId: '1', localType: 'task', localId: 'b' },
        ]),
      ).rejects.toThrow('duplicate ref');
    });

    it('lookup returns only existing refs; empty input is a no-op', async () => {
      const w = await world();
      const j = await previewed(w);
      await refs.upsertMany(w.connection.id, j, [{ externalType: 'issue', externalId: '1', localType: 'task', localId: 'a', contentHash: 'h' }]);
      const m = await refs.lookup(w.connection.id, 'issue', ['1', '2']);
      expect([...m.keys()]).toEqual(['1']);
      expect(m.get('1')).toMatchObject({ localId: 'a', localType: 'task', contentHash: 'h', importJobId: j });
      expect((await refs.lookup(w.connection.id, 'issue', [])).size).toBe(0);
      expect(await refs.upsertMany(w.connection.id, j, [])).toEqual([]);
    });

    it('inside a transaction the ref commits or vanishes together with the caller\'s writes', async () => {
      const w = await world();
      const j = await previewed(w);
      await expect(
        prisma.$transaction(async (tx) => {
          await refs.upsertMany(w.connection.id, j, [{ externalType: 'issue', externalId: 'T', localType: 'task', localId: 'x' }], tx);
          throw new Error('abort');
        }),
      ).rejects.toThrow('abort');
      expect(await prisma.externalRef.count()).toBe(0);
    });

    it('pageByJob is keyset-paged and filters by local type; rollback can walk a whole job', async () => {
      const w = await world();
      const j = await previewed(w);
      await refs.upsertMany(w.connection.id, j, Array.from({ length: 7 }, (_, i) => ({ externalType: 'issue', externalId: `i${i}`, localType: i < 5 ? 'task' : 'comment', localId: `l${i}` })));
      const seen: string[] = [];
      let after: string | undefined;
      for (;;) {
        const page = await refs.pageByJob(j, { localType: 'task', afterId: after, take: 2 });
        if (page.length === 0) break;
        seen.push(...page.map((r) => r.externalId));
        after = page[page.length - 1].id;
      }
      expect(seen.sort()).toEqual(['i0', 'i1', 'i2', 'i3', 'i4']);
    });

    it('deleting a draft job that created nothing leaves no refs; deleting the workspace cascades jobs, refs and issues', async () => {
      const w = await world();
      const j = await previewed(w);
      await refs.upsertMany(w.connection.id, j, [{ externalType: 'issue', externalId: '1', localType: 'task', localId: 'a' }]);
      await issues.record(j, [{ severity: ImportIssueSeverity.INFO, code: 'X', message: 'm' }]);
      await prisma.workspace.delete({ where: { id: w.workspace.id } });
      expect([await prisma.importJob.count(), await prisma.externalRef.count(), await prisma.importJobIssue.count()]).toEqual([0, 0, 0]);
    });
  });

  // ------------------------------------------------------------------------------------------
  describe('import_items meter', () => {
    it('charge adds up atomically under concurrency (10 x 5 = 50), and checkLimit sees it', async () => {
      const w = await world('FREE_PERSONAL');
      await Promise.all(Array.from({ length: 10 }, () => usage.charge(w.account.id, 5)));
      expect(await usage.used(w.account.id)).toBe(50);
      expect(await prisma.usageMetric.count({ where: { accountId: w.account.id, metric: 'import_items' } })).toBe(1);
      expect(await planLimits.checkLimit('importItems', 'runImport', { accountId: w.account.id }, { additional: 200 })).toBe(true);
      expect(await planLimits.checkLimit('importItems', 'runImport', { accountId: w.account.id }, { additional: 201 })).toBe(false);
    });

    it('refund gives back per period, never below zero, and ignores empty / unknown periods', async () => {
      const w = await world();
      const march = new Date(Date.UTC(2026, 2, 15));
      const april = new Date(Date.UTC(2026, 3, 15));
      const pm = await usage.charge(w.account.id, 30, march);
      const pa = await usage.charge(w.account.id, 10, april);
      expect([pm, pa]).toEqual(['2026-03', '2026-04']);
      await usage.refund(w.account.id, { '2026-03': 20, '2026-04': 999, '2026-05': 5, '2026-02': 0 });
      const rows = await prisma.usageMetric.findMany({ where: { accountId: w.account.id, metric: 'import_items' }, orderBy: { period: 'asc' } });
      expect(rows.map((r) => [r.period, r.value])).toEqual([['2026-03', 10], ['2026-04', 0]]);
    });

    it('charge(0) writes nothing; a negative or fractional amount is a programming error', async () => {
      const w = await world();
      expect(await usage.charge(w.account.id, 0)).toBe(usagePeriod());
      expect(await prisma.usageMetric.count()).toBe(0);
      await expect(usage.charge(w.account.id, -1)).rejects.toThrow('invalid items');
      await expect(usage.charge(w.account.id, 1.5)).rejects.toThrow('invalid items');
    });
  });
});
