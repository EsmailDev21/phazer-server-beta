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
import { RequireAccess } from '../../access-control/decorators/require-access.decorator';
import { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequireFeature } from '../../feature-flags/require-feature.decorator';
import {
  CloseIterationDto,
  CreateIterationDto,
  CurrentIterationsQueryDto,
  ListIterationsQueryDto,
  UpdateIterationDto,
  VelocityQueryDto,
} from './dto/iteration.dto';
import { IterationsService } from './iterations.service';

/** ADR-0007. 404 while FEATURE_WORKFLOW is off (ADR-0002). `:id` is always the WORKSPACE id. */
@RequireFeature('WORKFLOW')
@Controller('workspaces/:id/iterations')
export class IterationsController {
  constructor(private readonly service: IterationsService) {}

  @Get()
  list(
    @Param('id') workspaceId: string,
    @Query() query: ListIterationsQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.list(workspaceId, user.userId, query);
  }

  /** ADR-0008: every ACTIVE iteration (several or none). Declared before `:iterationId`. */
  @Get('current')
  current(
    @Param('id') workspaceId: string,
    @Query() query: CurrentIterationsQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.current(workspaceId, user.userId, query);
  }

  /** ADR-0008: completed points and task count per iteration. Declared before `:iterationId`. */
  @Get('velocity')
  velocity(
    @Param('id') workspaceId: string,
    @Query() query: VelocityQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.velocity(workspaceId, user.userId, query);
  }

  @Get(':iterationId')
  get(
    @Param('id') workspaceId: string,
    @Param('iterationId') iterationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.get(workspaceId, iterationId, user.userId);
  }

  @RequireAccess('manageWorkflow', { targetType: 'WORKSPACE' })
  @Post()
  create(@Param('id') workspaceId: string, @Body() dto: CreateIterationDto) {
    return this.service.create(workspaceId, dto);
  }

  @RequireAccess('manageWorkflow', { targetType: 'WORKSPACE' })
  @Patch(':iterationId')
  update(
    @Param('id') workspaceId: string,
    @Param('iterationId') iterationId: string,
    @Body() dto: UpdateIterationDto,
  ) {
    return this.service.update(workspaceId, iterationId, dto);
  }

  @RequireAccess('manageWorkflow', { targetType: 'WORKSPACE' })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':iterationId')
  async delete(
    @Param('id') workspaceId: string,
    @Param('iterationId') iterationId: string,
  ) {
    await this.service.delete(workspaceId, iterationId);
  }

  @RequireAccess('manageWorkflow', { targetType: 'WORKSPACE' })
  @HttpCode(HttpStatus.OK)
  @Post(':iterationId/start')
  start(
    @Param('id') workspaceId: string,
    @Param('iterationId') iterationId: string,
  ) {
    return this.service.start(workspaceId, iterationId);
  }

  @RequireAccess('manageWorkflow', { targetType: 'WORKSPACE' })
  @HttpCode(HttpStatus.OK)
  @Post(':iterationId/close')
  close(
    @Param('id') workspaceId: string,
    @Param('iterationId') iterationId: string,
    @Body() dto: CloseIterationDto,
  ) {
    return this.service.close(workspaceId, iterationId, dto);
  }

  @RequireAccess('manageWorkflow', { targetType: 'WORKSPACE' })
  @HttpCode(HttpStatus.OK)
  @Post(':iterationId/reopen')
  reopen(
    @Param('id') workspaceId: string,
    @Param('iterationId') iterationId: string,
  ) {
    return this.service.reopen(workspaceId, iterationId);
  }
}
