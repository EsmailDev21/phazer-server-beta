import { Injectable, Logger } from '@nestjs/common';
import { AuditAction, ImportIssueSeverity as Sev, ImportJob, ImportJobStatus as S, Prisma } from '@prisma/client';
import { AttachmentsService } from '../../attachments/attachments.service';
import { DomainEraser } from '../../domain-writer/domain-eraser.service';
import { DomainWriter } from '../../domain-writer/domain-writer.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ExternalRefService } from '../external-ref.service';
import { ImportIssueService, NewImportIssue } from '../import-issue.service';
import { ImportUsageService } from '../import-usage.service';
import { ImportProgressPublisher, ProgressTracker } from './import-progress';
import { REF, REUSED } from './import-writer';

const BATCH = 200;
const MAX_ROUNDS = 6;
const MAX_KEPT_ISSUES = 200;

type LoadedJob = ImportJob & { workspace: { accountId: string } };

/**
 * Step 4.4. Undoes an import: deletes exactly the rows THIS job created (found through ExternalRef by `importJobId`), in
 * dependency order, and nothing else. Runs in the worker on `imports.rollback`; idempotent and resumable (every step deletes
 * the refs it has handled, so a retry continues where it stopped).
 *
 * The rule that makes it safe to press: **rollback never deletes anything a person added afterwards.**
 *  - a task that gained a subtask, a project that gained a task, a field that gained a value, a type / iteration still used by
 *    another task, a tag still attached elsewhere: KEPT (reported as ROLLBACK_KEPT), its reference released;
 *  - rows the import only MATCHED (`:reused` refs: an existing issue type or tag) are never touched;
 *  - rows created by an EARLIER import of the same source belong to that import (the ref keeps its first owner).
 * What remains is a normal row with no import record; nothing dangles.
 */
@Injectable()
export class ImportRollback {
  private readonly logger = new Logger(ImportRollback.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly refs: ExternalRefService,
    private readonly eraser: DomainEraser,
    private readonly domain: DomainWriter,
    private readonly usage: ImportUsageService,
    private readonly issues: ImportIssueService,
    private readonly publisher: ImportProgressPublisher,
    private readonly attachments: AttachmentsService,
  ) {}

