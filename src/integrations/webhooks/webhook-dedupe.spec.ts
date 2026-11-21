/**
 * Step 0.9: "duplicate delivery -> single processing". Unit level over a Prisma
 * double whose createMany({skipDuplicates}) is a genuine insert-or-ignore (the
 * check and the insert are one synchronous step, as ON CONFLICT DO NOTHING is
 * one statement). The SQL-level behaviour was verified separately on a real
 * Postgres (PROGRESS.md); the DB-backed spec is test/integration/webhook-dedupe.int-spec.ts.
 */
import { BadRequestException } from '@nestjs/common';
import { IntegrationWebhookSweepJob } from './webhook-sweep.job';
import {
  DELIVERY_ID_MAX_LENGTH,
  WEBHOOK_EVENT_RETENTION_MS,
  WebhookDedupeService,
} from './webhook-dedupe.service';
import { JobHandlerRegistry } from '../../queue/job-handler.registry';

type Row = {
  id: string;
  provider: string;
  deliveryId: string;
  receivedAt: Date;
};

function makeDb(initial: Row[] = []) {
  const rows: Row[] = [...initial];
  let seq = 0;
  const calls = { findMany: 0, deleteMany: 0 };
  const db: any = {
    integrationWebhookEvent: {
      createMany: async ({ data }: any) => {
        // await first: lets concurrent callers interleave, then check+insert atomically
        await Promise.resolve();
        let count = 0;
        for (const d of data) {
          if (
            !rows.some(
              (r) => r.provider === d.provider && r.deliveryId === d.deliveryId,
            )
          ) {
            rows.push({ id: `e${++seq}`, receivedAt: new Date(), ...d });
            count++;
          }
        }
        return { count };
      },
      deleteMany: async ({ where }: any) => {
        calls.deleteMany++;
        const before = rows.length;
        const keep = rows.filter((r) => {
          if (where.id?.in) return !where.id.in.includes(r.id);
          return !(
            r.provider === where.provider && r.deliveryId === where.deliveryId
          );
        });
        rows.length = 0;
        rows.push(...keep);
        return { count: before - keep.length };
      },
      findMany: async ({ where, take }: any) => {
        calls.findMany++;
        return rows
          .filter((r) => r.receivedAt < where.receivedAt.lt)
          .sort((a, b) => +a.receivedAt - +b.receivedAt)
          .slice(0, take)
          .map((r) => ({ id: r.id }));
      },
    },
  };
  return { db, rows, calls, svc: new WebhookDedupeService(db) };
}

