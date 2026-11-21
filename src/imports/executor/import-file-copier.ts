import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CreationMode, ImportFileItem, ImportIssueSeverity as Sev, Prisma } from '@prisma/client';
import { DomainWriter } from '../../domain-writer/domain-writer.service';
import { AttachmentsService } from '../../attachments/attachments.service';
import { STORAGE_PROVIDER, StorageObjectTooLargeError, StorageProvider } from '../../attachments/storage/storage-provider.interface';
import { PlanLimitExceededException } from '../../common/exceptions/plan-limit-exceeded.exception';
import { ProviderHttpError } from '../../integrations/core/integration.types';
import { PrismaService } from '../../prisma/prisma.service';
import { ExternalRefService } from '../external-ref.service';
import { ImportAdapterContext, ImportCapableAdapter } from '../import-adapter';
import { ImportIssueService } from '../import-issue.service';
import { REF } from './import-writer';

/** A file whose download keeps failing is given up on (reported); the import carries on. */
export const MAX_FILE_ATTEMPTS = 3;
/** HTTP statuses that mean THIS file cannot be had (gone, forbidden, not allowed), not that the connection is broken. */
const FILE_GONE = new Set([400, 403, 404, 410, 422, 451]);

export type CopyOutcome = 'DONE' | 'SKIPPED' | 'FAILED' | 'STOPPED';

class ImportStopped extends Error {}

export interface CopyContext {
  importJobId: string;
  connectionId: string;
  accountId: string;
  workspaceId: string;
  createdById: string;
  keepDates: boolean;
  adapter: ImportCapableAdapter;
  adapterCtx: ImportAdapterContext;
  limits: { maxFileSizeBytes: number; storageBytes: number };
}

/**
 * Step 4.6 (diagram 05, lane "Attachment copy"): copies ONE file from the provider into our storage.
 *
 *   a1 the item (written with its task)  ->  a2 quota reserve: PENDING attachment row  ->  a3 stream provider -> S3 multipart
 *   (no full buffering, size capped, SHA-256 on the way)  ->  a4 confirm: CONFIRMED + ExternalRef + item DONE, in ONE transaction.
 *
 * It never decides what an error means for the JOB: auth / rate limit / transient trouble / a full storage plan are rethrown for
 * the executor to classify (pause, delayed retry). What it decides itself is what happens to THIS file: gone at the provider,
 * over the plan's per-file cap, given up after MAX_FILE_ATTEMPTS -> the item is closed, an issue is reported, the import goes on.
 *
 * Retry-safe at every step: the reserved row is remembered on the item and reused; a crash after the bytes are stored but
 * before the confirm just copies again over the same key; the confirm is one transaction.
 */
@Injectable()
export class ImportFileCopier {
  private readonly logger = new Logger(ImportFileCopier.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly attachments: AttachmentsService,
    private readonly refs: ExternalRefService,
    private readonly issues: ImportIssueService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    private readonly domain: DomainWriter,
    @Optional() private readonly config?: ConfigService,
  ) {}

  /** The address a copied file gets in text: `<prefix>/files/<id>/content` (prefix = FILES_CONTENT_URL_PREFIX, e.g. "/api"; default none). */
  contentLink(attachmentId: string): string {
    const prefix = (this.config?.get<string>('FILES_CONTENT_URL_PREFIX') ?? '').replace(/\/+$/, '');
    return `${prefix}/files/${attachmentId}/content`;
  }

