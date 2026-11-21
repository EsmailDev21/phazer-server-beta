import { Module } from '@nestjs/common';
import { DomainWriterModule } from '../../domain-writer/domain-writer.module';
import { ProjectsTasksModule } from '../../projects-tasks/projects-tasks.module';
import { TenancyModule } from '../../tenancy/tenancy.module';
import { IntegrationCoreModule } from '../integration-core.module';
import { IntegrationIdentityModule } from '../integration-identity.module';
import { IntegrationWebhooksModule } from '../webhooks/integration-webhooks.module';
import { GithubAdminService } from './github-admin.service';
import { GithubEventJob } from './github-event.job';
import { GithubEventService } from './github-event.service';
import { GithubLinkService } from './github-link.service';
import { GithubAdminController, GithubWebhookController } from './github.controller';

/**
 * Step 2.6. Imported by BOTH processes: the API answers the webhook and the admin routes, the worker runs `github.event`.
 */
@Module({
  imports: [IntegrationCoreModule, IntegrationIdentityModule, IntegrationWebhooksModule, DomainWriterModule, ProjectsTasksModule, TenancyModule],
  controllers: [GithubWebhookController, GithubAdminController],
  providers: [GithubEventService, GithubLinkService, GithubEventJob, GithubAdminService],
})
export class IntegrationGithubModule {}
