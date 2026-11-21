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
import { TeamsService } from './teams.service';
import { CreateTeamDto } from './dto/create-team.dto';
import { UpdateTeamDto } from './dto/update-team.dto';
import { RequireAccess } from '../../access-control/decorators/require-access.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';

@Controller('teams')
export class TeamsController {
  constructor(private readonly teamsService: TeamsService) {}

  @RequireAccess('createTeam', { paramSource: 'body', paramName: 'accountId' })
  @Post()
  async create(
    @Body() dto: CreateTeamDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.teamsService.create(dto, user.userId);
  }

  // Reuses editTeam for viewing too — Teams are ORGANIZATION-only
  // structural entities per the graph; no separate "view team" action was
  // approved, and team CRUD/members collectively are OWNER/ADMIN-only.
  @RequireAccess('editTeam')
  @Get(':id')
  async getById(@Param('id') id: string) {
    return this.teamsService.getById(id);
  }

  @RequireAccess('editTeam')
  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: UpdateTeamDto) {
    return this.teamsService.update(id, dto);
  }

  @RequireAccess('deleteTeam')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':id')
  async delete(@Param('id') id: string) {
    await this.teamsService.delete(id);
  }

  @RequireAccess('editTeam')
  @Get(':id/members')
  async listMembers(@Param('id') id: string) {
    return this.teamsService.listMembers(id);
  }

  @RequireAccess('manageTeamMembers')
  @Post(':id/members/:userId')
  async addMember(@Param('id') id: string, @Param('userId') userId: string) {
    return this.teamsService.addMember(id, userId);
  }

  @RequireAccess('manageTeamMembers')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':id/members/:userId')
  async removeMember(@Param('id') id: string, @Param('userId') userId: string) {
    await this.teamsService.removeMember(id, userId);
  }
}
