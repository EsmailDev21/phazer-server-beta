import { Injectable, Logger } from '@nestjs/common';
import { PaymentProvider, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Foundations Operational Hardening — webhook idempotency.
 *
 * Backed by ProcessedWebhookEvent { provider, externalEventId } (compound
 * unique, since each payment provider has its own event-id namespace).
 *
 * Usage (future Billing module, StripeService/MorService/TunisiaGatewayService
 * .handleWebhookEvent): look up (provider, externalEventId) FIRST — if found,
 * return 200 immediately without re-running side effects. If not found,
 * process THEN insert, in the same transaction as the side effect where
 * possible.
 */
@Injectable()
export class WebhookIdempotencyService {
  private readonly logger = new Logger(WebhookIdempotencyService.name);

  constructor(private readonly prisma: PrismaService) {}

  async wasAlreadyProcessed(
    provider: PaymentProvider,
    externalEventId: string,
  ): Promise<boolean> {
    const existing = await this.prisma.processedWebhookEvent.findUnique({
      where: { provider_externalEventId: { provider, externalEventId } },
    });
    return existing !== null;
  }

  /**
   * Runs `sideEffect` and records the event as processed in the SAME
   * transaction, unless it was already processed (in which case sideEffect
   * is skipped entirely and this resolves immediately).
   *
   * `sideEffect` receives the transaction client so any writes it performs
   * are atomic with the idempotency marker.
   */
  async runIdempotent<T>(
    provider: PaymentProvider,
    externalEventId: string,
    sideEffect: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<{ alreadyProcessed: boolean; result?: T }> {
    if (await this.wasAlreadyProcessed(provider, externalEventId)) {
      this.logger.log(
        `Skipping already-processed webhook event ${provider}:${externalEventId}`,
      );
      return { alreadyProcessed: true };
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const sideEffectResult = await sideEffect(tx);
      await tx.processedWebhookEvent.create({
        data: { provider, externalEventId },
      });
      return sideEffectResult;
    });

    return { alreadyProcessed: false, result };
  }
}
