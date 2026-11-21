import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Redirect,
} from '@nestjs/common';
import { RequireAccess } from '../access-control/decorators/require-access.decorator';
import { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';
import { Public } from '../auth/decorators/public.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequireFeature } from '../feature-flags/require-feature.decorator';
import { parseProviderParam } from './core/connector.registry';
import { IntegrationHealthService } from './core/integration-health.service';
import { IntegrationsService } from './core/integrations.service';
import { OAuthService } from './core/oauth.service';
import { ConnectIntegrationDto, ListConnectionsQueryDto } from './dto/integration.dto';

@RequireFeature('INTEGRATIONS')
@Controller('integrations')
export class IntegrationsController {
  constructor(
    private readonly oauth: OAuthService,
    private readonly integrations: IntegrationsService,
    private readonly health: IntegrationHealthService,
  ) {}

  @RequireAccess('manageIntegrations', { paramSource: 'query', paramName: 'accountId' })
  @Get()
  list(@Query() q: ListConnectionsQueryDto) {
    return this.integrations.list(q.accountId);
  }

  /** Step 2.7: why is this integration (not) working. Owner/admin of the connection's account; resolved in the service. */
  @Get('connections/:id/health')
  connectionHealth(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.health.check(id, user.userId);
  }

  // Declared before ':provider/...' routes so 'connections' is never read as a provider.
  // No @RequireAccess: the connection's account is resolved and checked in the service.
  @Delete('connections/:id')
  revoke(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.integrations.revoke(id, user.userId);
  }

  @RequireAccess('manageIntegrations', { paramSource: 'body', paramName: 'accountId' })
  @Post(':provider/connect')
  connect(
    @Param('provider') provider: string,
    @Body() dto: ConnectIntegrationDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.oauth.start(parseProviderParam(provider), dto.accountId, user.userId);
  }

  /**
   * @Public: the browser arrives from the provider with no bearer token. Authority comes from the
   * single-use state row (bound to the user and account that started the flow) and is re-checked.
   */
  @Public()
  @Redirect()
  @Get(':provider/callback')
  async callback(
    @Param('provider') provider: string,
    @Query() query: Record<string, string>,
  ) {
    const strings = Object.fromEntries(
      Object.entries(query ?? {}).filter(([, v]) => typeof v === 'string'),
    ) as Record<string, string>; // a repeated ?x=1&x=2 arrives as an array: ignored
    const url = await this.oauth.handleCallback(parseProviderParam(provider), strings);
    return { url, statusCode: 302 };
  }
}
