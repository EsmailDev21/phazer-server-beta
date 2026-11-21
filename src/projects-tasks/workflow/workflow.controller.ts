import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { RequireAccess } from '../../access-control/decorators/require-access.decorator';
import { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequireFeature } from '../../feature-flags/require-feature.decorator';
import {
  CreateWorkflowStatusDto,
  DeleteWorkflowStatusQueryDto,
  ReorderWorkflowDto,
  SetTransitionsDto,
  UpdateWorkflowSettingsDto,
  UpdateWorkflowStatusDto,
} from './dto/workflow.dto';
import { WorkflowService } from './workflow.service';

/**
 * ADR-0006 decision 11. Every route answers 404 while FEATURE_WORKFLOW is off
 * (ADR-0002). `:id` is a PROJECT id, which the guard resolves natively
 * (`manageWorkflow` has a PROJECT scope). The read is authorised in the service
 * with the same project-level check the project detail uses, so CLIENT-tier
 * project members can read the statuses of the tasks they can see.
 */
@RequireFeature('WORKFLOW')
@Controller('projects/:id/workflow')
export class WorkflowController {
  constructor(private readonly workflow: WorkflowService) {}

  @Get()
  get(@Param('id') projectId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.workflow.getWorkflow(projectId, user.userId);
  }

  @RequireAccess('manageWorkflow', { targetType: 'PROJECT' })
  @Patch()
  updateSettings(
    @Param('id') projectId: string,
    @Body() dto: UpdateWorkflowSettingsDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.workflow.updateSettings(projectId, dto, user.userId);
  }

  @RequireAccess('manageWorkflow', { targetType: 'PROJECT' })
  @Post('statuses')
  createStatus(
    @Param('id') projectId: string,
    @Body() dto: CreateWorkflowStatusDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.workflow.createStatus(projectId, dto, user.userId);
  }

  @RequireAccess('manageWorkflow', { targetType: 'PROJECT' })
  @Patch('statuses/:statusId')
  updateStatus(
    @Param('id') projectId: string,
    @Param('statusId') statusId: string,
    @Body() dto: UpdateWorkflowStatusDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.workflow.updateStatus(projectId, statusId, dto, user.userId);
  }

  @RequireAccess('manageWorkflow', { targetType: 'PROJECT' })
  @Delete('statuses/:statusId')
  deleteStatus(
    @Param('id') projectId: string,
    @Param('statusId') statusId: string,
    @Query() query: DeleteWorkflowStatusQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.workflow.deleteStatus(
      projectId,
      statusId,
      query.reassignTo,
      user.userId,
    );
  }

  @RequireAccess('manageWorkflow', { targetType: 'PROJECT' })
  @Put('order')
  reorder(
    @Param('id') projectId: string,
    @Body() dto: ReorderWorkflowDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.workflow.reorder(projectId, dto.statusIds, user.userId);
  }

  @RequireAccess('manageWorkflow', { targetType: 'PROJECT' })
  @Put('transitions')
  setTransitions(
    @Param('id') projectId: string,
    @Body() dto: SetTransitionsDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.workflow.setTransitions(projectId, dto, user.userId);
  }
}