  async run(payload: { importJobId: string }): Promise<'DONE' | 'STALE'> {
    const job = (await this.prisma.importJob.findUnique({ where: { id: payload.importJobId }, include: { workspace: { select: { accountId: true } } } })) as LoadedJob | null;
    if (!job || job.status !== S.ROLLING_BACK) return 'STALE';
    const kept: NewImportIssue[] = [];
    const note = (type: string, localId: string, why: string) => {
      if (kept.length < MAX_KEPT_ISSUES) kept.push({ severity: Sev.INFO, code: 'ROLLBACK_KEPT', externalRef: `${type}:${localId}`, message: `Kept: ${why}` });
    };
    const progress = new ProgressTracker(job.progress);

    // step 4.6: what hangs off the tasks goes first, so the tasks' "has somebody added something?" check sees only people's work
    await this.rollbackAttachments(job, note);
    await this.rollbackComments(job, note);
    await this.rollbackHistory(job);
    await this.rollbackTasks(job, note);
    await this.rollbackProjects(job, note);
    await this.rollbackCustomFields(job, note);
    await this.rollbackIssueTypes(job, note);
    await this.rollbackIterations(job, note);
    await this.rollbackTags(job, note);
    await this.prisma.importPendingLink.deleteMany({ where: { importJobId: job.id } });
    await this.prisma.externalRef.deleteMany({ where: { importJobId: job.id } }); // whatever is left (statuses, reused refs): released
    await this.issues.record(job.id, kept);

    // refund + finish in ONE transaction: a retry after a crash must never refund twice
    const charged = progress.chargedByPeriod();
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.importJob.updateMany({
        where: { id: job.id, status: S.ROLLING_BACK },
        data: {
          status: S.ROLLED_BACK,
          finishedAt: new Date(),
          pauseReason: null,
          checkpoint: Prisma.DbNull,
          progress: { phase: null, counts: {}, chargedByPeriod: {}, updatedAt: new Date().toISOString() } as unknown as Prisma.InputJsonValue,
        },
      });
      if (count === 1) await this.usage.refund(job.workspace.accountId, charged, tx);
    });
    await this.domain.recordJobSummary({
      actorId: job.createdById,
      accountId: job.workspace.accountId,
      action: AuditAction.IMPORT_ROLLED_BACK,
      metadata: { importJobId: job.id, connectionId: job.connectionId, workspaceId: job.workspaceId, kept: kept.length },
    });
    const fresh = await this.prisma.importJob.findUnique({ where: { id: job.id }, select: { status: true, progress: true, pauseReason: true } });
    if (fresh) await this.publisher.publish(job.createdById, { importJobId: job.id, status: fresh.status, progress: fresh.progress as never, pauseReason: fresh.pauseReason });
    return 'DONE';
  }

  // ------------------------------------------------------------------------------------------------ steps

  /** Tasks, leaves first: each round deletes tasks with no subtasks, which frees their parents for the next round. */
  private async rollbackTasks(job: LoadedJob, note: (t: string, id: string, why: string) => void): Promise<void> {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      let after: string | undefined;
      let deletedThisRound = 0;
      for (;;) {
        const page = await this.refs.pageByJob(job.id, { localType: REF.task, afterId: after, take: BATCH });
        if (page.length === 0) break;
        after = page[page.length - 1].id;
        const protectedIds = await this.tasksWithPeoplesContent(page.map((r) => r.localId));
        const deleted = await this.prisma.$transaction((tx) => this.eraser.deleteLeafTasks(tx, page.map((r) => r.localId).filter((id) => !protectedIds.has(id))));
        if (deleted.length) {
          deletedThisRound += deleted.length;
          const gone = new Set(deleted);
          await this.prisma.externalRef.deleteMany({ where: { id: { in: page.filter((r) => gone.has(r.localId)).map((r) => r.id) } } });
        }
      }
      if (deletedThisRound === 0) break;
    }
    // whatever remains has a subtask somebody added (or is gone already): release the reference, say why
    const leftover = await this.prisma.externalRef.findMany({ where: { importJobId: job.id, localType: REF.task }, select: { id: true, localId: true } });
    if (leftover.length) {
      const stillThere = new Set((await this.prisma.task.findMany({ where: { id: { in: leftover.map((r) => r.localId) } }, select: { id: true } })).map((t) => t.id));
      const mine = await this.tasksWithPeoplesContent(leftover.map((r) => r.localId));
      for (const r of leftover) if (stillThere.has(r.localId)) note('task', r.localId, mine.has(r.localId) ? 'comments or files were added to it after the import' : 'it has subtasks that were not imported');
      await this.prisma.externalRef.deleteMany({ where: { id: { in: leftover.map((r) => r.id) } } });
    }
  }

  // ------------------------------------------------------------------------------------------------ step 4.6

  /** Tasks (of these ids) that still carry a comment or a file after the import's own were removed: somebody added them. */
  private async tasksWithPeoplesContent(taskIds: string[]): Promise<Set<string>> {
    if (taskIds.length === 0) return new Set();
    const [c, a] = await Promise.all([
      this.prisma.comment.findMany({ where: { targetType: 'TASK', targetId: { in: taskIds } }, select: { targetId: true }, distinct: ['targetId'] }),
      this.prisma.attachment.findMany({ where: { targetType: 'TASK', targetId: { in: taskIds } }, select: { targetId: true }, distinct: ['targetId'] }),
    ]);
    return new Set([...c, ...a].map((x) => x.targetId));
  }

  /** The files this job copied: rows and (when nothing else shares them) storage objects. Idempotent: every ref is released as handled. */
  private async rollbackAttachments(job: LoadedJob, _note: (t: string, id: string, why: string) => void): Promise<void> {
    await this.eachRef(job, 'attachment', async (r) => {
      await this.attachments.deleteMany([r.localId]);
    });
    await this.prisma.importFileItem.deleteMany({ where: { importJobId: job.id } });
    // reserved-but-never-confirmed rows of this job's items died with the items above; the 24 h abandoned-upload sweep takes any stray PENDING row
  }

  /**
   * The comments this job wrote. Replies go first; a root somebody replied to afterwards is KEPT (deleting it would take their
   * reply with it): reported, its reference released, and its task then counts as holding people's content.
   */
  private async rollbackComments(job: LoadedJob, note: (t: string, id: string, why: string) => void): Promise<void> {
    const mine = async (): Promise<Array<{ id: string; localId: string }>> => {
      const out: Array<{ id: string; localId: string }> = [];
      let after: string | undefined;
      for (;;) {
        const page = await this.refs.pageByJob(job.id, { localType: 'comment', afterId: after, take: BATCH });
        if (page.length === 0) return out;
        after = page[page.length - 1].id;
        out.push(...page.map((r) => ({ id: r.id, localId: r.localId })));
      }
    };
    const refsRows = await mine();
    if (refsRows.length === 0) return;
    const ids = refsRows.map((r) => r.localId);
    for (let i = 0; i < ids.length; i += BATCH) {
      const slice = ids.slice(i, i + BATCH);
      // replies (they have a parent) first, then roots with no reply left
      await this.prisma.$transaction(async (tx) => {
        const replies = await tx.comment.findMany({ where: { id: { in: slice }, parentCommentId: { not: null } }, select: { id: true } });
        await this.deleteCommentRows(tx, replies.map((c) => c.id));
        const roots = await tx.comment.findMany({ where: { id: { in: slice }, parentCommentId: null }, select: { id: true, _count: { select: { replies: true } } } });
        const free = roots.filter((c) => c._count.replies === 0).map((c) => c.id);
        await this.deleteCommentRows(tx, free);
        for (const c of roots) if (c._count.replies > 0) note('comment', c.id, 'somebody replied to it after the import');
      });
    }
    await this.prisma.externalRef.deleteMany({ where: { id: { in: refsRows.map((r) => r.id) } } });
  }

  private async deleteCommentRows(tx: Prisma.TransactionClient, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await tx.reaction.deleteMany({ where: { targetType: 'COMMENT', targetId: { in: ids } } });
    await tx.comment.deleteMany({ where: { id: { in: ids } } });
  }

  /** History rows of tasks that survive the rollback (kept tasks): the activity this job wrote goes, whatever happens to the task. */
  private async rollbackHistory(job: LoadedJob): Promise<void> {
    await this.prisma.activity.deleteMany({ where: { visibility: 'IMPORTED', metadata: { path: ['importJobId'], equals: job.id } } });
    await this.prisma.externalRef.deleteMany({ where: { importJobId: job.id, localType: 'history' } });
  }

  private async eachRef(job: LoadedJob, localType: string, fn: (ref: { id: string; localId: string }) => Promise<void>): Promise<void> {
    let after: string | undefined;
    for (;;) {
      const page = await this.refs.pageByJob(job.id, { localType, afterId: after, take: BATCH });
      if (page.length === 0) return;
      after = page[page.length - 1].id;
      for (const r of page) await fn(r);
      await this.prisma.externalRef.deleteMany({ where: { id: { in: page.map((r) => r.id) } } });
    }
  }

  private async rollbackProjects(job: LoadedJob, note: (t: string, id: string, why: string) => void): Promise<void> {
    await this.eachRef(job, 'project', async (r) => {
      const gone = await this.prisma.$transaction((tx) => this.eraser.deleteProjectIfEmpty(tx, r.localId));
      if (!gone) note('project', r.localId, 'it now contains tasks that were not imported');
    });
  }

  private async rollbackCustomFields(job: LoadedJob, note: (t: string, id: string, why: string) => void): Promise<void> {
    await this.eachRef(job, 'customField', async (r) => {
      const gone = await this.prisma.$transaction((tx) => this.eraser.deleteCustomFieldIfUnused(tx, r.localId));
      if (!gone) note('customField', r.localId, 'tasks that were not imported have values in it');
    });
  }

  private async rollbackIssueTypes(job: LoadedJob, note: (t: string, id: string, why: string) => void): Promise<void> {
    await this.eachRef(job, 'issueType', async (r) => {
      if ((await this.prisma.task.count({ where: { issueTypeId: r.localId } })) > 0) return note('issueType', r.localId, 'tasks that were not imported use it');
      await this.prisma.issueType.deleteMany({ where: { id: r.localId } });
    });
  }

  private async rollbackIterations(job: LoadedJob, note: (t: string, id: string, why: string) => void): Promise<void> {
    await this.eachRef(job, 'iteration', async (r) => {
      if ((await this.prisma.task.count({ where: { iterationId: r.localId } })) > 0) return note('iteration', r.localId, 'tasks that were not imported are in it');
      await this.prisma.iteration.deleteMany({ where: { id: r.localId } });
    });
  }

  private async rollbackTags(job: LoadedJob, note: (t: string, id: string, why: string) => void): Promise<void> {
    await this.eachRef(job, 'tag', async (r) => {
      if ((await this.prisma.taskTag.count({ where: { tagId: r.localId } })) > 0) return note('tag', r.localId, 'it is attached to tasks that were not imported');
      await this.prisma.tag.deleteMany({ where: { id: r.localId } });
    });
  }
}

export { REUSED };
