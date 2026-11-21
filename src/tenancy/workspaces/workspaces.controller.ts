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
import { WorkspacesService } from './workspaces.service';
import { CreateWorkspaceDto } from './dto/create-workspace.dto';
import { UpdateWorkspaceDto } from './dto/update-workspace.dto';
import { AddCollaboratorDto } from './dto/add-collaborator.dto';
import { AddGuestDto } from './dto/add-guest.dto';
import { GrantTeamAccessDto } from './dto/grant-team-access.dto';
import { RequireAccess } from '../../access-control/decorators/require-access.decorator';
import { RequireFeature } from '../../feature-flags/require-feature.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';
import { RenameWorkspaceKeyDto } from './dto/rename-workspace-key.dto';
import { WorkspaceKeysService } from './workspace-keys.service';

@Controller('workspaces')
export class WorkspacesController {
  constructor(
    private readonly workspacesService: WorkspacesService,
    private readonly keysService: WorkspaceKeysService,
  ) {}

  @RequireAccess('createWorkspace', {
    paramSource: 'body',
    paramName: 'accountId',
  })
  @Post()
  async create(@Body() dto: CreateWorkspaceDto) {
    return this.workspacesService.create(dto);
  }

  // ADR-0004. Key changes are ADMIN+ (editWorkspace) and part of the workflow
  // feature: with FEATURE_WORKFLOW off this answers 404 like the rest of it.
  @RequireFeature('WORKFLOW')
  @RequireAccess('editWorkspace', { targetType: 'WORKSPACE' })
  @Patch(':id/key')
  async renameKey(
    @Param('id') id: string,
    @Body() dto: RenameWorkspaceKeyDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.keysService.rename(id, dto.key, user.userId);
  }

  // Reuses viewActivity — no dedicated "view workspace" action exists in
  // the Permission Resolution catalog; viewActivity is workspace-scoped
  // and already excludes CLIENT, which matches intent (a project-scoped
  // CLIENT shouldn't see the workspace shell itself).
  @RequireAccess('viewActivity', { targetType: 'WORKSPACE' })
  @Get(':id')
  async getById(@Param('id') id: string) {
    return this.workspacesService.getById(id);
  }

  @RequireAccess('editWorkspace')
  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: UpdateWorkspaceDto) {
    return this.workspacesService.update(id, dto);
  }

  @RequireAccess('deleteWorkspace')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':id')
  async delete(@Param('id') id: string) {
    await this.workspacesService.delete(id);
  }

  @RequireAccess('viewActivity', { targetType: 'WORKSPACE' })
  @Get(':id/members')
  async listMembers(@Param('id') id: string) {
    return this.workspacesService.listMembers(id);
  }

  // ---- Collaborators (PERSONAL accounts only) ----

  @RequireAccess('manageWorkspaceCollaborators')
  @Get(':id/collaborators')
  async listCollaborators(@Param('id') id: string) {
    return this.workspacesService.listCollaborators(id);
  }

  @RequireAccess('manageWorkspaceCollaborators')
  @Post(':id/collaborators')
  async addCollaborator(
    @Param('id') id: string,
    @Body() dto: AddCollaboratorDto,
  ) {
    return this.workspacesService.addCollaborator(id, dto);
  }

  @RequireAccess('manageWorkspaceCollaborators')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':id/collaborators/:userId')
  async removeCollaborator(
    @Param('id') id: string,
    @Param('userId') userId: string,
  ) {
    await this.workspacesService.removeCollaborator(id, userId);
  }

  // ---- Guests (ORGANIZATION accounts only) ----

  @RequireAccess('manageWorkspaceGuests')
  @Get(':id/guests')
  async listGuests(@Param('id') id: string) {
    return this.workspacesService.listGuests(id);
  }

  @RequireAccess('manageWorkspaceGuests')
  @Post(':id/guests')
  async addGuest(@Param('id') id: string, @Body() dto: AddGuestDto) {
    return this.workspacesService.addGuest(id, dto);
  }

  @RequireAccess('manageWorkspaceGuests')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':id/guests/:userId')
  async removeGuest(@Param('id') id: string, @Param('userId') userId: string) {
    await this.workspacesService.removeGuest(id, userId);
  }

  // ---- Team access ----

  @RequireAccess('grantTeamWorkspaceAccess')
  @Post(':id/team-access/:teamId')
  async grantTeamAccess(
    @Param('id') id: string,
    @Param('teamId') teamId: string,
    @Body() dto: GrantTeamAccessDto,
  ) {
    return this.workspacesService.grantTeamAccess(id, teamId, dto);
  }

  @RequireAccess('grantTeamWorkspaceAccess')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':id/team-access/:teamId')
  async revokeTeamAccess(
    @Param('id') id: string,
    @Param('teamId') teamId: string,
  ) {
    await this.workspacesService.revokeTeamAccess(id, teamId);
  }
}
