import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';
import { SharedStateCollector } from './shared-state.collector';

const TOKEN = 'a-metrics-token-of-sufficient-length';
const controller = (token: string | undefined, m = new MetricsService()) => ({
  m,
  c: new MetricsController(m, { get: (k: string) => (k === 'METRICS_TOKEN' ? token : undefined) } as never),
});

describe('GET /metrics access', () => {
  it('no token configured, or one too short to be a secret: the route does not exist (404), even for a caller who sends a header', async () => {
    await expect(controller(undefined).c.scrape(`Bearer ${TOKEN}`)).rejects.toBeInstanceOf(NotFoundException);
    await expect(controller('').c.scrape('Bearer x')).rejects.toBeInstanceOf(NotFoundException);
    await expect(controller('short').c.scrape('Bearer short')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('missing, malformed or wrong credentials: 401 and nothing is rendered', async () => {
    const { c, m } = controller(TOKEN);
    const render = jest.spyOn(m, 'render');
    for (const h of [undefined, '', 'Bearer', 'Bearer ', `Basic ${TOKEN}`, `bearer ${TOKEN}`, `Bearer ${TOKEN}x`, `Bearer ${TOKEN.slice(1)}`, 'Bearer wrong']) {
      await expect(c.scrape(h)).rejects.toBeInstanceOf(UnauthorizedException);
    }
    expect(render).not.toHaveBeenCalled();
  });

  it('the right bearer token gets the Prometheus text, including process metrics', async () => {
    const { c } = controller(TOKEN);
    const text = await c.scrape(`Bearer ${TOKEN}`);
    expect(text).toContain('# TYPE process_cpu_user_seconds_total counter');
    expect(text).toContain('# TYPE integration_webhook_rejected_total counter');
  });
});

describe('MetricsService', () => {
  it('a failing collector drops only its own series: the scrape still succeeds and the failure is counted', async () => {
    const m = new MetricsService();
    m.registerCollector(async function good(mm) { mm.disabledSubscriptions.set(4); });
    m.registerCollector(async function broken() { throw new Error('redis down'); });
    const text = await m.render();
    expect(text).toContain('integration_subscriptions_disabled 4');
    expect(text).toContain('metrics_collector_errors_total{collector="broken"} 1');
  });

  it('counters carry provider/reason labels and never anything request-derived', async () => {
    const m = new MetricsService();
    m.webhookRejected.inc({ provider: 'SLACK', reason: 'expired' });
    m.webhookDuplicate.inc({ provider: 'GITHUB' });
    const text = await m.render();
    expect(text).toContain('integration_webhook_rejected_total{provider="SLACK",reason="expired"} 1');
    expect(text).toContain('integration_webhook_duplicates_total{provider="GITHUB"} 1');
  });
});

describe('SharedStateCollector', () => {
  const fakePrisma = (over: Record<string, unknown> = {}) => ({
    integrationConnection: { groupBy: jest.fn().mockResolvedValue([{ provider: 'SLACK', status: 'ACTIVE', _count: { _all: 2 } }]) },
    $queryRaw: jest.fn().mockResolvedValue([{ provider: 'SLACK', status: 'FAILED', n: BigInt(3) }]),
    channelDelivery: { findFirst: jest.fn().mockResolvedValue(null) },
    channelSubscription: { count: jest.fn().mockResolvedValue(1) },
    integrationCredential: { groupBy: jest.fn().mockResolvedValue([{ kid: 'k1', _count: { _all: 5 } }]) },
    ...over,
  });

  it('exports DB state as gauges (credentials only by key id) and reports the queue as down when Redis is not configured', async () => {
    const m = new MetricsService();
    const col = new SharedStateCollector(m, fakePrisma() as never, { configured: false } as never);
    await col.collect();
    const text = await m.render();
    expect(text).toContain('integration_connections{provider="SLACK",status="ACTIVE"} 2');
    expect(text).toContain('integration_channel_deliveries_last_hour{provider="SLACK",status="FAILED"} 3');
    expect(text).toContain('integration_credentials_by_kid{kid="k1"} 5');
    expect(text).toContain('integration_subscriptions_disabled 1');
    expect(text).toContain('queue_inspection_up 0');
  });

  it('reads queue depth per queue and state, and the age of the oldest waiting job', async () => {
    const m = new MetricsService();
    const q = {
      getJobCounts: jest.fn().mockResolvedValue({ waiting: 7, active: 1, delayed: 2, failed: 3, prioritized: 0 }),
      getJobs: jest.fn().mockResolvedValue([{ timestamp: Date.now() - 90_000 }]),
    };
    const col = new SharedStateCollector(m, fakePrisma() as never, { configured: true, getQueue: () => q } as never);
    await col.collect();
    const text = await m.render();
    expect(text).toContain('queue_jobs{queue="notify",state="waiting"} 7');
    expect(text).toContain('queue_jobs{queue="chat",state="failed"} 3');
    expect(text).toMatch(/queue_oldest_waiting_age_seconds\{queue="webhooks"\} (89|90|91)(\.\d+)?/);
    expect(text).toContain('queue_inspection_up 1');
  });

  it('a Redis that hangs cannot hang the scrape: it times out, queue_inspection_up is 0, the DB gauges are still served', async () => {
    const m = new MetricsService();
    const q = { getJobCounts: jest.fn(() => new Promise(() => undefined)), getJobs: jest.fn() };
    const col = new SharedStateCollector(m, fakePrisma() as never, { configured: true, getQueue: () => q } as never);
    col.onModuleInit();
    const t0 = Date.now();
    const text = await m.render();
    expect(Date.now() - t0).toBeLessThan(4_000);
    expect(text).toContain('queue_inspection_up 0');
    expect(text).toContain('metrics_collector_errors_total');
  }, 10_000);

  it('concurrent scrapes share one set of queries (and a scrape right after another is served from the 5 s cache)', async () => {
    const m = new MetricsService();
    const prisma = fakePrisma();
    const col = new SharedStateCollector(m, prisma as never, { configured: false } as never);
    await Promise.all([col.collect(), col.collect(), col.collect()]);
    await col.collect();
    expect((prisma.integrationConnection.groupBy as jest.Mock).mock.calls).toHaveLength(1);
  });
});