  /**
   * The file now lives with us, so the link to it in the task's text (the description and the task's comments) is re-pointed at our
   * stable address instead of staying a link into the source system that dies with its subscription. Only exact occurrences of the
   * address the file was fetched from are replaced; a source whose text never contains it (ClickUp) is untouched. Runs in the
   * confirm transaction: either the file is confirmed AND its links are re-pointed, or neither.
   */
  private async repointLinks(cx: CopyContext, tx: Prisma.TransactionClient, item: ImportFileItem, attachmentId: string): Promise<void> {
    const to = this.contentLink(attachmentId);
    const ctx = { origin: CreationMode.IMPORT, actorId: cx.createdById, silent: true, importJobId: cx.importJobId, keepOriginalDates: cx.keepDates, tx, afterCommit: [] as Array<() => void> };
    await this.domain.rewriteImportedText(cx.workspaceId, item.taskId, item.providerRef, to, ctx);
    const comments = await tx.comment.findMany({ where: { targetType: 'TASK', targetId: item.taskId, content: { contains: item.providerRef } }, select: { id: true, content: true, updatedAt: true }, take: 1000 });
    for (const c of comments) await tx.comment.update({ where: { id: c.id }, data: { content: c.content.split(item.providerRef).join(to), updatedAt: c.updatedAt } });
  }

  async copyOne(cx: CopyContext, item: ImportFileItem): Promise<CopyOutcome> {
    const ref = `attachment:${item.externalId}`;
    const refKey = `${item.taskId}:${item.externalId}`;

    // a crash after the confirm but before the item was closed: just close it
    let row = item.attachmentId ? await this.prisma.attachment.findUnique({ where: { id: item.attachmentId } }) : null;
    if (row?.status === 'CONFIRMED') {
      await this.close(item.id, 'DONE', null);
      return 'DONE';
    }
    // already imported by an earlier job of the same source (a re-run): nothing to copy
    const known = await this.refs.lookup(cx.connectionId, REF.attachment, [refKey]);
    if (known.has(refKey)) {
      await this.close(item.id, 'SKIPPED', 'already imported');
      return 'SKIPPED';
    }

    // ---- open the download
    let fetched;
    try {
      if (!cx.adapter.fetchAttachment) throw new ProviderHttpError(404, 'adapter', 'This provider cannot copy files');
      fetched = await cx.adapter.fetchAttachment({ ctx: cx.adapterCtx, providerRef: item.providerRef });
    } catch (e) {
      return this.afterDownloadError(cx, item, ref, e);
    }

    const declared = fetched.sizeBytes ?? item.sizeBytes ?? undefined;
    if (declared !== undefined && declared > cx.limits.maxFileSizeBytes) {
      fetched.stream.destroy();
      return this.giveUp(cx, item, 'SKIPPED', Sev.WARN, 'ATTACHMENT_TOO_LARGE', ref, `"${item.fileName}" is larger than this plan's per-file limit (${mb(cx.limits.maxFileSizeBytes)} MB) and was not copied`);
    }
    const mimeType = cleanMime(fetched.mimeType ?? item.mimeType);

    // ---- reserve quota (before the first byte is stored)
    try {
      if (!row) {
        row = await this.attachments.reserveForImport({
          accountId: cx.accountId,
          taskId: item.taskId,
          uploadedById: item.uploadedById,
          filename: item.fileName,
          mimeType,
          sizeBytes: declared ?? 1, // unknown size: a placeholder, verified against the plan once the real size is known
        });
        await this.prisma.importFileItem.update({ where: { id: item.id }, data: { attachmentId: row.id } });
      }
    } catch (e) {
      fetched.stream.destroy();
      throw e; // PlanLimitExceededException -> the executor pauses the import (diagram 05: "quota exceeded -> PAUSED")
    }

    // ---- stream it into storage
    let stored;
    try {
      stored = await this.storage.putObjectStream(row.storageKey, fetched.stream, { mimeType, maxBytes: cx.limits.maxFileSizeBytes });
    } catch (e) {
      fetched.stream.destroy();
      if (e instanceof StorageObjectTooLargeError) {
        await this.attachments.deleteMany([row.id]);
        await this.prisma.importFileItem.update({ where: { id: item.id }, data: { attachmentId: null } });
        return this.giveUp(cx, item, 'SKIPPED', Sev.WARN, 'ATTACHMENT_TOO_LARGE', ref, `"${item.fileName}" is larger than this plan's per-file limit (${mb(cx.limits.maxFileSizeBytes)} MB) and was not copied`);
      }
      return this.afterDownloadError(cx, item, ref, e);
    }

    if (declared === undefined && !(await this.attachments.hasRoomFor(cx.accountId, Math.max(stored.sizeBytes - 1, 0)))) {
      await this.attachments.deleteMany([row.id]);
      await this.prisma.importFileItem.update({ where: { id: item.id }, data: { attachmentId: null } });
      throw new PlanLimitExceededException('The files of this import would exceed the storage limit for this plan');
    }

    // ---- confirm (one transaction: row, ExternalRef, item)
    let result;
    try {
      result = await this.attachments.finalizeImported(
        row.id,
        { sizeBytes: stored.sizeBytes, sha256: stored.sha256, mimeType, ...(cx.keepDates && item.sourceCreatedAt ? { createdAt: item.sourceCreatedAt } : {}) },
        async (tx, att) => {
          const job = await tx.importJob.findUnique({ where: { id: cx.importJobId }, select: { status: true } });
          if (!job || job.status !== 'RUNNING') throw new ImportStopped(); // canceled meanwhile: nothing is confirmed, no ref is left behind
          await this.refs.upsertMany(cx.connectionId, cx.importJobId, [{ externalType: REF.attachment, externalId: refKey, localType: 'attachment', localId: att.id }], tx);
          await this.repointLinks(cx, tx, item, att.id);
          await tx.importFileItem.update({ where: { id: item.id }, data: { status: 'DONE', note: null } });
        },
      );
    } catch (e) {
      if (e instanceof ImportStopped) return 'STOPPED';
      throw e;
    }
    if (result.redundantKey) await this.attachments.releaseObject(result.redundantKey);
    return 'DONE';
  }

