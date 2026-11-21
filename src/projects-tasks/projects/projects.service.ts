import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ActivityAction,
  ActivityTargetType,
  ActivityVisibility,
  Prisma,
  TaskStatus,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PermissionResolver } from '../../access-control/access-control.service';
import { ActivityService } from '../../events/activity.service';
import { SeedDefinition, WorkflowService } from '../workflow/workflow.service';
import {
  WriteContext,
  assertWriteContext,
} from '../../domain-writer/write-context';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import {
  ProjectDetailDto,
  ProjectListItemDto,
} from './dto/project-response.dto';
import { UserEntity } from '../../common/entities/user.entity';
import { WorkspacesService } from '../../tenancy/workspaces/workspaces.service';

/**
 * Tasks that take part in progress: no specific status (Inbox / unmapped) or a status
 * not flagged excludeFromProgress. Written as an explicit null-or-false OR because
 * `NOT (x IN (...))` is NULL, not true, for a task without a status.
 */
const COUNTS_FOR_PROGRESS: Prisma.TaskWhereInput = {
  OR: [
    { workflowStatusId: null },
    { workflowStatus: { excludeFromProgress: false } },
  ],
};

/** Server-side-only additions to a project create (see ProjectsService.create). */
export interface ProjectCreateExtras {
  workflow?: {
    statuses: SeedDefinition[];
    transitions?: Array<{ from: number; to: number }>;
    enforceTransitions?: boolean;
  };
}

