import { ChannelDeliverySweepJob, DEFAULT_DELIVERY_RETENTION_DAYS, resolveDeliveryRetentionDays } from './channel-delivery-sweep.job';

describe('resolveDeliveryRetentionDays', () => {
  it('defaults to 30; accepts an integer >= 7; refuses anything else (a value that would empty the delivery log is a typo)', () => {
    expect(resolveDeliveryRetentionDays(undefined)).toBe(DEFAULT_DELIVERY_RETENTION_DAYS);
    expect(resolveDeliveryRetentionDays('90')).toBe(90);
    expect(resolveDeliveryRetentionDays(' 7 ')).toBe(7);
    for (const bad of ['6', '0', '-30', '1.5', 'abc', '']) expect(resolveDeliveryRetentionDays(bad)).toBe(DEFAULT_DELIVERY_RETENTION_DAYS);
  });
});

describe('ChannelDeliverySweepJob', () => {
  const DAY = 24 * 60 * 60 * 1000;
  function make(rows: number, setting?: string) {
    let left = rows;
    const findMany = jest.fn(async ({ take }: { take: number }) => { const n = Math.min(take, left); return Array.from({ length: n }, (_, i) => ({ id: `r${i}` })); });
    const deleteMany = jest.fn(async ({ where }: { where: { id: { in: string[] } } }) => { left -= where.id.in.length; return { count: where.id.in.length }; });
    const registry = { register: jest.fn(), registerSchedule: jest.fn() };
    const job = new ChannelDeliverySweepJob(registry as never, { channelDelivery: { findMany, deleteMany } } as never, { get: () => setting } as never);
    return { job, findMany, deleteMany, registry };
  }

  it('registers on the always-on system queue, hourly', () => {
    const { job, registry } = make(0);
    job.onModuleInit();
    expect(registry.register).toHaveBeenCalledWith(job);
    expect(registry.registerSchedule).toHaveBeenCalledWith(expect.objectContaining({ queue: 'system', schedulerId: 'channel-deliveries-sweep-hourly', everyMs: 3_600_000 }));
  });

  it('deletes only rows older than the cutoff, whatever their status (a PENDING that old lost its job)', async () => {
    const { job, findMany } = make(3, '14');
    const now = new Date('2026-10-14T12:00:00Z');
    const r = await job.sweep(now);
    expect(r).toEqual({ deleted: 3, hasMore: false, retentionDays: 14 });
    const where = (findMany.mock.calls[0] as unknown as [{ where: { createdAt: { lt: Date } } }])[0].where;
    expect(where.createdAt.lt.getTime()).toBe(now.getTime() - 14 * DAY);
    expect(JSON.stringify(where)).not.toContain('status');
  });

  it('is capped per run and says so; the next run continues', async () => {
    const { job } = make(5000 * 40 + 10);
    const r = await job.sweep();
    expect(r.deleted).toBe(5000 * 40);
    expect(r.hasMore).toBe(true);
  });

  it('nothing to delete: no delete call', async () => {
    const { job, deleteMany } = make(0);
    expect(await job.sweep()).toEqual({ deleted: 0, hasMore: false, retentionDays: 30 });
    expect(deleteMany).not.toHaveBeenCalled();
  });
});
