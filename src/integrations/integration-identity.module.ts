import { Module } from '@nestjs/common';
import { IdentityService } from './core/identity.service';
import { LinkPromptBuilder } from './core/link-prompt.builder';
import { LinkTokenService } from './core/link-token.service';
import { PromptThrottleService } from './core/prompt-throttle.service';
import { IntegrationCoreModule } from './integration-core.module';

/** Identity resolution shared by the API (identity routes) and the worker (chat.command re-checks who is calling). */
@Module({
  imports: [IntegrationCoreModule],
  providers: [LinkPromptBuilder, LinkTokenService, PromptThrottleService, IdentityService],
  exports: [LinkPromptBuilder, LinkTokenService, IdentityService],
})
export class IntegrationIdentityModule {}
