import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { FeatureFlagsModule } from '../feature-flags/feature-flags.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AccessControlModule } from '../access-control/access-control.module';
import { EventsModule } from '../events/events.module';
import { WebhookIdempotencyModule } from '../common/webhook-idempotency/webhook-idempotency.module';
import { QueueModule } from '../queue/queue.module';
import { RedisModule } from '../redis/redis.module';
import { CryptoModule } from '../crypto/crypto.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { ActivityNotificationsModule } from '../activity-notifications/activity-notifications.module';
import { AttachmentsModule } from '../attachments/attachments.module';
import { SnapModule } from '../snap/snap.module';
import { BillingModule } from '../billing/billing.module';
import { DomainWriterModule } from '../domain-writer/domain-writer.module';
import { IntegrationWebhooksModule } from '../integrations/webhooks/integration-webhooks.module';
import { IntegrationMaintenanceModule } from '../integrations/integration-maintenance.module';
import { IntegrationNotifyModule } from '../integrations/notify/integration-notify.module';
import { IntegrationChatModule } from '../integrations/chat/integration-chat.module';
import { IntegrationGithubModule } from '../integrations/github/integration-github.module';
import { ProjectsTasksModule } from '../projects-tasks/projects-tasks.module';
import { AutomationsModule } from '../automations/automations.module';
import { ImportsWorkerModule } from '../imports/imports-worker.module';
import { SystemJobsModule } from './system-jobs.module';
import { WorkerModule } from './worker.module';

/**
 * Root module of the worker process (no HTTP). Step 0.2 wired only the queue
 * plumbing and the built-in `system` jobs. Step 0.3 (ADR-0001 decision 3)
 * adds the same domain modules the API uses, so job handlers run the very
 * same services (and, as a side effect, the worker-side fan-out listener
 * inside ActivityNotificationsModule — the due-date-reminder job goes
 * through ActivityService.record() same as every other write path).
 *
 * PrismaModule/AccessControlModule/EventsModule/WebhookIdempotencyModule/
 * CryptoModule are all @Global, but that only means "don't re-import per
 * module" WITHIN one application graph — this is a separate
 * `createApplicationContext` from the API's AppModule, so each must still
 * be imported once here, at this graph's own root. (Found by a real
 * DI-resolution smoke test, not guessed: BillingService needs
 * WebhookIdempotencyService and the first version of this module omitted
 * it.) CryptoModule has no caller in either process yet (step 0.5) but is
 * added here now, same as RedisModule was in 0.1 before 0.2's queue used
 * it — Phase 2's worker-side token refresh will need it.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    FeatureFlagsModule,
    PrismaModule,
    AccessControlModule,
    EventsModule,
    WebhookIdempotencyModule,
    RedisModule,
    CryptoModule,
    QueueModule,
    TenancyModule,
    IntegrationWebhooksModule, // runs the webhook-event retention sweep (step 0.9)
    IntegrationMaintenanceModule, // runs the oauth_states retention sweep (step 2.1)
    IntegrationNotifyModule, // step 2.3: notification router + notify.deliver
    IntegrationChatModule, // step 2.4: Discord interactions endpoint + chat.command job
    IntegrationGithubModule, // step 2.6: runs github.event
    ProjectsTasksModule, // step 6.1: the hourly sprint snapshot job
    AutomationsModule, // step 5.2: the due-date sweep job (and the runner for what the sweep changes)
    DomainWriterModule, // importers/templates run here (step 0.7)
    ImportsWorkerModule, // import executor + rollback handlers (step 4.4, FEATURE_IMPORTS)
    ActivityNotificationsModule,
    AttachmentsModule,
    SnapModule,
    BillingModule,
    SystemJobsModule,
    WorkerModule,
  ],
})
export class WorkerAppModule {}
