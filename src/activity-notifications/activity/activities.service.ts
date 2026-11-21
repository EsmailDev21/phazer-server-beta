import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { ActivityTargetType, ActivityVisibility } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PermissionResolver } from '../../access-control/access-control.service';
import { TaskVisibilityService } from '../../projects-tasks/tasks/task-visibility.service';
import { QueryActivitiesDto } from './dto/query-activities.dto';

@Injectable()
export class ActivitiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissionResolver: PermissionResolver,
    private readonly taskVisibility: TaskVisibilityService,
  ) {}

  /**
   * Same visibility discipline as Tasks/Projects: a workspace-level user
   * sees the whole workspace feed; a Tier1-only ProjectMember can only
   * request the feed scoped to their own project (targetType=PROJECT,
   * targetId=that project, or targetType=TASK for a task within it).
   */
  async list(userId: string, query: QueryActivitiesDto) {
    if (
      query.includeImported &&
      !(query.targetType === ActivityTargetType.TASK && query.targetId)
    ) {
      throw new BadRequestException(
        'includeImported needs targetType=TASK and a targetId: imported history is shown on the task itself, never in the workspace feed',
      );
    }
    await this.assertCanView(userId, query);

    const where = {
      workspaceId: query.workspaceId,
      ...(query.targetType && { targetType: query.targetType }),
      ...(query.targetId && { targetId: query.targetId }),
      // SILENT rows exist purely to drive notifications, never appear
      // here by default — includeSilent is an admin/debug escape hatch.
      ...(!query.includeSilent && {
        visibility: query.includeImported
          ? { in: [ActivityVisibility.TIMELINE, ActivityVisibility.IMPORTED] }
          : ActivityVisibility.TIMELINE,
      }),
    };

    const [data, total] = await Promise.all([
      this.prisma.activity.findMany({
        where,
        take: query.take,
        skip: query.skip,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.activity.count({ where }),
    ]);

    return { data, total, take: query.take, skip: query.skip };
  }

  private async assertCanView(
    userId: string,
    query: QueryActivitiesDto,
  ): Promise<void> {
    if (
      await this.permissionResolver.hasWorkspaceLevelAccess(
        userId,
        query.workspaceId,
      )
    )
      return;

    if (query.targetType === ActivityTargetType.PROJECT && query.targetId) {
      if (
        await this.permissionResolver.hasProjectLevelAccess(
          userId,
          query.targetId,
        )
      )
        return;
    }
    if (query.targetType === ActivityTargetType.TASK && query.targetId) {
      if (await this.taskVisibility.canViewTask(userId, query.targetId)) return;
    }

    throw new ForbiddenException(
      "You do not have access to this workspace's activity feed — Tier1-only users must filter by their own project/task",
    );
  }
}
