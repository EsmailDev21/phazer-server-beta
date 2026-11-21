import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { CustomFieldsService } from './custom-fields.service';
import { CreateCustomFieldDto } from './dto/create-custom-field.dto';
import { UpdateCustomFieldDto } from './dto/update-custom-field.dto';
import { RequireAccess } from '../../access-control/decorators/require-access.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';

@Controller()
export class CustomFieldsController {
  constructor(private readonly customFieldsService: CustomFieldsService) {}

  @RequireAccess('manageCustomFields', { targetType: 'WORKSPACE' })
  @Post('workspaces/:id/custom-fields')
  async create(
    @Param('id') workspaceId: string,
    @Body() dto: CreateCustomFieldDto,
  ) {
    return this.customFieldsService.create(workspaceId, dto);
  }

  @RequireAccess('manageCustomFields', { targetType: 'WORKSPACE' })
  @Get('workspaces/:id/custom-fields')
  async listByWorkspace(@Param('id') workspaceId: string) {
    return this.customFieldsService.listByWorkspace(workspaceId);
  }

  // No @RequireAccess — :id here is the FIELD's own id, not a workspaceId;
  // permission is checked manually inside the service against the field's
  // resolved workspaceId (see CustomFieldsService.assertCanManage).
  @Patch('custom-fields/:id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateCustomFieldDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.customFieldsService.update(id, dto, user.userId);
  }

  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete('custom-fields/:id')
  async delete(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.customFieldsService.delete(id, user.userId);
  }
}
