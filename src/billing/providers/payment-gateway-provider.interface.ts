export interface CheckoutSessionResult {
  url: string;
  externalSessionId: string;
}

export interface PortalUrlResult {
  url: string;
}

/**
 * Common internal events every provider's webhook normalizes into,
 * BEFORE touching Account/Payment/Invoice — the rest of the billing
 * module never needs to know which provider triggered an update.
 */
export type NormalizedBillingEvent =
  | {
      type: 'SUBSCRIPTION_ACTIVATED';
      externalEventId: string;
      accountId: string;
      planKey: string;
      externalSubscriptionId: string;
      externalCustomerId?: string;
    }
  | {
      type: 'SUBSCRIPTION_CANCELED';
      externalEventId: string;
      accountId: string;
      externalSubscriptionId: string;
    }
  | {
      type: 'PAYMENT_SUCCEEDED';
      externalEventId: string;
      accountId: string;
      externalTransactionId: string;
      amount: number;
      currency: string;
      receiptUrl?: string;
    }
  | {
      type: 'PAYMENT_FAILED';
      externalEventId: string;
      accountId: string;
      externalTransactionId: string;
      amount: number;
      currency: string;
      failureReason?: string;
    };

/**
 * PaymentGatewayProvider — all 3 providers (Stripe, MOR, TunisiaGateway)
 * implement this. The rest of the billing module (BillingService,
 * webhook controller) is provider-agnostic and only ever talks to this
 * interface, never a specific provider's SDK/API shape directly.
 */
export interface PaymentGatewayProvider {
  createCheckoutSession(
    accountId: string,
    planKey: string,
    successUrl: string,
    cancelUrl: string,
  ): Promise<CheckoutSessionResult>;

  /**
   * Verifies the signature per THIS provider's own method (different
   * scheme per provider), then normalizes the payload into one of the
   * common internal event types above. Throws on invalid signature —
   * never silently returns null for a bad signature.
   */
  handleWebhookEvent(
    rawPayload: Buffer,
    signature: string,
  ): Promise<NormalizedBillingEvent>;

  cancelSubscription(accountId: string): Promise<void>;
  resumeSubscription(accountId: string): Promise<void>;

  /**
   * FOUND missing while designing the Billing UI: card/payment-method
   * management needs a provider-hosted portal link, not an in-app form,
   * for PCI-compliance reasons that apply regardless of provider.
   */
  generateBillingPortalUrl(
    accountId: string,
    returnUrl: string,
  ): Promise<PortalUrlResult>;
}

export const PAYMENT_GATEWAY_PROVIDER = Symbol('PAYMENT_GATEWAY_PROVIDER');
