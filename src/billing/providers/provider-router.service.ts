import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentProvider } from '@prisma/client';
import { PaymentGatewayProvider } from './payment-gateway-provider.interface';
import { StripeProvider } from './stripe.provider';
import { MorProvider } from './mor.provider';
import { TunisiaGatewayProvider } from './tunisia-gateway.provider';

/**
 * Routing rule, per BILLING__PROVIDER__ROUTING:
 *   billingCountry === 'TN' -> TUNISIA_GATEWAY
 *   otherwise                -> MOR
 * Stripe is NEVER auto-selected for a new checkout — only reachable via
 * ENABLE_STRIPE_AUTO_SELECT (a manual killswitch an operator flips once
 * the actual blocking condition, e.g. a Foreign Exchange Code reform or
 * a foreign entity incorporation, is genuinely resolved — this codebase
 * has no way to detect either of those itself). Existing accounts
 * already on Stripe (paymentProvider === STRIPE from a prior migration)
 * keep using Stripe for every existing-subscription action — never
 * silently migrated to a different provider.
 */
@Injectable()
export class ProviderRouterService {
  constructor(
    private readonly configService: ConfigService,
    @Inject(StripeProvider) private readonly stripeProvider: StripeProvider,
    @Inject(MorProvider) private readonly morProvider: MorProvider,
    @Inject(TunisiaGatewayProvider)
    private readonly tunisiaGatewayProvider: TunisiaGatewayProvider,
  ) {}

  determineProviderForNewCheckout(
    billingCountry: string | null,
  ): PaymentProvider {
    if (
      this.configService.get<string>('ENABLE_STRIPE_AUTO_SELECT') === 'true'
    ) {
      return PaymentProvider.STRIPE;
    }
    return billingCountry === 'TN'
      ? PaymentProvider.TUNISIA_GATEWAY
      : PaymentProvider.MOR;
  }

  getProvider(provider: PaymentProvider): PaymentGatewayProvider {
    switch (provider) {
      case PaymentProvider.STRIPE:
        return this.stripeProvider;
      case PaymentProvider.MOR:
        return this.morProvider;
      case PaymentProvider.TUNISIA_GATEWAY:
        return this.tunisiaGatewayProvider;
    }
  }
}
