import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  AttachmentStatus,
  AttachmentableType,
  ActivityAction,
  ActivityTargetType,
} from '@prisma/client';
import { randomUUID } from 'crypto';
import { Attachment, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PermissionResolver } from '../access-control/access-control.service';
import { ActivityService } from '../events/activity.service';
import { PlanLimitExceededException } from '../common/exceptions/plan-limit-exceeded.exception';
import { getPlanLimits } from '../common/config/billing-tiers.config';
import {
  STORAGE_PROVIDER,
  StorageProvider,
} from './storage/storage-provider.interface';
import { CreateUploadUrlDto } from './dto/create-upload-url.dto';
import { QueryFilesDto } from './dto/query-files.dto';

const PENDING_EXPIRY_HOURS = 24;

interface ResolvedTarget {
  accountId: string;
  workspaceId: string;
}

@Injectable()
export class AttachmentsService {
  private readonly logger = new Logger(AttachmentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly permissionResolver: PermissionResolver,
    private readonly activityService: ActivityService,
    @Inject(STORAGE_PROVIDER) private readonly storageProvider: StorageProvider,
  ) {}

  /**
   * POST /files/upload-url. No @RequireAccess on the controller —
   * uploadFile has three valid scopes (TASK|PROJECT|COMMENT), only one
   * known at request time, same pattern as createComment/reactToTarget.
   * Manual PermissionResolver.resolve() call here instead.
   *
   * Order, cheapest-check-first per FILES__LIMIT__PER_FILE_CAP: permission
   * -> per-file cap -> cumulative live-sum check -> only then touch
   * storage or the database.
   */
  async createUploadUrl(dto: CreateUploadUrlDto, userId: string) {
    const target = await this.resolveTarget(dto.targetType, dto.targetId);

    const permission = await this.permissionResolver.resolve(
      userId,
      'uploadFile',
      dto.targetType,
      dto.targetId,
    );
    if (!permission.allowed) {
      throw new ForbiddenException(
        permission.reason ?? 'You do not have permission to upload files here',
      );
    }

    const account = await this.prisma.account.findUnique({
      where: { id: target.accountId },
      select: { planType: true },
    });
    const limits = getPlanLimits(account?.planType ?? null);

    if (dto.sizeBytes > limits.maxFileSizeBytes) {
      throw new PlanLimitExceededException(
        `File exceeds the ${(limits.maxFileSizeBytes / (1024 * 1024)).toFixed(0)}MB per-file limit for this plan`,
      );
    }

    // FIX per FILES__LIMIT__RESERVATION: sums CONFIRMED + not-yet-expired
    // PENDING attachments, not CONFIRMED alone — otherwise a burst of
    // concurrent upload-url requests could all pass simultaneously (none
    // confirmed yet) then all confirm together and blow past the limit.
    const pendingCutoff = new Date(
      Date.now() - PENDING_EXPIRY_HOURS * 60 * 60 * 1000,
    );
    const usedBytes = await this.prisma.attachment.aggregate({
      where: {
        accountId: target.accountId,
        OR: [
          { status: AttachmentStatus.CONFIRMED },
          {
            status: AttachmentStatus.PENDING,
            createdAt: { gte: pendingCutoff },
          },
        ],
      },
      _sum: { sizeBytes: true },
    });
    const currentBytes = usedBytes._sum.sizeBytes ?? 0;
    const limitBytes = limits.storageGB * 1024 * 1024 * 1024;

    if (currentBytes + dto.sizeBytes > limitBytes) {
      throw new PlanLimitExceededException(
        `This upload would exceed the ${limits.storageGB}GB storage limit for this plan`,
      );
    }

    const sanitizedFilename = dto.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const storageKey = `attachments/${target.accountId}/${dto.targetType}/${dto.targetId}/${randomUUID()}-${sanitizedFilename}`;

    const attachment = await this.prisma.attachment.create({
      data: {
        accountId: target.accountId,
        targetType: dto.targetType,
        targetId: dto.targetId,
        uploadedById: userId,
        filename: dto.filename,
        mimeType: dto.mimeType,
        sizeBytes: dto.sizeBytes,
        storageKey,
        status: AttachmentStatus.PENDING,
      },
    });

    const { url, expiresAt } =
      await this.storageProvider.generatePresignedUploadUrl(
        storageKey,
        dto.mimeType,
        dto.sizeBytes,
      );

    return { attachmentId: attachment.id, uploadUrl: url, expiresAt };
  }

