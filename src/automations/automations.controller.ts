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
  Query,
} from '@nestjs/common';
import { RequireAccess } from '../access-control/decorators/require-access.decorator';
import { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequireFeature } from '../feature-flags/require-feature.decorator';
import { AutomationsService } from './automations.service';
import {
  CreateAutomationDto,
  ListAutomationsQueryDto,
  ListRunsQueryDto,
  UpdateAutomationDto,
  ValidateAutomationDto,
} from './dto/automation.dto';

/** Step 5.1. 404 while FEATURE_WORKFLOW is off (ADR-0002). `:id` is always the WORKSPACE id. */
@RequireFeature('WORKFLOW')
@Controller('workspaces/:id/automations')
export class AutomationsController {
  constructor(private readonly service: AutomationsService) {}

  @Get()
  list(
    @Param('id') workspaceId: string,
    @Query() query: ListAutomationsQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.list(workspaceId, user.userId, query);
  }

  /**
   * Everything a rule editor can offer: triggers, actions (with an example each), condition fields,
   * placeholders, limits. Static; generated from the registry. Declared BEFORE `:automationId` so it is
   * not read as an id.
   */
  @RequireAccess('manageAutomations', { targetType: 'WORKSPACE' })
  @Get('catalogue')
  catalogue() {
    return this.service.catalogue();
  }

  /** Dry run for the rule editor: issues with paths, what is unsupported, whether it could be switched on. Stores nothing. */
  @RequireAccess('manageAutomations', { targetType: 'WORKSPACE' })
  @HttpCode(HttpStatus.OK)
  @Post('validate')
  validate(
    @Param('id') workspaceId: string,
    @Body() dto: ValidateAutomationDto,
  ) {
    return this.service.validate(workspaceId, dto);
  }

  @RequireAccess('manageAutomations', { targetType: 'WORKSPACE' })
  @Post()
  create(
    @Param('id') workspaceId: string,
    @Body() dto: CreateAutomationDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.create(workspaceId, user.userId, dto);
  }

  /** The waits this rule has in flight (a Wait action that has not been carried on yet). */
  @RequireAccess('manageAutomations', { targetType: 'WORKSPACE' })
  @Get(':automationId/waits')
  waits(
    @Param('id') workspaceId: string,
    @Param('automationId') automationId: string,
  ) {
    return this.service.listWaits(workspaceId, automationId);
  }

  /** Cancels one: the rest of that run never happens. */
  @RequireAccess('manageAutomations', { targetType: 'WORKSPACE' })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':automationId/waits/:waitId')
  async cancelWait(
    @Param('id') workspaceId: string,
    @Param('automationId') automationId: string,
    @Param('waitId') waitId: string,
  ): Promise<void> {
    await this.service.cancelWait(workspaceId, automationId, waitId);
  }

  @Get(':automationId')
  get(
    @Param('id') workspaceId: string,
    @Param('automationId') automationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.get(workspaceId, automationId, user.userId);
  }

  @Get(':automationId/runs')
  runs(
    @Param('id') workspaceId: string,
    @Param('automationId') automationId: string,
    @Query() query: ListRunsQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.listRuns(workspaceId, automationId, user.userId, query);
  }

  @RequireAccess('manageAutomations', { targetType: 'WORKSPACE' })
  @Patch(':automationId')
  update(
    @Param('id') workspaceId: string,
    @Param('automationId') automationId: string,
    @Body() dto: UpdateAutomationDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.update(workspaceId, automationId, user.userId, dto);
  }

  @RequireAccess('manageAutomations', { targetType: 'WORKSPACE' })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':automationId')
  async remove(
    @Param('id') workspaceId: string,
    @Param('automationId') automationId: string,
  ) {
    await this.service.remove(workspaceId, automationId);
  }
}
