import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma, SavedView, SavedViewLayout } from '@prisma/client';
import { PermissionResolver } from '../access-control/access-control.service';
import { RuleIssue, WorkspaceContextLoader } from '../automations/dsl';
import { PrismaService } from '../prisma/prisma.service';
import { TaskQueryResult, TaskQueryService } from './run/task-query.service';
import { viewFilters } from './run/view-filters';
import { normalizeName } from '../projects-tasks/planning/normalize-name';
import {
  CreateViewDto,
  ListViewsQueryDto,
  UpdateViewDto,
  ValidateViewDto,
} from './dto/view.dto';
import {
  VIEW_LIMITS as L,
  ViewConfigV1,
  checkViewSemantics,
  collectViewCustomUserIds,
  collectViewReferences,
  validateViewConfig,
} from './dsl';

export interface ViewDto {
  id: string;
  workspaceId: string;
  projectId: string | null;
  ownerId: string | null;
  name: string;
  layout: SavedViewLayout;
  config: Prisma.JsonValue;
  isShared: boolean;
  position: number;
  createdAt: Date;
  updatedAt: Date;
  /** Can THIS caller change or delete it? (personal: its owner; shared: an admin) */
  canEdit: boolean;
  /** Only on `get`: what is wrong with the config NOW (a tag or field it names may have been deleted since). */
  problems?: RuleIssue[];
}

export interface ViewValidationReport {
  valid: boolean;
  issues: RuleIssue[];
}

/**
 * Step 5.4. Saved views: a layout plus a config (filters, grouping, sort, columns) checked against
 * the workspace's real fields. Running a view is not part of this step.
 *
 *  PERSONAL: only its owner sees or changes it (anyone else gets 404, not 403: no existence leak).
 *  SHARED:   every workspace member sees it; creating, changing, sharing, unsharing or deleting one
 *            needs `editWorkspace` (an admin), whoever made it. It outlives its owner.
 *  A view of a project needs access to that project, to see it as well as to make it.
 *  `projectId` is fixed at creation: statuses are per project, so moving a view would silently break it.
 */
