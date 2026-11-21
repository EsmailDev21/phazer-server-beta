import { ForbiddenException, Injectable } from '@nestjs/common';
import { NotificationSourceType, NotificationType } from '@prisma/client';
import { NotificationsService } from '../activity-notifications/notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { TaskVisibilityService } from '../projects-tasks/tasks/task-visibility.service';

/**
 * Step 5.14. What a NOTIFY does: store the message once (it is the source the notifications point at) and
 * send one in-app notification per person who can SEE the task it is about. A person who cannot see the
 * task is skipped, not an error: a rule's message must not carry a task's title to someone who has no
 * access to it (a watcher or assignee that lost access, a literal user id that was removed).
 */
@Injectable()
export class AutomationNotifier {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly visibility: TaskVisibilityService,
  ) {}

  async notify(input: {
    workspaceId: string;
    automationId: string;
    taskId: string | null;
    userIds: string[];
    message: string;
  }): Promise<{ sent: number; skipped: number }> {
    const visible: string[] = [];
    for (const userId of input.userIds)
      if (await this.canSee(userId, input.workspaceId, input.taskId))
        visible.push(userId);
    if (visible.length === 0) return { sent: 0, skipped: input.userIds.length };

    const row = await this.prisma.automationMessage.create({
      data: {
        workspaceId: input.workspaceId,
        automationId: input.automationId,
        taskId: input.taskId,
        message: input.message,
      },
    });
    for (const userId of visible)
      await this.notifications.createNotification({
        userId,
        type: NotificationType.AUTOMATION_MESSAGE,
        sourceType: NotificationSourceType.AUTOMATION_MESSAGE,
        sourceId: row.id,
        extra: { message: input.message, taskId: input.taskId },
      });
    return {
      sent: visible.length,
      skipped: input.userIds.length - visible.length,
    };
  }

  /** the task's visibility rule (the ONE definition), or workspace access when there is no task */
  private async canSee(
    userId: string,
    workspaceId: string,
    taskId: string | null,
  ): Promise<boolean> {
    try {
      const where = await this.visibility.buildVisibleTasksWhere(userId, {
        workspaceId,
      });
      if (!taskId) return true; // it did not throw: the person has access to the workspace
      return (
        (await this.prisma.task.count({
          where: { AND: [where, { id: taskId }] },
        })) > 0
      );
    } catch (err) {
      if (err instanceof ForbiddenException) return false;
      throw err;
    }
  }
}
