import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  NotImplementedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CheckoutSessionResult,
  NormalizedBillingEvent,
  PaymentGatewayProvider,
  PortalUrlResult,
} from './payment-gateway-provider.interface';

const PAYMEE_API_BASE = 'https://app.paymee.tn/api/v2';

/**
 * TunisiaGatewayProvider — Paymee chosen as the example implementation.
 * The graph itself marks this "TBD... signature scheme unknown until
 * then" — this is a genuinely LOWER-CONFIDENCE implementation than
 * MorProvider, not something to treat as production-verified. Two real
 * architectural differences from Stripe/MOR, not oversights:
 *
 * 1. VERIFICATION SCHEME: Paymee's IPN callback isn't a signed payload
 *    the way Stripe/Lemon Squeezy webhooks are — verification is a
 *    server-to-server confirmation call back to Paymee using the
 *    payment token, not a signature comparison. handleWebhookEvent's
 *    `signature` parameter is unused here for that reason (the token
 *    IS the payload; there's nothing else to check it against locally).
 *
 * 2. NO NATIVE SUBSCRIPTIONS: Paymee is a one-off payment gateway, not a
 *    subscription-billing platform — there's no recurring-charge object
 *    to create/cancel/resume the way Stripe/Lemon Squeezy have. True
 *    recurring billing on this path needs its OWN scheduled job that
 *    generates a new payment request each billing cycle (not built —
 *    same "no job scheduler exists" constraint as every other cleanup
 *    job in this codebase). cancelSubscription/resumeSubscription here
 *    only flip a local flag; they do not talk to Paymee at all.
 */
@Injectable()
export class TunisiaGatewayProvider implements PaymentGatewayProvider {
  private readonly logger = new Logger(TunisiaGatewayProvider.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async createCheckoutSession(
    accountId: string,
    planKey: string,
    successUrl: string,
    cancelUrl: string,
  ): Promise<CheckoutSessionResult> {
    const apiKey = this.configService.get<string>('PAYMEE_API_KEY');
    const amount = this.configService.get<string>(
      `PAYMEE_AMOUNT_TND_${planKey}`,
    );
    if (!amount)
      throw new BadRequestException(
        `No Paymee TND amount configured for plan ${planKey}`,
      );

    const response = await fetch(`${PAYMEE_API_BASE}/payments/create`, {
      method: 'POST',
      headers: {
        Authorization: `Token ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: Number(amount),
        note: `Subscription: ${planKey}`,
        return_url: successUrl,
        cancel_url: cancelUrl,
        webhook_url:
          this.configService.get<string>('APP_URL') +
          '/billing/webhook/tunisia-gateway',
        order_id: `${accountId}:${planKey}:${Date.now()}`,
      }),
    });

    if (!response.ok) {
      this.logger.error(
        `Paymee create-payment failed: ${response.status} ${await response.text()}`,
      );
      throw new BadRequestException('Failed to create Paymee payment');
    }

    const body = await response.json();
    return { url: body.data.payment_url, externalSessionId: body.data.token };
  }

  async handleWebhookEvent(
    rawPayload: Buffer,
  ): Promise<NormalizedBillingEvent> {
    const body = JSON.parse(rawPayload.toString('utf-8'));
    const token: string = body.token;
    if (!token)
      throw new BadRequestException('Missing payment token in Paymee callback');

    // Server-to-server confirmation — the actual trust mechanism here,
    // not a signature. Re-fetches the payment status directly from
    // Paymee rather than trusting the callback body's own claims.
    const apiKey = this.configService.get<string>('PAYMEE_API_KEY');
    const checkResponse = await fetch(
      `${PAYMEE_API_BASE}/payments/${token}/check`,
      {
        headers: { Authorization: `Token ${apiKey}` },
      },
    );
    if (!checkResponse.ok)
      throw new BadRequestException('Unable to confirm Paymee payment status');
    const check = await checkResponse.json();

    const [accountId] = (check.data.order_id as string).split(':');
    if (!accountId)
      throw new BadRequestException('Malformed order_id in Paymee payment');

    if (check.data.payment_status === true) {
      return {
        type: 'PAYMENT_SUCCEEDED',
        externalEventId: token,
        accountId,
        externalTransactionId: token,
        amount: check.data.amount,
        currency: 'tnd',
      };
    }

    return {
      type: 'PAYMENT_FAILED',
      externalEventId: token,
      accountId,
      externalTransactionId: token,
      amount: check.data.amount,
      currency: 'tnd',
      failureReason: 'Paymee payment not confirmed',
    };
  }

  /** See class doc — no native subscription object exists on this provider; this only flips a local record. */
  async cancelSubscription(accountId: string): Promise<void> {
    const account = await this.prisma.account.findUnique({
      where: { id: accountId },
    });
    if (!account) throw new NotFoundException('Account not found');
    await this.prisma.account.update({
      where: { id: accountId },
      data: { canceledAt: new Date() },
    });
  }

  async resumeSubscription(accountId: string): Promise<void> {
    const account = await this.prisma.account.findUnique({
      where: { id: accountId },
    });
    if (!account) throw new NotFoundException('Account not found');
    await this.prisma.account.update({
      where: { id: accountId },
      data: { canceledAt: null },
    });
  }

  async generateBillingPortalUrl(
    _accountId: string,
    _returnUrl: string,
  ): Promise<PortalUrlResult> {
    // Honest gap, not a bug: Paymee has no customer self-service portal
    // concept at all. Surfacing this clearly rather than fabricating a
    // fake URL that would 404 for the user.
    throw new NotImplementedException(
      'This payment provider does not support a self-service billing portal',
    );
  }
}
