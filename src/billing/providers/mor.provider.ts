import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CheckoutSessionResult,
  NormalizedBillingEvent,
  PaymentGatewayProvider,
  PortalUrlResult,
} from './payment-gateway-provider.interface';

const LEMONSQUEEZY_API_BASE = 'https://api.lemonsqueezy.com/v1';

/**
 * MorProvider — Lemon Squeezy chosen over Paddle: comparable
 * checkout+webhook shapes per the graph's own framing ("either is
 * fine... an implementation swap behind this same interface, not a
 * schema/architecture decision"), picked here for a simpler plain-HMAC
 * webhook scheme and a REST API usable via plain `fetch` without an SDK
 * dependency. Being merchant-of-record, Lemon Squeezy remits tax/VAT
 * itself — materially less tax logic needed in this codebase for this
 * path than for Stripe or the Tunisia gateway.
 *
 * CONFIDENCE NOTE, same honesty as the Stripe integration doesn't need
 * but this one does: built from documented API shape (JSON:API request/
 * response format, X-Signature HMAC-SHA256 webhook verification), not
 * verified against a live sandbox from within this environment (no
 * network access to lemonsqueezy.com here). Confirm exact field names
 * against Lemon Squeezy's current live docs before taking this to
 * production — the verification logic and overall flow are correct,
 * but a JSON:API attribute name could plausibly have shifted.
 */
@Injectable()
export class MorProvider implements PaymentGatewayProvider {
  private readonly logger = new Logger(MorProvider.name);

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
    const variantId = this.configService.get<string>(
      `LEMONSQUEEZY_VARIANT_ID_${planKey}`,
    );
    const storeId = this.configService.get<string>('LEMONSQUEEZY_STORE_ID');
    if (!variantId || !storeId)
      throw new BadRequestException(
        `No Lemon Squeezy variant configured for plan ${planKey}`,
      );

    const response = await this.apiRequest('POST', '/checkouts', {
      data: {
        type: 'checkouts',
        attributes: {
          checkout_data: { custom: { accountId, planKey } },
          product_options: {
            redirect_url: successUrl,
            receipt_link_url: cancelUrl,
          },
        },
        relationships: {
          store: { data: { type: 'stores', id: storeId } },
          variant: { data: { type: 'variants', id: variantId } },
        },
      },
    });

