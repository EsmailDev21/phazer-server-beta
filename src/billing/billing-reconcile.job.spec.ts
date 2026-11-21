import { JobHandlerRegistry } from '../queue/job-handler.registry';
import { buildEnvelope } from '../queue/job-envelope';
import { BillingReconcileJob } from './billing-reconcile.job';
import { BillingService } from './billing.service';

describe('BillingReconcileJob', () => {
  function build() {
    const registry = new JobHandlerRegistry();
    const billingService = {
      reconcileSeatOverages: jest
        .fn()
        .mockResolvedValue({ accountsInvoiced: 4 }),
    } as unknown as BillingService;
    const job = new BillingReconcileJob(registry, billingService);
    return { registry, billingService, job };
  }

  it('registers itself on the system queue and a monthly schedule', () => {
    const { registry, job } = build();
    job.onModuleInit();

    expect(registry.get('system', 'system.billing-reconcile-overages')).toBe(
      job,
    );
    const schedules = registry.schedulesFor('system');
    expect(schedules).toHaveLength(1);
    expect(schedules[0]).toMatchObject({
      schedulerId: 'billing-reconcile-overages-monthly',
      jobName: 'system.billing-reconcile-overages',
      cron: '0 4 1 * *',
    });
  });

  it('handle() delegates to reconcileSeatOverages and returns its result', async () => {
    const { billingService, job } = build();
    const result = await job.handle(buildEnvelope({}));

    expect(billingService.reconcileSeatOverages).toHaveBeenCalled();
    expect(result).toEqual({ accountsInvoiced: 4 });
  });
});
