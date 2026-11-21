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
import {
  CreateViewDto,
  ListViewsQueryDto,
  RunViewConfigDto,
  RunViewQueryDto,
  UpdateViewDto,
  ValidateViewDto,
} from './dto/view.dto';
import { ViewsService } from './views.service';

/**
 * Step 5.4. 404 while FEATURE_WORKFLOW is off. `:id` is always the WORKSPACE id. Writes need
 * `manageSavedViews` (MEMBER+); making, changing or removing a SHARED view additionally needs an admin
 * (checked in the service). Reads need workspace access; other people's personal views answer 404.
 */
@RequireFeature('WORKFLOW')
@Controller('workspaces/:id/views')
export class ViewsController {
  constructor(private readonly service: ViewsService) {}

  @Get()
  list(
    @Param('id') workspaceId: string,
    @Query() query: ListViewsQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.list(workspaceId, user.userId, query);
  }

  /** Dry run for the view editor: issues with paths. Stores nothing. */
  @RequireAccess('manageSavedViews', { targetType: 'WORKSPACE' })
  @HttpCode(HttpStatus.OK)
  @Post('validate')
  validate(
    @Param('id') workspaceId: string,
    @Body() dto: ValidateViewDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.validate(workspaceId, user.userId, dto);
  }

  /** Preview for the view editor: the tasks this unsaved config would show the caller. Stores nothing. */
  @RequireAccess('manageSavedViews', { targetType: 'WORKSPACE' })
  @HttpCode(HttpStatus.OK)
  @Post('run')
  runConfig(
    @Param('id') workspaceId: string,
    @Body() dto: RunViewConfigDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.runConfig(
      workspaceId,
      user.userId,
      dto.layout,
      dto.projectId ?? null,
      dto.config,
      { limit: dto.limit, cursor: dto.cursor },
    );
  }

  @RequireAccess('manageSavedViews', { targetType: 'WORKSPACE' })
  @Post()
  create(
    @Param('id') workspaceId: string,
    @Body() dto: CreateViewDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.create(workspaceId, user.userId, dto);
  }

  @Get(':viewId')
  get(
    @Param('id') workspaceId: string,
    @Param('viewId') viewId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.get(workspaceId, viewId, user.userId);
  }

  /** The tasks a saved view shows the CALLER (their access, `ME` = them), one page at a time. */
  @Get(':viewId/tasks')
  tasks(
    @Param('id') workspaceId: string,
    @Param('viewId') viewId: string,
    @Query() query: RunViewQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.run(workspaceId, viewId, user.userId, query);
  }

  @RequireAccess('manageSavedViews', { targetType: 'WORKSPACE' })
  @Patch(':viewId')
  update(
    @Param('id') workspaceId: string,
    @Param('viewId') viewId: string,
    @Body() dto: UpdateViewDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.update(workspaceId, viewId, user.userId, dto);
  }

  @RequireAccess('manageSavedViews', { targetType: 'WORKSPACE' })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':viewId')
  async remove(
    @Param('id') workspaceId: string,
    @Param('viewId') viewId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.service.remove(workspaceId, viewId, user.userId);
  }

  /** "Save as my own": a personal copy of a view the caller can see. */
  @RequireAccess('manageSavedViews', { targetType: 'WORKSPACE' })
  @Post(':viewId/duplicate')
  duplicate(
    @Param('id') workspaceId: string,
    @Param('viewId') viewId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.duplicate(workspaceId, viewId, user.userId);
  }
}
