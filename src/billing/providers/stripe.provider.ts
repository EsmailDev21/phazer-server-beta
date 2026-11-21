import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CheckoutSessionResult,
  NormalizedBillingEvent,
  PaymentGatewayProvider,
  PortalUrlResult,
} from './payment-gateway-provider.interface';

/**
 * StripeProvider — KEPT, real signature verification and webhook
 * handling preserved. EXCLUDED from auto-selection (see
 * ProviderRouterService) until a feature flag flips — either the Tunisia
 * Foreign Exchange Code reform lands in practice, or a foreign entity is
 * incorporated. Existing active subscriptions never silently migrate
 * providers — this stays fully functional regardless of routing status.
 *
 * Price IDs are per-environment Stripe Dashboard config, not something
 * this codebase can know in advance — STRIPE_PRICE_ID_<PLAN_KEY> env vars
 * map each PlanKey to its real Stripe Price id.
 */
@Injectable()
export class StripeProvider implements PaymentGatewayProvider {
  private readonly logger = new Logger(StripeProvider.name);
  private stripeClient?: Stripe;
  private readonly webhookSecret: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.webhookSecret =
      this.configService.get<string>('STRIPE_WEBHOOK_SECRET') ?? '';
  }

  /**
   * Lazy on purpose. Stripe is optional (see the class comment and
   * .env.example: STRIPE_SECRET_KEY is blank by default), but the Stripe SDK
   * throws from its constructor when given no key. Constructing eagerly here
   * therefore crashed application boot in every environment without Stripe
   * credentials. Now the client is created on first use, and a missing key is
   * a clear 503 for the Stripe code path only.
   */
  private get stripe(): Stripe {
    if (!this.stripeClient) {
      const key = this.configService.get<string>('STRIPE_SECRET_KEY');
      if (!key) {
        throw new ServiceUnavailableException(
          'Stripe is not configured (STRIPE_SECRET_KEY is unset)',
        );
      }
      this.stripeClient = new Stripe(key);
    }
    return this.stripeClient;
  }

  async createCheckoutSession(
    accountId: string,
    planKey: string,
    successUrl: string,
    cancelUrl: string,
  ): Promise<CheckoutSessionResult> {
    const account = await this.prisma.account.findUnique({
      where: { id: accountId },
    });
    if (!account) throw new NotFoundException('Account not found');

    const priceId = this.configService.get<string>(
      `STRIPE_PRICE_ID_${planKey}`,
    );
    if (!priceId)
      throw new BadRequestException(
        `No Stripe price configured for plan ${planKey}`,
      );

    let customerId = account.externalCustomerId;
    if (!customerId || account.paymentProvider !== 'STRIPE') {
      const customer = await this.stripe.customers.create({
        metadata: { accountId },
      });
      customerId = customer.id;
      // FIX caught while wiring BillingService: the customer was being
      // created here but never persisted back to Account — every
      // subsequent checkout/portal call would have created a NEW Stripe
      // customer instead of reusing this one.
      await this.prisma.account.update({
        where: { id: accountId },
        data: { externalCustomerId: customerId, paymentProvider: 'STRIPE' },
      });
    }

    const session = await this.stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: { accountId, planKey },
      subscription_data: { metadata: { accountId, planKey } },
    });

    if (!session.url) throw new Error('Stripe did not return a checkout URL');
    return { url: session.url, externalSessionId: session.id };
  }

  async handleWebhookEvent(
    rawPayload: Buffer,
    signature: string,
  ): Promise<NormalizedBillingEvent> {
    // Real, working signature verification — throws on any tampering or
    // wrong secret, exactly as it did in the original audited code.
    const event = this.stripe.webhooks.constructEvent(
      rawPayload,
      signature,
      this.webhookSecret,
    );

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        const accountId = session.metadata?.accountId;
        const planKey = session.metadata?.planKey;
        if (!accountId || !planKey)
          throw new BadRequestException(
            'Missing accountId/planKey in checkout session metadata',
          );
        return {
          type: 'SUBSCRIPTION_ACTIVATED',
          externalEventId: event.id,
          accountId,
          planKey,
          externalSubscriptionId: (session.subscription as string) ?? '',
          externalCustomerId: (session.customer as string) ?? undefined,
        };
      }
      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription;
        const accountId =
          subscription.metadata?.accountId ??
          (await this.findAccountIdByCustomerId(
            subscription.customer as string,
          ));
        return {
          type: 'SUBSCRIPTION_CANCELED',
          externalEventId: event.id,
          accountId,
          externalSubscriptionId: subscription.id,
        };
      }
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object as Stripe.Invoice;
        const accountId = await this.findAccountIdByCustomerId(
          invoice.customer as string,
        );
        return {
          type: 'PAYMENT_SUCCEEDED',
          externalEventId: event.id,
          accountId,
          externalTransactionId: invoice.id, // simpler and unambiguous — invoice.payment_intent was removed from the top-level Invoice type in the installed Stripe SDK's API version (moved under a nested confirmation_secret/parent structure); invoice.id is always present and sufficient as the transaction reference
          amount: invoice.amount_paid / 100,
          currency: invoice.currency,
          receiptUrl: invoice.hosted_invoice_url ?? undefined,
        };
      }
      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        const accountId = await this.findAccountIdByCustomerId(
          invoice.customer as string,
        );
        return {
          type: 'PAYMENT_FAILED',
          externalEventId: event.id,
          accountId,
          externalTransactionId: invoice.id, // simpler and unambiguous — invoice.payment_intent was removed from the top-level Invoice type in the installed Stripe SDK's API version (moved under a nested confirmation_secret/parent structure); invoice.id is always present and sufficient as the transaction reference
          amount: invoice.amount_due / 100,
          currency: invoice.currency,
          failureReason: 'Stripe invoice payment failed',
        };
      }
      default:
        throw new BadRequestException(
          `Unhandled Stripe event type: ${event.type}`,
        );
    }
  }

  async cancelSubscription(accountId: string): Promise<void> {
    const account = await this.getAccountWithSubscription(accountId);
    // Graceful cancel (end of current period), not immediate — matches
    // typical SaaS expectation of "keep access until what was paid for runs out."
    await this.stripe.subscriptions.update(account.externalSubscriptionId!, {
      cancel_at_period_end: true,
    });
  }

  async resumeSubscription(accountId: string): Promise<void> {
    const account = await this.getAccountWithSubscription(accountId);
    await this.stripe.subscriptions.update(account.externalSubscriptionId!, {
      cancel_at_period_end: false,
    });
  }

  async generateBillingPortalUrl(
    accountId: string,
    returnUrl: string,
  ): Promise<PortalUrlResult> {
    const account = await this.prisma.account.findUnique({
      where: { id: accountId },
    });
    if (!account?.externalCustomerId)
      throw new NotFoundException(
        'No Stripe customer on file for this account',
      );

    const session = await this.stripe.billingPortal.sessions.create({
      customer: account.externalCustomerId,
      return_url: returnUrl,
    });
    return { url: session.url };
  }

  private async getAccountWithSubscription(accountId: string) {
    const account = await this.prisma.account.findUnique({
      where: { id: accountId },
    });
    if (!account?.externalSubscriptionId)
      throw new NotFoundException(
        'No active Stripe subscription for this account',
      );
    return account;
  }

  private async findAccountIdByCustomerId(customerId: string): Promise<string> {
    const account = await this.prisma.account.findFirst({
      where: { externalCustomerId: customerId },
    });
    if (!account)
      throw new NotFoundException(
        `No account found for Stripe customer ${customerId}`,
      );
    return account.id;
  }
}