  // ------------------------------------------------------------------------------------------------ internals

  private async afterDownloadError(cx: CopyContext, item: ImportFileItem, ref: string, e: unknown): Promise<CopyOutcome> {
    if (e instanceof ProviderHttpError && FILE_GONE.has(e.status)) {
      return this.giveUp(cx, item, 'FAILED', Sev.WARN, 'ATTACHMENT_UNAVAILABLE', ref, `"${item.fileName}" could not be fetched from the source (HTTP ${e.status}) and was not copied`);
    }
    // auth / rate limit / 5xx / network: the JOB's problem (the executor pauses or retries) - but a file that keeps failing is given up on
    const attempts = item.attempts + 1;
    if (attempts >= MAX_FILE_ATTEMPTS) {
      return this.giveUp(cx, item, 'FAILED', Sev.WARN, 'ATTACHMENT_FAILED', ref, `"${item.fileName}" kept failing (${(e as Error)?.message ?? 'error'}) and was not copied`);
    }
    await this.prisma.importFileItem.update({ where: { id: item.id }, data: { attempts } });
    throw e;
  }

  private async giveUp(cx: CopyContext, item: ImportFileItem, status: 'SKIPPED' | 'FAILED', severity: Sev, code: string, externalRef: string, message: string): Promise<CopyOutcome> {
    await this.close(item.id, status, message);
    await this.issues.record(cx.importJobId, [{ severity, code, externalRef, message }]);
    return status;
  }

  private async close(id: string, status: 'DONE' | 'SKIPPED' | 'FAILED', note: string | null, tx: Prisma.TransactionClient | PrismaService = this.prisma): Promise<void> {
    await tx.importFileItem.update({ where: { id }, data: { status, note } });
  }
}

const mb = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(0);

/** A MIME type from provider data: only a plausible `type/subtype` survives, anything else is a plain binary download. */
export function cleanMime(raw: string | null | undefined): string {
  const base = (raw ?? '').split(';')[0].trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/.test(base) ? base : 'application/octet-stream';
}
