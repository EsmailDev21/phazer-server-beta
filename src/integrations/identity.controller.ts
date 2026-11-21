import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, Redirect } from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';
import { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequireFeature } from '../feature-flags/require-feature.decorator';
import { parseProviderParam } from './core/connector.registry';
import { IdentityOAuthService } from './core/identity-oauth.service';
import { IdentityService } from './core/identity.service';
import { LinkTokenDto, ManualIdentityLinkDto, StartIdentityLinkDto } from './dto/integration.dto';

/**
 * Step 2.2 routes. Authorization lives in the services (they resolve the connection's account first), so no
 * @RequireAccess here: an id that is not yours answers 404, never a hint that it exists.
 */
@RequireFeature('INTEGRATIONS')
@Controller('integrations')
export class IdentityController {
  constructor(
    private readonly oauth: IdentityOAuthService,
    private readonly identities: IdentityService,
  ) {}

  // ---- the person linking themself
  @Post(':provider/identity/start')
  start(
    @Param('provider') provider: string,
    @Body() dto: StartIdentityLinkDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.oauth.start(parseProviderParam(provider), dto.connectionId, user.userId);
  }

  /** @Public: the browser returns from the provider without a bearer token; the single-use state is the authority. */
  @Public()
  @Redirect()
  @Get(':provider/identity/callback')
  async callback(@Param('provider') provider: string, @Query() query: Record<string, string>) {
    const strings = Object.fromEntries(
      Object.entries(query ?? {}).filter(([, v]) => typeof v === 'string'),
    ) as Record<string, string>;
    const url = await this.oauth.handleCallback(parseProviderParam(provider), strings);
    return { url, statusCode: 302 };
  }

  /** The page behind the one-time link: what is being linked (no chat identifiers). Does not consume the token. */
  @HttpCode(200)
  @Post('identities/link-token/inspect')
  inspectToken(@Body() dto: LinkTokenDto, @CurrentUser() user: AuthenticatedUser) {
    return this.identities.inspectLinkToken(dto.token, user.userId);
  }

  /** Completing the one-time link: the logged-in user becomes the chat user's identity. */
  @HttpCode(200)
  @Post('identities/link-token/complete')
  completeToken(@Body() dto: LinkTokenDto, @CurrentUser() user: AuthenticatedUser) {
    return this.identities.completeLinkToken(dto.token, user.userId);
  }

  @Get('identities/me')
  mine(@CurrentUser() user: AuthenticatedUser) {
    return this.identities.listMine(user.userId);
  }

  @HttpCode(204)
  @Delete('identities/:id')
  async unlinkMine(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    await this.identities.unlinkMine(id, user.userId);
  }

  // ---- admins (manageIntegrations on the connection's account)
  @Get('connections/:id/identities')
  list(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.identities.listForConnection(id, user.userId);
  }

  @Put('connections/:id/identities')
  manual(@Param('id') id: string, @Body() dto: ManualIdentityLinkDto, @CurrentUser() user: AuthenticatedUser) {
    return this.identities.manualLink(id, user.userId, dto);
  }

  @HttpCode(204)
  @Delete('connections/:id/identities/:externalUserId')
  async unlink(
    @Param('id') id: string,
    @Param('externalUserId') externalUserId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.identities.unlink(id, externalUserId, user.userId);
  }
}
