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
import { AccountsService } from './accounts.service';
import { UpdateAccountDto } from './dto/update-account.dto';
import { DeleteAccountDto } from './dto/delete-account.dto';
import { ChangeMemberRoleDto } from './dto/change-member-role.dto';
import { CreateOrganizationAccountDto } from './dto/create-organization-account.dto';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';
import { RequireAccess } from '../../access-control/decorators/require-access.decorator';

@Controller()
export class AccountsController {
  constructor(private readonly accountsService: AccountsService) {}

  // No @RequireAccess — nothing to resolve permission against yet; any
  // authenticated user may start a new organization account.
  @Post('accounts')
  async createOrganization(
    @Body() dto: CreateOrganizationAccountDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.accountsService.createOrganization(dto, user.userId);
  }

  // MISSING from the original pass, found while designing Navigation UI —
  // powers the account switcher. No @RequireAccess: inherently self-scoped,
  // nothing to resolve permissions against.
  @Get('me/accounts')
  async listMyAccounts(@CurrentUser() user: AuthenticatedUser) {
    return this.accountsService.listMyAccounts(user.userId);
  }

  @RequireAccess('viewAccount')
  @Get('accounts/:id')
  async getAccount(@Param('id') id: string) {
    return this.accountsService.getById(id);
  }

  @RequireAccess('editAccount')
  @Patch('accounts/:id')
  async updateAccount(
    @Param('id') id: string,
    @Body() dto: UpdateAccountDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.accountsService.update(id, dto, user.userId);
  }

  @RequireAccess('deleteAccount')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete('accounts/:id')
  async deleteAccount(@Param('id') id: string, @Body() dto: DeleteAccountDto) {
    await this.accountsService.delete(id, dto);
  }

  // Reuses viewAccount — no dedicated "view members" action exists;
  // member-list visibility tracks account visibility.
  @RequireAccess('viewAccount')
  @Get('accounts/:id/members')
  async listMembers(
    @Param('id') id: string,
    @Query() pagination: PaginationDto,
  ) {
    return this.accountsService.listMembers(id, pagination);
  }

  @RequireAccess('changeAccountMemberRole')
  @Patch('accounts/:id/members/:userId')
  async changeMemberRole(
    @Param('id') id: string,
    @Param('userId') userId: string,
    @Body() dto: ChangeMemberRoleDto,
    @CurrentUser() requester: AuthenticatedUser,
  ) {
    return this.accountsService.changeMemberRole(
      id,
      userId,
      dto,
      requester.userId,
    );
  }

  @RequireAccess('removeAccountMember')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete('accounts/:id/members/:userId')
  async removeMember(
    @Param('id') id: string,
    @Param('userId') userId: string,
    @CurrentUser() requester: AuthenticatedUser,
  ) {
    await this.accountsService.removeMember(id, userId, requester.userId);
  }

  @RequireAccess('viewAuditLog')
  @Get('accounts/:id/audit-log')
  async listAuditLog(
    @Param('id') id: string,
    @Query() pagination: PaginationDto,
  ) {
    return this.accountsService.listAuditLog(id, pagination);
  }

  // Reuses viewAccount — listing an account's workspaces/teams tracks
  // account-level visibility, not a dedicated workspace/team action.
  @RequireAccess('viewAccount')
  @Get('accounts/:id/workspaces')
  async listWorkspaces(
    @Param('id') id: string,
    @Query() pagination: PaginationDto,
  ) {
    return this.accountsService.listWorkspaces(id, pagination);
  }

  @RequireAccess('viewAccount')
  @Get('accounts/:id/teams')
  async listTeams(@Param('id') id: string, @Query() pagination: PaginationDto) {
    return this.accountsService.listTeams(id, pagination);
  }
}
