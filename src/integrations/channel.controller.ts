import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequireFeature } from '../feature-flags/require-feature.decorator';
import { CreateChannelLinkDto, CreateSubscriptionDto, UpdateSubscriptionDto } from './dto/integration.dto';
import { ChannelAdminService } from './notify/channel-admin.service';

/** Step 2.3 admin routes. Authorization is in the service (it resolves the connection's account first). */
@RequireFeature('INTEGRATIONS')
@Controller('integrations')
export class ChannelController {
  constructor(private readonly channels: ChannelAdminService) {}

  @Get('connections/:id/channel-links')
  list(@Param('id') id: string, @CurrentUser() u: AuthenticatedUser) {
    return this.channels.listLinks(id, u.userId);
  }

  @Post('connections/:id/channel-links')
  create(@Param('id') id: string, @Body() dto: CreateChannelLinkDto, @CurrentUser() u: AuthenticatedUser) {
    return this.channels.createLink(id, u.userId, dto);
  }

  @HttpCode(204)
  @Delete('channel-links/:linkId')
  async remove(@Param('linkId') linkId: string, @CurrentUser() u: AuthenticatedUser) {
    await this.channels.deleteLink(linkId, u.userId);
  }

  @Get('channel-links/:linkId/deliveries')
  deliveries(@Param('linkId') linkId: string, @Query('limit') limit: string | undefined, @CurrentUser() u: AuthenticatedUser) {
    return this.channels.deliveries(linkId, u.userId, limit === undefined ? 50 : Number(limit));
  }

  @Post('channel-links/:linkId/subscriptions')
  subscribe(@Param('linkId') linkId: string, @Body() dto: CreateSubscriptionDto, @CurrentUser() u: AuthenticatedUser) {
    return this.channels.createSubscription(linkId, u.userId, dto);
  }

  @Patch('subscriptions/:subId')
  update(@Param('subId') subId: string, @Body() dto: UpdateSubscriptionDto, @CurrentUser() u: AuthenticatedUser) {
    return this.channels.updateSubscription(subId, u.userId, dto);
  }

  @HttpCode(204)
  @Delete('subscriptions/:subId')
  async unsubscribe(@Param('subId') subId: string, @CurrentUser() u: AuthenticatedUser) {
    await this.channels.deleteSubscription(subId, u.userId);
  }
}
