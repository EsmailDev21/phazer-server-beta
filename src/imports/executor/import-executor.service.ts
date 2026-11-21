import { Injectable, Logger } from '@nestjs/common';
import { AuditAction, ImportIssueSeverity as Sev, ImportJob, ImportJobStatus as S, IntegrationConnectionStatus, Prisma } from '@prisma/client';
import { PlanLimitsService } from '../../access-control/plan-limits.service';
import { PlanLimitExceededException } from '../../common/exceptions/plan-limit-exceeded.exception';
import { DomainWriter } from '../../domain-writer/domain-writer.service';
import { ConnectorRegistry } from '../../integrations/core/connector.registry';
import { CredentialService } from '../../integrations/core/credential.service';
import { PrismaService } from '../../prisma/prisma.service';
import { QUEUES } from '../../queue/queue.definitions';
import { QueueService } from '../../queue/queue.service';
import { validateBundle } from '../canonical';
import { isImportCapable } from '../import-adapter';
import { ImportIssueService, NewImportIssue } from '../import-issue.service';
import { ImportCapableAdapter } from '../import-adapter';
import { ImportOptions, ImportSelection } from '../imports.types';
import { applyMapping } from '../mapping';
import { MappingService } from '../mapping/mapping.service';
import { ImportFailure, MAX_AUTO_RETRIES, classifyImportError } from './import-errors';
import { ImportProgressPublisher, ProgressTracker } from './import-progress';
import { AttachmentsService } from '../../attachments/attachments.service';
import { ImportTemplateRunner } from '../template/import-template.runner';
import { ImportContentWriter } from './import-content-writer';
import { ImportFileCopier } from './import-file-copier';
import { ImportWriter, PageContext, RunJob } from './import-writer';

/** Files one copy job handles before it hands the import back (keeps jobs short; a restart continues from the item table). */
export const MAX_FILES_PER_RUN = 200;
/** Pages one queue job may process before it hands the import back (keeps jobs short and the queue fair). */
export const MAX_PAGES_PER_RUN = 40;
const TX_TIMEOUT_MS = 15_000;
/** Findings about a person / value / status that are reported once per JOB, not once per page. */
const ONCE_PER_JOB = new Set(['USER_UNMAPPED', 'PRIORITY_UNMATCHED', 'STATUS_UNKNOWN', 'CUSTOM_VALUE_USER_UNMAPPED', 'ISSUE_TYPE_UNAVAILABLE']);

export interface RunCheckpoint {
  /** FILES (step 4.6): the pages are done; the attachment-copy job (queue `import-files`) is draining `import_file_items`. */
  phase: 'PAGES' | 'LINKS' | 'FILES';
  cursor: unknown;
  pages: number;
  /** Consecutive automatic retries without a finished page. */
  retries: number;
}

type LoadedJob = ImportJob & {
  connection: { provider: Parameters<ConnectorRegistry['get']>[0]; status: IntegrationConnectionStatus; externalAccountId: string };
  workspace: { accountId: string };
};

/**
 * Step 4.4 (diagrams 04 + 05). Runs ONE import: fetch a page, validate it, map it, write it, checkpoint, repeat; then resolve
 * the links that could not be made before; then finish. Runs in the WORKER process, driven by the `imports.run` job.
 *
 * Rules (ADR-0033):
 *  - The job row is the only truth. A queue job acts only when `payload.attempt === job.attempt` and the status is one this
 *    handler may continue (QUEUED, RUNNING after a worker death, PAUSED by its own delayed retry); anything else is a no-op.
 *  - Every state change is a compare-and-set on `status = RUNNING`, so a cancel is seen at the next page boundary and nothing
 *    can resurrect a canceled or finished job.
 *  - The checkpoint (cursor) advances only AFTER a page is fully written; a crash re-fetches the same page, and the ExternalRef
 *    lookups make that a no-op for what already exists.
 *  - Errors are classified (import-errors.ts): pause for auth / plan limit, pause + automatic delayed retry for rate limits and
 *    transient trouble (bounded), isolate a refused item and carry on, fail (resumable) for everything else.
 */
