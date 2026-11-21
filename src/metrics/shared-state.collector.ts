import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { QUEUE_DEFINITIONS } from '../queue/queue.definitions';
import { QueueService } from '../queue/queue.service';
import { MetricsService } from './metrics.service';

const QUEUE_STATES = ['waiting', 'active', 'delayed', 'failed', 'prioritized'] as const;
/** BullMQ calls can hang during a Redis outage (its connection retries forever); a scrape must not. */
const QUEUE_READ_TIMEOUT_MS = 2_000;
/** Concurrent scrapes (two Prometheus replicas, a curl) share one set of queries. */
const CACHE_MS = 5_000;

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });

/**
 * The shared-state gauges (see MetricsService). Everything here is a read: counts and ages only, never a payload,
 * a token or a ciphertext (a credential is reported only by its key id).
 */
@Injectable()
export class SharedStateCollector implements OnModuleInit {
  private lastRun = 0;
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly metrics: MetricsService,
    private readonly prisma: PrismaService,
    private readonly queues: QueueService,
  ) {}

  onModuleInit(): void {
    this.metrics.registerCollector(this.collect.bind(this));
  }

  collect(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (Date.now() - this.lastRun < CACHE_MS) return Promise.resolve();
    this.inFlight = this.run().finally(() => {
      this.lastRun = Date.now();
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async run(): Promise<void> {
    await Promise.all([this.queueDepth(), this.database()]);
  }

  private async queueDepth(): Promise<void> {
    const m = this.metrics;
    m.queueJobs.reset();
    m.queueOldestWaitingSeconds.reset();
    if (!this.queues.configured) {
      m.queueUp.set(0);
      return;
    }
    try {
      for (const def of QUEUE_DEFINITIONS) {
        const q = this.queues.getQueue(def.name);
        const counts = await withTimeout(q.getJobCounts(...QUEUE_STATES), QUEUE_READ_TIMEOUT_MS);
        for (const s of QUEUE_STATES) m.queueJobs.set({ queue: def.name, state: s }, counts[s] ?? 0);
        // Which end of the list is "oldest" is BullMQ's internal ordering, so look at both ends and take the older.
        const ends = await withTimeout(Promise.all([q.getJobs(['waiting'], 0, 0, true), q.getJobs(['waiting'], 0, 0, false)]), QUEUE_READ_TIMEOUT_MS);
        const stamps = ends.flat().map((j) => j.timestamp);
        m.queueOldestWaitingSeconds.set({ queue: def.name }, stamps.length ? Math.max(0, (Date.now() - Math.min(...stamps)) / 1000) : 0);
      }
      m.queueUp.set(1);
    } catch (e) {
      m.queueUp.set(0);
      throw e;
    }
  }

  private async database(): Promise<void> {
    const m = this.metrics;

    const conns = await this.prisma.integrationConnection.groupBy({ by: ['provider', 'status'], _count: { _all: true } });
    m.connections.reset();
    for (const c of conns) m.connections.set({ provider: c.provider, status: c.status }, c._count._all);

    const deliveries = await this.prisma.$queryRaw<Array<{ provider: string; status: string; n: bigint }>>`
      SELECT c.provider::text AS provider, d.status::text AS status, count(*) AS n
      FROM channel_deliveries d
      JOIN channel_subscriptions s ON s.id = d.subscription_id
      JOIN channel_links l ON l.id = s.channel_link_id
      JOIN integration_connections c ON c.id = l.connection_id
      WHERE d.created_at > now() - interval '1 hour'
      GROUP BY 1, 2`;
    m.deliveriesLastHour.reset();
    for (const r of deliveries) m.deliveriesLastHour.set({ provider: r.provider, status: r.status }, Number(r.n));

    const pending = await this.prisma.channelDelivery.findFirst({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    });
    m.oldestPendingDeliverySeconds.set(pending ? Math.max(0, (Date.now() - pending.createdAt.getTime()) / 1000) : 0);

    m.disabledSubscriptions.set(await this.prisma.channelSubscription.count({ where: { enabled: false } }));

    const kids = await this.prisma.integrationCredential.groupBy({ by: ['kid'], _count: { _all: true } });
    m.credentialsByKid.reset();
    for (const k of kids) m.credentialsByKid.set({ kid: k.kid }, k._count._all);
  }
}