@Injectable()
export class ViewsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: PermissionResolver,
    private readonly contextLoader: WorkspaceContextLoader,
    private readonly taskQuery: TaskQueryService,
  ) {}

  // ------------------------------------------------------------------ reads -------------------
  async list(
    workspaceId: string,
    userId: string,
    query: ListViewsQueryDto,
  ): Promise<ViewDto[]> {
    await this.assertCanRead(workspaceId, userId);
    const rows = await this.prisma.savedView.findMany({
      where: {
        workspaceId,
        OR: [{ isShared: true }, { ownerId: userId }],
        ...(query.projectId
          ? {
              AND: [
                { OR: [{ projectId: query.projectId }, { projectId: null }] },
              ],
            }
          : {}),
        ...(query.layout ? { layout: query.layout } : {}),
        ...(query.shared !== undefined ? { isShared: query.shared } : {}),
      },
      // shared views first, then the caller's own; each list by its own positions (they are numbered separately)
      orderBy: [
        { isShared: 'desc' },
        { position: 'asc' },
        { createdAt: 'asc' },
        { id: 'asc' },
      ],
      take: L.maxPersonalPerUserPerWorkspace + L.maxSharedPerWorkspace,
    });
    const visible = await this.filterByProjectAccess(rows, userId);
    const admin = await this.isAdmin(userId, workspaceId);
    return visible.map((r) => this.toDto(r, userId, admin));
  }

  async get(workspaceId: string, id: string, userId: string): Promise<ViewDto> {
    await this.assertCanRead(workspaceId, userId);
    const row = await this.loadVisible(workspaceId, id, userId);
    const dto = this.toDto(
      row,
      userId,
      await this.isAdmin(userId, workspaceId),
    );
    const parsed = validateViewConfig(row.layout, row.config);
    dto.problems =
      parsed.ok === true
        ? await this.semanticIssues(
            workspaceId,
            row.layout,
            row.projectId,
            parsed.config,
          )
        : parsed.issues;
    return dto;
  }

  // ------------------------------------------------------------------ running -----------------
  /**
   * The tasks a saved view shows, for THIS caller: their project access applies and `ME` is them. A view
   * that has gone stale (it names something deleted) answers 422 with its issues rather than a wrong list.
   */
  async run(
    workspaceId: string,
    id: string,
    userId: string,
    paging: { limit?: number; cursor?: string },
  ): Promise<TaskQueryResult> {
    await this.assertCanRead(workspaceId, userId);
    const row = await this.loadVisible(workspaceId, id, userId);
    return this.runConfig(
      workspaceId,
      userId,
      row.layout,
      row.projectId,
      row.config,
      paging,
    );
  }

  /** Run a config that is not saved (the editor's preview). Same checks as saving it. */
  async runConfig(
    workspaceId: string,
    userId: string,
    layout: SavedViewLayout,
    projectId: string | null,
    config: unknown,
    paging: { limit?: number; cursor?: string },
  ): Promise<TaskQueryResult> {
    await this.assertCanRead(workspaceId, userId);
    if (projectId)
      await this.assertProjectUsable(workspaceId, projectId, userId);
    const report = await this.report(workspaceId, layout, projectId, config);
    this.assertValid(report);
    const parsed = validateViewConfig(layout, config);
    if (parsed.ok === false) {
      this.assertValid({ valid: false, issues: parsed.issues });
      throw new Error('unreachable'); // assertValid throws for an invalid report
    }
    return this.taskQuery.run({
      workspaceId,
      userId,
      projectId,
      filters: viewFilters(parsed.config),
      limit: paging.limit,
      cursor: paging.cursor,
    });
  }

  // ------------------------------------------------------------------ dry run -----------------
  async validate(
    workspaceId: string,
    userId: string,
    dto: ValidateViewDto,
  ): Promise<ViewValidationReport> {
    if (dto.projectId)
      await this.assertProjectUsable(workspaceId, dto.projectId, userId);
    return this.report(
      workspaceId,
      dto.layout,
      dto.projectId ?? null,
      dto.config,
    );
  }

  // ------------------------------------------------------------------ writes ------------------
  async create(
    workspaceId: string,
    userId: string,
    dto: CreateViewDto,
  ): Promise<ViewDto> {
    const { name, nameKey } = normalizeName(dto.name, 'Name', L.maxNameLength);
    if (dto.projectId)
      await this.assertProjectUsable(workspaceId, dto.projectId, userId);
    const report = await this.report(
      workspaceId,
      dto.layout,
      dto.projectId ?? null,
      dto.config,
    );
    this.assertValid(report);
    const shared = dto.isShared === true;
    if (shared) await this.assertAdmin(userId, workspaceId);

    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM workspaces WHERE id = ${workspaceId} FOR UPDATE`; // serialises the caps below
        await this.assertRoom(tx, workspaceId, userId, shared);
        const position =
          dto.position ??
          (await this.nextPosition(tx, workspaceId, userId, shared));
        const row = await tx.savedView.create({
          data: {
            workspaceId,
            projectId: dto.projectId ?? null,
            ownerId: userId,
            name,
            nameKey,
            layout: dto.layout,
            config: dto.config as Prisma.InputJsonValue,
            isShared: shared,
            position,
          },
        });
        return this.toDto(
          row,
          userId,
          shared ? true : await this.isAdmin(userId, workspaceId),
        );
      });
    } catch (err) {
      throw this.mapWriteError(err);
    }
  }

  async update(
    workspaceId: string,
    id: string,
    userId: string,
    dto: UpdateViewDto,
  ): Promise<ViewDto> {
    await this.assertCanRead(workspaceId, userId);
    const current = await this.loadVisible(workspaceId, id, userId);
    const sharing =
      dto.isShared !== undefined && dto.isShared !== current.isShared;
    // a shared view (and the act of sharing a personal one) is the team's: an admin's call
    if (current.isShared || dto.isShared === true)
      await this.assertAdmin(userId, workspaceId);

    const data: Prisma.SavedViewUpdateInput = {};
    if (dto.name !== undefined) {
      const n = normalizeName(dto.name, 'Name', L.maxNameLength);
      data.name = n.name;
      data.nameKey = n.nameKey;
    }
    if (dto.position !== undefined) data.position = dto.position;

    if (dto.layout !== undefined || dto.config !== undefined) {
      const layout = dto.layout ?? current.layout;
      const config = dto.config ?? (current.config as Record<string, unknown>);
      const report = await this.report(
        workspaceId,
        layout,
        current.projectId,
        config,
      );
      this.assertValid(report);
      data.layout = layout;
      data.config = config as Prisma.InputJsonValue;
    }
    if (sharing) {
      data.isShared = dto.isShared;
      if (dto.isShared === false && current.ownerId === null)
        data.owner = { connect: { id: userId } }; // an ownerless shared view becomes the unsharer's
    }
    if (Object.keys(data).length === 0)
      return this.toDto(
        current,
        userId,
        await this.isAdmin(userId, workspaceId),
      );

    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM workspaces WHERE id = ${workspaceId} FOR UPDATE`;
        if (sharing) {
          const ownerForCap =
            dto.isShared === false ? (current.ownerId ?? userId) : userId;
          await this.assertRoom(
            tx,
            workspaceId,
            ownerForCap,
            dto.isShared === true,
          );
        }
        const row = await tx.savedView.update({ where: { id }, data });
        return this.toDto(row, userId, await this.isAdmin(userId, workspaceId));
      });
    } catch (err) {
      throw this.mapWriteError(err);
    }
  }

  async remove(workspaceId: string, id: string, userId: string): Promise<void> {
    await this.assertCanRead(workspaceId, userId);
    const current = await this.loadVisible(workspaceId, id, userId);
    if (current.isShared) await this.assertAdmin(userId, workspaceId);
    await this.prisma.savedView.delete({ where: { id } });
  }

  /** "Save as my own": a personal copy of any view the caller can see (typically a shared one they want to tweak). */
  async duplicate(
    workspaceId: string,
    id: string,
    userId: string,
  ): Promise<ViewDto> {
    await this.assertCanRead(workspaceId, userId);
    const src = await this.loadVisible(workspaceId, id, userId);
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM workspaces WHERE id = ${workspaceId} FOR UPDATE`;
        await this.assertRoom(tx, workspaceId, userId, false);
        const taken = new Set(
          (
            await tx.savedView.findMany({
              where: {
                workspaceId,
                projectId: src.projectId,
                ownerId: userId,
                isShared: false,
              },
              select: { nameKey: true },
            })
          ).map((r) => r.nameKey),
        );
        let name = '';
        let nameKey = '';
        for (let n = 1; n < 1000; n++) {
          const suffix = n === 1 ? ' (copy)' : ` (copy ${n})`;
          const candidate = normalizeName(
            `${src.name.slice(0, L.maxNameLength - suffix.length)}${suffix}`,
            'Name',
            L.maxNameLength,
          );
          if (!taken.has(candidate.nameKey)) {
            name = candidate.name;
            nameKey = candidate.nameKey;
            break;
          }
        }
        if (!name)
          throw new ConflictException({
            code: 'NAME_TAKEN',
            message: 'Too many copies of this view',
          });
        const row = await tx.savedView.create({
          data: {
            workspaceId,
            projectId: src.projectId,
            ownerId: userId,
            name,
            nameKey,
            layout: src.layout,
            config: src.config as Prisma.InputJsonValue,
            isShared: false,
            position: await this.nextPosition(tx, workspaceId, userId, false),
          },
        });
        return this.toDto(row, userId, await this.isAdmin(userId, workspaceId));
      });
    } catch (err) {
      throw this.mapWriteError(err);
    }
  }

  // ------------------------------------------------------------------ internals ---------------
  private toDto(r: SavedView, userId: string, admin: boolean): ViewDto {
    return {
      id: r.id,
      workspaceId: r.workspaceId,
      projectId: r.projectId,
      ownerId: r.ownerId,
      name: r.name,
      layout: r.layout,
      config: r.config,
      isShared: r.isShared,
      position: r.position,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      canEdit: r.isShared ? admin : r.ownerId === userId,
    };
  }

  private async assertCanRead(workspaceId: string, userId: string) {
    if (!(await this.resolver.hasWorkspaceLevelAccess(userId, workspaceId)))
      throw new ForbiddenException('You do not have access to this workspace');
  }

  private async isAdmin(userId: string, workspaceId: string): Promise<boolean> {
    return (
      await this.resolver.resolve(
        userId,
        'editWorkspace',
        'WORKSPACE',
        workspaceId,
      )
    ).allowed;
  }

  private async assertAdmin(userId: string, workspaceId: string) {
    if (!(await this.isAdmin(userId, workspaceId)))
      throw new ForbiddenException({
        code: 'SHARED_NEEDS_ADMIN',
        message:
          'Only an admin can create, change or remove a view shared with the workspace',
      });
  }

  /** Missing, someone else's personal view, or a project the caller cannot see: all 404, so nothing leaks. */
  private async loadVisible(
    workspaceId: string,
    id: string,
    userId: string,
  ): Promise<SavedView> {
    const row = await this.prisma.savedView.findUnique({ where: { id } });
    if (
      !row ||
      row.workspaceId !== workspaceId ||
      (!row.isShared && row.ownerId !== userId)
    )
      throw new NotFoundException('View not found');
    if (
      row.projectId &&
      !(await this.resolver.hasProjectLevelAccess(userId, row.projectId))
    )
      throw new NotFoundException('View not found');
    return row;
  }

  private async filterByProjectAccess(
    rows: SavedView[],
    userId: string,
  ): Promise<SavedView[]> {
    const projectIds = [
      ...new Set(
        rows.map((r) => r.projectId).filter((p): p is string => p !== null),
      ),
    ];
    const allowed = new Set<string>();
    for (const pid of projectIds)
      if (await this.resolver.hasProjectLevelAccess(userId, pid))
        allowed.add(pid);
    return rows.filter((r) => r.projectId === null || allowed.has(r.projectId));
  }

  private async assertProjectUsable(
    workspaceId: string,
    projectId: string,
    userId: string,
  ) {
    const p = await this.prisma.project.findFirst({
      where: { id: projectId, workspaceId },
      select: { id: true },
    });
    if (!p || !(await this.resolver.hasProjectLevelAccess(userId, projectId)))
      throw new BadRequestException('Project not found in this workspace');
  }

  private assertValid(report: ViewValidationReport) {
    if (!report.valid)
      throw new UnprocessableEntityException({
        code: 'VIEW_INVALID',
        message: 'This view is not valid',
        issues: report.issues,
      });
  }

  private async assertRoom(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    ownerId: string,
    shared: boolean,
  ) {
    if (shared) {
      if (
        (await tx.savedView.count({
          where: { workspaceId, isShared: true },
        })) >= L.maxSharedPerWorkspace
      ) {
        throw new ConflictException({
          code: 'VIEW_LIMIT',
          message: `A workspace can have at most ${L.maxSharedPerWorkspace} shared views`,
        });
      }
    } else if (
      (await tx.savedView.count({
        where: { workspaceId, ownerId, isShared: false },
      })) >= L.maxPersonalPerUserPerWorkspace
    ) {
      throw new ConflictException({
        code: 'VIEW_LIMIT',
        message: `You can have at most ${L.maxPersonalPerUserPerWorkspace} personal views in a workspace`,
      });
    }
  }

  private async nextPosition(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    ownerId: string,
    shared: boolean,
  ): Promise<number> {
    const agg = await tx.savedView.aggregate({
      where: shared
        ? { workspaceId, isShared: true }
        : { workspaceId, ownerId, isShared: false },
      _max: { position: true },
    });
    return Math.min((agg._max.position ?? -1) + 1, L.maxPosition);
  }

  private mapWriteError(err: unknown): unknown {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    ) {
      return new ConflictException({
        code: 'NAME_TAKEN',
        message:
          'You already have a view with that name here (or, for a shared view, the workspace does)',
      });
    }
    return err;
  }

  /** Structure first; only a structurally valid config is checked against the workspace. */
  private async report(
    workspaceId: string,
    layout: SavedViewLayout,
    projectId: string | null,
    config: unknown,
  ): Promise<ViewValidationReport> {
    const structural = validateViewConfig(layout, config);
    if (structural.ok === false)
      return { valid: false, issues: structural.issues };
    const issues = await this.semanticIssues(
      workspaceId,
      layout,
      projectId,
      structural.config,
    );
    return { valid: issues.length === 0, issues };
  }

  private async semanticIssues(
    workspaceId: string,
    layout: SavedViewLayout,
    projectId: string | null,
    config: ViewConfigV1,
  ): Promise<RuleIssue[]> {
    const ctx = await this.contextLoader.load(
      workspaceId,
      collectViewReferences(config, projectId),
      (typeOf) => collectViewCustomUserIds(config, typeOf),
    );
    return checkViewSemantics(layout, config, projectId, ctx);
  }
}
