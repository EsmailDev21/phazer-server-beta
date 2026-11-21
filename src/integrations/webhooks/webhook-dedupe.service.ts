import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { IntegrationProvider } from '@prisma/client';
import { MetricsService } from '../../metrics/metrics.service';
import { PrismaService } from '../../prisma/prisma.service';

export const WEBHOOK_EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const DELIVERY_ID_MAX_LENGTH = 200;
const SWEEP_BATCH = 1_000;
const SWEEP_MAX_BATCHES = 100;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

export interface AcceptResult {
  /** True = this delivery id was already accepted; nothing was enqueued. */
  duplicate: boolean;
}

/**
 * Delivery-id dedupe for provider webhooks (step 0.9, diagram 08).
 *
 * CONTRACT FOR CALLERS (the Phase 2 adapters):
 *   1. Verify the signature against the raw body FIRST.
 *   2. Only then call acceptDelivery(). This table is written by that call, so
 *      calling it before verification would let an unauthenticated caller
 *      fill it - and, worse, burn a real delivery id with a forged request so
 *      the genuine one is dropped as a duplicate.
 *   3. Answer 200 whatever the result: a duplicate is success.
 *
 * "First time" is ONE atomic statement (INSERT ... ON CONFLICT DO NOTHING via
 * createMany+skipDuplicates; the row count says whether this call won), so two
 * simultaneous deliveries of the same id cannot both be processed.
 */
@Injectable()
export class WebhookDedupeService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  /** True if this call recorded the id (first time); false if it was already there. */
  async claim(
    provider: IntegrationProvider,
    deliveryId: string,
  ): Promise<boolean> {
    this.assertDeliveryId(deliveryId);
    const { count } = await this.prisma.integrationWebhookEvent.createMany({
      data: [{ provider, deliveryId }],
      skipDuplicates: true,
    });
    if (count !== 1) this.metrics?.webhookDuplicate.inc({ provider });
    return count === 1;
  }

  /** Forget a claim. Used when the work that followed the claim could not be queued. */
  async release(
    provider: IntegrationProvider,
    deliveryId: string,
  ): Promise<void> {
    await this.prisma.integrationWebhookEvent.deleteMany({
      where: { provider, deliveryId },
    });
  }

  /**
   * claim -> enqueue, with the claim undone if enqueue fails.
   *
   * Without the undo, a Redis blip between "recorded" and "queued" would lose
   * the delivery permanently: the provider's redelivery (GitHub's manual
   * "Redeliver" button re-sends the SAME delivery id) would be swallowed as a
   * duplicate. On failure the error is rethrown, so the route answers 5xx and
   * the provider shows the delivery as failed.
   *
   * A failure AFTER a successful enqueue (the worker job itself) is the queue's
   * business - attempts/backoff - and deliberately leaves the claim in place:
   * the job exists, so a redelivery must not create a second one.
   */
  async acceptDelivery(params: {
    provider: IntegrationProvider;
    deliveryId: string;
    enqueue: () => Promise<unknown>;
  }): Promise<AcceptResult> {
    const { provider, deliveryId, enqueue } = params;
    if (!(await this.claim(provider, deliveryId))) return { duplicate: true };

    try {
      await enqueue();
    } catch (err) {
      try {
        await this.release(provider, deliveryId);
      } catch {
        // Could not undo either (database down too). The original error is the
        // one worth reporting; a stuck claim ages out with the 7-day sweep.
      }
      throw err;
    }
    return { duplicate: false };
  }

  /**
   * Retention sweep. Deletes in small batches (bounded per run) rather than one
   * giant DELETE, so a busy installation does not hold a long lock; `hasMore`
   * says the run hit its cap and the next run continues.
   */
  async sweep(
    now: Date = new Date(),
    retentionMs: number = WEBHOOK_EVENT_RETENTION_MS,
  ): Promise<{ deleted: number; hasMore: boolean }> {
    const cutoff = new Date(now.getTime() - retentionMs);
    let deleted = 0;
    for (let i = 0; i < SWEEP_MAX_BATCHES; i++) {
      const batch = await this.prisma.integrationWebhookEvent.findMany({
        where: { receivedAt: { lt: cutoff } },
        select: { id: true },
        orderBy: { receivedAt: 'asc' },
        take: SWEEP_BATCH,
      });
      if (batch.length === 0) return { deleted, hasMore: false };
      const res = await this.prisma.integrationWebhookEvent.deleteMany({
        where: { id: { in: batch.map((b) => b.id) } },
      });
      deleted += res.count;
      if (batch.length < SWEEP_BATCH) return { deleted, hasMore: false };
    }
    return { deleted, hasMore: true };
  }

  private assertDeliveryId(deliveryId: string): void {
    if (
      typeof deliveryId !== 'string' ||
      deliveryId.length === 0 ||
      deliveryId.length > DELIVERY_ID_MAX_LENGTH ||
      CONTROL_CHARS.test(deliveryId)
    ) {
      throw new BadRequestException(
        `deliveryId must be 1-${DELIVERY_ID_MAX_LENGTH} printable characters`,
      );
    }
  }
}
