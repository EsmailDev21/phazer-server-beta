import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  AccountType,
  AuditAction,
  ImportIssueSeverity,
  ImportJob,
  ImportJobStatus as S,
  IntegrationConnectionStatus,
  IntegrationProvider,
  Prisma,
} from '@prisma/client';
import { PermissionResolver } from '../access-control/access-control.service';
import { PlanLimitsService } from '../access-control/plan-limits.service';
import { getPlanLimits } from '../common/config/billing-tiers.config';
import { AuditLogService } from '../events/audit-log.service';
import { ConnectorRegistry } from '../integrations/core/connector.registry';
import {
  ConnectionNeedsReauthError,
  CredentialService,
} from '../integrations/core/credential.service';
import {
  ProviderAuthRejectedError,
  ProviderCircuitOpenError,
  ProviderHttpError,
  ProviderRateLimitedError,
} from '../integrations/core/integration.types';
import { PlanLimitExceededException } from '../common/exceptions/plan-limit-exceeded.exception';
import { PrismaService } from '../prisma/prisma.service';
import { WorkspacesService } from '../tenancy/workspaces/workspaces.service';
import { QUEUES } from '../queue/queue.definitions';
import { QueueService } from '../queue/queue.service';
import { ExternalRefService } from './external-ref.service';
import { ImportAdapterContext, ImportCapableAdapter, isImportCapable } from './import-adapter';
import { ImportIssueService } from './import-issue.service';
import { InventoryError, parseInventory } from './mapping/mapping.inventory';
import { MappingService, MappingView } from './mapping/mapping.service';
import {
  CANCELABLE,
  MAPPING_EDITABLE,
  PREVIEWABLE,
  RESUMABLE,
  ROLLBACKABLE,
  SELECTION_EDITABLE,
  isSetup,
} from './import-state-machine';
import {
  ImportEstimate,
  ImportOptions,
  ImportPreviewSummary,
  ImportSelection,
  PreflightBlocker,
  SourceTree,
  TemplateTarget,
} from './imports.types';
import { assertSelectionInTree, parseOptions, parseSelection } from './imports.validation';

export interface PerSpaceResult {
  spaceId: string;
  spaceName: string;
  workspaceId: string;
  workspaceCreated: boolean;
  job: ImportJobView;
}

/** `[{ spaceId, workspaceId?, sources? }]`, 1 to 50 distinct spaces. Strict: anything else is a 400. */
export function parsePerSpace(raw: unknown): Array<{ spaceId: string; workspaceId?: string; sources?: Array<{ id: string; type: string }> }> {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 50) throw new BadRequestException('spaces must be a list of 1 to 50 entries');
  const seen = new Set<string>();
  return raw.map((r) => {
    const e = r as Record<string, unknown> | null;
    const keys = e && typeof e === 'object' ? Object.keys(e) : [];
    if (!e || typeof e.spaceId !== 'string' || !e.spaceId || keys.some((k) => !['spaceId', 'workspaceId', 'sources'].includes(k))) {
      throw new BadRequestException('each space needs a spaceId (and optionally workspaceId and sources)');
    }
    if (seen.has(e.spaceId)) throw new BadRequestException('a space can only be listed once');
    seen.add(e.spaceId);
    if (e.workspaceId !== undefined && (typeof e.workspaceId !== 'string' || !e.workspaceId)) throw new BadRequestException('workspaceId must be a string');
    let sources: Array<{ id: string; type: string }> | undefined;
    if (e.sources !== undefined) {
      if (!Array.isArray(e.sources) || e.sources.length < 1 || e.sources.length > 500) throw new BadRequestException('sources must be a list of 1 to 500 entries');
      sources = e.sources.map((s) => {
        const x = s as { id?: unknown; type?: unknown };
        if (!x || typeof x.id !== 'string' || typeof x.type !== 'string') throw new BadRequestException('each source needs an id and a type');
        return { id: x.id, type: x.type };
      });
    }
    return { spaceId: e.spaceId, ...(e.workspaceId ? { workspaceId: e.workspaceId as string } : {}), ...(sources ? { sources } : {}) };
  });
}


export const REPORT_MAX_ROWS = 50_000;

/** CSV cell: quoted, quotes doubled, and a leading = + - @ (or tab / CR) neutralized so a spreadsheet never runs it as a formula. */
export function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}
export const csvRow = (cells: string[]): string => cells.map(csvCell).join(',');

