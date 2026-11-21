import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  RawBodyRequest,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { PaymentProvider } from '@prisma/client';
import { BillingService } from './billing.service';
import { Public } from '../auth/decorators/public.decorator';

/**
 * 3 SEPARATE routes per BILLING__WEBHOOKS__ROUTES — one per provider,
 * not a single dispatcher route, since each provider's payload shape and
 * verification scheme differ enough that a shared route would just
 * re-implement the branching this already does via 3 controller methods.
 * All @Public() — called by external services with no user JWT.
 */
@Controller('billing/webhook')
export class BillingWebhooksController {
  constructor(private readonly billingService: BillingService) {}

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('stripe')
  async stripeWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string,
  ) {
    if (!req.rawBody) throw new BadRequestException('Missing raw request body');
    await this.billingService.handleWebhook(
      PaymentProvider.STRIPE,
      req.rawBody,
      signature,
    );
    return { received: true };
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('mor')
  async morWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-signature') signature: string,
  ) {
    if (!req.rawBody) throw new BadRequestException('Missing raw request body');
    await this.billingService.handleWebhook(
      PaymentProvider.MOR,
      req.rawBody,
      signature,
    );
    return { received: true };
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('tunisia-gateway')
  async tunisiaGatewayWebhook(@Req() req: RawBodyRequest<Request>) {
    if (!req.rawBody) throw new BadRequestException('Missing raw request body');
    // No signature header — Paymee's verification is a server-to-server
    // confirmation call inside TunisiaGatewayProvider itself, not a
    // header comparison. Passing an empty string keeps the shared
    // handleWebhook/PaymentGatewayProvider signature uniform across all
    // 3 providers rather than special-casing this one's method arity.
    await this.billingService.handleWebhook(
      PaymentProvider.TUNISIA_GATEWAY,
      req.rawBody,
      '',
    );
    return { received: true };
  }
}
