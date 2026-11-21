/**
 * Step 0.9, database level. Needs a real Postgres + generated Prisma Client
 * (`npm run test:integration`). WRITTEN, NOT EXECUTED in the sandbox that
 * produced it (no Prisma engine) - type-checked only. The SQL it relies on
 * (ON CONFLICT DO NOTHING under 40 parallel connections, the length CHECK, the
 * sweep's index scan) was verified directly on a real Postgres.
 */
import { WebhookDedupeService } from '../../src/integrations/webhooks/webhook-dedupe.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import {
  getTestPrisma,
  disconnectTestPrisma,
} from './support/prisma-test-client';
import { resetDb } from './support/reset-db';

describe('WebhookDedupeService (real database)', () => {
  let prisma: PrismaService;
  let svc: WebhookDedupeService;

  beforeAll(() => {
    prisma = getTestPrisma();
    svc = new WebhookDedupeService(prisma);
  });
  beforeEach(() => resetDb(prisma));
  afterAll(() => disconnectTestPrisma());

  it('30 simultaneous deliveries of one id: exactly one is enqueued, one row stored', async () => {
    let enqueued = 0;
    const enqueue = async () => {
      enqueued++;
    };
    const results = await Promise.all(
      Array.from({ length: 30 }, () =>
        svc.acceptDelivery({ provider: 'GITHUB', deliveryId: 'race', enqueue }),
      ),
    );
    expect(enqueued).toBe(1);
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(await prisma.integrationWebhookEvent.count()).toBe(1);
  });

  it('enqueue failure leaves no row, so the redelivery of the same id is processed', async () => {
    await expect(
      svc.acceptDelivery({
        provider: 'GITHUB',
        deliveryId: 'redeliver-me',
        enqueue: async () => {
          throw new Error('redis down');
        },
      }),
    ).rejects.toThrow('redis down');
    expect(await prisma.integrationWebhookEvent.count()).toBe(0);
    const again = await svc.acceptDelivery({
      provider: 'GITHUB',
      deliveryId: 'redeliver-me',
      enqueue: async () => undefined,
    });
    expect(again.duplicate).toBe(false);
  });

  it('sweep removes only rows older than 7 days', async () => {
    const day = 24 * 60 * 60 * 1000;
    await prisma.integrationWebhookEvent.createMany({
      data: [
        {
          provider: 'GITHUB',
          deliveryId: 'old1',
          receivedAt: new Date(Date.now() - 8 * day),
        },
        {
          provider: 'GITHUB',
          deliveryId: 'old2',
          receivedAt: new Date(Date.now() - 30 * day),
        },
        {
          provider: 'GITHUB',
          deliveryId: 'fresh',
          receivedAt: new Date(Date.now() - 1 * day),
        },
      ],
    });
    expect(await svc.sweep()).toEqual({ deleted: 2, hasMore: false });
    const left = await prisma.integrationWebhookEvent.findMany();
    expect(left.map((r) => r.deliveryId)).toEqual(['fresh']);
  });

  it('a swept id can be accepted again (retention is the dedupe window)', async () => {
    await prisma.integrationWebhookEvent.create({
      data: {
        provider: 'GITHUB',
        deliveryId: 'aged',
        receivedAt: new Date(Date.now() - 9 * 24 * 60 * 60 * 1000),
      },
    });
    await svc.sweep();
    expect(await svc.claim('GITHUB', 'aged')).toBe(true);
  });
});
