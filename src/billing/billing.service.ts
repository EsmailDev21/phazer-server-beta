import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PaymentProvider, Prisma } from '@prisma/client';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { WebhookIdempotencyService } from '../common/webhook-idempotency/webhook-idempotency.service';
import {
  BILLING_TIERS,
  getPlanLimits,
} from '../common/config/billing-tiers.config';
import { CreateCheckoutDto } from './dto/create-checkout.dto';
import { QueryInvoicesDto } from './dto/query-invoices.dto';
import { ProviderRouterService } from './providers/provider-router.service';
import { NormalizedBillingEvent } from './providers/payment-gateway-provider.interface';

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly providerRouter: ProviderRouterService,
    private readonly webhookIdempotency: WebhookIdempotencyService,
  ) {}

  getTiers() {
    // Public — GET /billing/tiers needs no auth. Returns the SAME config
    // every enforcement check reads from; no parallel/rounded-off copy
    // for display purposes.
    return BILLING_TIERS;
  }

  async getSubscriptionDetails(accountId: string) {
    const account = await this.getAccountOrThrow(accountId);
    const seatsUsed = await this.prisma.accountMember.count({
      where: { accountId },
    });
    const limits = getPlanLimits(account.planType);

    return {
      planType: account.planType,
      paymentProvider: account.paymentProvider,
      subscriptionStatus: account.subscriptionStatus,
      currentPeriodStart: account.currentPeriodStart,
      currentPeriodEnd: account.currentPeriodEnd,
      canceledAt: account.canceledAt,
      trialEndsAt: account.trialEndsAt,
      seatsIncluded: limits.includedSeats,
      seatsUsed,
      overageCostPerSeatUsd: limits.overageCostPerSeatUsd,
    };
  }

  /**
   * Live usage vs. plan limits — reads the exact same BILLING_TIERS
   * numbers PlanLimitsService enforces, so this can never drift from
   * what actually gets blocked (the old code's confirmed bug).
   */
  async getUsage(accountId: string) {
    const account = await this.getAccountOrThrow(accountId);
    const limits = getPlanLimits(account.planType);

    const [workspaceCount, seatCount, storageUsed] = await Promise.all([
      this.prisma.workspace.count({ where: { accountId } }),
      this.prisma.accountMember.count({ where: { accountId } }),
      this.prisma.attachment.aggregate({
        where: { accountId, status: 'CONFIRMED' },
        _sum: { sizeBytes: true },
      }),
    ]);

    const projectCount =
      account.type === 'PERSONAL'
        ? null // per-workspace, not a single account-level number — see note below
        : await this.prisma.project.count({
            where: { workspace: { accountId } },
          });

    return {
      workspaces: { used: workspaceCount, limit: limits.workspaces },
      // PERSONAL project/task limits are per-workspace, not account-total
      // (see billing-tiers.config.ts) — a single account-wide "used"
      // number would misrepresent the actual constraint. Report null
      // here for PERSONAL accounts; the frontend should query per-
      // workspace project counts via GET /workspaces/:id/projects for
      // that case instead.
      projects: {
        used: projectCount,
        limit: limits.projects,
        scope: account.type === 'PERSONAL' ? 'PER_WORKSPACE' : 'ACCOUNT_TOTAL',
      },
      seats: {
        used: seatCount,
        limit: limits.includedSeats,
        overageCostPerSeatUsd: limits.overageCostPerSeatUsd,
      },
      storageBytes: {
        used: storageUsed._sum.sizeBytes ?? 0,
        limitBytes: limits.storageGB * 1024 * 1024 * 1024,
      },
    };
  }

  async getInvoices(accountId: string, pagination: QueryInvoicesDto) {
    await this.getAccountOrThrow(accountId);
    const where = { accountId };
    const [data, total] = await Promise.all([
      this.prisma.invoice.findMany({
        where,
        take: pagination.take,
        skip: pagination.skip,
        orderBy: { createdAt: 'desc' } as any,
      }),
      this.prisma.invoice.count({ where }),
    ]);
    return { data, total, take: pagination.take, skip: pagination.skip };
  }

  /**
   * OWNER-tier only per BILLING__ENDPOINTS — enforced via @RequireAccess
   * (manageBilling) at the controller, not here; this assumes that guard
   * already ran.
   */
  async createCheckoutSession(accountId: string, dto: CreateCheckoutDto) {
    const account = await this.getAccountOrThrow(accountId);

    const provider =
      account.paymentProvider ??
      this.providerRouter.determineProviderForNewCheckout(
        account.billingCountry,
      );
    const gatewayProvider = this.providerRouter.getProvider(provider);

    const result = await gatewayProvider.createCheckoutSession(
      accountId,
      dto.planKey,
      dto.successUrl,
      dto.cancelUrl,
    );
    return { url: result.url };
  }

  async cancelSubscription(accountId: string): Promise<void> {
    const account = await this.getAccountOrThrow(accountId);
    if (!account.paymentProvider)
      throw new BadRequestException(
        'This account has no active subscription to cancel',
      );

    const gatewayProvider = this.providerRouter.getProvider(
      account.paymentProvider,
    );
    await gatewayProvider.cancelSubscription(accountId);
  }

  async resumeSubscription(accountId: string): Promise<void> {
    const account = await this.getAccountOrThrow(accountId);
    if (!account.paymentProvider)
      throw new BadRequestException(
        'This account has no subscription to resume',
      );

    const gatewayProvider = this.providerRouter.getProvider(
      account.paymentProvider,
    );
    await gatewayProvider.resumeSubscription(accountId);
  }

  async getBillingPortalUrl(accountId: string, returnUrl: string) {
    const account = await this.getAccountOrThrow(accountId);
    if (!account.paymentProvider)
      throw new BadRequestException(
        'This account has no billing provider on file',
      );

    const gatewayProvider = this.providerRouter.getProvider(
      account.paymentProvider,
    );
    return gatewayProvider.generateBillingPortalUrl(accountId, returnUrl);
  }

  /**
   * The ONE entry point all 3 webhook routes call into (each route just
   * verifies the request looks like it's from that provider's format and
   * hands off here) — per CONSOLIDATE__CANCHECKS, idempotency keyed on
   * (provider, externalEventId), reusing the SAME WebhookIdempotencyService
   * every future webhook-driven module should use, not a bespoke one.
   */
  async handleWebhook(
    provider: PaymentProvider,
    rawPayload: Buffer,
    signature: string,
  ): Promise<void> {
    const gatewayProvider = this.providerRouter.getProvider(provider);
    const event = await gatewayProvider.handleWebhookEvent(
      rawPayload,
      signature,
    );

    const { alreadyProcessed } = await this.webhookIdempotency.runIdempotent(
      provider,
      event.externalEventId,
      (tx) => this.applyEvent(tx, provider, event),
    );

    if (alreadyProcessed) {
      this.logger.log(
        `Skipped already-processed ${provider} webhook event ${event.externalEventId}`,
      );
    }
  }

  /**
   * BILLING__TIERS__OVERAGE — "either Stripe usage records or a scheduled
   * monthly reconciliation job is fine." This is the reconciliation-job
   * path: computes overcount × overageCostPerSeatUsd from a LIVE
   * AccountMember count (never a stored/cached seat count) and RECORDS it
   * as an Invoice line item. It does not attempt to actually collect
   * payment for the overage itself (that would need extending
   * PaymentGatewayProvider with a one-off-charge method, or relying on
   * the provider's own dashboard-configured usage billing) — recording
   * the charge is the part this codebase owns; collection is a follow-up
   * once a provider-side mechanism is chosen. Not wired to an actual
   * scheduler — same "no job scheduler exists" constraint as every other
   * cleanup job in this codebase.
   */
  async reconcileSeatOverages(): Promise<{ accountsInvoiced: number }> {
    const accounts = await this.prisma.account.findMany({
      where: { type: 'ORGANIZATION', deletedAt: null, planType: { not: null } },
      select: { id: true, planType: true, paymentProvider: true },
    });

    let accountsInvoiced = 0;

    for (const account of accounts) {
      const limits = getPlanLimits(account.planType);
      if (
        limits.overageCostPerSeatUsd === null ||
        limits.includedSeats === null
      )
        continue; // no overage support on this tier

      const seatCount = await this.prisma.accountMember.count({
        where: { accountId: account.id },
      });
      const overcount = seatCount - limits.includedSeats;
      if (overcount <= 0) continue;

      const overageAmount = overcount * limits.overageCostPerSeatUsd;

      await this.prisma.invoice.create({
        data: {
          accountId: account.id,
          provider: account.paymentProvider ?? PaymentProvider.MOR,
          invoiceNumber: this.generateInvoiceNumber(),
          externalInvoiceId: `overage-${account.id}-${Date.now()}`, // no provider-side transaction exists yet for this — collection is a follow-up step, see class doc
          amount: overageAmount,
          currency: 'usd',
          status: 'pending',
          dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          lineItems: [
            {
              description: `Seat overage: ${overcount} seat(s) beyond the ${limits.includedSeats} included`,
              amount: overageAmount,
            },
          ] as unknown as Prisma.InputJsonValue,
        },
      });

      accountsInvoiced += 1;
    }

    this.logger.log(
      `Seat overage reconciliation: ${accountsInvoiced} account(s) invoiced`,
    );
    return { accountsInvoiced };
  }

  // ---- internals ----

  private async getAccountOrThrow(accountId: string) {
    const account = await this.prisma.account.findUnique({
      where: { id: accountId },
    });
    if (!account || account.deletedAt)
      throw new NotFoundException('Account not found');
    return account;
  }

  private async applyEvent(
    tx: Prisma.TransactionClient,
    provider: PaymentProvider,
    event: NormalizedBillingEvent,
  ): Promise<void> {
    switch (event.type) {
      case 'SUBSCRIPTION_ACTIVATED': {
        await tx.account.update({
          where: { id: event.accountId },
          data: {
            planType: event.planKey as any,
            paymentProvider: provider,
            externalSubscriptionId: event.externalSubscriptionId,
            ...(event.externalCustomerId && {
              externalCustomerId: event.externalCustomerId,
            }),
            subscriptionStatus: 'active',
            currentPeriodStart: new Date(),
            currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30-day approximation — the provider's own period boundaries are the real source of truth, refined by subsequent invoice events
            canceledAt: null,
          },
        });
        break;
      }

      case 'SUBSCRIPTION_CANCELED': {
        await tx.account.update({
          where: { id: event.accountId },
          data: { subscriptionStatus: 'canceled', canceledAt: new Date() },
        });
        break;
      }

      case 'PAYMENT_SUCCEEDED': {
        await tx.payment.create({
          data: {
            accountId: event.accountId,
            provider,
            externalTransactionId: event.externalTransactionId,
            amount: event.amount,
            currency: event.currency,
            status: 'succeeded',
            receiptUrl: event.receiptUrl,
          },
        });
        await tx.invoice.create({
          data: {
            accountId: event.accountId,
            provider,
            invoiceNumber: this.generateInvoiceNumber(),
            externalInvoiceId: event.externalTransactionId,
            amount: event.amount,
            currency: event.currency,
            status: 'paid',
            dueDate: new Date(),
            paidAt: new Date(),
            lineItems: [
              { description: 'Subscription charge', amount: event.amount },
            ] as unknown as Prisma.InputJsonValue,
            pdfUrl: event.receiptUrl,
          },
        });
        await tx.account.update({
          where: { id: event.accountId },
          data: { subscriptionStatus: 'active' },
        });
        break;
      }

      case 'PAYMENT_FAILED': {
        await tx.payment.create({
          data: {
            accountId: event.accountId,
            provider,
            externalTransactionId: event.externalTransactionId,
            amount: event.amount,
            currency: event.currency,
            status: 'failed',
            failureReason: event.failureReason,
          },
        });
        await tx.invoice.create({
          data: {
            accountId: event.accountId,
            provider,
            invoiceNumber: this.generateInvoiceNumber(),
            externalInvoiceId: event.externalTransactionId,
            amount: event.amount,
            currency: event.currency,
            status: 'failed',
            dueDate: new Date(),
            lineItems: [
              {
                description: 'Subscription charge (failed)',
                amount: event.amount,
              },
            ] as unknown as Prisma.InputJsonValue,
          },
        });
        await tx.account.update({
          where: { id: event.accountId },
          data: { subscriptionStatus: 'past_due' },
        });
        break;
      }
    }
  }

  /**
   * Human-readable, not truly sequential — a real accounting/tax
   * jurisdiction might require strict sequential invoice numbers; this
   * is a reasonable simplification, flagged as such rather than silently
   * assumed sufficient for every jurisdiction this app might operate in.
   */
  private generateInvoiceNumber(): string {
    const now = new Date();
    const yearMonth = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
    return `INV-${yearMonth}-${randomBytes(4).toString('hex').toUpperCase()}`;
  }
}