/** `{ name?, description?, category?, includeComments?, onSecret? }`, strict. A missing name defaults to the source's. */
export function parseTemplateTarget(raw: unknown, defaultName: string): TemplateTarget {
  const e = (raw ?? {}) as Record<string, unknown>;
  if (typeof e !== 'object' || Array.isArray(e)) throw new BadRequestException('The template settings must be an object');
  const allowed = ['name', 'description', 'category', 'includeComments', 'onSecret'];
  for (const k of Object.keys(e)) if (!allowed.includes(k)) throw new BadRequestException(`Unknown template setting "${k}"`);
  const str = (k: string, max: number): string | undefined => {
    const v = e[k];
    if (v === undefined || v === null || v === '') return undefined;
    if (typeof v !== 'string' || v.length > max) throw new BadRequestException(`${k} must be text of at most ${max} characters`);
    return v;
  };
  const name = (str('name', 120) ?? defaultName).trim();
  if (!name) throw new BadRequestException('The template needs a name');
  const category = str('category', 60);
  if (category !== undefined && !/^[a-z0-9][a-z0-9-]{0,59}$/.test(category)) throw new BadRequestException('category must be lower-case letters, digits and dashes');
  if (e.includeComments !== undefined && typeof e.includeComments !== 'boolean') throw new BadRequestException('includeComments must be true or false');
  if (e.onSecret !== undefined && e.onSecret !== 'block' && e.onSecret !== 'redact') throw new BadRequestException('onSecret must be "block" or "redact"');
  return { name, ...(str('description', 2000) ? { description: str('description', 2000) } : {}), ...(category ? { category } : {}), ...(e.includeComments === true ? { includeComments: true } : {}), ...(e.onSecret ? { onSecret: e.onSecret as 'block' | 'redact' } : {}) };
}

function defaultTemplateName(summary: ImportPreviewSummary | null, provider: string): string {
  const first = summary?.projects?.[0]?.name;
  const n = summary?.projects?.length ?? 0;
  return (first ? (n > 1 ? `${first} and ${n - 1} more` : first) : `${provider} import`).slice(0, 120);
}

/** The only shape of a job that leaves the API: no checkpoint (cursors are provider internals). */
export interface ImportJobView {
  id: string;
  status: S;
  connectionId: string;
  workspaceId: string;
  provider: string;
  selection: unknown;
  options: unknown;
  previewSummary: unknown;
  progress: unknown;
  /** Step 4.9: what a finished job produced besides rows (import-as-template: `{ kind: 'TEMPLATE', templateId, ... }`). */
  result: unknown;
  pauseReason: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
}

type JobWithConnection = ImportJob & {
  connection: { provider: IntegrationProvider; status: IntegrationConnectionStatus; externalAccountId: string; accountId: string };
  workspace: { accountId: string };
};

const JOB_INCLUDE = {
  connection: { select: { provider: true, status: true, externalAccountId: true, accountId: true } },
  workspace: { select: { accountId: true } },
} as const;

const TX_TIMEOUT_MS = 15_000;

/**
 * Step 4.1 (diagram 04, ADR-0030). Everything a person does to an import job up to and including start / cancel /
 * resume / rollback. It never writes tasks: the executor (step 4.4) does, in a worker process.
 *
 * Authority: `runImport` (WORKSPACE, ADMIN) on the job's target workspace, checked on EVERY call (the controller
 * checks it for create/list; every `:id` route goes through load()). A job can only use a connection of the same
 * Account as its workspace.
 */
@Injectable()
export class ImportsService {
  private readonly logger = new Logger(ImportsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ConnectorRegistry,
    private readonly credentials: CredentialService,
    private readonly resolver: PermissionResolver,
    private readonly planLimits: PlanLimitsService,
    private readonly audit: AuditLogService,
    private readonly queue: QueueService,
    private readonly issues: ImportIssueService,
    private readonly refs: ExternalRefService,
    private readonly mapping: MappingService,
    private readonly workspaces: WorkspacesService,
  ) {}

  // ---------------------------------------------------------------- create / read