describe('WebhookDedupeService.acceptDelivery', () => {
  it('first delivery is enqueued once; the same id again is a duplicate and enqueues nothing', async () => {
    const { svc } = makeDb();
    const enqueue = jest.fn().mockResolvedValue(undefined);
    expect(
      await svc.acceptDelivery({
        provider: 'GITHUB',
        deliveryId: 'd1',
        enqueue,
      }),
    ).toEqual({ duplicate: false });
    expect(
      await svc.acceptDelivery({
        provider: 'GITHUB',
        deliveryId: 'd1',
        enqueue,
      }),
    ).toEqual({ duplicate: true });
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('20 simultaneous deliveries of one id: exactly ONE is processed', async () => {
    const { svc, rows } = makeDb();
    const enqueue = jest.fn().mockResolvedValue(undefined);
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        svc.acceptDelivery({ provider: 'GITHUB', deliveryId: 'same', enqueue }),
      ),
    );
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(rows).toHaveLength(1);
  });

  it('the key is (provider, deliveryId): same id on another provider is a different delivery', async () => {
    const { svc } = makeDb();
    const enqueue = jest.fn().mockResolvedValue(undefined);
    await svc.acceptDelivery({ provider: 'GITHUB', deliveryId: 'x', enqueue });
    const other = await svc.acceptDelivery({
      provider: 'SLACK',
      deliveryId: 'x',
      enqueue,
    });
    expect(other.duplicate).toBe(false);
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it('enqueue failure releases the claim and rethrows, so a redelivery of the SAME id is processed', async () => {
    const { svc, rows } = makeDb();
    const boom = new Error('redis down');
    await expect(
      svc.acceptDelivery({
        provider: 'GITHUB',
        deliveryId: 'd9',
        enqueue: async () => {
          throw boom;
        },
      }),
    ).rejects.toBe(boom);
    expect(rows).toHaveLength(0);

    const enqueue = jest.fn().mockResolvedValue(undefined);
    expect(
      await svc.acceptDelivery({
        provider: 'GITHUB',
        deliveryId: 'd9',
        enqueue,
      }),
    ).toEqual({ duplicate: false });
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('if the release ALSO fails, the ORIGINAL error is what surfaces', async () => {
    const { svc, db } = makeDb();
    db.integrationWebhookEvent.deleteMany = async () => {
      throw new Error('db down too');
    };
    const original = new Error('redis down');
    await expect(
      svc.acceptDelivery({
        provider: 'GITHUB',
        deliveryId: 'd',
        enqueue: async () => {
          throw original;
        },
      }),
    ).rejects.toBe(original);
  });

  it("a failure after a SUCCESSFUL enqueue is not this service's to undo (the job exists)", async () => {
    const { svc, rows } = makeDb();
    await svc.acceptDelivery({
      provider: 'GITHUB',
      deliveryId: 'kept',
      enqueue: async () => undefined,
    });
    expect(rows.map((r) => r.deliveryId)).toEqual(['kept']);
  });

  it.each([
    ['empty', ''],
    ['too long', 'x'.repeat(DELIVERY_ID_MAX_LENGTH + 1)],
    ['control char', 'a\u0000b'],
    ['newline', 'a\nb'],
  ])(
    'rejects a %s delivery id before touching the database',
    async (_n, id) => {
      const { svc, rows } = makeDb();
      const enqueue = jest.fn();
      await expect(
        svc.acceptDelivery({ provider: 'GITHUB', deliveryId: id, enqueue }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(enqueue).not.toHaveBeenCalled();
      expect(rows).toHaveLength(0);
    },
  );

  it('accepts the boundary length and typical real ids (GUID, Slack event id)', async () => {
    const { svc } = makeDb();
    const ok = async (id: string) => (await svc.claim('GITHUB', id)) === true;
    expect(await ok('x'.repeat(DELIVERY_ID_MAX_LENGTH))).toBe(true);
    expect(await ok('72d3162e-cc78-11e3-81ab-4c9367dc0958')).toBe(true);
    expect(await ok('Ev0PV52K25')).toBe(true);
  });
});

describe('WebhookDedupeService.sweep', () => {
  const now = new Date('2026-10-10T00:00:00Z');
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const mk = (n: number, receivedAt: Date, prefix = 'r'): Row[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `${prefix}${i}`,
      provider: 'GITHUB',
      deliveryId: `${prefix}${i}`,
      receivedAt,
    }));

  it('deletes rows older than 7 days, keeps newer ones, exactly at the boundary', async () => {
    const day = 24 * 60 * 60 * 1000;
    const { svc, rows } = makeDb([
      ...mk(3, ago(8 * day), 'old'),
      ...mk(2, ago(6 * day), 'new'),
      {
        id: 'edge',
        provider: 'GITHUB',
        deliveryId: 'edge',
        receivedAt: ago(WEBHOOK_EVENT_RETENTION_MS),
      }, // exactly 7d: NOT older than the cutoff
    ]);
    const res = await svc.sweep(now);
    expect(res).toEqual({ deleted: 3, hasMore: false });
    expect(rows.map((r) => r.id).sort()).toEqual(['edge', 'new0', 'new1']);
  });

  it('works in batches of 1000 rather than one giant delete', async () => {
    const { svc, rows, calls } = makeDb(
      mk(2500, ago(30 * 24 * 60 * 60 * 1000)),
    );
    const res = await svc.sweep(now);
    expect(res).toEqual({ deleted: 2500, hasMore: false });
    expect(rows).toHaveLength(0);
    expect(calls.deleteMany).toBe(3);
  });

  it('is bounded per run: reports hasMore instead of looping forever, next run continues', async () => {
    const { svc, rows } = makeDb(mk(100_500, ago(30 * 24 * 60 * 60 * 1000)));
    const first = await svc.sweep(now);
    expect(first).toEqual({ deleted: 100_000, hasMore: true });
    expect(rows).toHaveLength(500);
    expect(await svc.sweep(now)).toEqual({ deleted: 500, hasMore: false });
  });

  it('an empty table is a cheap no-op', async () => {
    const { svc, calls } = makeDb();
    expect(await svc.sweep(now)).toEqual({ deleted: 0, hasMore: false });
    expect(calls.deleteMany).toBe(0);
  });
});

describe('IntegrationWebhookSweepJob', () => {
  it('registers its handler and an hourly schedule on the always-on system queue', () => {
    const registry = new JobHandlerRegistry();
    const dedupe: any = {
      sweep: jest.fn().mockResolvedValue({ deleted: 4, hasMore: false }),
    };
    const job = new IntegrationWebhookSweepJob(registry, dedupe);
    job.onModuleInit();
    expect(
      registry.get('system', 'system.integration-webhook-events-sweep'),
    ).toBe(job);
    expect(registry.schedulesFor('system')).toEqual([
      expect.objectContaining({
        schedulerId: 'integration-webhook-events-sweep-hourly',
        everyMs: 3_600_000,
      }),
    ]);
  });

  it('handle() runs the sweep and returns its result', async () => {
    const dedupe: any = {
      sweep: jest.fn().mockResolvedValue({ deleted: 4, hasMore: true }),
    };
    const job = new IntegrationWebhookSweepJob(
      new JobHandlerRegistry(),
      dedupe,
    );
    expect(await job.handle({ traceId: 't' } as any)).toEqual({
      deleted: 4,
      hasMore: true,
    });
  });
});
