import { Injectable } from '@nestjs/common';
import { ActivityAction, ActivityTargetType, ActivityVisibility, CommentableType, CreationMode, ImportIssueSeverity as Sev, Prisma } from '@prisma/client';
import { newEntityId } from '../../domain-writer/entity-id';
import { WriteContext } from '../../domain-writer/write-context';
import { ActivityService, RecordActivityParams } from '../../events/activity.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ExternalRefService, NewExternalRef } from '../external-ref.service';
import { MappedComment, MappedHistoryEntry, MappedPage, MappedTask } from '../mapping';
import { classifyImportError, unwrap } from './import-errors';
import { ProgressTracker } from './import-progress';
import { PageContext, REF, RunJob } from './import-writer';

/** Rows one transaction may carry (comments / activity rows). A task has at most 1000 comments / 2000 history entries. */
const COMMENT_BATCH = 500;
const HISTORY_BATCH = 2000;

type Author = MappedComment['author'];

/**
 * Step 4.6 (diagram 04, phases P6 comments and P7 history). Writes the comments and the activity history of the tasks of ONE
 * page, after the page's tasks exist. Same rules as ImportWriter: no state between calls, every row committed in the same
 * transaction as its ExternalRef, a re-run finds the refs and skips.
 *
 *  - Comments: written straight to `comments` (they carry no business rule an import must keep: no permission check, no
 *    notification, no mention fan-out, no COMMENTED activity - the comment IS the record). Author = the mapped member, or the
 *    importer (the real name is already in the text, see mapComment). One level of replies, resolved through refs.
 *  - History: one `IMPORTED_CHANGE` activity per field change, visibility IMPORTED (never in the workspace feed), original
 *    timestamp when the job keeps dates, silent (nothing is emitted). One ref per TASK marks its history as done, so a replay
 *    never doubles it.
 */
@Injectable()
export class ImportContentWriter {
  constructor(
    private readonly prisma: PrismaService,
    private readonly refs: ExternalRefService,
    private readonly activity: ActivityService,
  ) {}

  private ctx(job: RunJob, tx: Prisma.TransactionClient): WriteContext {
    return { origin: CreationMode.IMPORT, actorId: job.createdById, silent: true, importJobId: job.id, keepOriginalDates: job.options.keepDates, tx };
  }

  private authorId(job: RunJob, a: Author | null): string {
    return a && a.kind === 'user' ? a.userId : job.createdById;
  }

  /** Counters + job row in ONE transaction with the rows (same discipline as the task chunk). */
  private async commit(pc: PageContext, tx: Prisma.TransactionClient, bump: (t: ProgressTracker) => void): Promise<void> {
    const before = pc.tracker.snapshot();
    bump(pc.tracker);
    try {
      await tx.importJob.update({ where: { id: pc.job.id }, data: { progress: pc.tracker.snapshot() as unknown as Prisma.InputJsonValue } });
    } catch (e) {
      Object.assign(pc.tracker, new ProgressTracker(before));
      throw e;
    }
  }

  private async resetTracker(pc: PageContext): Promise<void> {
    const fresh = await this.prisma.importJob.findUnique({ where: { id: pc.job.id }, select: { progress: true } });
    Object.assign(pc.tracker, new ProgressTracker(fresh?.progress));
  }

  private async taskIds(pc: PageContext, tasks: MappedTask[]): Promise<Map<string, string>> {
    const found = await this.refs.lookup(pc.job.connectionId, REF.task, tasks.map((t) => t.externalId));
    return new Map([...found].map(([ext, r]) => [ext, r.localId]));
  }

  // ================================================================================================ comments

