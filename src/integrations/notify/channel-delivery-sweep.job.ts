import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { JobEnvelope } from '../../queue/job-envelope';
import { JobHandler, JobHandlerRegistry } from '../../queue/job-handler.registry';
import { QUEUES } from '../../queue/queue.definitions';

declare module '../../queue/queue.definitions' {
  interface JobPayloads {
    'system.channel-deliveries-sweep': Record<string, never>;
  }
}

export const DEFAULT_DELIVERY_RETENTION_DAYS = 30;
/** Below a week the delivery list (the admin's "why did this not arrive" tool) stops being useful. */
export const MIN_DELIVERY_RETENTION_DAYS = 7;
const BATCH = 5_000;
const MAX_BATCHES = 40;

/** `CHANNEL_DELIVERY_RETENTION_DAYS`: an integer >= 7; anything else falls back to 30. */
export function resolveDeliveryRetentionDays(raw: string | undefined): number {
  const n = Number((raw ?? '').trim());
  return Number.isInteger(n) && n >= MIN_DELIVERY_RETENTION_DAYS ? n : DEFAULT_DELIVERY_RETENTION_DAYS;
}

/**
 * Step 2.7: `channel_deliveries` grows by one row per (subscription, activity) forever (ADR-0011 known gap). Delete rows older than
 * the retention, whatever their status: a PENDING row that old lost its job and will never be sent. On the always-on `system`
 * queue like the other sweeps, so it keeps trimming even if INTEGRATIONS is switched off. Batched; a run that hits its cap
 * says so and the next hourly run continues. Idempotent.
 */
@Injectable()
export class ChannelDeliverySweepJob implements JobHandler<'system.channel-deliveries-sweep'>, OnModuleInit {
  private readonly logger = new Logger(ChannelDeliverySweepJob.name);
  readonly queue = QUEUES.SYSTEM.name;
  readonly jobName = 'system.channel-deliveries-sweep' as const;

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
    this.registry.registerSchedule({
      queue: this.queue,
      schedulerId: 'channel-deliveries-sweep-hourly',
      jobName: this.jobName,
      payload: {},
      everyMs: 60 * 60 * 1000,
    });
  }

  async handle(envelope: JobEnvelope) {
    const r = await this.sweep();
    this.logger.log(`Delivery sweep ${envelope.traceId}: ${r.deleted} deleted${r.hasMore ? ' (more remain, next run continues)' : ''}`);
    return r;
  }

  async sweep(now = new Date()): Promise<{ deleted: number; hasMore: boolean; retentionDays: number }> {
    const retentionDays = resolveDeliveryRetentionDays(this.config.get<string>('CHANNEL_DELIVERY_RETENTION_DAYS'));
    const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
    let deleted = 0;
    for (let i = 0; i < MAX_BATCHES; i++) {
      const rows = await this.prisma.channelDelivery.findMany({ where: { createdAt: { lt: cutoff } }, select: { id: true }, orderBy: { createdAt: 'asc' }, take: BATCH });
      if (rows.length === 0) return { deleted, hasMore: false, retentionDays };
      deleted += (await this.prisma.channelDelivery.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } })).count;
      if (rows.length < BATCH) return { deleted, hasMore: false, retentionDays };
    }
    return { deleted, hasMore: true, retentionDays };
  }
}