  async create(
    dto: { connectionId: string; workspaceId: string; options?: unknown },
    userId: string,
  ): Promise<ImportJobView> {
    const options = parseOptions(dto.options);
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: dto.workspaceId },
      select: { id: true, accountId: true },
    });
    if (!workspace) throw new NotFoundException('Workspace not found');
    // The controller's guard already checked this; repeated here so the service is safe to call from anywhere.
    const perm = await this.resolver.resolve(userId, 'runImport', 'WORKSPACE', workspace.id);
    if (!perm.allowed) throw new ForbiddenException(perm.reason ?? 'You cannot run imports in this workspace');
    // Same 404 for "no such connection" and "someone else's": do not reveal other accounts' connection ids.
    const connection = await this.prisma.integrationConnection.findUnique({
      where: { id: dto.connectionId },
      select: { id: true, accountId: true, provider: true, status: true },
    });
    if (!connection || connection.accountId !== workspace.accountId) {
      throw new NotFoundException('Connection not found');
    }
    if (connection.status !== IntegrationConnectionStatus.ACTIVE) {
      throw new ConflictException('This connection must be reconnected before it can import');
    }
    this.adapterFor(connection.provider);

    const job = await this.prisma.importJob.create({
      data: {
        connectionId: connection.id,
        workspaceId: workspace.id,
        createdById: userId,
        status: S.DRAFT,
        options: options as unknown as Prisma.InputJsonValue,
      },
      include: JOB_INCLUDE,
    });
    return this.view(job);
  }

  /**
   * Step 4.7b (diagram 06: Space -> Workspace, "new, or merge into existing"). One call sets up one import job PER SPACE, each
   * in its own workspace: an existing one the caller names, or a NEW one named after the Space. A job still has exactly one
   * destination workspace, so mapping, quota, progress and rollback stay per job; this method only prepares them.
   *
   * All-or-nothing up to the first job: every permission, the tree and the plan's workspace limit are checked before anything is
   * created, and workspaces created here are removed again if a later step fails. The jobs come back in DRAFT with their
   * selection set; the caller then previews / maps / starts each one as usual.
   */
  async createPerSpace(
    dto: { connectionId: string; options?: unknown; spaces: unknown },
    userId: string,
  ): Promise<PerSpaceResult[]> {
    const options = parseOptions(dto.options);
    const spaces = parsePerSpace(dto.spaces);
    const connection = await this.prisma.integrationConnection.findUnique({
      where: { id: dto.connectionId },
      select: { id: true, accountId: true, provider: true, status: true, externalAccountId: true },
    });
    if (!connection) throw new NotFoundException('Connection not found');
    if (connection.status !== IntegrationConnectionStatus.ACTIVE) {
      throw new ConflictException('This connection must be reconnected before it can import');
    }
    const adapter = this.adapterFor(connection.provider);
    const nodeType = adapter.workspaceNodeType;
    if (!nodeType) throw new BadRequestException(`${connection.provider} has no level that maps to workspaces`);

    // Permissions first: nothing about the connection's tree is revealed to someone who may not use it.
    const creating = spaces.filter((s) => !s.workspaceId);
    if (creating.length > 0) {
      const perm = await this.resolver.resolve(userId, 'createWorkspace', 'ACCOUNT', connection.accountId);
      if (!perm.allowed) throw new ForbiddenException(perm.reason ?? 'You cannot create workspaces in this account');
    }
    for (const s of spaces.filter((x) => x.workspaceId)) {
      const ws = await this.prisma.workspace.findUnique({ where: { id: s.workspaceId! }, select: { id: true, accountId: true } });
      if (!ws || ws.accountId !== connection.accountId) throw new NotFoundException('Workspace not found');
      const perm = await this.resolver.resolve(userId, 'runImport', 'WORKSPACE', ws.id);
      if (!perm.allowed) throw new ForbiddenException(perm.reason ?? 'You cannot run imports in this workspace');
    }

    const tree = await this.callProvider(
      { id: 'per-space', connectionId: connection.id, connection } as unknown as JobWithConnection,
      (ctx) => adapter.discover(ctx),
    );
    const byId = new Map(tree.nodes.map((n) => [n.id, n]));
    const ancestors = (id: string): string[] => {
      const out: string[] = [];
      for (let n = byId.get(id), i = 0; n && n.parentId && i < 20; n = byId.get(n.parentId), i++) out.push(n.parentId);
      return out;
    };
    const plan = spaces.map((s) => {
      const node = byId.get(s.spaceId);
      if (!node || node.type !== nodeType) throw new BadRequestException(`"${s.spaceId}" is not a ${nodeType} of this connection`);
      const sources = s.sources ?? [{ id: node.id, type: node.type }];
      for (const src of sources) {
        const n = byId.get(src.id);
        if (!n || n.type !== src.type || !n.selectable || (n.id !== node.id && !ancestors(n.id).includes(node.id))) {
          throw new BadRequestException(`"${src.id}" is not part of ${node.name}`);
        }
      }
      return { ...s, name: node.name, sources };
    });

    if (creating.length > 0) {
      const ok = await this.planLimits.checkLimit('workspace', 'createWorkspace', { accountId: connection.accountId }, { additional: creating.length });
      if (!ok) throw new PlanLimitExceededException(`Creating ${creating.length} workspace(s) would exceed this plan's workspace limit`);
    }

    const made: string[] = [];
    try {
      const out: PerSpaceResult[] = [];
      for (const p of plan) {
        let workspaceId = p.workspaceId;
        if (!workspaceId) {
          const ws = await this.workspaces.create({ accountId: connection.accountId, name: p.name.slice(0, 100) } as never);
          made.push(ws.id);
          workspaceId = ws.id;
        }
        const job = await this.create({ connectionId: connection.id, workspaceId, options: dto.options }, userId);
        const withSelection = await this.setSelection(job.id, { sources: p.sources }, userId);
        out.push({ spaceId: p.spaceId, spaceName: p.name, workspaceId, workspaceCreated: !p.workspaceId, job: withSelection });
      }
      void options;
      return out;
    } catch (e) {
      // a workspace made for a job that cannot exist is removed again (it is empty: nothing was imported yet)
      for (const id of made) await this.prisma.workspace.delete({ where: { id } }).catch(() => undefined);
      throw e;
    }
  }

  /**
   * Step 4.9 (diagram 14: "import -> sanitize -> template"). Same previewed job, but NOTHING is written to the workspace: the import
   * is read, mapped and stored as a PRIVATE template of this account (see ImportTemplateRunner). Needs what creating a template needs
   * (`createTemplate` on the account, which includes the plan's template limit), on top of running imports.
   */
  async startAsTemplate(id: string, dto: unknown, userId: string): Promise<ImportJobView> {
    const job = await this.load(id, userId);
    this.assertIn(job, [S.PREVIEW_READY], 'Preview the import before starting it');
    if (!job.previewSummary) throw new ConflictException('Preview the import before starting it');
    const perm = await this.resolver.resolve(userId, 'createTemplate', 'ACCOUNT', job.workspace.accountId);
    if (!perm.allowed) throw new ForbiddenException(perm.reason ?? 'You cannot create templates in this account');
    const options = job.options as unknown as ImportOptions;
    if (options.target === 'TEMPLATE' && options.template) {
      // idempotent re-request of the same start: nothing to change
    }
    const template = parseTemplateTarget(dto, defaultTemplateName(job.previewSummary as unknown as ImportPreviewSummary, job.connection.provider));
    await this.prisma.importJob.update({ where: { id }, data: { options: { ...options, target: 'TEMPLATE', template } as unknown as Prisma.InputJsonValue } });
    await this.queueRun(job, [S.PREVIEW_READY], userId, false);
    return this.get(id, userId);
  }

  /**
   * Step 4.9. The report as a file: the job's outcome and EVERY recorded issue (capped), as CSV (one row per issue, safe to open in a
   * spreadsheet: a cell that starts with = + - @ is neutralized) or JSON (the whole report). Same permission as the on-screen report.
   */
  async reportDownload(id: string, userId: string, format: 'csv' | 'json'): Promise<{ filename: string; contentType: string; body: string }> {
    const report = await this.report(id, userId);
    const rows: Array<{ id: string; severity: string; code: string; externalRef: string | null; message: string; createdAt: Date }> = [];
    let after: string | undefined;
    for (let n = 0; n < 200 && rows.length < REPORT_MAX_ROWS; n++) {
      const page = await this.issues.page(id, { afterId: after, take: 500 });
      if (page.length === 0) break;
      rows.push(...(page as typeof rows));
      after = page[page.length - 1].id;
      if (page.length < 500) break;
    }
    const truncated = rows.length >= REPORT_MAX_ROWS;
    const used = rows.slice(0, REPORT_MAX_ROWS);
    if (format === 'json') {
      return { filename: `import-${id}-report.json`, contentType: 'application/json; charset=utf-8', body: JSON.stringify({ ...report, issueRows: used, truncated }, null, 2) };
    }
    const lines = [csvRow(['severity', 'code', 'item', 'message', 'recorded at'])];
    for (const r of used) lines.push(csvRow([r.severity, r.code, r.externalRef ?? '', r.message, r.createdAt.toISOString()]));
    if (truncated) lines.push(csvRow(['INFO', 'REPORT_TRUNCATED', '', `Only the first ${REPORT_MAX_ROWS} issues are listed`, '']));
    return { filename: `import-${id}-report.csv`, contentType: 'text/csv; charset=utf-8', body: `\uFEFF${lines.join('\r\n')}\r\n` };
  }

  async list(workspaceId: string): Promise<ImportJobView[]> {
    const rows = await this.prisma.importJob.findMany({
      where: { workspaceId },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: 50,
      include: JOB_INCLUDE,
    });
    return rows.map((r) => this.view(r));
  }

  async get(id: string, userId: string): Promise<ImportJobView> {
    return this.view(await this.load(id, userId));
  }

  /** Only a job that never started: nothing was written to the workspace, so there is nothing to undo. */
  async delete(id: string, userId: string): Promise<void> {
    await this.load(id, userId);
    const { count } = await this.prisma.importJob.deleteMany({
      where: { id, status: { in: [S.DRAFT, S.SOURCES_SELECTED, S.MAPPING, S.PREVIEW_READY] } },
    });
    if (count === 0) {
      throw new ConflictException('Only an import that has not started can be deleted; use rollback instead');
    }
  }

  // ---------------------------------------------------------------- setup steps

  async sources(id: string, userId: string): Promise<SourceTree> {
    const job = await this.load(id, userId);
    if (!isSetup(job.status)) throw new ConflictException(`Sources are only available while setting up (job is ${job.status})`);
    return this.discover(job);
  }

  async setSelection(id: string, raw: unknown, userId: string): Promise<ImportJobView> {
    const selection = parseSelection(raw);
    const job = await this.load(id, userId);
    this.assertIn(job, SELECTION_EDITABLE, 'The selection can no longer be changed');
    assertSelectionInTree(selection, await this.discover(job));
    // A new selection makes the old preview wrong; the mapping is kept (4.3 reconciles it against the new sources).
    await this.cas(id, SELECTION_EDITABLE, S.SOURCES_SELECTED, {
      selection: selection as unknown as Prisma.InputJsonValue,
      previewSummary: Prisma.DbNull,
      // what exists in the source depends on the selection: the next preview rebuilds it
      inventory: Prisma.DbNull,
    });
    return this.get(id, userId);
  }

  /**
   * The Map step: what the person saved, what the engine would do, what to look at. Without an inventory (no preview yet,
   * or the selection changed since) only the saved overrides come back.
   */
  async getMapping(id: string, userId: string): Promise<MappingView> {
    const job = await this.load(id, userId);
    return this.mapping.view(job);
  }

  async setMapping(id: string, raw: unknown, userId: string): Promise<ImportJobView> {
    const job = await this.load(id, userId);
    this.assertIn(job, MAPPING_EDITABLE, 'The mapping can no longer be changed');
    const config = await this.mapping.validateForSave(job, raw); // 400 listing every problem
    await this.cas(id, MAPPING_EDITABLE, S.MAPPING, {
      mappingConfig: config as unknown as Prisma.InputJsonValue,
      previewSummary: Prisma.DbNull,
    });
    return this.get(id, userId);
  }

  /** Dry run: asks the provider for counts (read-only), evaluates G1, stores the report. Never writes to the workspace. */
  async preview(id: string, userId: string): Promise<ImportJobView> {
    const job = await this.load(id, userId);
    this.assertIn(job, PREVIEWABLE, 'Choose what to import before previewing');
    const selection = job.selection as unknown as ImportSelection | null;
    if (!selection) throw new ConflictException('Choose what to import before previewing');

    const adapter = this.adapterFor(job.connection.provider);
    const estimate = await this.callProvider(job, (ctx) =>
      adapter.estimate(ctx, selection, job.options as unknown as ImportOptions),
    );
    const summary = await this.buildSummary(job, estimate);

    // The Map step (4.3): keep what the source contains, and tell the person what to look at.
    let inventory: Prisma.InputJsonValue | typeof Prisma.DbNull = Prisma.DbNull;
    if (estimate.inventory !== undefined) {
      let parsed;
      try {
        parsed = parseInventory(estimate.inventory);
      } catch (e) {
        if (!(e instanceof InventoryError)) throw e;
        this.logger.warn(`Provider inventory for import ${job.id} rejected: ${e.message}`);
        throw new UnprocessableEntityException(`The provider's structure could not be read for mapping: ${e.message}`);
      }
      inventory = parsed as unknown as Prisma.InputJsonValue;
      const res = await this.mapping.resolution({ ...job }, parsed);
      if (res) {
        summary.unmappedUsers = this.mapping.unmappedUsers(res);
        summary.mapping = { attention: res.attention };
        if (!(estimate.users !== undefined)) summary.counts.users = parsed.users.length;
      }
    }
    await this.cas(id, PREVIEWABLE, S.PREVIEW_READY, {
      previewSummary: summary as unknown as Prisma.InputJsonValue,
      inventory,
    });
    return this.get(id, userId);
  }

  // ---------------------------------------------------------------- run control

  /** G1 again (plan and connection may have changed since the preview), then QUEUED + enqueue in one unit. */
  async start(id: string, userId: string): Promise<ImportJobView> {
    const job = await this.load(id, userId);
    this.assertIn(job, [S.PREVIEW_READY], 'Preview the import before starting it');
    const summary = job.previewSummary as unknown as ImportPreviewSummary | null;
    if (!summary) throw new ConflictException('Preview the import before starting it');

    const blockers = await this.preflight(job, summary.projects, summary.counts.tasks);
    if (blockers.length > 0) throw this.blocked(blockers);

    await this.queueRun(job, [S.PREVIEW_READY], userId, false);
    return this.get(id, userId);
  }

  async resume(id: string, userId: string): Promise<ImportJobView> {
    const job = await this.load(id, userId);
    this.assertIn(job, RESUMABLE, 'Only a paused or failed import can be resumed');
    if (job.connection.status !== IntegrationConnectionStatus.ACTIVE) {
      throw new ConflictException('Reconnect the integration, then resume');
    }
    await this.queueRun(job, RESUMABLE, userId, true);
    return this.get(id, userId);
  }

  async cancel(id: string, userId: string): Promise<ImportJobView> {
    const job = await this.load(id, userId);
    this.assertIn(job, CANCELABLE, 'Only a queued, running or paused import can be canceled');
    // The executor looks at the status between chunks and stops; rows already written stay until rollback.
    await this.cas(id, CANCELABLE, S.CANCELED, { finishedAt: new Date(), pauseReason: null });
    return this.get(id, userId);
  }

  /** Deletes everything this job created (the executor walks ExternalRef by importJobId). Idempotent to re-request. */
  async rollback(id: string, userId: string): Promise<ImportJobView> {
    const job = await this.load(id, userId);
    this.assertIn(job, [...ROLLBACKABLE, S.ROLLING_BACK], 'This import cannot be rolled back');
    await this.prisma.$transaction(
      async (tx) => {
        await this.cas(id, [...ROLLBACKABLE, S.ROLLING_BACK], S.ROLLING_BACK, { pauseReason: null }, tx);
        await this.queue.enqueue(
          QUEUES.IMPORTS.name,
          'imports.rollback',
          { importJobId: id },
          { jobId: `import-rollback-${id}` },
        );
      },
      { timeout: TX_TIMEOUT_MS },
    );
    return this.get(id, userId);
  }

  // ---------------------------------------------------------------- report

  async report(id: string, userId: string) {
    const job = await this.load(id, userId);
    const [bySeverity, created] = await Promise.all([
      this.issues.countBySeverity(id),
      this.refs.countByLocalType(id),
    ]);
    return {
      job: this.view(job),
      issues: bySeverity,
      /** Rows this job created, by local type (what a rollback would delete). */
      created,
    };
  }

  async issuePage(
    id: string,
    userId: string,
    q: { severity?: ImportIssueSeverity; after?: string; take?: number },
  ) {
    await this.load(id, userId);
    const take = Math.min(Math.max(q.take ?? 100, 1), 500);
    const rows = await this.issues.page(id, { severity: q.severity, afterId: q.after, take: take + 1 });
    const items = rows.slice(0, take);
    return { items, nextCursor: rows.length > take ? items[items.length - 1].id : null };
  }

  // ---------------------------------------------------------------- internals

  /** Job + connection + permission. 404 when absent, 403 when the person may not run imports in that workspace. */
  private async load(id: string, userId: string): Promise<JobWithConnection> {
    const job = await this.prisma.importJob.findUnique({ where: { id }, include: JOB_INCLUDE });
    if (!job) throw new NotFoundException('Import not found');
    const perm = await this.resolver.resolve(userId, 'runImport', 'WORKSPACE', job.workspaceId);
    if (!perm.allowed) throw new ForbiddenException(perm.reason ?? 'You cannot run imports in this workspace');
    return job;
  }

  private adapterFor(provider: IntegrationProvider): ImportCapableAdapter {
    const adapter = this.registry.get(provider); // 404 when no adapter exists
    if (!isImportCapable(adapter)) {
      throw new UnprocessableEntityException(`${provider} cannot be used to import`);
    }
    return adapter;
  }

  private assertIn(job: { status: S }, allowed: readonly S[], message: string): void {
    if (!allowed.includes(job.status)) throw new ConflictException(`${message} (import is ${job.status})`);
  }

  /**
   * THE transition primitive: UPDATE ... WHERE id AND status IN (from). Two racing requests cannot both win; the
   * loser gets a 409 naming the status it actually found. The matrix (import-state-machine.ts) is asserted in
   * the unit tests for every edge used here; `from` lists are the same constants the matrix tests cover.
   */
  private async cas(
    id: string,
    from: readonly S[],
    to: S,
    data: Prisma.ImportJobUpdateManyMutationInput = {},
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<void> {
    const { count } = await db.importJob.updateMany({
      where: { id, status: { in: [...from] } },
      data: { ...data, status: to },
    });
    if (count === 0) {
      const now = await db.importJob.findUnique({ where: { id }, select: { status: true } });
      if (!now) throw new NotFoundException('Import not found');
      throw new ConflictException(`The import changed while this was happening (it is now ${now.status}); reload and retry`);
    }
  }

  /**
   * start / resume: flip to QUEUED and enqueue in ONE transaction. If Redis is down the enqueue throws and the status
   * flip rolls back (503, nothing changed). If the commit fails after a successful enqueue, the orphan queue job
   * finds a non-QUEUED job and does nothing (executor rule, ADR-0030 d.4), and the retry reuses the same jobId.
   */
  private async queueRun(
    job: JobWithConnection,
    from: readonly S[],
    userId: string,
    resumed: boolean,
  ): Promise<void> {
    await this.prisma.$transaction(
      async (tx) => {
        await this.cas(
          job.id,
          from,
          S.QUEUED,
          {
            attempt: { increment: 1 },
            pauseReason: null,
            finishedAt: null,
            ...(job.startedAt ? {} : { startedAt: new Date() }),
          },
          tx,
        );
        const { attempt } = await tx.importJob.findUniqueOrThrow({ where: { id: job.id }, select: { attempt: true } });
        await this.queue.enqueue(
          QUEUES.IMPORTS.name,
          'imports.run',
          { importJobId: job.id, attempt },
          { jobId: `import-run-${job.id}-${attempt}` },
        );
      },
      { timeout: TX_TIMEOUT_MS },
    );
    await this.audit.record({
      actorId: userId,
      accountId: job.workspace.accountId,
      action: AuditAction.IMPORT_STARTED,
      metadata: {
        importJobId: job.id,
        connectionId: job.connectionId,
        workspaceId: job.workspaceId,
        provider: job.connection.provider,
        resumed,
      },
    });
  }

  private async discover(job: JobWithConnection): Promise<SourceTree> {
    const adapter = this.adapterFor(job.connection.provider);
    return this.callProvider(job, (ctx) => adapter.discover(ctx));
  }

  /** Token + error translation shared by discover and estimate. */
  private async callProvider<T>(job: JobWithConnection, fn: (ctx: ImportAdapterContext) => Promise<T>): Promise<T> {
    if (job.connection.status !== IntegrationConnectionStatus.ACTIVE) {
      throw new ConflictException('Reconnect the integration to continue');
    }
    try {
      const accessToken = await this.credentials.getAccessToken(job.connectionId);
      return await fn({
        connectionId: job.connectionId,
        externalAccountId: job.connection.externalAccountId,
        accessToken,
      });
    } catch (e) {
      if (e instanceof ConnectionNeedsReauthError || e instanceof ProviderAuthRejectedError) {
        throw new ConflictException('Reconnect the integration to continue');
      }
      if (
        e instanceof ProviderRateLimitedError ||
        e instanceof ProviderCircuitOpenError ||
        e instanceof ProviderHttpError
      ) {
        this.logger.warn(`Provider call for import ${job.id} failed: ${(e as Error).message}`);
        throw new ServiceUnavailableException('The provider is not answering right now; try again shortly');
      }
      throw e;
    }
  }

  private async buildSummary(job: JobWithConnection, est: ImportEstimate): Promise<ImportPreviewSummary> {
    const projects = est.projects.map((p) => ({ sourceId: p.sourceId, name: p.name, tasks: p.tasks }));
    const tasks = projects.reduce((n, p) => n + p.tasks, 0);
    const blockers = await this.preflight(job, projects, tasks);
    return {
      generatedAt: new Date().toISOString(),
      counts: {
        projects: projects.length,
        tasks,
        comments: est.comments ?? 0,
        attachments: est.attachments ?? 0,
        attachmentBytes: est.attachmentBytes ?? 0,
        users: est.users ?? 0,
      },
      projects,
      warnings: est.warnings ?? [],
      unmappedUsers: [],
      plan: { importItems: tasks, blockers },
    };
  }

  /**
   * G1 of diagram 04. Pure reads. `storage` (attachment bytes) is deliberately NOT checked here: it is enforced
   * per file when attachments are copied (step 4.6), where it pauses the job instead of blocking the start.
   */
  private async preflight(
    job: JobWithConnection,
    projects: ReadonlyArray<{ sourceId: string; name: string; tasks: number }>,
    totalTasks: number,
  ): Promise<PreflightBlocker[]> {
    const blockers: PreflightBlocker[] = [];
    const accountId = job.workspace.accountId;

    if (job.connection.status !== IntegrationConnectionStatus.ACTIVE) {
      blockers.push({ code: 'CONNECTION_NOT_ACTIVE', message: 'Reconnect the integration first' });
    }
    if (projects.length === 0 || totalTasks === 0) {
      blockers.push({ code: 'NOTHING_TO_IMPORT', message: 'The selection contains no tasks' });
      return blockers;
    }

    const ctx = { accountId, workspaceId: job.workspaceId };
    if (!(await this.planLimits.checkLimit('project', 'runImport', ctx, { additional: projects.length }))) {
      blockers.push({
        code: 'PROJECT_LIMIT',
        message: `Importing ${projects.length} project(s) would exceed your plan's project limit`,
      });
    }

    // Per-project task cap (PERSONAL plans). New projects have no rows yet, so checkLimit('task') cannot see them:
    // read the cap from the tier table instead. ORGANIZATION accounts have no task cap at any tier.
    const account = await this.prisma.account.findUnique({
      where: { id: accountId },
      select: { type: true, planType: true },
    });
    const cap = account && account.type !== AccountType.ORGANIZATION ? getPlanLimits(account.planType).tasks : null;
    if (cap !== null) {
      for (const p of projects) {
        if (p.tasks > cap) {
          blockers.push({
            code: 'TASK_LIMIT',
            sourceId: p.sourceId,
            message: `"${p.name}" has ${p.tasks} tasks; your plan allows ${cap} per project`,
          });
        }
      }
    }

    if (!(await this.planLimits.checkLimit('importItems', 'runImport', { accountId }, { additional: totalTasks }))) {
      blockers.push({
        code: 'IMPORT_ITEMS_LIMIT',
        message: `Importing ${totalTasks} tasks would exceed this month's import allowance`,
      });
    }
    return blockers;
  }

  private blocked(blockers: PreflightBlocker[]): UnprocessableEntityException {
    return new UnprocessableEntityException({
      statusCode: 422,
      error: 'Unprocessable Entity',
      message: 'This import is blocked by your plan or connection; import a subset or upgrade',
      blockers,
    });
  }

  private view(job: JobWithConnection): ImportJobView {
    return {
      id: job.id,
      status: job.status,
      connectionId: job.connectionId,
      workspaceId: job.workspaceId,
      provider: job.connection.provider,
      selection: job.selection,
      options: job.options,
      previewSummary: job.previewSummary,
      progress: job.progress,
      result: job.result ?? null,
      pauseReason: job.pauseReason,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      createdAt: job.createdAt,
    };
  }
}

// Re-exported so the unit tests can pin the constants the service uses to the matrix.
export const IMPORT_SERVICE_EDGES = { SELECTION_EDITABLE, MAPPING_EDITABLE, PREVIEWABLE, CANCELABLE, RESUMABLE, ROLLBACKABLE };