  async writeComments(pc: PageContext, page: MappedPage): Promise<void> {
    const { job } = pc;
    if (!job.options.comments) return;
    const withComments = page.tasks.filter((t) => t.comments.length > 0);
    if (withComments.length === 0) return;
    const taskIds = await this.taskIds(pc, withComments);

    const all = withComments.flatMap((t) => (taskIds.has(t.externalId) ? t.comments.map((c) => ({ task: taskIds.get(t.externalId) as string, c })) : []));
    const have = await this.refs.lookup(job.connectionId, REF.comment, all.map((x) => x.c.externalId));
    const todo = all.filter((x) => !have.has(x.c.externalId));
    for (const x of all) if (have.has(x.c.externalId) && have.get(x.c.externalId)?.importJobId !== job.id) pc.tracker.add('comment', 'skipped');

    for (let i = 0; i < todo.length; i += COMMENT_BATCH) await this.commentBatch(pc, todo.slice(i, i + COMMENT_BATCH));
  }

  private async commentBatch(pc: PageContext, batch: Array<{ task: string; c: MappedComment }>): Promise<void> {
    try {
      await this.insertComments(pc, batch);
    } catch (e) {
      await this.resetTracker(pc);
      if (classifyImportError(e).kind !== 'ITEM') throw e;
      // one refused comment must not cost its neighbours: retry one by one, report the culprit
      for (const one of batch) {
        try {
          await this.insertComments(pc, [one]);
        } catch (e2) {
          await this.resetTracker(pc);
          if (classifyImportError(e2).kind !== 'ITEM') throw e2;
          pc.issues.push({ severity: Sev.WARN, code: 'COMMENT_REJECTED', externalRef: `comment:${one.c.externalId}`, message: `A comment could not be created: ${(unwrap(e2) as Error).message}` });
          pc.tracker.add('comment', 'failed');
        }
      }
    }
  }

  private async insertComments(pc: PageContext, batch: Array<{ task: string; c: MappedComment }>): Promise<void> {
    const { job } = pc;
    await this.prisma.$transaction(
      async (tx) => {
        const ids = new Map(batch.map((x) => [x.c.externalId, newEntityId()]));
        // a reply whose root is NOT in this batch (an earlier batch, an earlier run) is found through its ref
        const outside = batch.map((x) => x.c.parentExternalId).filter((p): p is string => !!p && !ids.has(p));
        const parents = await this.refs.lookup(job.connectionId, REF.comment, outside, tx);
        const parentOf = (x: { c: MappedComment }): string | null => {
          const p = x.c.parentExternalId;
          if (!p) return null;
          return ids.get(p) ?? parents.get(p)?.localId ?? null;
        };
        const dates = (c: MappedComment) =>
          job.options.keepDates && c.createdAt
            ? { createdAt: new Date(c.createdAt), updatedAt: new Date(c.editedAt ?? c.createdAt), ...(c.editedAt ? { editedAt: new Date(c.editedAt) } : {}) }
            : {};
        const row = (x: { task: string; c: MappedComment }, parent: string | null): Prisma.CommentUncheckedCreateInput => ({
          id: ids.get(x.c.externalId) as string,
          targetType: CommentableType.TASK,
          targetId: x.task,
          authorId: this.authorId(job, x.c.author),
          content: x.c.body,
          parentCommentId: parent,
          ...dates(x.c),
        });
        // roots first (a reply references an id that must exist), then replies
        const parentIdOf = new Map(batch.map((x) => [x.c.externalId, parentOf(x)]));
        const roots = batch.filter((x) => parentIdOf.get(x.c.externalId) === null);
        const replies = batch.filter((x) => parentIdOf.get(x.c.externalId) !== null);
        for (const x of replies) if (x.c.parentExternalId && parentIdOf.get(x.c.externalId) === null) pc.issues.push({ severity: Sev.INFO, code: 'COMMENT_PARENT_MISSING', externalRef: `comment:${x.c.externalId}`, message: 'The comment it replies to was not imported; it was added as a top-level comment' });
        if (roots.length) await tx.comment.createMany({ data: roots.map((x) => row(x, null)) });
        if (replies.length) await tx.comment.createMany({ data: replies.map((x) => row(x, parentIdOf.get(x.c.externalId) as string)) });
        await this.refs.upsertMany(
          job.connectionId,
          job.id,
          batch.map<NewExternalRef>((x) => ({ externalType: REF.comment, externalId: x.c.externalId, localType: 'comment', localId: ids.get(x.c.externalId) as string })),
          tx,
        );
        await this.commit(pc, tx, (t) => t.add('comment', 'created', batch.length));
      },
      { timeout: 30_000 },
    );
  }

