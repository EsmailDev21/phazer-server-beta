import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ActivityAction,
  ActivityTargetType,
  Prisma,
  Tag,
} from '@prisma/client';
import { WriteContext } from '../../domain-writer/write-context';
import { PrismaService } from '../../prisma/prisma.service';
import { PermissionResolver } from '../../access-control/access-control.service';
import { ActivityService } from '../../events/activity.service';
import { CreateTagDto } from './dto/create-tag.dto';
import { UpdateTagDto } from './dto/update-tag.dto';
import { normalizeTagName } from './tag-name';

/** What leaves this service. `nameKey` is an implementation detail and never returned. */
export interface TagDto {
  id: string;
  name: string;
  workspaceId: string;
}

export interface TagListItemDto extends TagDto {
  taskCount: number;
}

const toDto = (t: Pick<Tag, 'id' | 'name' | 'workspaceId'>): TagDto => ({
  id: t.id,
  name: t.name,
  workspaceId: t.workspaceId,
});

/**
 * Tag definitions are workspace-scoped (`manageTags`); attaching/detaching an
 * EXISTING tag on a task is `editTask` (see action-config.ts) - that is a
 * route-level decision, enforced by @RequireAccess on the controller.
 *
 * Uniqueness is the database's job (`uq_tags_workspace_id_name_key`, on the
 * normalized key): every write just attempts the insert/update and maps the
 * unique violation to 409, so two concurrent creates of "Bug" and "bug"
 * produce exactly one winner without any check-then-insert race.
 *
 * Like every other service here, the row write and its activity row are two
 * statements, not one transaction (the pre-existing pattern; ADR-0003
 * decision 5 leaves making that atomic as its own deliberate change).
 */
