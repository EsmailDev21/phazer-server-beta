import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { IssueType, Prisma } from '@prisma/client';
import { PermissionResolver } from '../../access-control/access-control.service';
import { PrismaService } from '../../prisma/prisma.service';
import { MAX_ISSUE_TYPES_PER_WORKSPACE } from '../iterations/iteration-rules';
import { normalizeName } from '../planning/normalize-name';
import { CreateIssueTypeDto, UpdateIssueTypeDto } from './dto/issue-type.dto';

export interface IssueTypeDto {
  id: string;
  workspaceId: string;
  name: string;
  icon: string | null;
  color: string;
  level: string;
}

const toDto = (t: IssueType): IssueTypeDto => ({
  id: t.id,
  workspaceId: t.workspaceId,
  name: t.name,
  icon: t.icon,
  color: t.color,
  level: t.level,
});

/**
 * ADR-0007. Workspace-level issue types. Writes are `manageWorkflow` (route guard on
 * the workspace id); reads need only workspace-level access, like tags. Uniqueness is
 * the database's job (name_key), mapped to 409 - no check-then-insert race.
 * Deleting a type never touches tasks beyond clearing their pointer (null = untyped).
 */
@Injectable()
export class IssueTypesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissionResolver: PermissionResolver,
  ) {}

  async list(workspaceId: string, userId: string) {
    await this.assertCanRead(workspaceId, userId);
    const rows = await this.prisma.issueType.findMany({
      where: { workspaceId },
      orderBy: { nameKey: 'asc' },
      include: { _count: { select: { tasks: true } } },
    });
    return rows.map((r) => ({ ...toDto(r), taskCount: r._count.tasks }));
  }

  async create(workspaceId: string, dto: CreateIssueTypeDto) {
    const { name, nameKey } = normalizeName(dto.name, 'Issue type name', 100);
    const ws = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true },
    });
    if (!ws) throw new NotFoundException('Workspace not found');
    const count = await this.prisma.issueType.count({ where: { workspaceId } });
    if (count >= MAX_ISSUE_TYPES_PER_WORKSPACE) {
      throw new ConflictException(
        `A workspace can have at most ${MAX_ISSUE_TYPES_PER_WORKSPACE} issue types`,
      );
    }
    try {
      const created = await this.prisma.issueType.create({
        data: {
          workspaceId,
          name,
          nameKey,
          icon: dto.icon,
          color: dto.color,
          level: dto.level,
        },
      });
      return toDto(created);
    } catch (err) {
      throw this.mapUnique(err, name);
    }
  }

  async update(workspaceId: string, typeId: string, dto: UpdateIssueTypeDto) {
    await this.getOrThrow(workspaceId, typeId);
    const renamed =
      dto.name !== undefined
        ? normalizeName(dto.name, 'Issue type name', 100)
        : null;
    try {
      const updated = await this.prisma.issueType.update({
        where: { id: typeId },
        data: {
          ...(renamed ?? {}),
          ...(dto.icon !== undefined ? { icon: dto.icon } : {}),
          ...(dto.color !== undefined ? { color: dto.color } : {}),
          ...(dto.level !== undefined ? { level: dto.level } : {}),
        },
      });
      return toDto(updated);
    } catch (err) {
      throw this.mapUnique(err, renamed?.name ?? '');
    }
  }

  async delete(workspaceId: string, typeId: string): Promise<void> {
    await this.getOrThrow(workspaceId, typeId);
    // tasks.issue_type_id is ON DELETE SET NULL: affected tasks become untyped.
    await this.prisma.issueType.delete({ where: { id: typeId } });
  }

  private async getOrThrow(workspaceId: string, typeId: string) {
    const t = await this.prisma.issueType.findFirst({
      where: { id: typeId, workspaceId },
    });
    if (!t) throw new NotFoundException('Issue type not found');
    return t;
  }

  private async assertCanRead(workspaceId: string, userId: string) {
    if (
      !(await this.permissionResolver.hasWorkspaceLevelAccess(
        userId,
        workspaceId,
      ))
    ) {
      throw new ForbiddenException('You do not have access to this workspace');
    }
  }

  private mapUnique(err: unknown, name: string): unknown {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    ) {
      return new ConflictException(
        `An issue type named "${name}" already exists in this workspace (names are case-insensitive)`,
      );
    }
    return err;
  }
}