@Injectable()
export class ImportExecutor {
  private readonly logger = new Logger(ImportExecutor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ConnectorRegistry,
    private readonly credentials: CredentialService,
    private readonly mapping: MappingService,
    private readonly writer: ImportWriter,
    private readonly issues: ImportIssueService,
    private readonly queue: QueueService,
    private readonly publisher: ImportProgressPublisher,
    private readonly domain: DomainWriter,
    private readonly planLimits: PlanLimitsService,
    private readonly content: ImportContentWriter,
    private readonly copier: ImportFileCopier,
    private readonly attachments: AttachmentsService,
    private readonly templateRunner: ImportTemplateRunner,
  ) {}

  async run(payload: { importJobId: string; attempt: number }): Promise<'DONE' | 'STALE'> {
    const job = await this.load(payload.importJobId);
    if (!job || job.attempt !== payload.attempt) return 'STALE';
    if (job.status === S.QUEUED || job.status === S.PAUSED) {
      const claimed = await this.cas(job.id, [job.status], S.RUNNING, { pauseReason: null, ...(job.startedAt ? {} : { startedAt: new Date() }) });
      if (!claimed) return 'STALE';
    } else if (job.status !== S.RUNNING) {
      return 'STALE';
    }
    try {
      await this.drive(job);
    } catch (e) {
      await this.onError(job, e);
    }
    return 'DONE';
  }

  // ------------------------------------------------------------------------------------------------ the loop

  private async drive(job: LoadedJob): Promise<void> {
    const run: RunJob = { id: job.id, connectionId: job.connectionId, workspaceId: job.workspaceId, accountId: job.workspace.accountId, createdById: job.createdById, options: job.options as unknown as ImportOptions };
    const selection = job.selection as unknown as ImportSelection | null;
    if (!selection) throw new ImportFailure('The import has no selection. Preview it again.');
    if (job.connection.status !== IntegrationConnectionStatus.ACTIVE) throw new ImportFailure('The connection is no longer active. Reconnect it and resume.');

    const adapter = this.registry.get(job.connection.provider);
    if (!isImportCapable(adapter)) throw new ImportFailure(`${job.connection.provider} cannot be used to import.`);
    // step 4.9: import-as-template reads and maps like an import, but writes NOTHING to the workspace
    if (run.options.target === 'TEMPLATE') return this.driveTemplate(job, run, selection, adapter);

    const resolved = await this.mapping.resolveForRun(job);
    if (!resolved) throw new ImportFailure('The import was never previewed with a structure to map. Preview it again.');

    const tracker = new ProgressTracker(job.progress);
    const cp = readCheckpoint(job.checkpoint);
    let { phase, cursor, pages, retries } = cp;
    void retries;
    let pagesThisRun = 0;

    // resumed / handed back while the files were being copied: the pages are done, go straight back to the copy job
    if (phase === 'FILES') return this.startFiles(job, { phase, cursor, pages, retries: 0 });

    while (phase === 'PAGES') {
      if (await this.shouldStop(job.id)) return;
      if (pagesThisRun >= MAX_PAGES_PER_RUN) return this.handBack(job, { phase, cursor, pages, retries: 0 });

      const accessToken = await this.credentials.getAccessToken(job.connectionId);
      const fetched = await adapter.fetchBundle({
        ctx: { connectionId: job.connectionId, externalAccountId: job.connection.externalAccountId, accessToken },
        selection,
        options: run.options,
        cursor,
      });
      const v = validateBundle(fetched.bundle);
      if ('fatal' in v) {
        await this.issues.record(job.id, v.issues as NewImportIssue[]);
        throw new ImportFailure(`The provider's data could not be used (${v.fatal.code}): ${v.fatal.message}`);
      }
      const mapped = applyMapping(v.bundle, resolved);
      const toWrite = mapped.tasks.length;
      if (toWrite > 0 && !(await this.planLimits.checkLimit('importItems', 'runImport', { accountId: run.accountId }, { additional: toWrite }))) {
        throw new PlanLimitExceededException("This month's import allowance is used up");
      }

      const pc: PageContext = { job: run, tracker, issues: [...(v.issues as NewImportIssue[]), ...(mapped.issues as NewImportIssue[])] };
      tracker.phase = 'writing';
      await this.writer.writeStructure(pc, mapped);
      await this.writer.writeTasks(pc, mapped);
      await this.writer.writeDependencies(pc, mapped);
      tracker.phase = 'comments and history';
      await this.content.writeComments(pc, mapped); // diagram 04, P6
      await this.content.writeHistory(pc, mapped); // diagram 04, P7
      await this.issues.record(job.id, await this.firstTimeOnly(job.id, pc.issues));

      pages += 1;
      pagesThisRun += 1;
      cursor = fetched.next;
      phase = fetched.next === null ? 'LINKS' : 'PAGES';
      if (!(await this.persist(job.id, tracker, { phase, cursor, pages, retries: 0 }))) return; // canceled while writing
      await this.push(job.id);
    }

    if (phase === 'LINKS') {
      // LINKS: parents / dependencies whose other end arrived later
      tracker.phase = 'linking';
      const pc: PageContext = { job: run, tracker, issues: [] };
      await this.writer.resolvePendingLinks(pc, () => this.shouldStop(job.id));
      await this.issues.record(job.id, await this.firstTimeOnly(job.id, pc.issues));
      if (await this.shouldStop(job.id)) return;
    }

    // FILES (diagram 04 P8, diagram 05 "Attachment copy (separate queue)"): the files queued with their tasks are copied by the
    // `import-files` queue; the job stays RUNNING until that is drained, then finishes from there.
    if (run.options.attachments && (await this.prisma.importFileItem.count({ where: { importJobId: job.id, status: 'PENDING' } })) > 0) {
      return this.startFiles(job, { phase: 'FILES', cursor: null, pages, retries: 0 });
    }
    await this.finish(job, tracker);
  }