  // ================================================================================================ history

  async writeHistory(pc: PageContext, page: MappedPage): Promise<void> {
    const { job } = pc;
    if (!job.options.history) return;
    const withHistory = page.tasks.filter((t) => t.history.length > 0);
    if (withHistory.length === 0) return;
    const taskIds = await this.taskIds(pc, withHistory);
    const done = await this.refs.lookup(job.connectionId, REF.history, withHistory.map((t) => t.externalId));
    const todo = withHistory.filter((t) => taskIds.has(t.externalId) && !done.has(t.externalId));
    for (const t of withHistory) if (done.has(t.externalId) && done.get(t.externalId)?.importJobId !== job.id) pc.tracker.add('history', 'skipped', t.history.length);

    // whole tasks per transaction, up to HISTORY_BATCH rows
    let group: MappedTask[] = [];
    let rows = 0;
    const flush = async () => {
      if (group.length) await this.historyBatch(pc, group, taskIds);
      group = [];
      rows = 0;
    };
    for (const t of todo) {
      if (rows + t.history.length > HISTORY_BATCH) await flush();
      group.push(t);
      rows += t.history.length;
    }
    await flush();
  }

  private async historyBatch(pc: PageContext, group: MappedTask[], taskIds: Map<string, string>): Promise<void> {
    const { job } = pc;
    try {
      await this.prisma.$transaction(
        async (tx) => {
          const params: RecordActivityParams[] = group.flatMap((t) => t.history.map((h) => this.activityRow(job, taskIds.get(t.externalId) as string, h, t)));
          await this.activity.recordMany(params, this.ctx(job, tx));
          await this.refs.upsertMany(
            job.connectionId,
            job.id,
            group.map((t) => ({ externalType: REF.history, externalId: t.externalId, localType: 'history', localId: taskIds.get(t.externalId) as string })),
            tx,
          );
          await this.commit(pc, tx, (t) => t.add('history', 'created', params.length));
        },
        { timeout: 30_000 },
      );
    } catch (e) {
      await this.resetTracker(pc);
      if (classifyImportError(e).kind !== 'ITEM') throw e;
      for (const t of group) {
        pc.issues.push({ severity: Sev.WARN, code: 'HISTORY_REJECTED', externalRef: `task:${t.externalId}`, message: `Its history could not be copied: ${(unwrap(e) as Error).message}` });
        pc.tracker.add('history', 'failed', t.history.length);
      }
    }
  }

  /** The workspace id is needed per row: it is read once per batch from the task. */
  private activityRow(job: RunJob, taskId: string, h: MappedHistoryEntry, task: MappedTask): RecordActivityParams {
    const actor: Record<string, string> = {};
    if (h.actor?.kind === 'importer') actor.name = h.actor.label;
    return {
      actorId: this.authorId(job, h.actor),
      action: ActivityAction.IMPORTED_CHANGE,
      targetType: ActivityTargetType.TASK,
      targetId: taskId,
      workspaceId: job.workspaceId,
      visibility: ActivityVisibility.IMPORTED,
      createdAt: new Date(h.at),
      metadata: {
        externalId: h.externalId,
        at: h.at,
        field: h.field,
        ...(h.from !== undefined ? { from: h.from } : {}),
        ...(h.to !== undefined ? { to: h.to } : {}),
        ...(Object.keys(actor).length ? { actor } : {}),
        taskKey: task.key ?? null,
      },
    };
  }
}
