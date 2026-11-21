import { ClassSerializerInterceptor, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import {
  APP_FILTER,
  APP_GUARD,
  APP_INTERCEPTOR,
  Reflector,
} from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { AccessControlModule } from './access-control/access-control.module';
import { HealthModule } from './health/health.module';
import { MetricsModule } from './metrics/metrics.module';
import { TenancyModule } from './tenancy/tenancy.module';
import { ProjectsTasksModule } from './projects-tasks/projects-tasks.module';
import { EventsModule } from './events/events.module';
import { CollaborationModule } from './collaboration/collaboration.module';
import { ActivityNotificationsModule } from './activity-notifications/activity-notifications.module';
import { AttachmentsModule } from './attachments/attachments.module';
import { SnapModule } from './snap/snap.module';
import { BillingModule } from './billing/billing.module';
import { QueueModule } from './queue/queue.module';
import { RedisModule } from './redis/redis.module';
import { FeatureFlagsModule } from './feature-flags/feature-flags.module';
import { CryptoModule } from './crypto/crypto.module';
import { FeatureGuard } from './feature-flags/feature.guard';
import { WebhookIdempotencyModule } from './common/webhook-idempotency/webhook-idempotency.module';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { AccessControlGuard } from './access-control/guards/access-control.guard';
import { DomainWriterModule } from './domain-writer/domain-writer.module';
import { IntegrationWebhooksModule } from './integrations/webhooks/integration-webhooks.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { IntegrationMaintenanceModule } from './integrations/integration-maintenance.module';
import { IntegrationNotifyModule } from './integrations/notify/integration-notify.module';
import { IntegrationChatModule } from './integrations/chat/integration-chat.module';
import { IntegrationGithubModule } from './integrations/github/integration-github.module';
import { ImportsModule } from './imports/imports.module';
import { AutomationsModule } from './automations/automations.module';
import { ViewsModule } from './views/views.module';
import { TemplatesModule } from './templates/templates.module';
import { PlatformModule } from './platform/platform.module';
import { PlatformGuard } from './platform/platform.guard';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Foundations Operational Hardening — exact rate limits:
    //   default: 100 req/min per IP (everything not overridden below)
    //   /auth/login, /auth/register, /auth/refresh: 5 req/min per IP
    //     (overridden per-route with @Throttle in AuthController)
    ThrottlerModule.forRoot([
      {
        name: 'default',
        ttl: 60_000,
        limit: 100,
      },
    ]),
    FeatureFlagsModule,
    RedisModule,
    CryptoModule, // no caller yet - Phase 2's IntegrationCredential is the first (step 0.5)
    QueueModule, // producer side only; consumers live in the worker process
    PrismaModule,
    WebhookIdempotencyModule,
    AuthModule,
    AccessControlModule,
    PlatformModule, // no route yet - Phase 6's moderation queue is the first (step 0.6)
    HealthModule,
    TemplatesModule, // step 3.5; 404 while FEATURE_TEMPLATES is off
    AutomationsModule, // step 5.1; 404 while FEATURE_WORKFLOW is off
    ViewsModule, // step 5.4; 404 while FEATURE_WORKFLOW is off
    MetricsModule, // step 2.7: GET /metrics (bearer METRICS_TOKEN)
    EventsModule,
    TenancyModule,
    ProjectsTasksModule,
    IntegrationWebhooksModule, // no webhook route yet - 2.6 is the first (step 0.9)
    IntegrationsModule, // step 2.1: connect / callback / list / revoke (FEATURE_INTEGRATIONS)
    ImportsModule, // step 4.1: import job control (FEATURE_IMPORTS); the executor runs in the worker (step 4.4)
    IntegrationMaintenanceModule, // step 2.1: oauth_states retention sweep
    IntegrationNotifyModule, // step 2.3: notification router + notify.deliver
    IntegrationChatModule, // step 2.4: Discord interactions endpoint + chat.command job
    IntegrationGithubModule, // step 2.6: GitHub webhook + repo links
    DomainWriterModule, // no caller yet - Phase 2 chat is the first (step 0.7)
    ActivityNotificationsModule,
    CollaborationModule,
    AttachmentsModule,
    SnapModule,
    BillingModule,
  ],
  providers: [
    // Global exception filter — ONE, per Foundations.
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    // Global ClassSerializerInterceptor — structural safety net for
    // Validation Rule 4 (@Exclude on password etc.), applies regardless
    // of whether a controller remembers to apply it locally.
    { provide: APP_INTERCEPTOR, useClass: ClassSerializerInterceptor },
    // FeatureGuard FIRST (ADR-0002): a route whose feature flag is off must
    // answer 404 before auth can answer 401 and reveal that it exists.
    { provide: APP_GUARD, useClass: FeatureGuard },
    // Then throttler, then auth, then access-control/platform — order
    // matters: AccessControlGuard/PlatformGuard both read request.user,
    // which JwtAuthGuard sets. AccessControlGuard vs PlatformGuard order
    // doesn't matter between themselves — disjoint metadata keys, a route
    // uses one or the other, never both.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: AccessControlGuard },
    { provide: APP_GUARD, useClass: PlatformGuard },
    Reflector,
  ],
})
export class AppModule {}
