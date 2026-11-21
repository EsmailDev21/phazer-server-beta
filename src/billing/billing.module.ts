import { Module } from '@nestjs/common';
import { BillingController } from './billing.controller';
import { BillingWebhooksController } from './billing-webhooks.controller';
import { BillingService } from './billing.service';
import { ProviderRouterService } from './providers/provider-router.service';
import { StripeProvider } from './providers/stripe.provider';
import { MorProvider } from './providers/mor.provider';
import { TunisiaGatewayProvider } from './providers/tunisia-gateway.provider';
import { BillingReconcileJob } from './billing-reconcile.job';

@Module({
  controllers: [BillingController, BillingWebhooksController],
  providers: [
    BillingService,
    ProviderRouterService,
    StripeProvider,
    MorProvider,
    TunisiaGatewayProvider,
    BillingReconcileJob,
  ],
  exports: [BillingService],
})
export class BillingModule {}