  /** RUNNING stays RUNNING; the checkpoint says "files" and the copy job is queued in the same transaction (no queue, no state change). */
  private async startFiles(job: LoadedJob, cp: RunCheckpoint): Promise<void> {
    await this.prisma.$transaction(
      async (tx) => {
        const { count } = await tx.importJob.updateMany({ where: { id: job.id, status: S.RUNNING }, data: { checkpoint: cp as unknown as Prisma.InputJsonValue } });
        if (count !== 1) return; // canceled meanwhile
        await this.queue.enqueue(QUEUES.IMPORT_FILES.name, 'imports.copy-files', { importJobId: job.id, attempt: job.attempt }, { jobId: `import-files-${job.id}-${job.attempt}` });
      },
      { timeout: TX_TIMEOUT_MS },
    );
  }

  // ------------------------------------------------------------------------------------------------ template (step 4.9)

  private async driveTemplate(job: LoadedJob, run: RunJob, selection: ImportSelection, adapter: ImportCapableAdapter): Promise<void> {
    const tracker = new ProgressTracker(job.progress);
    tracker.phase = 'building the template';
    const out = await this.templateRunner.run({
      job: { id: job.id, accountId: run.accountId, createdById: run.createdById, inventory: job.inventory, mappingConfig: job.mappingConfig },
      adapter,
      selection,
      options: run.options,
      ctx: (accessToken) => ({ connectionId: job.connectionId, externalAccountId: job.connection.externalAccountId, accessToken }),
      accessToken: () => this.credentials.getAccessToken(job.connectionId),
      shouldStop: () => this.shouldStop(job.id),
    });
    if (out === 'STOPPED') return;
    tracker.add('task', 'created', out.tasks);
    tracker.phase = null;
    const sev = await this.issues.countBySeverity(job.id);
    const status = out.warnings || sev.WARN + sev.ERROR > 0 ? S.COMPLETED_WITH_WARNINGS : S.COMPLETED;
    const done = await this.cas(job.id, [S.RUNNING], status, {
      finishedAt: new Date(),
      pauseReason: null,
      checkpoint: Prisma.DbNull,
      progress: tracker.snapshot() as unknown as Prisma.InputJsonValue,
      result: out.result as Prisma.InputJsonValue,
    });
    if (!done) return; // canceled in the last moment: the cancel wins (the template, if made, stays: it is a normal private template)
    await this.domain.recordJobSummary({
      actorId: job.createdById,
      accountId: job.workspace.accountId,
      action: AuditAction.IMPORT_COMPLETED,
      metadata: { importJobId: job.id, connectionId: job.connectionId, workspaceId: job.workspaceId, status, target: 'TEMPLATE', templateId: out.result.templateId as string },
    });
    await this.push(job.id);
  }

