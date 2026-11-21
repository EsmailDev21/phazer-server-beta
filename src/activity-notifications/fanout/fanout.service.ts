import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  Activity,
  ActivityAction,
  ActivityTargetType,
  AuditLog,
  NotificationSourceType,
  NotificationType,
  Role,
  WatchableType,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

/**
 * Exact recipient-resolution rules per AN__FANOUT__RECIPIENTS_ACTIVITY.
 * The "assignees + creator" bucket — every ActivityAction here maps to
 * its own NotificationType (explicit decision: granular, not one generic
 * TASK_UPDATED — see schema.prisma NotificationType comment).
 */
const GENERIC_BUCKET_TYPE: Partial<Record<ActivityAction, NotificationType>> = {
  CREATED: NotificationType.TASK_CREATED,
  STATUS_CHANGED: NotificationType.STATUS_CHANGED,
  PRIORITY_CHANGED: NotificationType.PRIORITY_CHANGED,
  DUE_DATE_CHANGED: NotificationType.DUE_DATE_CHANGED,
  DESCRIPTION_UPDATED: NotificationType.DESCRIPTION_UPDATED,
  ARCHIVED: NotificationType.TASK_ARCHIVED,
  RESTORED: NotificationType.TASK_RESTORED,
  DEPENDENCY_ADDED: NotificationType.DEPENDENCY_ADDED,
  DEPENDENCY_REMOVED: NotificationType.DEPENDENCY_REMOVED,
  ATTACHMENT_ADDED: NotificationType.ATTACHMENT_ADDED,
  DUE_DATE_APPROACHING: NotificationType.DUE_DATE_APPROACHING,
};