  /**
   * POST /files/:id/confirm — ownership check only (uploadedById ===
   * current user), not a full PermissionResolver pass again (already
   * checked at upload-url issuance). Idempotent: confirming an
   * already-CONFIRMED attachment just returns it as-is rather than erroring.
   *
   * ORDERING per FILES__UPLOAD__ACTIVITY_TIMING: ATTACHMENT_ADDED fires
   * HERE, on confirm, never on upload-url issuance — an abandoned/never-
   * confirmed upload must never appear in the target's Activity feed.
   */
  async confirmUpload(attachmentId: string, userId: string) {
    const attachment = await this.prisma.attachment.findUnique({
      where: { id: attachmentId },
    });
    if (!attachment) throw new NotFoundException('Attachment not found');
    if (attachment.uploadedById !== userId) {
      throw new ForbiddenException('You can only confirm your own uploads');
    }

    if (attachment.status === AttachmentStatus.CONFIRMED) {
      return attachment;
    }

    const updated = await this.prisma.attachment.update({
      where: { id: attachmentId },
      data: { status: AttachmentStatus.CONFIRMED, confirmedAt: new Date() },
    });

    const target = await this.resolveTarget(
      attachment.targetType,
      attachment.targetId,
    );
    await this.activityService.record({
      actorId: userId,
      action: ActivityAction.ATTACHMENT_ADDED,
      targetType: attachment.targetType as unknown as ActivityTargetType, // TASK|PROJECT|COMMENT overlap exactly between the two enums
      targetId: attachment.targetId,
      workspaceId: target.workspaceId,
      metadata: { attachmentId: attachment.id, filename: attachment.filename },
    });

    return updated;
  }

