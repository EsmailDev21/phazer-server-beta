import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ActivityAction,
  ActivityTargetType,
  CommentableType,
  NotificationSourceType,
  NotificationType,
} from '@prisma/client';
import { WriteContext } from '../../domain-writer/write-context';
import { PrismaService } from '../../prisma/prisma.service';
import { PermissionResolver } from '../../access-control/access-control.service';
import { ActivityService } from '../../events/activity.service';
import { NotificationsService } from '../../activity-notifications/notifications/notifications.service';
import { CreateCommentDto } from './dto/create-comment.dto';
import { UpdateCommentDto } from './dto/update-comment.dto';
import { QueryCommentsDto } from './dto/query-comments.dto';
import { UserEntity } from '../../common/entities/user.entity';

@Injectable()
export class CommentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissionResolver: PermissionResolver,
    private readonly activityService: ActivityService,
    private readonly notificationsService: NotificationsService,
  ) {}

  /**
   * No @RequireAccess on the controller — createComment now has THREE
   * valid scopes (TASK|PROJECT|ACTIVITY), only one of which is known at
   * request time (dto.targetType), so the static decorator can't infer
   * it. Manual PermissionResolver.resolve() call here instead, same
   * pattern as InvitesService/CustomFieldsService's dynamic checks.
   */
  async create(dto: CreateCommentDto, authorId: string) {
    const workspaceId = await this.resolveWorkspaceId(
      dto.targetType,
      dto.targetId,
    );

    const permission = await this.permissionResolver.resolve(
      authorId,
      'createComment',
      dto.targetType,
      dto.targetId,
    );
    if (!permission.allowed) {
      throw new ForbiddenException(
        permission.reason ?? 'You do not have permission to comment here',
      );
    }

    // COLLAB__COMMENT__NESTING: one level only, app-enforced.
    if (dto.parentCommentId) {
      const parent = await this.prisma.comment.findUnique({
        where: { id: dto.parentCommentId },
      });
      if (!parent) throw new NotFoundException('parentCommentId not found');
      if (parent.parentCommentId) {
        throw new BadRequestException(
          'Replies can only be one level deep — cannot reply to a reply',
        );
      }
      if (
        parent.targetType !== dto.targetType ||
        parent.targetId !== dto.targetId
      ) {
        throw new BadRequestException(
          'parentCommentId must belong to the same target',
        );
      }
    }

    if (dto.mentionedUserIds && dto.mentionedUserIds.length > 0) {
      const existingUsers = await this.prisma.user.findMany({
        where: { id: { in: dto.mentionedUserIds } },
        select: { id: true },
      });
      const existingIds = new Set(existingUsers.map((u) => u.id));
      const missing = dto.mentionedUserIds.filter((id) => !existingIds.has(id));
      if (missing.length > 0) {
        throw new NotFoundException(
          `Mentioned user(s) not found: ${missing.join(', ')}`,
        );
      }
    }

    const comment = await this.prisma.comment.create({
      data: {
        targetType: dto.targetType,
        targetId: dto.targetId,
        authorId,
        content: dto.content,
        parentCommentId: dto.parentCommentId,
        mentions: dto.mentionedUserIds
          ? {
              create: dto.mentionedUserIds.map((mentionedUserId) => ({
                mentionedUserId,
              })),
            }
          : undefined,
      },
    });

    await this.generateActivityOrTerminalNotification(
      dto.targetType,
      dto.targetId,
      workspaceId,
      authorId,
      comment.id,
    );

    return this.toResponse(comment, authorId);
  }

  /**
   * Step 5.2. A comment written by the SYSTEM actor on behalf of an automation rule. Like DomainWriter,
   * it does NOT authorise: the rule's own permission (an admin created it) is the authority, and the
   * system user is a member of nothing. Everything after the permission check is the same as `create`
   * (one comment row, the COMMENTED activity, the same fan-out), so it shows up and notifies like any other.
   */
  async createSystemComment(
    targetType: CommentableType,
    targetId: string,
    authorId: string,
    content: string,
    ctx?: WriteContext,
  ) {
    const workspaceId = await this.resolveWorkspaceId(targetType, targetId);
    const comment = await this.prisma.comment.create({
      data: { targetType, targetId, authorId, content },
    });
    await this.generateActivityOrTerminalNotification(
      targetType,
      targetId,
      workspaceId,
      authorId,
      comment.id,
      ctx,
    );
    return comment;
  }

  async list(query: QueryCommentsDto, userId: string) {
    await this.assertCanView(query.targetType, query.targetId, userId);

    const [rows, total] = await Promise.all([
      this.prisma.comment.findMany({
        where: { targetType: query.targetType, targetId: query.targetId },
        take: query.take,
        skip: query.skip,
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.comment.count({
        where: { targetType: query.targetType, targetId: query.targetId },
      }),
    ]);

    const data = await Promise.all(
      rows.map((row) => this.toResponse(row, userId)),
    );
    return { data, total, take: query.take, skip: query.skip };
  }

  async update(commentId: string, dto: UpdateCommentDto, userId: string) {
    const comment = await this.prisma.comment.findUnique({
      where: { id: commentId },
    });
    if (!comment) throw new NotFoundException('Comment not found');
    const updated = await this.prisma.comment.update({
      where: { id: commentId },
      data: { content: dto.content },
    });
    return this.toResponse(updated, userId);
  }

  async delete(commentId: string): Promise<void> {
    const comment = await this.prisma.comment.findUnique({
      where: { id: commentId },
    });
    if (!comment) throw new NotFoundException('Comment not found');
    await this.prisma.comment.delete({ where: { id: commentId } });
  }

  // ---- internals ----

  private async resolveWorkspaceId(
    targetType: CommentableType,
    targetId: string,
  ): Promise<string> {
    if (targetType === CommentableType.TASK) {
      const task = await this.prisma.task.findUnique({
        where: { id: targetId },
        select: { workspaceId: true },
      });
      if (!task) throw new NotFoundException('Task not found');
      return task.workspaceId;
    }
    if (targetType === CommentableType.PROJECT) {
      const project = await this.prisma.project.findUnique({
        where: { id: targetId },
        select: { workspaceId: true },
      });
      if (!project) throw new NotFoundException('Project not found');
      return project.workspaceId;
    }
    // ACTIVITY
    const activity = await this.prisma.activity.findUnique({
      where: { id: targetId },
      select: { workspaceId: true },
    });
    if (!activity) throw new NotFoundException('Activity not found');
    return activity.workspaceId;
  }

  private async assertCanView(
    targetType: CommentableType,
    targetId: string,
    userId: string,
  ): Promise<void> {
    // Viewing a comment thread requires the same visibility as its
    // target — reuses hasWorkspaceLevelAccess/hasProjectLevelAccess for
    // TASK/PROJECT the same way the rest of the codebase does for
    // CLIENT-inclusive reads. ACTIVITY targets: workspace-level only
    // (matches the ACTIVITY resolution in PermissionResolver).
    if (targetType === CommentableType.TASK) {
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
    if (targetType === CommentableType.PROJECT) {
      if (
        !(await this.permissionResolver.hasProjectLevelAccess(userId, targetId))
      ) {
        throw new ForbiddenException('You do not have access to this project');
      }
      return;
    }
    // ACTIVITY
    const activity = await this.prisma.activity.findUnique({
      where: { id: targetId },
      select: { workspaceId: true },
    });
    if (!activity) throw new NotFoundException('Activity not found');
    if (
      !(await this.permissionResolver.hasWorkspaceLevelAccess(
        userId,
        activity.workspaceId,
      ))
    ) {
      throw new ForbiddenException('You do not have access to this workspace');
    }
  }

  /**
   * COLLAB__ACTIVITY_RULE — precise, not a blanket "terminal":
   *   TASK|PROJECT target -> Activity{COMMENTED, TIMELINE, metadata:{commentId}}
   *     (structurally required — Notifications are generated FROM Activity)
   *   ACTIVITY target -> GENUINELY TERMINAL, no new Activity row at all.
   *     Notification DIRECTLY to the original Activity's actorId. If that
   *     actorId is null (system-generated source, e.g. a due-date
   *     reminder) there is no recipient by definition — skipped, not an
   *     error; the comment itself still succeeds.
   */
  private async generateActivityOrTerminalNotification(
    targetType: CommentableType,
    targetId: string,
    workspaceId: string,
    authorId: string,
    commentId: string,
    ctx?: WriteContext,
  ): Promise<void> {
    if (targetType === CommentableType.ACTIVITY) {
      const originalActivity = await this.prisma.activity.findUnique({
        where: { id: targetId },
        select: { actorId: true },
      });
      if (!originalActivity?.actorId || originalActivity.actorId === authorId)
        return; // no recipient, or EXCLUDE_ACTOR

      await this.notificationsService.createNotification({
        userId: originalActivity.actorId,
        type: NotificationType.COMMENT_REPLY,
        sourceType: NotificationSourceType.ACTIVITY,
        sourceId: targetId,
      });
      return;
    }

    const params = {
      actorId: authorId,
      action: ActivityAction.COMMENTED,
      targetType: targetType as unknown as ActivityTargetType, // TASK|PROJECT overlap exactly between the two enums here
      targetId,
      workspaceId,
      metadata: { commentId },
    };
    await (ctx
      ? this.activityService.record(params, ctx)
      : this.activityService.record(params));
  }

  /**
   * Precomputed canEdit/canDelete per row (once per comment) — avoids an
   * N+1 where the frontend would otherwise call /access-control/check per
   * rendered comment. editComment/deleteComment share an identical
   * role+ownership profile in this codebase's matrices, but both are
   * resolved independently through the real engine rather than hand-
   * rolled, per the "no service method contains its own permission logic"
   * rule — accepted perf tradeoff, as specified.
   */
  private async toResponse(
    comment: Awaited<ReturnType<typeof this.prisma.comment.findUniqueOrThrow>>,
    userId: string,
  ) {
    const [attachmentCount, canEditResult, canDeleteResult, author] =
      await Promise.all([
        this.prisma.attachment.count({
          where: {
            targetType: 'COMMENT',
            targetId: comment.id,
            status: 'CONFIRMED',
          },
        }),
        this.permissionResolver.resolve(
          userId,
          'editComment',
          'COMMENT',
          comment.id,
        ),
        this.permissionResolver.resolve(
          userId,
          'deleteComment',
          'COMMENT',
          comment.id,
        ),
        this.prisma.user.findUnique({ where: { id: comment.authorId } }),
      ]);

    return {
      id: comment.id,
      targetType: comment.targetType,
      targetId: comment.targetId,
      content: comment.content,
      parentCommentId: comment.parentCommentId,
      author: author ? new UserEntity(author) : null,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
      attachmentCount,
      canEdit: canEditResult.allowed,
      canDelete: canDeleteResult.allowed,
    };
  }
}
