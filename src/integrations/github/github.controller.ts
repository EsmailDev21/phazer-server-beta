import { Body, Controller, Get, Headers, Param, Patch, Post, Query, UnauthorizedException } from '@nestjs/common';
import { PublicSigned, SignedPayload, SignedRawBody } from '../../auth/decorators/public-signed.decorator';
import { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequireFeature } from '../../feature-flags/require-feature.decorator';
import { LinkRepoDto, UpdateStatusRulesDto } from '../dto/integration.dto';
import { GithubAdminService } from './github-admin.service';
import { GithubEventService } from './github-event.service';

/**
 * GitHub's webhook URL (set in the App settings, content type `application/json`):
 *   POST /integrations/github/webhook
 * @PublicSigned: no JWT; the HMAC over the RAW body is the authentication, checked first in the service. A bare 401 for any failure.
 */
@RequireFeature('INTEGRATIONS')
@Controller('integrations/github')
export class GithubWebhookController {
  constructor(private readonly events: GithubEventService) {}

  @PublicSigned()
  @Post('webhook')
  async webhook(
    @SignedRawBody() rawBody: Buffer,
    @SignedPayload() payload: unknown,
    @Headers('x-hub-signature-256') signature?: string,
    @Headers('x-github-event') event?: string,
    @Headers('x-github-delivery') deliveryId?: string,
  ) {
    const out = await this.events.handle({ rawBody, payload, signature, event, deliveryId });
    if (out.status === 401) throw new UnauthorizedException();
    return out.body;
  }
}

/** Admin routes (step 2.6). Authorization is in the service (it resolves the connection's account first). */
@RequireFeature('INTEGRATIONS')
@Controller('integrations')
export class GithubAdminController {
  constructor(private readonly admin: GithubAdminService) {}

  @Get('connections/:id/github/repositories')
  repositories(@Param('id') id: string, @Query('page') page: string | undefined, @CurrentUser() u: AuthenticatedUser) {
    return this.admin.repositories(id, u.userId, page === undefined ? 1 : Number(page));
  }

  @Post('connections/:id/github/repo-links')
  link(@Param('id') id: string, @Body() dto: LinkRepoDto, @CurrentUser() u: AuthenticatedUser) {
    return this.admin.linkRepo(id, u.userId, dto);
  }

  @Patch('channel-links/:linkId/github-rules')
  rules(@Param('linkId') linkId: string, @Body() dto: UpdateStatusRulesDto, @CurrentUser() u: AuthenticatedUser) {
    return this.admin.updateRules(linkId, u.userId, dto.statusRules);
  }
}
