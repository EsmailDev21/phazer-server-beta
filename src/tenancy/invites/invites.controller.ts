import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { InvitesService } from './invites.service';
import { CreateInviteDto } from './dto/create-invite.dto';
import { BatchDeleteInvitesDto } from './dto/batch-delete-invites.dto';
import { Public } from '../../auth/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';

@Controller('invites')
export class InvitesController {
  constructor(private readonly invitesService: InvitesService) {}

  // No @RequireAccess — the correct permission action depends on
  // targetType (and, for WORKSPACE, the target account's type), resolved
  // dynamically inside InvitesService against the same PermissionResolver.
  @Post()
  async create(
    @Body() dto: CreateInviteDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.invitesService.create(dto, user.userId);
  }

  @Get('pending')
  async findPending(
    @Query('email') email: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.invitesService.findPendingForEmail(
      email ?? user.email,
      user.email,
    );
  }

  @Public()
  @Get('validate/:token')
  async validate(@Param('token') token: string) {
    return this.invitesService.validateByToken(token);
  }

  @Post(':token/accept')
  async accept(
    @Param('token') token: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.invitesService.accept(token, user.userId);
  }

  // Literal routes MUST be declared before ':id' below, or Nest/Express
  // would try to match "batch"/"cleanup" as an :id value.
  @HttpCode(HttpStatus.OK)
  @Delete('batch')
  async batchDelete(
    @Body() dto: BatchDeleteInvitesDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.invitesService.batchDelete(dto.ids, user.userId);
  }

  @HttpCode(HttpStatus.OK)
  @Delete('cleanup/expired')
  async cleanupExpired(@CurrentUser() user: AuthenticatedUser) {
    return this.invitesService.cleanupExpired(user.userId);
  }

  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':id')
  async delete(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.invitesService.delete(id, user.userId);
  }
}