  // ------------------------------------------------------------------------------------------------ files

  /** Handler of `imports.copy-files` (queue `import-files`). Acts only for the job's CURRENT attempt while it is RUNNING. */
  async runFiles(payload: { importJobId: string; attempt: number }): Promise<'DONE' | 'STALE'> {
    const job = await this.load(payload.importJobId);
    if (!job || job.attempt !== payload.attempt || job.status !== S.RUNNING) return 'STALE';
    try {
      await this.driveFiles(job);
    } catch (e) {
      await this.onError(job, e);
    }
    return 'DONE';
  }

  private async driveFiles(job: LoadedJob): Promise<void> {
    const run: RunJob = { id: job.id, connectionId: job.connectionId, workspaceId: job.workspaceId, accountId: job.workspace.accountId, createdById: job.createdById, options: job.options as unknown as ImportOptions };
    const adapter = this.registry.get(job.connection.provider);
    if (!isImportCapable(adapter)) throw new ImportFailure(`${job.connection.provider} cannot be used to import.`);
    const cp = readCheckpoint(job.checkpoint);
    const tracker = new ProgressTracker(job.progress);
    tracker.phase = 'copying files';
    const limits = await this.attachments.importLimits(run.accountId);
    let handled = 0;

    for (;;) {
      if (await this.shouldStop(job.id)) return;
      if (handled >= MAX_FILES_PER_RUN) return this.handBack(job, { ...cp, phase: 'FILES', retries: 0 });
      const items = await this.prisma.importFileItem.findMany({ where: { importJobId: job.id, status: 'PENDING' }, orderBy: { id: 'asc' }, take: 10 });
      if (items.length === 0) break;
      for (const item of items) {
        if (await this.shouldStop(job.id)) return;
        // a fresh token per file: a long copy can outlive one (CredentialService refreshes under lock when near expiry)
        const accessToken = await this.credentials.getAccessToken(job.connectionId);
        const outcome = await this.copier.copyOne(
          { importJobId: job.id, connectionId: job.connectionId, accountId: run.accountId, workspaceId: run.workspaceId, createdById: run.createdById, keepDates: run.options.keepDates, adapter, adapterCtx: { connectionId: job.connectionId, externalAccountId: job.connection.externalAccountId, accessToken }, limits },
          item,
        );
        if (outcome === 'STOPPED') return;
        handled += 1;
      }
      if (!(await this.syncFileCounts(job.id, tracker))) return;
      await this.push(job.id);
    }

    if (!(await this.syncFileCounts(job.id, tracker))) return;
    if (await this.shouldStop(job.id)) return;
    await this.finish(job, tracker);
  }

  /** The attachment counters are DERIVED from the item rows (never incremented), so a replay cannot double them. */
  private async syncFileCounts(jobId: string, tracker: ProgressTracker): Promise<boolean> {
    const groups = await this.prisma.importFileItem.groupBy({ by: ['status'], where: { importJobId: jobId }, _count: { _all: true } });
    const n = (s: string) => groups.find((g) => g.status === s)?._count._all ?? 0;
    tracker.set('attachment', 'created', n('DONE'));
    tracker.set('attachment', 'skipped', n('SKIPPED'));
    tracker.set('attachment', 'failed', n('FAILED'));
    const { count } = await this.prisma.importJob.updateMany({ where: { id: jobId, status: S.RUNNING }, data: { progress: tracker.snapshot() as unknown as Prisma.InputJsonValue } });
    return count === 1;
  }

