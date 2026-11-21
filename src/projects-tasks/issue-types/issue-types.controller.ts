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
import { RequireAccess } from '../../access-control/decorators/require-access.decorator';
import { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequireFeature } from '../../feature-flags/require-feature.decorator';
import { CreateIssueTypeDto, UpdateIssueTypeDto } from './dto/issue-type.dto';
import { IssueTypesService } from './issue-types.service';

/** ADR-0007. 404 while FEATURE_WORKFLOW is off (ADR-0002). `:id` is always the WORKSPACE id. */
@RequireFeature('WORKFLOW')
@Controller('workspaces/:id/issue-types')
export class IssueTypesController {
  constructor(private readonly service: IssueTypesService) {}

  // Readable by anyone with workspace access (gated in the service), like tags.
  @Get()
  list(
    @Param('id') workspaceId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.list(workspaceId, user.userId);
  }

  @RequireAccess('manageWorkflow', { targetType: 'WORKSPACE' })
  @Post()
  create(@Param('id') workspaceId: string, @Body() dto: CreateIssueTypeDto) {
    return this.service.create(workspaceId, dto);
  }

  @RequireAccess('manageWorkflow', { targetType: 'WORKSPACE' })
  @Patch(':typeId')
  update(
    @Param('id') workspaceId: string,
    @Param('typeId') typeId: string,
    @Body() dto: UpdateIssueTypeDto,
  ) {
    return this.service.update(workspaceId, typeId, dto);
  }

  @RequireAccess('manageWorkflow', { targetType: 'WORKSPACE' })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':typeId')
  async delete(
    @Param('id') workspaceId: string,
    @Param('typeId') typeId: string,
  ) {
    await this.service.delete(workspaceId, typeId);
  }
}