@Injectable()
export class FanoutService {
  private readonly logger = new Logger(FanoutService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  @OnEvent('activity.created')
  async handleActivityCreated(activity: Activity): Promise<void> {
    try {
      switch (activity.action) {
        case ActivityAction.ASSIGNED:
        case ActivityAction.UNASSIGNED:
          await this.handleAssignmentChange(activity);
          return;
        case ActivityAction.COMMENTED:
          await this.handleCommented(activity);
          return;
        case ActivityAction.REACTED:
          await this.handleReacted(activity);
          return;
        case ActivityAction.TAG_ADDED:
        case ActivityAction.TAG_REMOVED:
        // Step 1.3: hierarchy and project moves are timeline history only.
        case ActivityAction.PARENT_CHANGED:
        case ActivityAction.TASK_MOVED:
        // Step 1.4: workflow edits are project-level history only (ADR-0006 d.9).
        case ActivityAction.WORKFLOW_CHANGED:
        // Step 1.5: planning metadata, history only (no notification).
        case ActivityAction.ISSUE_TYPE_CHANGED:
        case ActivityAction.ITERATION_CHANGED:
        // Step 2.6: an integration linked a PR/commit/branch: timeline history (and channel messages), no in-app notification.
        case ActivityAction.EXTERNAL_LINKED:
          // Step 0.8: tag changes are timeline history only - no
          // NotificationType exists for them, and an unmapped action would
          // log a warning on every attach.
          return;
        case ActivityAction.MENTIONED:
          // DESIGN CALL (Collaboration module): never emitted as its own
          // Activity row — a mention is an attribute of the COMMENTED
          // event, split out in handleCommented. No-op here for safety.
          return;
        default: {
          const notificationType = GENERIC_BUCKET_TYPE[activity.action];
          if (!notificationType) {
            this.logger.warn(
              `No NotificationType mapped for ActivityAction ${activity.action}`,
            );
            return;
          }
          await this.handleGenericBucket(activity, notificationType);
          return;
        }
      }
    } catch (error) {
      // Never a silent swallow — logged with full context, but a fan-out
      // failure must not surface to (or retry against) the original
      // request, which has already completed by the time this runs.
      this.logger.error(
        `Fan-out failed for activity ${activity.id} (${activity.action})`,
        error as Error,
      );
    }
  }

  @OnEvent('auditlog.created')
  async handleAuditLogCreated(auditLog: AuditLog): Promise<void> {
    try {
      const admins = await this.prisma.accountMember.findMany({
        where: {
          accountId: auditLog.accountId,
          role: { in: [Role.OWNER, Role.ADMIN] },
        },
        select: { userId: true },
      });

      const recipients = new Set(admins.map((a) => a.userId));
      // EXCLUDE_ACTOR, unconditional - except for events the SYSTEM raised (metadata.system = true, step 2.2/2.3):
      // those borrow a real user as actor only because AuditLog.actorId is required, and the sole admin of an
      // account must still hear that their integration broke.
      const isSystemEvent = (auditLog.metadata as { system?: boolean } | null)?.system === true;
      if (!isSystemEvent) recipients.delete(auditLog.actorId);

      await Promise.all(
        Array.from(recipients).map((userId) =>
          this.notifications.createNotification({
            userId,
            type: NotificationType.ACCOUNT_ALERT,
            sourceType: NotificationSourceType.AUDIT_LOG,
            sourceId: auditLog.id,
          }),
        ),
      );
    } catch (error) {
      this.logger.error(
        `AuditLog fan-out failed for ${auditLog.id}`,
        error as Error,
      );
    }
  }

  // ---- per-action handlers ----

  private async handleGenericBucket(
    activity: Activity,
    type: NotificationType,
  ): Promise<void> {
    const recipients = await this.resolveTargetAssigneesAndCreator(
      activity.targetType,
      activity.targetId,
    );
    const finalRecipients = await this.unionWithWatchersAndExcludeActor(
      recipients,
      activity,
    );

    await this.notifyAll(finalRecipients, type, activity.id);
  }

  private async handleAssignmentChange(activity: Activity): Promise<void> {
    // TasksService emits ONE Activity per newly-added/removed assignee,
    // metadata: { assigneeId } — recipients = just that one user.
    const assigneeId = (activity.metadata as { assigneeId?: string } | null)
      ?.assigneeId;
    if (!assigneeId || assigneeId === activity.actorId) return; // EXCLUDE_ACTOR

    await this.notifications.createNotification({
      userId: assigneeId,
      type:
        activity.action === ActivityAction.ASSIGNED
          ? NotificationType.TASK_ASSIGNED
          : NotificationType.TASK_UNASSIGNED,
      sourceType: NotificationSourceType.ACTIVITY,
      sourceId: activity.id,
    });
  }

  private async handleCommented(activity: Activity): Promise<void> {
    const commentId = (activity.metadata as { commentId?: string } | null)
      ?.commentId;
    if (!commentId) {
      this.logger.warn(
        `COMMENTED activity ${activity.id} missing metadata.commentId`,
      );
      return;
    }

    const [baseRecipients, priorCommenters, mentions] = await Promise.all([
      this.resolveTargetAssigneesAndCreator(
        activity.targetType,
        activity.targetId,
      ),
      this.prisma.comment
        .findMany({
          where: {
            targetType: activity.targetType as unknown as 'TASK' | 'PROJECT',
            targetId: activity.targetId,
          },
          select: { authorId: true },
          distinct: ['authorId'],
        })
        .then((rows) => rows.map((r) => r.authorId)),
      this.prisma.mention.findMany({
        where: { commentId },
        select: { mentionedUserId: true },
      }),
    ]);

    const mentionedIds = new Set(mentions.map((m) => m.mentionedUserId));

    const commentReplyRecipients = new Set([
      ...baseRecipients,
      ...priorCommenters,
    ]);
    // Mention split: mentioned users are REMOVED from the general
    // COMMENT_REPLY set and get MENTIONED instead — same source Activity,
    // different type, never both for one comment.
    for (const id of mentionedIds) commentReplyRecipients.delete(id);

    const [finalCommentReply, finalMentioned] = await Promise.all([
      this.unionWithWatchersAndExcludeActor(commentReplyRecipients, activity),
      this.excludeActor(mentionedIds, activity.actorId),
    ]);

    await Promise.all([
      this.notifyAll(
        finalCommentReply,
        NotificationType.COMMENT_REPLY,
        activity.id,
      ),
      this.notifyAll(finalMentioned, NotificationType.MENTIONED, activity.id),
    ]);
  }

  private async handleReacted(activity: Activity): Promise<void> {
    // targetType COMMENT, targetId = the reacted-to comment's id.
    const comment = await this.prisma.comment.findUnique({
      where: { id: activity.targetId },
      select: { authorId: true },
    });
    if (!comment) return;

    const recipients = this.excludeActor(
      new Set([comment.authorId]),
      activity.actorId,
    );
    await this.notifyAll(
      recipients,
      NotificationType.REACTION_RECEIVED,
      activity.id,
    );
  }

  // ---- shared helpers ----

  private async resolveTargetAssigneesAndCreator(
    targetType: ActivityTargetType,
    targetId: string,
  ): Promise<Set<string>> {
    const recipients = new Set<string>();

    if (targetType === ActivityTargetType.TASK) {
      const task = await this.prisma.task.findUnique({
        where: { id: targetId },
        select: { createdById: true, assignees: { select: { id: true } } },
      });
      if (!task) return recipients;
      recipients.add(task.createdById);
      for (const a of task.assignees) recipients.add(a.id);
    } else if (targetType === ActivityTargetType.PROJECT) {
      const project = await this.prisma.project.findUnique({
        where: { id: targetId },
        select: { createdById: true },
      });
      if (!project) return recipients;
      recipients.add(project.createdById);
      // Project has no assignees concept — creator only.
    }

    return recipients;
  }

  private async unionWithWatchersAndExcludeActor(
    recipients: Set<string>,
    activity: Activity,
  ): Promise<Set<string>> {
    const merged = new Set(recipients);

    // Watch union only applies when the activity's targetType is a real
    // WatchableType member (TASK|PROJECT) — REACTED (targetType=COMMENT)
    // has no matching Watch rows by construction, contributes nothing.
    if (
      activity.targetType === ActivityTargetType.TASK ||
      activity.targetType === ActivityTargetType.PROJECT
    ) {
      const watchers = await this.prisma.watch.findMany({
        where: {
          targetType: activity.targetType as unknown as WatchableType,
          targetId: activity.targetId,
        },
        select: { userId: true },
      });
      for (const w of watchers) merged.add(w.userId);
    }

    return this.excludeActor(merged, activity.actorId);
  }

  /** ALWAYS exclude actorId, unconditionally, on every action type — a no-op when actorId is null (system-generated events). */
  private excludeActor(
    recipients: Set<string>,
    actorId: string | null,
  ): Set<string> {
    if (actorId) recipients.delete(actorId);
    return recipients;
  }

  private async notifyAll(
    recipients: Set<string>,
    type: NotificationType,
    activityId: string,
  ): Promise<void> {
    await Promise.all(
      Array.from(recipients).map((userId) =>
        this.notifications.createNotification({
          userId,
          type,
          sourceType: NotificationSourceType.ACTIVITY,
          sourceId: activityId,
        }),
      ),
    );
  }
}
