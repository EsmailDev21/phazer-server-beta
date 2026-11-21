import { Injectable, Logger } from '@nestjs/common';
import { ActivityAction, ActivityTargetType, TaskStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ActivityService } from '../../events/activity.service';

/**
 * AN__GAP__FIX: due-date reminders have no human actor, so they're
 * written with actorId: null (Activity.actorId is nullable specifically
 * for this) and flow through the SAME fan-out algorithm as everything
 * else — no second notification mechanism.
 *
 * NOT WIRED TO AN ACTUAL SCHEDULER — this codebase has no job scheduler
 * (same "no job scheduler exists" constraint noted in Foundations and the
 * Tenancy module's Account soft-delete purge job). `scanAndNotify()` is a
 * complete, callable implementation; wire it to a cron trigger (e.g.
 * `@nestjs/schedule`, or an external scheduler hitting an admin endpoint)
 * when one is introduced. Calling it more than once for the same
 * task/day would currently emit duplicate reminders — add a
 * dedup/last-reminded-at check at that point too.
 */
@Injectable()
export class DueDateReminderService {
  private readonly logger = new Logger(DueDateReminderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly activityService: ActivityService,
  ) {}

  async scanAndNotify(withinHours = 24): Promise<{ scanned: number }> {
    const threshold = new Date(Date.now() + withinHours * 60 * 60 * 1000);

    const tasks = await this.prisma.task.findMany({
      where: {
        isArchived: false,
        status: { not: TaskStatus.DONE },
        dueDate: { not: null, lte: threshold, gte: new Date() },
      },
      select: { id: true, workspaceId: true },
    });

    for (const task of tasks) {
      await this.activityService.record({
        actorId: null,
        action: ActivityAction.DUE_DATE_APPROACHING,
        targetType: ActivityTargetType.TASK,
        targetId: task.id,
        workspaceId: task.workspaceId,
      });
    }

    this.logger.log(`Due-date reminder scan: ${tasks.length} task(s) notified`);
    return { scanned: tasks.length };
  }
}