  /**
   * GET /files?targetType=&targetId= — visibility-gated the same way as
   * every other CLIENT-inclusive read in this codebase (not
   * @RequireAccess; see TaskVisibilityService/ProjectsService/
   * CommentsService for the established pattern). Returns CONFIRMED
   * attachments only — PENDING/abandoned ones never appear in a listing.
   */
  async listByTarget(query: QueryFilesDto, userId: string) {
    await this.assertCanView(query.targetType, query.targetId, userId);

    const where = {
      targetType: query.targetType,
      targetId: query.targetId,
      status: AttachmentStatus.CONFIRMED,
    };
    const [data, total] = await Promise.all([
      this.prisma.attachment.findMany({
        where,
        take: query.take,
        skip: query.skip,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.attachment.count({ where }),
    ]);

    return { data, total, take: query.take, skip: query.skip };
  }

  /**
   * GET /files/:id/download-url — presigned, time-limited, re-derived
   * fresh per request so access is re-checked via the visibility guard
   * EVERY time, never granted once and cached. Only CONFIRMED attachments
   * are downloadable.
   */
  async getDownloadUrl(attachmentId: string, userId: string) {
    const attachment = await this.prisma.attachment.findUnique({
      where: { id: attachmentId },
    });
    if (!attachment || attachment.status !== AttachmentStatus.CONFIRMED) {
      throw new NotFoundException('Attachment not found');
    }

    await this.assertCanView(
      attachment.targetType,
      attachment.targetId,
      userId,
    );

    const { url, expiresAt } =
      await this.storageProvider.generatePresignedDownloadUrl(
        attachment.storageKey,
      );
    return { downloadUrl: url, expiresAt };
  }

  /**
   * DELETE /files/:id — permission already checked by @RequireAccess
   * (deleteFile, ownershipField: uploadedById) at the controller level.
   * Deletes BOTH the row AND the object — storage accounting must
   * reflect the deletion immediately (live SUM reads CONFIRMED rows),
   * not just stop showing it in a listing.
   */
  async delete(attachmentId: string): Promise<void> {
    const attachment = await this.prisma.attachment.findUnique({
      where: { id: attachmentId },
    });
    if (!attachment) throw new NotFoundException('Attachment not found');

    await this.deleteMany([attachmentId]);
  }

  /**
   * Step 4.6. Deletes the rows, THEN every storage object no remaining row references. Rows of one account can share an
   * object (a deduped import copy: same bytes, different task), so an object is only removed with its last row. The row goes
   * first (inside its own transaction, which waits for a concurrent finalizeImported() that is pointing a new row at the same
   * object) and the reference check runs after it commits, so a twin can never be left pointing at a deleted object.
   * An object that cannot be deleted is logged and left (storage cost, never a dangling row).
   */
  async deleteMany(ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const rows = await this.prisma.attachment.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, storageKey: true },
    });
    if (rows.length === 0) return 0;
    await this.prisma.attachment.deleteMany({
      where: { id: { in: rows.map((r) => r.id) } },
    });
    for (const key of new Set(rows.map((r) => r.storageKey))) {
      await this.releaseObject(key);
    }
    return rows.length;
  }

  /** Deletes the object unless some attachment row still points at it. Never throws. */
  async releaseObject(storageKey: string): Promise<void> {
    try {
      if ((await this.prisma.attachment.count({ where: { storageKey } })) > 0) return;
      await this.storageProvider.deleteObject(storageKey);
    } catch (error) {
      this.logger.warn(
        `Could not delete object ${storageKey}: ${(error as Error).message}`,
      );
    }
  }

  // ---- step 4.6: the importer's copy path (diagram 05, lane "Attachment copy") ----

  /** The plan numbers the copier needs BEFORE it fetches anything: the per-file cap, so an oversized file is skipped, not paused on. */
  async importLimits(accountId: string): Promise<{ maxFileSizeBytes: number; storageBytes: number }> {
    const account = await this.prisma.account.findUnique({
      where: { id: accountId },
      select: { planType: true },
    });
    const limits = getPlanLimits(account?.planType ?? null);
    return {
      maxFileSizeBytes: limits.maxFileSizeBytes,
      storageBytes: limits.storageGB * 1024 * 1024 * 1024,
    };
  }

  /**
   * "Quota reserved first" (same PENDING pattern as uploads): a PENDING row that already counts against the account's storage
   * BEFORE the first byte is fetched. The check and the insert run under one advisory lock per account, so two copies (two
   * jobs, two workers) cannot both pass on the last free bytes. Throws PlanLimitExceededException when the storage plan is full.
   * The per-file cap is NOT checked here (see importLimits): that one is a property of the file, not of the account.
   */
  async reserveForImport(p: {
    accountId: string;
    taskId: string;
    uploadedById: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
  }): Promise<Attachment> {
    const { storageBytes } = await this.importLimits(p.accountId);
    const pendingCutoff = new Date(Date.now() - PENDING_EXPIRY_HOURS * 60 * 60 * 1000);
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`attachment-quota:${p.accountId}`}))`;
      const used = await tx.attachment.aggregate({
        where: {
          accountId: p.accountId,
          OR: [
            { status: AttachmentStatus.CONFIRMED },
            { status: AttachmentStatus.PENDING, createdAt: { gte: pendingCutoff } },
          ],
        },
        _sum: { sizeBytes: true },
      });
      if ((used._sum.sizeBytes ?? 0) + p.sizeBytes > storageBytes) {
        throw new PlanLimitExceededException(
          'The files of this import would exceed the storage limit for this plan',
        );
      }
      const safe = p.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      return tx.attachment.create({
        data: {
          accountId: p.accountId,
          targetType: AttachmentableType.TASK,
          targetId: p.taskId,
          uploadedById: p.uploadedById,
          filename: p.filename,
          mimeType: p.mimeType,
          sizeBytes: p.sizeBytes,
          storageKey: `attachments/${p.accountId}/TASK/${p.taskId}/${randomUUID()}-${safe}`,
          status: AttachmentStatus.PENDING,
        },
      });
    });
  }

  /**
   * After a copy whose size was unknown up front: is the account still within its storage plan? (The reservation could only
   * hold a placeholder.) Counts CONFIRMED rows and fresh PENDING ones, this copy's own row included at its reserved size.
   */
  async hasRoomFor(accountId: string, extraBytes: number): Promise<boolean> {
    const { storageBytes } = await this.importLimits(accountId);
    const cutoff = new Date(Date.now() - PENDING_EXPIRY_HOURS * 60 * 60 * 1000);
    const used = await this.prisma.attachment.aggregate({
      where: { accountId, OR: [{ status: AttachmentStatus.CONFIRMED }, { status: AttachmentStatus.PENDING, createdAt: { gte: cutoff } }] },
      _sum: { sizeBytes: true },
    });
    return (used._sum.sizeBytes ?? 0) + extraBytes <= storageBytes;
  }

  /**
   * The copy is in storage: confirm the row with its real size and hash. If this account already holds the same bytes (same
   * SHA-256 and size) the row is pointed at THAT object and the freshly written one is reported back as `redundantKey` for the
   * caller to release (dedupe: one object, several rows; quota still counts every row). The twin row is locked FOR SHARE for the
   * transaction, so a concurrent deleteMany() of it waits and then sees this row as a reference.
   */
  async finalizeImported(
    attachmentId: string,
    done: { sizeBytes: number; sha256: string; mimeType?: string; createdAt?: Date },
    /** Runs in the SAME transaction (the importer records its ExternalRef and the file item here). If it throws, nothing is confirmed. */
    inTx?: (tx: Prisma.TransactionClient, attachment: Attachment) => Promise<void>,
  ): Promise<{ attachment: Attachment; redundantKey: string | null; deduped: boolean }> {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.attachment.findUniqueOrThrow({ where: { id: attachmentId } });
      const twins = await tx.$queryRaw<Array<{ storage_key: string }>>`
        SELECT storage_key FROM attachments
        WHERE account_id = ${row.accountId} AND sha256 = ${done.sha256} AND size_bytes = ${done.sizeBytes}
          AND status = 'CONFIRMED' AND id <> ${row.id}
        ORDER BY created_at ASC LIMIT 1 FOR SHARE`;
      const twin = twins[0]?.storage_key;
      const attachment = await tx.attachment.update({
        where: { id: attachmentId },
        data: {
          status: AttachmentStatus.CONFIRMED,
          confirmedAt: new Date(),
          sizeBytes: done.sizeBytes,
          sha256: done.sha256,
          ...(done.mimeType ? { mimeType: done.mimeType } : {}),
          ...(twin ? { storageKey: twin } : {}),
          ...(done.createdAt ? { createdAt: done.createdAt } : {}),
        },
      });
      if (inTx) await inTx(tx, attachment);
      return { attachment, redundantKey: twin ? row.storageKey : null, deduped: !!twin };
    });
  }

  /**
   * FILES__UPLOAD__ABANDONED_CLEANUP. Step 0.3 wires this to a repeatable
   * `system` queue job (see `attachment-cleanup.job.ts`) — this method
   * itself is unchanged, just no longer manually triggered.
   */
  async cleanupAbandoned(): Promise<{ deletedCount: number }> {
    const cutoff = new Date(Date.now() - PENDING_EXPIRY_HOURS * 60 * 60 * 1000);
    const abandoned = await this.prisma.attachment.findMany({
      where: { status: AttachmentStatus.PENDING, createdAt: { lt: cutoff } },
      select: { id: true, storageKey: true },
    });

    for (const attachment of abandoned) {
      // Best-effort — the object may never have actually been uploaded
      // (that's the whole point of "abandoned"), so a delete against a
      // nonexistent key is expected and fine, not an error to halt on.
      try {
        await this.storageProvider.deleteObject(attachment.storageKey);
      } catch (error) {
        this.logger.warn(
          `Failed to delete abandoned object ${attachment.storageKey}: ${(error as Error).message}`,
        );
      }
    }

    const result = await this.prisma.attachment.deleteMany({
      where: { status: AttachmentStatus.PENDING, createdAt: { lt: cutoff } },
    });

    this.logger.log(`Abandoned attachment cleanup: ${result.count} deleted`);
    return { deletedCount: result.count };
  }

  /**
   * Used ONLY by the account hard-delete purge job (step 0.3,
   * `account-purge.job.ts`). `Attachment.accountId` is deliberately
   * denormalized with no FK `@relation` to `Account` (see the schema
   * comment) specifically so this cleanup stays a conscious step, not an
   * accidental cascade — deleting the Account row does NOT touch these
   * rows or their storage objects on its own. Deletes every attachment for
   * the account regardless of status (unlike `cleanupAbandoned`, which
   * only targets stale PENDING rows): once the account itself is gone
   * there is no "keep the CONFIRMED ones" case to preserve.
   */
  async purgeAllForAccount(
    accountId: string,
  ): Promise<{ deletedCount: number }> {
    const attachments = await this.prisma.attachment.findMany({
      where: { accountId },
      select: { id: true, storageKey: true },
    });

    for (const attachment of attachments) {
      // Best-effort, same reasoning as cleanupAbandoned: a missing object
      // must not block the rest of an account purge.
      try {
        await this.storageProvider.deleteObject(attachment.storageKey);
      } catch (error) {
        this.logger.warn(
          `Failed to delete object ${attachment.storageKey} while purging account ${accountId}: ${(error as Error).message}`,
        );
      }
    }

    const result = await this.prisma.attachment.deleteMany({
      where: { accountId },
    });

    this.logger.log(
      `Attachment purge for account ${accountId}: ${result.count} deleted`,
    );
    return { deletedCount: result.count };
  }

  // ---- internals ----

  /**
   * Resolves an AttachmentableType target to its owning account/workspace.
   * COMMENT is multi-hop, same restriction as PermissionResolver's own
   * COMMENT resolution: only supported when the comment's OWN target is
   * TASK or PROJECT, not ACTIVITY (avoids a 3rd resolution hop for an
   * unlikely case — per FILES__UPLOAD__ENDPOINTS's explicit scope note).
   */
  private async resolveTarget(
    targetType: AttachmentableType,
    targetId: string,
  ): Promise<ResolvedTarget> {
    if (targetType === AttachmentableType.TASK) {
      const task = await this.prisma.task.findUnique({
        where: { id: targetId },
        select: {
          workspaceId: true,
          workspace: { select: { accountId: true } },
        },
      });
      if (!task) throw new NotFoundException('Task not found');
      return {
        accountId: task.workspace.accountId,
        workspaceId: task.workspaceId,
      };
    }

    if (targetType === AttachmentableType.PROJECT) {
      const project = await this.prisma.project.findUnique({
        where: { id: targetId },
        select: {
          workspaceId: true,
          workspace: { select: { accountId: true } },
        },
      });
      if (!project) throw new NotFoundException('Project not found');
      return {
        accountId: project.workspace.accountId,
        workspaceId: project.workspaceId,
      };
    }

    // COMMENT
    const comment = await this.prisma.comment.findUnique({
      where: { id: targetId },
      select: { targetType: true, targetId: true },
    });
    if (!comment) throw new NotFoundException('Comment not found');

    if (comment.targetType === 'TASK' || comment.targetType === 'PROJECT') {
      return this.resolveTarget(
        comment.targetType as unknown as AttachmentableType,
        comment.targetId,
      );
    }

    throw new BadRequestException(
      'Attachments are not supported on comments targeting an activity-feed entry',
    );
  }

  private async assertCanView(
    targetType: AttachmentableType,
    targetId: string,
    userId: string,
  ): Promise<void> {
    if (targetType === AttachmentableType.TASK) {
      const task = await this.prisma.task.findUnique({
        where: { id: targetId },
        select: { workspaceId: true, projectId: true },
      });
      if (!task) throw new NotFoundException('Task not found');
      if (
        await this.permissionResolver.hasWorkspaceLevelAccess(
          userId,
          task.workspaceId,
        )
      )
        return;
      if (task.projectId) {
        const membership = await this.prisma.projectMember.findUnique({
          where: { projectId_userId: { projectId: task.projectId, userId } },
        });
        if (membership) return;
      }
      throw new ForbiddenException('You do not have access to this task');
    }

    if (targetType === AttachmentableType.PROJECT) {
      if (
        !(await this.permissionResolver.hasProjectLevelAccess(userId, targetId))
      ) {
        throw new ForbiddenException('You do not have access to this project');
      }
      return;
    }

    // COMMENT — resolve via its own target, same restriction as above.
    const comment = await this.prisma.comment.findUnique({
      where: { id: targetId },
      select: { targetType: true, targetId: true },
    });
    if (!comment) throw new NotFoundException('Comment not found');

    if (comment.targetType === 'TASK' || comment.targetType === 'PROJECT') {
      await this.assertCanView(
        comment.targetType as unknown as AttachmentableType,
        comment.targetId,
        userId,
      );
      return;
    }

    throw new ForbiddenException(
      'This action is not supported for comments on activity-feed entries',
    );
  }
}
