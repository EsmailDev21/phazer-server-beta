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
import { ProjectsService } from './projects.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { RequireAccess } from '../../access-control/decorators/require-access.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';

@Controller()
export class ProjectsController {
  constructor(private readonly projectsService: ProjectsService) {}

  @RequireAccess('createProject', {
    paramSource: 'body',
    paramName: 'workspaceId',
  })
  @Post('projects')
  async create(
    @Body() dto: CreateProjectDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.projectsService.create(dto, user.userId);
  }

  @Get('me/projects')
  async listMine(
    @Query() pagination: PaginationDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.projectsService.listMyProjects(user.userId, pagination);
  }

  // No @RequireAccess — visibility-gated via
  // ProjectsService.assertCanView (PermissionResolver.hasProjectLevelAccess)
  // instead, since CLIENT-tier Tier1-only ProjectMembers must be able to
  // view their own project despite failing every named-action check.
  @Get('projects/:id')
  async getDetail(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.projectsService.getDetail(id, user.userId);
  }

  @Get('workspaces/:id/projects')
  async listByWorkspace(
    @Param('id') id: string,
    @Query() pagination: PaginationDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.projectsService.listByWorkspace(id, user.userId, pagination);
  }

  @RequireAccess('editProject')
  @Patch('projects/:id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateProjectDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.projectsService.update(id, dto, user.userId);
  }

  @RequireAccess('deleteProject')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete('projects/:id')
  async delete(@Param('id') id: string) {
    await this.projectsService.delete(id);
  }

  @RequireAccess('archiveProject')
  @Post('projects/:id/archive')
  async archive(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.projectsService.archive(id, user.userId);
  }

  @Get('projects/:id/stats')
  async getStats(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.projectsService.getStats(id, user.userId);
  }

  @Get('projects/:id/members')
  async listMembers(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.projectsService.listMembers(id, user.userId);
  }
}