@Injectable()
export class ProjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissionResolver: PermissionResolver,
    private readonly workspacesService: WorkspacesService,
    private readonly activityService: ActivityService,
    private readonly workflow: WorkflowService,
  ) {}

  /** `ctx` omitted = original behaviour (ADR-0003 decision 1). */
  /**
   * `extras` is SERVER-SIDE ONLY (the template applier, step 3.6): no DTO reaches it. It replaces
   * the default four statuses with the given workflow, in the same transaction. Transitions refer
   * to statuses by their INDEX in `statuses`.
   */
  async create(
    dto: CreateProjectDto,
    createdById: string,
    ctx?: WriteContext,
    extras?: ProjectCreateExtras,
  ) {
    if (ctx) assertWriteContext(ctx);
    const db = ctx?.tx ?? this.prisma;

    const workspace = await db.workspace.findUnique({
      where: { id: dto.workspaceId },
    });
    if (!workspace) throw new NotFoundException('Workspace not found');

    // ADR-0006 decision 2: a project is born with its four statuses, in the same
    // transaction, whether or not FEATURE_WORKFLOW is on (flipping it later then
    // needs no backfill). Inside a DomainWriter run the caller's transaction is joined.
    const insert = async (client: Prisma.TransactionClient) => {
      const created = await client.project.create({
        data: {
          workspaceId: dto.workspaceId,
          name: dto.name,
          description: dto.description,
          createdById,
        },
      });
      await this.workflow.seedDefaults(client, created.id, extras?.workflow?.statuses);
      if (extras?.workflow) {
        const { transitions, enforceTransitions } = extras.workflow;
        if (transitions?.length) {
          const rows = await client.workflowStatus.findMany({
            where: { projectId: created.id },
            orderBy: { position: 'asc' },
            select: { id: true },
          });
          await client.workflowTransition.createMany({
            data: transitions.map((t) => ({
              projectId: created.id,
              fromStatusId: rows[t.from].id,
              toStatusId: rows[t.to].id,
            })),
          });
        }
        if (enforceTransitions) {
          await client.project.update({ where: { id: created.id }, data: { enforceTransitions: true } });
        }
      }
      return client.project.findUniqueOrThrow({ where: { id: created.id } });
    };
    const project = ctx?.tx
      ? await insert(ctx.tx)
      : await this.prisma.$transaction(insert);

    await this.activityService.record(
      {
        actorId: ctx ? ctx.actorId : createdById,
        action: ActivityAction.CREATED,
        targetType: ActivityTargetType.PROJECT,
        targetId: project.id,
        workspaceId: project.workspaceId,
      },
      ctx,
    );

    return project;
  }

  /**
   * @RequireAccess doesn't fit GET reads that must include CLIENT-tier
   * Tier1-only ProjectMembers (CLIENT is false for nearly every named
   * action in ROLE_PERMISSIONS by design). Gated instead via
   * PermissionResolver.hasProjectLevelAccess — see access-control.service.ts.
   */
  async assertCanView(userId: string, projectId: string): Promise<void> {
    if (
      !(await this.permissionResolver.hasProjectLevelAccess(userId, projectId))
    ) {
      throw new ForbiddenException('You do not have access to this project');
    }
  }

  async getDetail(
    projectId: string,
    userId: string,
  ): Promise<ProjectDetailDto> {
    await this.assertCanView(userId, projectId);

    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        name: true,
        status: true,
        workspaceId: true,
        description: true,
      },
    });
    if (!project) throw new NotFoundException('Project not found');

    const [taskCount, progress, members, recentActivityRows] =
      await Promise.all([
        this.prisma.task.count({ where: { projectId, isArchived: false } }),
        this.computeProgress(projectId),
        this.listMembersRaw(projectId, project.workspaceId),
        this.prisma.activity.findMany({
          where: {
            targetType: ActivityTargetType.PROJECT,
            targetId: projectId,
            visibility: ActivityVisibility.TIMELINE,
          },
          orderBy: { createdAt: 'desc' },
          take: 5,
          select: {
            id: true,
            action: true,
            actorId: true,
            metadata: true,
            createdAt: true,
          },
        }),
      ]);

    return {
      id: project.id,
      name: project.name,
      status: project.status,
      workspaceId: project.workspaceId,
      description: project.description,
      taskCount,
      progress,
      memberCount: members.length,
      recentActivity: recentActivityRows,
    };
  }

  async listByWorkspace(
    workspaceId: string,
    userId: string,
    pagination: PaginationDto,
  ): Promise<{
    data: ProjectListItemDto[];
    total: number;
    take: number;
    skip: number;
  }> {
    // Workspace-level list: Tier1-only (project-scoped) users don't get a
    // meaningful "all projects in this workspace" view — they only ever
    // reach a project directly (GET /me/projects, or a link). Requiring
    // genuine workspace-level access here is consistent with that.
    if (
      !(await this.permissionResolver.hasWorkspaceLevelAccess(
        userId,
        workspaceId,
      ))
    ) {
      throw new ForbiddenException('You do not have access to this workspace');
    }

    const [rows, total] = await Promise.all([
      this.prisma.project.findMany({
        where: { workspaceId },
        select: {
          id: true,
          name: true,
          status: true,
          workspaceId: true,
          _count: { select: { tasks: true } },
        },
        take: pagination.take,
        skip: pagination.skip,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.project.count({ where: { workspaceId } }),
    ]);

    const data = await Promise.all(
      rows.map(async (row) => ({
        id: row.id,
        name: row.name,
        status: row.status,
        workspaceId: row.workspaceId,
        taskCount: row._count.tasks,
        progress: await this.computeProgress(row.id),
      })),
    );

    return { data, total, take: pagination.take, skip: pagination.skip };
  }

  /** GET /me/projects — direct ProjectMember access only, independent of any Account/Workspace tier. */
  async listMyProjects(userId: string, pagination: PaginationDto) {
    const [rows, total] = await Promise.all([
      this.prisma.projectMember.findMany({
        where: { userId },
        select: {
          role: true,
          project: {
            select: {
              id: true,
              name: true,
              status: true,
              workspaceId: true,
              _count: { select: { tasks: true } },
            },
          },
        },
        take: pagination.take,
        skip: pagination.skip,
        orderBy: { joinedAt: 'desc' },
      }),
      this.prisma.projectMember.count({ where: { userId } }),
    ]);

    const data = rows.map((r) => ({
      role: r.role,
      project: {
        id: r.project.id,
        name: r.project.name,
        status: r.project.status,
        workspaceId: r.project.workspaceId,
        taskCount: r.project._count.tasks,
      },
    }));

    return { data, total, take: pagination.take, skip: pagination.skip };
  }

  async update(projectId: string, dto: UpdateProjectDto, actorId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
    });
    if (!project) throw new NotFoundException('Project not found');

    const updated = await this.prisma.project.update({
      where: { id: projectId },
      data: dto,
    });

    const changes: ActivityAction[] = [];
    if (dto.status !== undefined && dto.status !== project.status)
      changes.push(ActivityAction.STATUS_CHANGED);
    if (
      dto.description !== undefined &&
      dto.description !== project.description
    )
      changes.push(ActivityAction.DESCRIPTION_UPDATED);

    await Promise.all(
      changes.map((action) =>
        this.activityService.record({
          actorId,
          action,
          targetType: ActivityTargetType.PROJECT,
          targetId: projectId,
          workspaceId: project.workspaceId,
        }),
      ),
    );

    return updated;
  }

  async delete(projectId: string): Promise<void> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
    });
    if (!project) throw new NotFoundException('Project not found');
    await this.prisma.project.delete({ where: { id: projectId } });
  }

  /**
   * archiveProject now routes through PermissionResolver via
   * @RequireAccess exclusively — no inline isOwner||isAdmin check here.
   * FORBIDDEN PATTERN per Permission Resolution module: no service method
   * contains its own permission logic.
   */
  async archive(projectId: string, actorId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
    });
    if (!project) throw new NotFoundException('Project not found');
    const updated = await this.prisma.project.update({
      where: { id: projectId },
      data: { status: 'ARCHIVED' },
    });
    await this.activityService.record({
      actorId,
      action: ActivityAction.ARCHIVED,
      targetType: ActivityTargetType.PROJECT,
      targetId: projectId,
      workspaceId: project.workspaceId,
    });
    return updated;
  }

  /**
   * FIX: prisma.task.groupBy, not fetch-then-.length. Replaces the
   * confirmed bug where getProjectStats fetched EVERY task in FULL just
   * to call .length on the array.
   */
  async getStats(projectId: string, userId: string) {
    await this.assertCanView(userId, projectId);

    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true },
    });
    if (!project) throw new NotFoundException('Project not found');

    const grouped = await this.prisma.task.groupBy({
      by: ['status'],
      where: { projectId, isArchived: false },
      _count: true,
    });

    const counts: Record<TaskStatus, number> = {
      TODO: 0,
      IN_PROGRESS: 0,
      BLOCKED: 0,
      DONE: 0,
    };
    for (const row of grouped) {
      counts[row.status] = row._count;
    }

    // `counts`/`total` are real TASK counts (parents and subtasks alike); only
    // `progress` is leaf-based, via the one shared computation.
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
    const progress = await this.computeProgress(projectId);

    return { counts, total, progress };
  }

  /**
   * GET /projects/:id/members — UNIONS workspace-tier access (via
   * WorkspacesService.listMembers, which already unions AccountMember/
   * team-access/collaborator/guest) WITH this project's own ProjectMember
   * rows, so CLIENT-tier/project-scoped users with NO workspace-tier
   * access at all still show up (needed for @-mention search on a
   * project-targeted comment).
   */
  async listMembers(projectId: string, userId: string) {
    await this.assertCanView(userId, projectId);

    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { workspaceId: true },
    });
    if (!project) throw new NotFoundException('Project not found');

    return this.listMembersRaw(projectId, project.workspaceId);
  }

  /**
   * Computed at read time from task status counts, never stored — kills
   * the "stale progress after status change" bug class entirely. Same
   * groupBy shape as getStats, reused here for the list/detail progress
   * field.
   *
   * ADR-0005 decision 6: counts LEAVES only - non-archived tasks that have no
   * non-archived subtask. A parent is a container and is not counted, so work is
   * never counted twice. In a project with no subtasks every task is a leaf and
   * this is exactly the old `done / total` (the characterization test is the
   * guard). getStats() delegates here so the two can never disagree.
   */
  async computeProgress(projectId: string): Promise<number> {
    // ADR-0006 decision 10: a task whose status is excludeFromProgress (Canceled)
    // is removed BEFORE leaves are computed - it behaves as if it did not exist.
    // So a parent whose subtasks are all excluded is a leaf itself.
    const grouped = await this.prisma.task.groupBy({
      by: ['status'],
      where: {
        projectId,
        isArchived: false,
        ...COUNTS_FOR_PROGRESS,
        children: { none: { isArchived: false, ...COUNTS_FOR_PROGRESS } },
      },
      _count: true,
    });

    let total = 0;
    let done = 0;
    for (const row of grouped) {
      total += row._count;
      if (row.status === TaskStatus.DONE) done = row._count;
    }

    return total === 0 ? 0 : Math.round((done / total) * 100);
  }

  /** Shared by getDetail (memberCount) and listMembers (full union) — no visibility check, callers already gate. */
  private async listMembersRaw(projectId: string, workspaceId: string) {
    const [workspaceMembers, projectMembers] = await Promise.all([
      this.workspacesService.listMembers(workspaceId),
      this.prisma.projectMember.findMany({
        where: { projectId },
        include: { user: true },
      }),
    ]);

    const byUserId = new Map<string, { user: UserEntity; sources: string[] }>();
    for (const m of workspaceMembers) {
      byUserId.set(m.user.id, { user: m.user, sources: [...m.sources] });
    }
    for (const pm of projectMembers) {
      const existing = byUserId.get(pm.userId);
      const source = `project:${pm.role}`;
      if (existing) {
        existing.sources.push(source);
      } else {
        byUserId.set(pm.userId, {
          user: new UserEntity(pm.user),
          sources: [source],
        });
      }
    }

    return Array.from(byUserId.values());
  }
}
