import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { WorkspaceKeysService } from '../../tenancy/workspaces/workspace-keys.service';
import { TaskDetailDto } from './dto/task-response.dto';
import { TaskVisibilityService } from './task-visibility.service';
import { TasksService } from './tasks.service';

/**
 * "ENG-123" -> task (ADR-0004). Kept apart from TasksService so the
 * characterization-pinned create/update class does not grow a tenancy
 * dependency for a read path.
 */
@Injectable()
export class TaskKeyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly keys: WorkspaceKeysService,
    private readonly visibility: TaskVisibilityService,
    private readonly tasks: TasksService,
  ) {}

  /**
   * Authorised exactly like GET /tasks/:id (TaskVisibilityService), after the
   * key is resolved WITHIN `accountId`. "No such key", "key of an account you
   * are not in" and "task you may not see" are deliberately the same 404, so
   * the endpoint cannot be used to discover which keys exist.
   */
  async getByKey(
    accountId: string,
    taskKey: string,
    userId: string,
  ): Promise<TaskDetailDto> {
    const resolved = await this.keys.resolveTask(
      this.prisma,
      accountId,
      taskKey,
    );
    if (
      !resolved ||
      !(await this.visibility.canViewTask(userId, resolved.taskId))
    ) {
      throw new NotFoundException('Task not found');
    }
    return this.tasks.getDetail(resolved.taskId, userId);
  }
}