    return {
      url: response.data.attributes.url,
      externalSessionId: response.data.id,
    };
  }

  async handleWebhookEvent(
    rawPayload: Buffer,
    signature: string,
  ): Promise<NormalizedBillingEvent> {
    this.verifySignature(rawPayload, signature);

    const body = JSON.parse(rawPayload.toString('utf-8'));
    const eventName: string = body.meta?.event_name;
    const customData = body.meta?.custom_data ?? {};
    const accountId: string | undefined = customData.accountId;
    const eventId: string = body.data?.id ?? `${eventName}-${Date.now()}`; // Lemon Squeezy doesn't guarantee a top-level event id the way Stripe does — falls back to a composite if absent

    if (!accountId && eventName !== 'subscription_payment_failed') {
      throw new BadRequestException(
        'Missing accountId in Lemon Squeezy webhook custom_data',
      );
    }

    const attributes = body.data?.attributes ?? {};

    switch (eventName) {
      case 'subscription_created':
        return {
          type: 'SUBSCRIPTION_ACTIVATED',
          externalEventId: eventId,
          accountId: accountId!,
          planKey: customData.planKey,
          externalSubscriptionId: body.data.id,
          externalCustomerId: attributes.customer_id
            ? String(attributes.customer_id)
            : undefined,
        };
      case 'subscription_cancelled':
      case 'subscription_expired':
        return {
          type: 'SUBSCRIPTION_CANCELED',
          externalEventId: eventId,
          accountId:
            accountId ??
            (await this.findAccountIdBySubscriptionId(body.data.id)),
          externalSubscriptionId: body.data.id,
        };
      case 'subscription_payment_success':
        return {
          type: 'PAYMENT_SUCCEEDED',
          externalEventId: eventId,
          accountId:
            accountId ??
            (await this.findAccountIdBySubscriptionId(
              attributes.subscription_id,
            )),
          externalTransactionId: body.data.id,
          amount: (attributes.total ?? 0) / 100,
          currency: (attributes.currency ?? 'usd').toLowerCase(),
          receiptUrl: attributes.urls?.receipt,
        };
      case 'subscription_payment_failed':
        return {
          type: 'PAYMENT_FAILED',
          externalEventId: eventId,
          accountId:
            accountId ??
            (await this.findAccountIdBySubscriptionId(
              attributes.subscription_id,
            )),
          externalTransactionId: body.data.id,
          amount: (attributes.total ?? 0) / 100,
          currency: (attributes.currency ?? 'usd').toLowerCase(),
          failureReason: 'Lemon Squeezy payment failed',
        };
      default:
        throw new BadRequestException(
          `Unhandled Lemon Squeezy event: ${eventName}`,
        );
    }
  }

  async cancelSubscription(accountId: string): Promise<void> {
    const subscriptionId = await this.getExternalSubscriptionId(accountId);
    await this.apiRequest('PATCH', `/subscriptions/${subscriptionId}`, {
      data: {
        type: 'subscriptions',
        id: subscriptionId,
        attributes: { cancelled: true },
      },
    });
  }

  async resumeSubscription(accountId: string): Promise<void> {
    const subscriptionId = await this.getExternalSubscriptionId(accountId);
    await this.apiRequest('PATCH', `/subscriptions/${subscriptionId}`, {
      data: {
        type: 'subscriptions',
        id: subscriptionId,
        attributes: { cancelled: false },
      },
    });
  }

  async generateBillingPortalUrl(
    accountId: string,
    _returnUrl: string,
  ): Promise<PortalUrlResult> {
    // Lemon Squeezy exposes the customer portal URL directly on the
    // subscription resource rather than via a separate "create session"
    // call the way Stripe does — no returnUrl parameter to pass through.
    const subscriptionId = await this.getExternalSubscriptionId(accountId);
    const response = await this.apiRequest(
      'GET',
      `/subscriptions/${subscriptionId}`,
    );
    const portalUrl = response.data.attributes.urls?.customer_portal;
    if (!portalUrl)
      throw new NotFoundException(
        'No customer portal URL available for this subscription',
      );
    return { url: portalUrl };
  }

  // ---- internals ----

  private verifySignature(rawPayload: Buffer, signature: string): void {
    const secret =
      this.configService.get<string>('LEMONSQUEEZY_WEBHOOK_SECRET') ?? '';
    const expected = createHmac('sha256', secret)
      .update(rawPayload)
      .digest('hex');
    const expectedBuffer = Buffer.from(expected, 'hex');
    const providedBuffer = Buffer.from(signature, 'hex');

    if (
      expectedBuffer.length !== providedBuffer.length ||
      !timingSafeEqual(expectedBuffer, providedBuffer)
    ) {
      throw new BadRequestException('Invalid Lemon Squeezy webhook signature');
    }
  }

  private async getExternalSubscriptionId(accountId: string): Promise<string> {
    const account = await this.prisma.account.findUnique({
      where: { id: accountId },
    });
    if (!account?.externalSubscriptionId)
      throw new NotFoundException('No active subscription for this account');
    return account.externalSubscriptionId;
  }

  private async findAccountIdBySubscriptionId(
    subscriptionId: string,
  ): Promise<string> {
    const account = await this.prisma.account.findFirst({
      where: { externalSubscriptionId: subscriptionId },
    });
    if (!account)
      throw new NotFoundException(
        `No account found for subscription ${subscriptionId}`,
      );
    return account.id;
  }

  private async apiRequest(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<any> {
    const apiKey = this.configService.get<string>('LEMONSQUEEZY_API_KEY');
    const response = await fetch(`${LEMONSQUEEZY_API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/vnd.api+json',
        Accept: 'application/vnd.api+json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      this.logger.error(
        `Lemon Squeezy API error (${response.status}): ${errorBody}`,
      );
      throw new BadRequestException(
        `Lemon Squeezy API request failed: ${response.status}`,
      );
    }

    return response.json();
  }
}
