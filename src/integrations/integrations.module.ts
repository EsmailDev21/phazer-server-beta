import { Module } from '@nestjs/common';
import { IntegrationHealthService } from './core/integration-health.service';
import { IntegrationsService } from './core/integrations.service';
import { IdentityOAuthService } from './core/identity-oauth.service';
import { OAuthStateService } from './core/oauth-state.service';
import { OAuthService } from './core/oauth.service';
import { ChannelController } from './channel.controller';
import { IdentityController } from './identity.controller';
import { IntegrationCoreModule } from './integration-core.module';
import { IntegrationIdentityModule } from './integration-identity.module';
import { IntegrationsController } from './integrations.controller';
import { ChannelAdminService } from './notify/channel-admin.service';

/** API-process surface (ADR-0009/0010/0011): connect, identity, channel admin. Provider plumbing is in IntegrationCoreModule. */
@Module({
  imports: [IntegrationCoreModule, IntegrationIdentityModule],
  controllers: [IntegrationsController, IdentityController, ChannelController],
  providers: [
    OAuthStateService,
    OAuthService,
    IntegrationsService,
    IntegrationHealthService,
    IdentityOAuthService,
    ChannelAdminService,
  ],
  exports: [IntegrationCoreModule, IntegrationIdentityModule],
})
export class IntegrationsModule {}
