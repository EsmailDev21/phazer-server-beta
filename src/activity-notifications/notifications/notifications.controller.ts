import { Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';
import { NotificationsService } from './notifications.service';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';

class QueryNotificationsDto extends PaginationDto {
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  unread?: boolean;
}

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  // ALWAYS the current user, never another user's — no userId param,
  // resolved from JWT, per the graph. Route ordering note: 'read-all' is
  // a literal path and must be declared BEFORE ':id/read' below, or Nest/
  // Express would try to match "read-all" as an :id value.
  @Get()
  async list(
    @Query() query: QueryNotificationsDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.notificationsService.list(
      user.userId,
      query.unread ?? false,
      query,
    );
  }

  @Patch('read-all')
  async markAllRead(@CurrentUser() user: AuthenticatedUser) {
    return this.notificationsService.markAllRead(user.userId);
  }

  @Patch(':id/read')
  async markRead(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.notificationsService.markRead(id, user.userId);
  }
}
