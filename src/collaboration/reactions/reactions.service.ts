import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ActivityAction,
  ActivityTargetType,
  NotificationSourceType,
  NotificationType,
  ReactableType,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PermissionResolver } from '../../access-control/access-control.service';
import { ActivityService } from '../../events/activity.service';
import { NotificationsService } from '../../activity-notifications/notifications/notifications.service';
import { CreateReactionDto } from './dto/create-reaction.dto';

@Injectable()
export class ReactionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissionResolver: PermissionResolver,
    private readonly activityService: ActivityService,
    private readonly notificationsService: NotificationsService,
  ) {}

  /**
   * No @RequireAccess — reactToTarget has two scopes (COMMENT|ACTIVITY),
   * only one known at request time. Manual check, same pattern as
   * CommentsService.
   *
   * TOGGLE behavior: atomic upsert-or-delete keyed on the
   * @@unique(targetType,targetId,userId,reaction) constraint — no
   * read-then-write race (COLLAB__REACTION__CRUD).
   */
  async toggle(dto: CreateReactionDto, userId: string) {
    const permission = await this.permissionResolver.resolve(
      userId,
      'reactToTarget',
      dto.targetType,
      dto.targetId,
    );
    if (!permission.allowed) {
      throw new ForbiddenException(
        permission.reason ?? 'You do not have permission to react to this',
      );
    }

    const uniqueWhere = {
      targetType_targetId_userId_reaction: {
        targetType: dto.targetType,
        targetId: dto.targetId,
        userId,
        reaction: dto.reaction,
      },
    };

    const existing = await this.prisma.reaction.findUnique({
      where: uniqueWhere,
    });

    if (existing) {
      await this.prisma.reaction.delete({ where: uniqueWhere });
      return { toggled: 'off' as const };
    }

    await this.prisma.reaction.create({
      data: {
        targetType: dto.targetType,
        targetId: dto.targetId,
        userId,
        reaction: dto.reaction,
      },
    });

    await this.generateActivityOrTerminalNotification(
      dto.targetType,
      dto.targetId,
      userId,
    );

    return { toggled: 'on' as const };
  }

  /**
   * COLLAB__ACTIVITY_RULE, reaction branch:
   *   COMMENT target -> Activity{REACTED, SILENT, targetType:COMMENT}
   *     (SILENT = never in the visible feed, but a real row — single
   *     notification-trigger mechanism, no second write path).
   *   ACTIVITY target -> GENUINELY TERMINAL (does NOT generalize to the
   *     COMMENT case above) — Notification DIRECTLY to the original
   *     Activity's actorId, type REACTION_RECEIVED. No recipient (null
   *     actorId, or reacting to your own activity) -> skipped, not an error.
   */
  private async generateActivityOrTerminalNotification(
    targetType: ReactableType,
    targetId: string,
    actorId: string,
  ): Promise<void> {
    if (targetType === ReactableType.ACTIVITY) {
      const originalActivity = await this.prisma.activity.findUnique({
        where: { id: targetId },
        select: { actorId: true },
      });
      if (!originalActivity?.actorId || originalActivity.actorId === actorId)
        return;

      await this.notificationsService.createNotification({
        userId: originalActivity.actorId,
        type: NotificationType.REACTION_RECEIVED,
        sourceType: NotificationSourceType.ACTIVITY,
        sourceId: targetId,
      });
      return;
    }

    // COMMENT — resolve the comment's own workspaceId via its own target,
    // same multi-hop pattern PermissionResolver uses for COMMENT.
    const comment = await this.prisma.comment.findUnique({
      where: { id: targetId },
      select: { targetType: true, targetId: true },
    });
    if (!comment) throw new NotFoundException('Comment not found');

    const workspaceId = await this.resolveWorkspaceIdForCommentTarget(
      comment.targetType,
      comment.targetId,
    );
    if (!workspaceId) return; // comment on an ACTIVITY (or ACTIVITY feed item itself) — no workspace-scoped Activity to write

    await this.activityService.record({
      actorId,
      action: ActivityAction.REACTED,
      targetType: ActivityTargetType.COMMENT,
      targetId,
      workspaceId,
    });
  }

  private async resolveWorkspaceIdForCommentTarget(
    targetType: string,
    targetId: string,
  ): Promise<string | null> {
    if (targetType === 'TASK') {
      const task = await this.prisma.task.findUnique({
        where: { id: targetId },
        select: { workspaceId: true },
      });
      return task?.workspaceId ?? null;
    }
    if (targetType === 'PROJECT') {
      const project = await this.prisma.project.findUnique({
        where: { id: targetId },
        select: { workspaceId: true },
      });
      return project?.workspaceId ?? null;
    }
    return null; // comment's own target is ACTIVITY — no workspace-scoped write
  }
}
