import { ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma, TaskStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PermissionResolver } from '../../access-control/access-control.service';

interface TaskFilters {
  workspaceId: string;
  projectId?: string;
  status?: TaskStatus;
  assigneeId?: string;
}

/**
 * TaskVisibilityService — "CONFIRMED GOOD in the old audit, preserved
 * as-is" per the graph, but this is a from-scratch rebuild with no prior
 * implementation to preserve. The exact rule below was confirmed
 * explicitly (Projects/Tasks module review) rather than inferred:
 *
 *   - A user with genuine WORKSPACE-LEVEL access (Tier2 WorkspaceCollaborator/
 *     Guest/team-access, or Tier3 AccountMember/personal owner) sees ALL
 *     tasks in the workspace, regardless of assignment — "MEMBER/VIEWER:
 *     view everything in scope."
 *   - A user whose ONLY access is one or more ProjectMember (Tier1) rows —
 *     NO workspace-level tier at all — sees ONLY tasks in the project(s)
 *     they're a ProjectMember of. This applies to ANY Tier1-only role, not
 *     just CLIENT (confirmed via the "Sarah" example: a Tier1-only MEMBER
 *     is scoped exactly like CLIENT — a ProjectMember row never implies
 *     workspace-wide visibility on its own).
 *   - Inbox tasks (projectId === null) are only visible to workspace-level
 *     users — a Tier1-only ProjectMember has no route to them, since Inbox
 *     tasks have no project to be a ProjectMember of.
 *
 * ASSUMPTION (explicitly left to our judgment, documented per instruction):
 * no additional team-based task filtering beyond what workspace-tier
 * access already implies via WorkspaceTeamAccess/TeamMember — the schema
 * has no per-task or per-project Team link (Task.assignees is User[], not
 * Team[]), so "team-scoped visibility" in the graph is read as referring
 * to HOW org users obtain their workspace tier, not a separate per-task
 * team filter layered on top. Revisit if that's wrong.
 *
 * Two real layers, per the graph: PermissionResolver.hasWorkspaceLevelAccess
 * says CAN you see into this workspace at all; this service says WHICH
 * tasks, once that's established.
 */
@Injectable()
export class TaskVisibilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissionResolver: PermissionResolver,
  ) {}

  /**
   * Resolves the caller's access shape for a workspace: either full
   * visibility, or the specific set of projectIds they're scoped to via
   * ProjectMember. Throws if the user has NEITHER.
   */
  private async resolveAccess(
    userId: string,
    workspaceId: string,
  ): Promise<{
    hasWorkspaceLevelAccess: boolean;
    allowedProjectIds: string[];
  }> {
    const hasWorkspaceLevelAccess =
      await this.permissionResolver.hasWorkspaceLevelAccess(
        userId,
        workspaceId,
      );
    if (hasWorkspaceLevelAccess) {
      return { hasWorkspaceLevelAccess: true, allowedProjectIds: [] };
    }

    const memberships = await this.prisma.projectMember.findMany({
      where: { userId, project: { workspaceId } },
      select: { projectId: true },
    });

    if (memberships.length === 0) {
      throw new ForbiddenException('You do not have access to this workspace');
    }

    return {
      hasWorkspaceLevelAccess: false,
      allowedProjectIds: memberships.map((m) => m.projectId),
    };
  }

  async buildVisibleTasksWhere(
    userId: string,
    filters: TaskFilters,
  ): Promise<Prisma.TaskWhereInput> {
    const access = await this.resolveAccess(userId, filters.workspaceId);

    if (
      !access.hasWorkspaceLevelAccess &&
      filters.projectId &&
      !access.allowedProjectIds.includes(filters.projectId)
    ) {
      throw new ForbiddenException('You do not have access to this project');
    }

    return {
      workspaceId: filters.workspaceId,
      isArchived: false,
      ...(filters.status && { status: filters.status }),
      ...(filters.assigneeId && {
        assignees: { some: { id: filters.assigneeId } },
      }),
      ...(filters.projectId
        ? { projectId: filters.projectId }
        : !access.hasWorkspaceLevelAccess
          ? { projectId: { in: access.allowedProjectIds } }
          : {}),
    };
  }

  async canViewTask(userId: string, taskId: string): Promise<boolean> {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { workspaceId: true, projectId: true },
    });
    if (!task) return false;

    if (
      await this.permissionResolver.hasWorkspaceLevelAccess(
        userId,
        task.workspaceId,
      )
    ) {
      return true;
    }

    // Inbox task (no project) — Tier1-only users have no route to it.
    if (!task.projectId) return false;

    const membership = await this.prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId: task.projectId, userId } },
    });
    return membership !== null;
  }

  async assertCanView(userId: string, taskId: string): Promise<void> {
    if (!(await this.canViewTask(userId, taskId))) {
      throw new ForbiddenException('You do not have access to this task');
    }
  }
}
