import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { BillingService } from './billing.service';
import { CreateCheckoutDto } from './dto/create-checkout.dto';
import { PortalUrlDto } from './dto/portal-url.dto';
import { QueryInvoicesDto } from './dto/query-invoices.dto';
import { RequireAccess } from '../access-control/decorators/require-access.decorator';
import { Public } from '../auth/decorators/public.decorator';

@Controller()
export class BillingController {
  constructor(private readonly billingService: BillingService) {}

  // Public — no auth, needed for a pricing page before signup.
  @Public()
  @Get('billing/tiers')
  getTiers() {
    return this.billingService.getTiers();
  }

  @RequireAccess('viewBilling')
  @Get('accounts/:id/billing')
  async getSubscription(@Param('id') id: string) {
    return this.billingService.getSubscriptionDetails(id);
  }

  @RequireAccess('viewBilling')
  @Get('accounts/:id/billing/usage')
  async getUsage(@Param('id') id: string) {
    return this.billingService.getUsage(id);
  }

  @RequireAccess('viewBilling')
  @Get('accounts/:id/billing/invoices')
  async getInvoices(@Param('id') id: string, @Query() query: QueryInvoicesDto) {
    return this.billingService.getInvoices(id, query);
  }

  // manageBilling is OWNER-tier only per ROLE_PERMISSIONS (ADMIN gets
  // viewBilling but not manageBilling) — already enforced by the
  // existing matrix, nothing new needed here.
  @RequireAccess('manageBilling')
  @Post('accounts/:id/billing/checkout')
  async createCheckout(
    @Param('id') id: string,
    @Body() dto: CreateCheckoutDto,
  ) {
    return this.billingService.createCheckoutSession(id, dto);
  }

  @RequireAccess('manageBilling')
  @Post('accounts/:id/billing/subscription/cancel')
  async cancelSubscription(@Param('id') id: string) {
    await this.billingService.cancelSubscription(id);
    return { canceled: true };
  }

  @RequireAccess('manageBilling')
  @Post('accounts/:id/billing/subscription/resume')
  async resumeSubscription(@Param('id') id: string) {
    await this.billingService.resumeSubscription(id);
    return { resumed: true };
  }

  @RequireAccess('manageBilling')
  @Post('accounts/:id/billing/portal-url')
  async getPortalUrl(@Param('id') id: string, @Body() dto: PortalUrlDto) {
    return this.billingService.getBillingPortalUrl(id, dto.returnUrl);
  }
}
