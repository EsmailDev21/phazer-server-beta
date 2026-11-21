import { Module } from '@nestjs/common';
import { DomainWriterModule } from '../../domain-writer/domain-writer.module';
import { ProjectsTasksModule } from '../../projects-tasks/projects-tasks.module';
import { TenancyModule } from '../../tenancy/tenancy.module';
import { IntegrationCoreModule } from '../integration-core.module';
import { IntegrationIdentityModule } from '../integration-identity.module';
import { IntegrationNotifyModule } from '../notify/integration-notify.module';
import { IntegrationWebhooksModule } from '../webhooks/integration-webhooks.module';
import { ChatCommandExecutor } from './chat-command.executor';
import { ChatCommandJob } from './chat-command.job';
import { DiscordInteractionService } from './discord-interaction.service';
import { DiscordInteractionsController } from './discord-interactions.controller';
import { ChatUnfurlJob } from './slack/chat-unfurl.job';
import { SlackController } from './slack/slack.controller';
import { SlackInteractionService } from './slack/slack-interaction.service';

/**
 * Steps 2.4 + 2.5. Imported by BOTH processes: the API answers Discord and Slack (controllers + services), the worker runs `chat.command` and `chat.unfurl`.
 * The executor is provider-neutral and is what Slack (2.5) will reuse.
 */
@Module({
  imports: [IntegrationCoreModule, IntegrationIdentityModule, IntegrationNotifyModule, IntegrationWebhooksModule, DomainWriterModule, ProjectsTasksModule, TenancyModule],
  controllers: [DiscordInteractionsController, SlackController],
  providers: [ChatCommandExecutor, ChatCommandJob, DiscordInteractionService, SlackInteractionService, ChatUnfurlJob],
  exports: [ChatCommandExecutor],
})
export class IntegrationChatModule {}
