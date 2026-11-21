/**
 * Compile-only dependency-injection smoke for BOTH root graphs (API and worker), with FEATURE_INTEGRATIONS on.
 * Why it exists: the worker is a separate application context, and a module missing from it (or a provider missing
 * from a shared module) only shows up at boot - found twice before (BillingService, step 0.5) and not caught by any
 * unit test. It needs no network call: compile() builds the provider graph but does not connect or listen.
 * Environment is set here (not by the runner) so the spec cannot silently depend on a developer's shell.
 */
import { randomBytes } from 'crypto';
import { Test } from '@nestjs/testing';

describe('DI smoke (compile only)', () => {
  beforeAll(() => {
    const e = process.env;
    e.FEATURE_INTEGRATIONS ??= 'true';
    e.REDIS_URL ??= e.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379';
    e.JWT_SECRET ??= 'di-smoke';
    e.JWT_REFRESH_SECRET ??= 'di-smoke-refresh';
    e.TOKEN_VAULT_KEYS ??= `k1:${randomBytes(32).toString('base64')}`;
    e.TOKEN_VAULT_CURRENT_KID ??= 'k1';
  });

  it('API graph resolves; router and channel admin controller are present', async () => {
    const { AppModule } = await import('../../src/app.module');
    const { NotificationRouter } = await import('../../src/integrations/notify/notification-router.service');
    const { ChannelController } = await import('../../src/integrations/channel.controller');
    const { DiscordInteractionsController } = await import('../../src/integrations/chat/discord-interactions.controller');
    const m = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const { SlackController } = await import('../../src/integrations/chat/slack/slack.controller');
    expect(m.get(DiscordInteractionsController, { strict: false })).toBeDefined();
    expect(m.get(SlackController, { strict: false })).toBeDefined();
    expect(m.get(NotificationRouter, { strict: false })).toBeDefined();
    expect(m.get(ChannelController, { strict: false })).toBeDefined();
    const { MetricsController } = await import('../../src/metrics/metrics.controller');
    const { IntegrationHealthService } = await import('../../src/integrations/core/integration-health.service');
    expect(m.get(MetricsController, { strict: false })).toBeDefined(); // step 2.7: GET /metrics lives in the API only
    expect(m.get(IntegrationHealthService, { strict: false })).toBeDefined();
    await m.close();
  });

  it('worker graph resolves; it routes its own activities and owns the notify.deliver job', async () => {
    const { WorkerAppModule } = await import('../../src/worker/worker-app.module');
    const { NotificationRouter } = await import('../../src/integrations/notify/notification-router.service');
    const { NotifyDeliverJob } = await import('../../src/integrations/notify/notify-deliver.job');
    const { ChatCommandJob } = await import('../../src/integrations/chat/chat-command.job');
    const m = await Test.createTestingModule({ imports: [WorkerAppModule] }).compile();
    const { ChatUnfurlJob } = await import('../../src/integrations/chat/slack/chat-unfurl.job');
    expect(m.get(ChatCommandJob, { strict: false })).toBeDefined(); // the worker runs the deferred half of every chat command
    expect(m.get(ChatUnfurlJob, { strict: false })).toBeDefined();
    expect(m.get(NotifyDeliverJob, { strict: false })).toBeDefined();
    expect(m.get(NotificationRouter, { strict: false })).toBeDefined();
    const { ChannelDeliverySweepJob } = await import('../../src/integrations/notify/channel-delivery-sweep.job');
    expect(m.get(ChannelDeliverySweepJob, { strict: false })).toBeDefined(); // step 2.7: the retention sweep runs in the worker
    await m.close();
  });
});
