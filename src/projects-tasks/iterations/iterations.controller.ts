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
  Put,
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
  SetRetroDto,
  CreateCriterionDto,
  UpdateCriterionDto,
  UpdateIterationDto,
  VelocityQueryDto,
} from './dto/iteration.dto';
import { IterationsService } from './iterations.service';
import { CycleService } from './cycle.service';
import { MilestoneService } from './milestone.service';
import { SprintService } from './sprint.service';

/** ADR-0007. 404 while FEATURE_WORKFLOW is off (ADR-0002). `:id` is always the WORKSPACE id. */
@RequireFeature('WORKFLOW')
@Controller('workspaces/:id/iterations')
export class IterationsController {
  constructor(
    private readonly service: IterationsService,
    private readonly sprints: SprintService,
    private readonly cycles: CycleService,
    private readonly milestones: MilestoneService,
  ) {}

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

  /** ADR-0046: health, progress, exit criteria, blockers and date history. MILESTONE only (400 KIND_NOT_SUPPORTED). */
  @Get(':iterationId/road')
  road(
    @Param('id') workspaceId: string,
    @Param('iterationId') iterationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.milestones.road(workspaceId, iterationId, user.userId);
  }

  /** ADR-0046: finished work and merged pull requests, as data and as markdown. MILESTONE only. */
  @Get(':iterationId/release-notes')
  releaseNotes(
    @Param('id') workspaceId: string,
    @Param('iterationId') iterationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.milestones.releaseNotes(workspaceId, iterationId, user.userId);
  }

  @RequireAccess('manageWorkflow', { targetType: 'WORKSPACE' })
  @Post(':iterationId/criteria')
  addCriterion(
    @Param('id') workspaceId: string,
    @Param('iterationId') iterationId: string,
    @Body() dto: CreateCriterionDto,
  ) {
    return this.milestones.addCriterion(workspaceId, iterationId, dto);
  }

  @RequireAccess('manageWorkflow', { targetType: 'WORKSPACE' })
  @Patch(':iterationId/criteria/:criterionId')
  updateCriterion(
    @Param('id') workspaceId: string,
    @Param('iterationId') iterationId: string,
    @Param('criterionId') criterionId: string,
    @Body() dto: UpdateCriterionDto,
  ) {
    return this.milestones.updateCriterion(
      workspaceId,
      iterationId,
      criterionId,
      dto,
    );
  }

  @RequireAccess('manageWorkflow', { targetType: 'WORKSPACE' })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':iterationId/criteria/:criterionId')
  async removeCriterion(
    @Param('id') workspaceId: string,
    @Param('iterationId') iterationId: string,
    @Param('criterionId') criterionId: string,
  ) {
    await this.milestones.removeCriterion(
      workspaceId,
      iterationId,
      criterionId,
    );
  }

  /** ADR-0045: the cycles around this one, with how far each got. CYCLE only (400 KIND_NOT_SUPPORTED). */
  @Get(':iterationId/ring')
  ring(
    @Param('id') workspaceId: string,
    @Param('iterationId') iterationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.cycles.ring(workspaceId, iterationId, user.userId);
  }

  /** ADR-0044: committed vs remaining per day, with the ideal line. SPRINT only (400 KIND_NOT_SUPPORTED). */
  @Get(':iterationId/burndown')
  burndown(
    @Param('id') workspaceId: string,
    @Param('iterationId') iterationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.sprints.burndown(workspaceId, iterationId, user.userId);
  }

  /** ADR-0044: points per person against their capacity. SPRINT only. */
  @Get(':iterationId/load')
  load(
    @Param('id') workspaceId: string,
    @Param('iterationId') iterationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.sprints.load(workspaceId, iterationId, user.userId);
  }

  /** ADR-0044: tasks added to or removed from a sprint after it started. SPRINT only. */
  @Get(':iterationId/scope-changes')
  scopeChanges(
    @Param('id') workspaceId: string,
    @Param('iterationId') iterationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.sprints.scopeChanges(workspaceId, iterationId, user.userId);
  }

  /** ADR-0044 d.6: the one setting that can be written on a closed sprint. */
  @RequireAccess('manageWorkflow', { targetType: 'WORKSPACE' })
  @Put(':iterationId/retro')
  setRetro(
    @Param('id') workspaceId: string,
    @Param('iterationId') iterationId: string,
    @Body() dto: SetRetroDto,
  ) {
    return this.sprints.setRetro(workspaceId, iterationId, dto.retro);
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
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.update(workspaceId, iterationId, dto, user.userId);
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
