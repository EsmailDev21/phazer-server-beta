import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { JobEnvelope } from '../queue/job-envelope';
import { JobHandler, JobHandlerRegistry } from '../queue/job-handler.registry';
import { QUEUES } from '../queue/queue.definitions';
import { BillingService } from './billing.service';

declare module '../queue/queue.definitions' {
  interface JobPayloads {
    'system.billing-reconcile-overages': Record<string, never>;
  }
}

/**
 * Step 0.3: wires `BillingService.reconcileSeatOverages`
 * (BILLING__TIERS__OVERAGE, previously a complete but uncallable
 * implementation) onto the `system` queue. Its own class doc says
 * "either Stripe usage records or a scheduled monthly reconciliation job
 * is fine" and explicitly names monthly reconciliation as an acceptable
 * design, so this runs on the 1st of each month rather than daily —
 * overage is billed per period, not per day, and re-running it more often
 * would only recompute the same live seat count against the same
 * still-open period. Idempotent by construction: `Invoice.externalInvoiceId`
 * is `overage-${accountId}-${Date.now()}`, so a retried run can create a
 * second line item for the same month if it lands on a later millisecond
 * — this pre-existing gap (no `(accountId, period)` uniqueness) is
 * unchanged by this step; flagging it here rather than silently
 * inheriting it.
 */
@Injectable()
export class BillingReconcileJob
  implements JobHandler<'system.billing-reconcile-overages'>, OnModuleInit
{
  private readonly logger = new Logger(BillingReconcileJob.name);
  readonly queue = QUEUES.SYSTEM.name;
  readonly jobName = 'system.billing-reconcile-overages' as const;

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly billingService: BillingService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
    this.registry.registerSchedule({
      queue: this.queue,
      schedulerId: 'billing-reconcile-overages-monthly',
      jobName: this.jobName,
      payload: {},
      cron: '0 4 1 * *', // 04:00 on the 1st of each month, server time
    });
  }

  async handle(envelope: JobEnvelope) {
    const result = await this.billingService.reconcileSeatOverages();
    this.logger.log(
      `Billing reconcile job ${envelope.traceId}: ${result.accountsInvoiced} account(s) invoiced`,
    );
    return result;
  }
}
