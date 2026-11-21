/**
 * Runs against a REAL Redis (TEST_REDIS_URL); skipped without it, like redis.real.spec.ts. BullMQ's list ordering is an internal
 * detail, so the "oldest waiting job" gauge is verified against the real thing rather than a fake.
 */
import { Queue } from 'bullmq';
import { QUEUE_DEFINITIONS } from '../queue/queue.definitions';
import { MetricsService } from './metrics.service';
import { SharedStateCollector } from './shared-state.collector';

const TARGET = process.env.TEST_REDIS_URL;
const d = TARGET ? describe : describe.skip;

d('SharedStateCollector against real Redis', () => {
  const queues = new Map<string, Queue>();
  const getQueue = (name: string) => {
    if (!queues.has(name)) {
      const u = new URL(TARGET!);
      queues.set(name, new Queue(`metrics-spec-${name}`, { connection: { host: u.hostname, port: Number(u.port || 6379) } }));
    }
    return queues.get(name)!;
  };
  afterAll(async () => { for (const q of queues.values()) await q.close(); });

  it('reports waiting counts per queue and the age of the OLDEST waiting job (not the newest)', async () => {
    for (const def of QUEUE_DEFINITIONS) await getQueue(def.name).obliterate({ force: true });
    const q = getQueue('notify');
    await q.add('first', {});
    await new Promise((r) => setTimeout(r, 1500));
    await q.add('second', {}); await q.add('third', {});

    const prisma = {
      integrationConnection: { groupBy: async () => [] }, $queryRaw: async () => [], channelDelivery: { findFirst: async () => null },
      channelSubscription: { count: async () => 0 }, integrationCredential: { groupBy: async () => [] },
    };
    const m = new MetricsService();
    const col = new SharedStateCollector(m, prisma as never, { configured: true, getQueue } as never);
    col.onModuleInit();
    const text = await m.render();
    expect(text).toContain('queue_jobs{queue="notify",state="waiting"} 3');
    expect(text).toContain('queue_jobs{queue="chat",state="waiting"} 0');
    expect(Number(/queue_oldest_waiting_age_seconds\{queue="notify"\} ([\d.]+)/.exec(text)![1])).toBeGreaterThan(1.4);
    expect(text).toContain('queue_inspection_up 1');
    for (const def of QUEUE_DEFINITIONS) await getQueue(def.name).obliterate({ force: true });
  }, 30_000);
});