  private async finish(job: LoadedJob, tracker: ProgressTracker): Promise<void> {
    const sev = await this.issues.countBySeverity(job.id);
    const status = sev.WARN + sev.ERROR + tracker.get('task', 'failed') > 0 ? S.COMPLETED_WITH_WARNINGS : S.COMPLETED;
    tracker.phase = null;
    const done = await this.cas(job.id, [S.RUNNING], status, {
      finishedAt: new Date(),
      pauseReason: null,
      checkpoint: Prisma.DbNull,
      progress: tracker.snapshot() as unknown as Prisma.InputJsonValue,
    });
    if (!done) return; // canceled in the last moment: the cancel wins
    await this.prisma.importPendingLink.deleteMany({ where: { importJobId: job.id } });
    await this.domain.recordJobSummary({
      actorId: job.createdById,
      accountId: job.workspace.accountId,
      action: AuditAction.IMPORT_COMPLETED,
      metadata: { importJobId: job.id, connectionId: job.connectionId, workspaceId: job.workspaceId, status, counts: tracker.totals() },
    });
    await this.push(job.id);
  }

  // ------------------------------------------------------------------------------------------------ errors

  private async onError(job: LoadedJob, e: unknown): Promise<void> {
    const fresh = await this.prisma.importJob.findUnique({ where: { id: job.id }, select: { status: true, checkpoint: true } });
    if (!fresh || fresh.status !== S.RUNNING) return; // canceled / already settled: nothing to say
    const cp = readCheckpoint(fresh.checkpoint);
    const c = classifyImportError(e, cp.retries);
    this.logger.warn(`Import ${job.id}: ${c.kind} - ${(e as Error)?.message ?? e}`);

    if (c.kind === 'AUTH' || c.kind === 'PLAN_LIMIT') return this.pause(job, c.message);
    if (c.kind === 'RATE_LIMIT' || c.kind === 'TRANSIENT') {
      const retries = cp.retries + 1;
      if (retries > MAX_AUTO_RETRIES) return this.fail(job, `The import kept being interrupted (${c.message}). Resume it to try again.`);
      return this.pauseWithRetry(job, c.message, c.delayMs ?? 60_000, { ...cp, retries });
    }
    return this.fail(job, c.message);
  }

  private async pause(job: LoadedJob, reason: string): Promise<void> {
    if (await this.cas(job.id, [S.RUNNING], S.PAUSED, { pauseReason: reason })) await this.push(job.id);
  }

  /** PAUSED + a delayed queue job of the next attempt. If the queue refuses, the status flip rolls back into a plain pause. */
  private async pauseWithRetry(job: LoadedJob, reason: string, delayMs: number, cp: RunCheckpoint): Promise<void> {
    try {
      await this.prisma.$transaction(
        async (tx) => {
          if (!(await this.cas(job.id, [S.RUNNING], S.PAUSED, { pauseReason: reason, attempt: { increment: 1 }, checkpoint: cp as unknown as Prisma.InputJsonValue }, tx))) return;
          const { attempt } = await tx.importJob.findUniqueOrThrow({ where: { id: job.id }, select: { attempt: true } });
          await this.queue.enqueue(QUEUES.IMPORTS.name, 'imports.run', { importJobId: job.id, attempt }, { jobId: `import-run-${job.id}-${attempt}`, delayMs });
        },
        { timeout: TX_TIMEOUT_MS },
      );
    } catch (e) {
      this.logger.warn(`Import ${job.id}: could not schedule the automatic retry (${(e as Error).message}); left paused`);
      await this.pause(job, `${reason} (automatic retry could not be scheduled; resume it manually)`);
      return;
    }
    await this.push(job.id);
  }

  private async fail(job: LoadedJob, reason: string): Promise<void> {
    await this.issues.record(job.id, [{ severity: Sev.ERROR, code: 'IMPORT_FAILED', message: reason }]);
    if (await this.cas(job.id, [S.RUNNING], S.FAILED, { finishedAt: new Date(), pauseReason: reason })) await this.push(job.id);
  }

