import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { IntegrationProvider } from '@prisma/client';
import { PermissionResolver } from '../access-control/access-control.service';
import { PlanLimitsService } from '../access-control/plan-limits.service';
import { TokenVaultService } from '../crypto/token-vault.service';
import { AuditLogService } from '../events/audit-log.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { ConnectorRegistry } from './core/connector.registry';
import { OAuthService } from './core/oauth.service';
import { ProviderHttpClient } from './core/provider-http.client';
import { IntegrationsController } from './integrations.controller';
import { IntegrationsModule } from './integrations.module';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { JobHandlerRegistry } from '../queue/job-handler.registry';
import { QueueService } from '../queue/queue.service';
import { NotificationRouter } from './notify/notification-router.service';
import { NotifyDeliverJob } from './notify/notify-deliver.job';
import { IntegrationNotifyModule } from './notify/integration-notify.module';
import { ChannelController } from './channel.controller';

// The globals the real app provides, stubbed: this spec only proves the module's own DI graph resolves.
@Global()
@Module({
  providers: [
    { provide: PrismaService, useValue: {} },
    { provide: RedisService, useValue: { configured: false, isReady: () => false } },
    { provide: TokenVaultService, useValue: { configured: false } },
    { provide: PermissionResolver, useValue: {} },
    { provide: PlanLimitsService, useValue: { registerCounter: jest.fn() } },
    { provide: AuditLogService, useValue: {} },
    { provide: EventEmitter2, useValue: new EventEmitter2() },
    { provide: ConfigService, useValue: { get: () => undefined } },
    { provide: QueueService, useValue: { enqueue: jest.fn() } },
    { provide: FeatureFlagsService, useValue: { isEnabled: () => true } },
    { provide: JobHandlerRegistry, useValue: { register: jest.fn(), registerSchedule: jest.fn() } },
  ],
  exports: [PrismaService, RedisService, TokenVaultService, PermissionResolver, PlanLimitsService, AuditLogService, EventEmitter2, ConfigService, QueueService, FeatureFlagsService, JobHandlerRegistry],
})
class GlobalsStub {}

describe('IntegrationsModule wiring', () => {
  it('compiles; registry holds every shipped provider (chat, code host, trackers); controller and services resolve', async () => {
    const m = await Test.createTestingModule({ imports: [GlobalsStub, IntegrationsModule] }).compile();
    const registry = m.get(ConnectorRegistry);
    for (const p of [IntegrationProvider.DISCORD, IntegrationProvider.SLACK, IntegrationProvider.GITHUB, IntegrationProvider.LINEAR, IntegrationProvider.CLICKUP, IntegrationProvider.JIRA, IntegrationProvider.ASANA, IntegrationProvider.MONDAY, IntegrationProvider.NOTION]) {
      expect(registry.has(p)).toBe(true);
    }
    expect(m.get(IntegrationsController)).toBeDefined();
    expect(m.get(OAuthService)).toBeDefined();
    expect(m.get(ProviderHttpClient)).toBeDefined();
    // nothing is configured in this env: every adapter says so instead of crashing
    expect(registry.all().every((a) => !a.isConfigured())).toBe(true);
  });

  it('IntegrationNotifyModule (imported by API AND worker) compiles on its own: router + deliver job resolve and the job registers itself', async () => {
    const m = await Test.createTestingModule({ imports: [GlobalsStub, IntegrationNotifyModule] }).compile();
    await m.init();
    expect(m.get(NotificationRouter)).toBeDefined();
    expect(m.get(NotifyDeliverJob)).toBeDefined();
    expect(m.get(JobHandlerRegistry).register).toHaveBeenCalledWith(m.get(NotifyDeliverJob));
  });

  it('the API module exposes the channel admin controller', async () => {
    const m = await Test.createTestingModule({ imports: [GlobalsStub, IntegrationsModule] }).compile();
    expect(m.get(ChannelController)).toBeDefined();
  });
});
