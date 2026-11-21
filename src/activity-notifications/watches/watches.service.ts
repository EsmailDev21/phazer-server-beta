import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { WatchableType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PermissionResolver } from '../../access-control/access-control.service';

@Injectable()
export class WatchesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissionResolver: PermissionResolver,
  ) {}

  /**
   * "If you can't see a task, you can't watch it either" — reuses the
   * SAME visibility gate as the target itself (hasProjectLevelAccess for
   * TASK, since a task's own visibility is scoped by its project when the
   * viewer is Tier1-only; hasWorkspaceLevelAccess for PROJECT lists, but a
   * single project's visibility is the project-level check either way).
   * Not @RequireAccess: no named action returns true for CLIENT/Tier1-only
   * users by design, same reasoning as TaskVisibilityService/ProjectsService.
   */
  async create(userId: string, targetType: WatchableType, targetId: string) {
    await this.assertCanView(userId, targetType, targetId);

    const existing = await this.prisma.watch.findUnique({
      where: { userId_targetType_targetId: { userId, targetType, targetId } },
    });
    if (existing) throw new ConflictException('Already watching this target');

    return this.prisma.watch.create({ data: { userId, targetType, targetId } });
  }

  async remove(
    userId: string,
    targetType: WatchableType,
    targetId: string,
  ): Promise<void> {
    await this.prisma.watch
      .delete({
        where: { userId_targetType_targetId: { userId, targetType, targetId } },
      })
      .catch(() => {
        throw new NotFoundException('Not watching this target');
      });
  }

  async listMine(userId: string) {
    return this.prisma.watch.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  private async assertCanView(
    userId: string,
    targetType: WatchableType,
    targetId: string,
  ): Promise<void> {
    if (targetType === WatchableType.TASK) {
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

    if (targetType === WatchableType.PROJECT) {
      if (
        !(await this.permissionResolver.hasProjectLevelAccess(userId, targetId))
      ) {
        throw new ForbiddenException('You do not have access to this project');
      }
    }
  }
}
