import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { FieldType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PermissionResolver } from '../../access-control/access-control.service';
import {
  WriteContext,
  assertWriteContext,
} from '../../domain-writer/write-context';
import { CreateCustomFieldDto } from './dto/create-custom-field.dto';
import { UpdateCustomFieldDto } from './dto/update-custom-field.dto';

@Injectable()
export class CustomFieldsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissionResolver: PermissionResolver,
  ) {}

  /** `ctx` omitted = original behaviour (ADR-0003 decision 1). */
  async create(
    workspaceId: string,
    dto: CreateCustomFieldDto,
    ctx?: WriteContext,
  ) {
    if (ctx) assertWriteContext(ctx);
    const db = ctx?.tx ?? this.prisma;
    const workspace = await db.workspace.findUnique({
      where: { id: workspaceId },
    });
    if (!workspace) throw new NotFoundException('Workspace not found');

    this.assertOptionsValidForType(dto.dataType, dto.options);

    return db.customField.create({
      data: {
        workspaceId,
        name: dto.name,
        key: dto.key,
        dataType: dto.dataType,
        options: dto.options,
        order: dto.order ?? 0,
      },
    });
  }

  async listByWorkspace(workspaceId: string) {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
    });
    if (!workspace) throw new NotFoundException('Workspace not found');

    return this.prisma.customField.findMany({
      where: { workspaceId },
      orderBy: { order: 'asc' },
    });
  }

  /**
   * PATCH /custom-fields/:id — the route param is the FIELD's own id, not
   * a workspaceId, so the standard @RequireAccess(manageCustomFields)
   * decorator (which auto-extracts targetId from :id and treats it as a
   * WORKSPACE id) would resolve the wrong resource. Manual permission
   * check here instead, same pattern as InvitesService's dynamic checks.
   */
  async update(fieldId: string, dto: UpdateCustomFieldDto, userId: string) {
    const field = await this.getFieldOrThrow(fieldId);
    await this.assertCanManage(userId, field.workspaceId);

    if (dto.options !== undefined) {
      this.assertOptionsValidForType(field.dataType, dto.options);
    }

    return this.prisma.customField.update({
      where: { id: fieldId },
      data: dto,
    });
  }

  /**
   * DELETE cascades to every TaskCustomValue referencing it (onDelete:
   * Cascade, already in schema.prisma) — deleting a field definition
   * silently removes its values from every task that had one set. Not
   * soft-deleted: field values aren't auditable history the way Account
   * data is, no grace-period needed.
   */
  async delete(fieldId: string, userId: string): Promise<void> {
    const field = await this.getFieldOrThrow(fieldId);
    await this.assertCanManage(userId, field.workspaceId);
    await this.prisma.customField.delete({ where: { id: fieldId } });
  }

  /**
   * PUT /tasks/:id/custom-values/:fieldId — validates value against
   * field.dataType (and field.options for SELECT/MULTI_SELECT) BEFORE the
   * write, non-negotiable per the schema-phase Custom Fields decision.
   */
  async setValue(
    taskId: string,
    fieldId: string,
    value: unknown,
    ctx?: WriteContext,
  ) {
    if (ctx) assertWriteContext(ctx);
    const db = ctx?.tx ?? this.prisma;
    const task = await db.task.findUnique({
      where: { id: taskId },
      select: { id: true, workspaceId: true },
    });
    if (!task) throw new NotFoundException('Task not found');

    const field = await this.getFieldOrThrow(fieldId, db);
    if (field.workspaceId !== task.workspaceId) {
      throw new BadRequestException(
        "This custom field does not belong to this task's workspace",
      );
    }

    this.validateValue(field.dataType, field.options as string[] | null, value);

    return db.taskCustomValue.upsert({
      where: { taskId_fieldId: { taskId, fieldId } },
      update: { value: value as object },
      create: { taskId, fieldId, value: value as object },
    });
  }

  async deleteValue(taskId: string, fieldId: string): Promise<void> {
    await this.prisma.taskCustomValue
      .delete({ where: { taskId_fieldId: { taskId, fieldId } } })
      .catch(() => {
        throw new NotFoundException('No value set for this field on this task');
      });
  }

  // ---- internals ----

  private async getFieldOrThrow(
    fieldId: string,
    db: Pick<PrismaService, 'customField'> = this.prisma,
  ) {
    const field = await db.customField.findUnique({
      where: { id: fieldId },
    });
    if (!field) throw new NotFoundException('Custom field not found');
    return field;
  }

  private async assertCanManage(
    userId: string,
    workspaceId: string,
  ): Promise<void> {
    const result = await this.permissionResolver.resolve(
      userId,
      'manageCustomFields',
      'WORKSPACE',
      workspaceId,
    );
    if (!result.allowed) {
      throw new ForbiddenException(
        result.reason ??
          'You do not have permission to manage custom fields here',
      );
    }
  }

  private assertOptionsValidForType(
    dataType: FieldType,
    options?: string[],
  ): void {
    const requiresOptions =
      dataType === FieldType.SELECT || dataType === FieldType.MULTI_SELECT;
    if (requiresOptions && (!options || options.length === 0)) {
      throw new BadRequestException(
        `options is required for ${dataType} fields`,
      );
    }
    if (!requiresOptions && options !== undefined) {
      throw new BadRequestException(
        `options is only valid for SELECT/MULTI_SELECT fields`,
      );
    }
  }

  validateValue(
    dataType: FieldType,
    options: string[] | null,
    value: unknown,
  ): void {
    switch (dataType) {
      case FieldType.TEXT:
      case FieldType.URL:
      case FieldType.USER:
        if (typeof value !== 'string')
          throw new BadRequestException(
            `Value must be a string for ${dataType}`,
          );
        break;
      case FieldType.NUMBER:
        if (typeof value !== 'number' || Number.isNaN(value)) {
          throw new BadRequestException('Value must be a number');
        }
        break;
      case FieldType.DATE:
        if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
          throw new BadRequestException('Value must be an ISO date string');
        }
        break;
      case FieldType.CHECKBOX:
        if (typeof value !== 'boolean')
          throw new BadRequestException('Value must be a boolean');
        break;
      case FieldType.SELECT:
        if (typeof value !== 'string' || !options?.includes(value)) {
          throw new BadRequestException(
            "Value must be one of this field's options",
          );
        }
        break;
      case FieldType.MULTI_SELECT:
        if (
          !Array.isArray(value) ||
          !value.every((v) => typeof v === 'string' && options?.includes(v))
        ) {
          throw new BadRequestException(
            "Value must be an array of this field's options",
          );
        }
        break;
    }
  }
}