@Injectable()
export class TagsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissionResolver: PermissionResolver,
    private readonly activityService: ActivityService,
  ) {}

  async create(workspaceId: string, dto: CreateTagDto): Promise<TagDto> {
    const { name, nameKey } = normalizeTagName(dto.name);

    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true },
    });
    if (!workspace) throw new NotFoundException('Workspace not found');

    try {
      const tag = await this.prisma.tag.create({
        data: { workspaceId, name, nameKey },
      });
      return toDto(tag);
    } catch (err) {
      throw this.mapUniqueViolation(err, name);
    }
  }

  /**
   * No @RequireAccess: every role that can see tasks needs the list to pick
   * from, but `manageTags` is false for some of them. Gated by genuine
   * workspace-level access instead (same shape as the task list); a
   * nonexistent workspace answers 403 like an inaccessible one.
   */
  async listByWorkspace(
    workspaceId: string,
    userId: string,
  ): Promise<TagListItemDto[]> {
    if (
      !(await this.permissionResolver.hasWorkspaceLevelAccess(
        userId,
        workspaceId,
      ))
    ) {
      throw new ForbiddenException('You do not have access to this workspace');
    }
    const rows = await this.prisma.tag.findMany({
      where: { workspaceId },
      orderBy: { nameKey: 'asc' },
      select: {
        id: true,
        name: true,
        workspaceId: true,
        _count: { select: { tasks: true } },
      },
    });
    return rows.map((r) => ({ ...toDto(r), taskCount: r._count.tasks }));
  }

  /** PATCH /tags/:id - :id is the TAG's id, so permission is checked here (same as custom fields). */
  async update(
    tagId: string,
    dto: UpdateTagDto,
    userId: string,
  ): Promise<TagDto> {
    const tag = await this.getTagOrThrow(tagId);
    await this.assertCanManage(userId, tag.workspaceId);

    const { name, nameKey } = normalizeTagName(dto.name);
    if (name === tag.name && nameKey === tag.nameKey) return toDto(tag);

    try {
      // A case-only rename ("bug" -> "Bug") keeps the same key: allowed, and
      // the unique index does not object to a row colliding with itself.
      const updated = await this.prisma.tag.update({
        where: { id: tagId },
        data: { name, nameKey },
      });
      return toDto(updated);
    } catch (err) {
      throw this.mapUniqueViolation(err, name);
    }
  }

  /**
   * Cascades to every TaskTag (onDelete: Cascade): the tag disappears from
   * every task that carried it. No per-task activity rows are written for a
   * definition delete (same stance as deleting a custom field).
   */
  async delete(tagId: string, userId: string): Promise<void> {
    const tag = await this.getTagOrThrow(tagId);
    await this.assertCanManage(userId, tag.workspaceId);
    await this.prisma.tag.delete({ where: { id: tagId } });
  }

  /**
   * PUT /tasks/:id/tags/:tagId. Idempotent: attaching an already-attached tag
   * is a 200 and writes NO second activity row. `createMany` +
   * `skipDuplicates` makes "did I add it" a single atomic fact (count 1 vs 0),
   * so concurrent attaches cannot both log it.
   */
  async attach(
    taskId: string,
    tagId: string,
    actorId: string,
    ctx?: WriteContext,
  ): Promise<TagDto> {
    const { task, tag } = await this.loadTaskAndTag(taskId, tagId);

    const { count } = await this.prisma.taskTag.createMany({
      data: [{ taskId, tagId }],
      skipDuplicates: true,
    });

    if (count === 1) {
      const params = {
        actorId,
        action: ActivityAction.TAG_ADDED,
        targetType: ActivityTargetType.TASK,
        targetId: taskId,
        workspaceId: task.workspaceId,
        metadata: { tagId, tagName: tag.name },
      };
      await (ctx
        ? this.activityService.record(params, ctx)
        : this.activityService.record(params));
    }
    return toDto(tag);
  }

  /** DELETE /tasks/:id/tags/:tagId. 404 if it was not attached (as deleting an unset custom value does). */
  async detach(
    taskId: string,
    tagId: string,
    actorId: string,
    ctx?: WriteContext,
  ): Promise<void> {
    const { task, tag } = await this.loadTaskAndTag(taskId, tagId);

    const { count } = await this.prisma.taskTag.deleteMany({
      where: { taskId, tagId },
    });
    if (count === 0) {
      throw new NotFoundException('Tag is not attached to this task');
    }

    const params = {
      actorId,
      action: ActivityAction.TAG_REMOVED,
      targetType: ActivityTargetType.TASK,
      targetId: taskId,
      workspaceId: task.workspaceId,
      metadata: { tagId, tagName: tag.name },
    };
    await (ctx
      ? this.activityService.record(params, ctx)
      : this.activityService.record(params));
  }

  // ---- internals ----

  private async loadTaskAndTag(taskId: string, tagId: string) {
    const [task, tag] = await Promise.all([
      this.prisma.task.findUnique({
        where: { id: taskId },
        select: { id: true, workspaceId: true },
      }),
      this.prisma.tag.findUnique({ where: { id: tagId } }),
    ]);
    if (!task) throw new NotFoundException('Task not found');
    if (!tag) throw new NotFoundException('Tag not found');
    if (tag.workspaceId !== task.workspaceId) {
      throw new BadRequestException(
        "This tag does not belong to this task's workspace",
      );
    }
    return { task, tag };
  }

  private async getTagOrThrow(tagId: string): Promise<Tag> {
    const tag = await this.prisma.tag.findUnique({ where: { id: tagId } });
    if (!tag) throw new NotFoundException('Tag not found');
    return tag;
  }

  private async assertCanManage(
    userId: string,
    workspaceId: string,
  ): Promise<void> {
    const result = await this.permissionResolver.resolve(
      userId,
      'manageTags',
      'WORKSPACE',
      workspaceId,
    );
    if (!result.allowed) {
      throw new ForbiddenException(
        result.reason ?? 'You do not have permission to manage tags here',
      );
    }
  }

  private mapUniqueViolation(err: unknown, name: string): unknown {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    ) {
      return new ConflictException(
        `A tag named "${name}" already exists in this workspace (names are case-insensitive)`,
      );
    }
    return err;
  }
}
