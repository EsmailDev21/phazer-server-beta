import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { SnapSessionsService } from './snap-sessions.service';
import { CreateSnapSessionDto } from './dto/create-snap-session.dto';
import { ReviewClauseDto } from './dto/review-clause.dto';
import { ExecutionResultDto } from './dto/execution-result.dto';
import { QuerySnapSessionsDto } from './dto/query-sessions.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';

/**
 * No @RequireAccess anywhere in this controller. Snap sessions are
 * personal drafts, not shared team resources — access is ownership
 * (session.userId === caller), enforced inside the service, plus an
 * explicit PermissionResolver.hasWorkspaceLevelAccess check at creation
 * time only (when workspaceId is provided) since that's the one point
 * workspace-level authorization actually matters. This is the "at
 * minimum, JwtAuthGuard + explicit workspace-access verification via
 * PermissionResolver, not ad hoc" pattern the graph calls for.
 */
@Controller('snap/sessions')
export class SnapSessionsController {
  constructor(private readonly snapSessionsService: SnapSessionsService) {}

  @Post()
  async create(
    @Body() dto: CreateSnapSessionDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.snapSessionsService.create(dto, user.userId);
  }

  @Get()
  async list(
    @Query() query: QuerySnapSessionsDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.snapSessionsService.list(user.userId, query);
  }

  @Get(':id')
  async getById(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.snapSessionsService.getById(id, user.userId);
  }

  @Patch(':id/clauses/:clauseId')
  async reviewClause(
    @Param('id') id: string,
    @Param('clauseId') clauseId: string,
    @Body() dto: ReviewClauseDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.snapSessionsService.reviewClause(
      id,
      clauseId,
      dto,
      user.userId,
    );
  }

  @Patch(':id/clauses/:clauseId/execution-result')
  async recordExecutionResult(
    @Param('id') id: string,
    @Param('clauseId') clauseId: string,
    @Body() dto: ExecutionResultDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.snapSessionsService.recordExecutionResult(
      id,
      clauseId,
      dto,
      user.userId,
    );
  }
}