  private async handBack(job: LoadedJob, cp: RunCheckpoint): Promise<void> {
    await this.prisma.$transaction(
      async (tx) => {
        if (!(await this.cas(job.id, [S.RUNNING], S.QUEUED, { attempt: { increment: 1 }, checkpoint: cp as unknown as Prisma.InputJsonValue }, tx))) return;
        const { attempt } = await tx.importJob.findUniqueOrThrow({ where: { id: job.id }, select: { attempt: true } });
        await this.queue.enqueue(QUEUES.IMPORTS.name, 'imports.run', { importJobId: job.id, attempt }, { jobId: `import-run-${job.id}-${attempt}` });
      },
      { timeout: TX_TIMEOUT_MS },
    );
  }

  // ------------------------------------------------------------------------------------------------ plumbing

  private async load(id: string): Promise<LoadedJob | null> {
    return this.prisma.importJob.findUnique({
      where: { id },
      include: { connection: { select: { provider: true, status: true, externalAccountId: true } }, workspace: { select: { accountId: true } } },
    }) as Promise<LoadedJob | null>;
  }

  /**
   * Some findings are about a PERSON or a VALUE, not a page: "Eve is not matched", "priority X is unknown". The mapping reports
   * them once per page; across a hundred pages that is a hundred identical lines. Keep the first, drop repeats; the check
   * is against the stored issues, so it also holds across a resume.
   */
  private async firstTimeOnly(jobId: string, list: NewImportIssue[]): Promise<NewImportIssue[]> {
    const once = list.filter((i) => ONCE_PER_JOB.has(i.code) && i.externalRef);
    if (once.length === 0) return list;
    const seen = await this.prisma.importJobIssue.findMany({
      where: { importJobId: jobId, code: { in: [...ONCE_PER_JOB] }, externalRef: { in: once.map((i) => i.externalRef as string) } },
      select: { code: true, externalRef: true },
    });
    const have = new Set(seen.map((i) => `${i.code}|${i.externalRef}`));
    const batch = new Set<string>();
    return list.filter((i) => {
      if (!ONCE_PER_JOB.has(i.code) || !i.externalRef) return true;
      const k = `${i.code}|${i.externalRef}`;
      if (have.has(k) || batch.has(k)) return false;
      batch.add(k);
      return true;
    });
  }

  private async shouldStop(id: string): Promise<boolean> {
    const row = await this.prisma.importJob.findUnique({ where: { id }, select: { status: true } });
    return !row || row.status !== S.RUNNING;
  }

  /** Progress + checkpoint, only while still RUNNING. false = it was canceled (or settled) meanwhile. */
  private async persist(id: string, tracker: ProgressTracker, cp: RunCheckpoint): Promise<boolean> {
    const { count } = await this.prisma.importJob.updateMany({
      where: { id, status: S.RUNNING },
      data: { progress: tracker.snapshot() as unknown as Prisma.InputJsonValue, checkpoint: cp as unknown as Prisma.InputJsonValue },
    });
    return count === 1;
  }

  private async cas(id: string, from: S[], to: S, data: Prisma.ImportJobUpdateManyMutationInput = {}, db: Prisma.TransactionClient | PrismaService = this.prisma): Promise<boolean> {
    const { count } = await db.importJob.updateMany({ where: { id, status: { in: from } }, data: { ...data, status: to } });
    return count === 1;
  }

  private async push(id: string): Promise<void> {
    const j = await this.prisma.importJob.findUnique({ where: { id }, select: { createdById: true, status: true, progress: true, pauseReason: true } });
    if (j) await this.publisher.publish(j.createdById, { importJobId: id, status: j.status, progress: j.progress as never, pauseReason: j.pauseReason });
  }
}

export function readCheckpoint(raw: unknown): RunCheckpoint {
  const c = (raw && typeof raw === 'object' ? raw : {}) as Partial<RunCheckpoint>;
  return {
    phase: c.phase === 'LINKS' ? 'LINKS' : c.phase === 'FILES' ? 'FILES' : 'PAGES',
    cursor: c.cursor === undefined ? null : c.cursor,
    pages: typeof c.pages === 'number' ? c.pages : 0,
    retries: typeof c.retries === 'number' && c.retries >= 0 ? c.retries : 0,
  };
}
