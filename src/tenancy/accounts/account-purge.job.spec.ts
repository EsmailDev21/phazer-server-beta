import { JobHandlerRegistry } from '../../queue/job-handler.registry';
import { buildEnvelope } from '../../queue/job-envelope';
import { AccountPurgeJob } from './account-purge.job';
import { AccountsService } from './accounts.service';
import { BillingService } from '../../billing/billing.service';
import { AttachmentsService } from '../../attachments/attachments.service';

describe('AccountPurgeJob', () => {
  function build(
    expired: { id: string }[] = [{ id: 'acc_1' }, { id: 'acc_2' }],
  ) {
    const registry = new JobHandlerRegistry();
    const accountsService = {
      listExpiredSoftDeletes: jest.fn().mockResolvedValue(expired),
      hardDelete: jest.fn().mockResolvedValue(undefined),
    } as unknown as AccountsService;
    const billingService = {
      cancelSubscription: jest.fn().mockResolvedValue(undefined),
    } as unknown as BillingService;
    const attachmentsService = {
      purgeAllForAccount: jest.fn().mockResolvedValue({ deletedCount: 0 }),
    } as unknown as AttachmentsService;
    const job = new AccountPurgeJob(
      registry,
      accountsService,
      billingService,
      attachmentsService,
    );
    return {
      registry,
      accountsService,
      billingService,
      attachmentsService,
      job,
    };
  }

  it('registers itself on the system queue and a daily schedule', () => {
    const { registry, job } = build();
    job.onModuleInit();

    expect(registry.get('system', 'system.account-purge')).toBe(job);
    const schedules = registry.schedulesFor('system');
    expect(schedules).toHaveLength(1);
    expect(schedules[0]).toMatchObject({
      schedulerId: 'account-purge-daily',
      jobName: 'system.account-purge',
      cron: '0 3 * * *',
    });
  });

  it('purges every expired account: cancel subscription, purge attachments, then hard-delete, in order', async () => {
    const { accountsService, billingService, attachmentsService, job } = build([
      { id: 'acc_1' },
    ]);
    const order: string[] = [];
    (billingService.cancelSubscription as jest.Mock).mockImplementation(
      async () => order.push('cancel'),
    );
    (attachmentsService.purgeAllForAccount as jest.Mock).mockImplementation(
      async () => order.push('attachments'),
    );
    (accountsService.hardDelete as jest.Mock).mockImplementation(async () =>
      order.push('account'),
    );

    const result = await job.handle(buildEnvelope({}));

    expect(order).toEqual(['cancel', 'attachments', 'account']);
    expect(billingService.cancelSubscription).toHaveBeenCalledWith('acc_1');
    expect(attachmentsService.purgeAllForAccount).toHaveBeenCalledWith('acc_1');
    expect(accountsService.hardDelete).toHaveBeenCalledWith('acc_1');
    expect(result).toEqual({ purgedCount: 1, candidateCount: 1 });
  });

  it('a missing/already-canceled subscription does not block the purge', async () => {
    const { accountsService, billingService, job } = build([{ id: 'acc_1' }]);
    (billingService.cancelSubscription as jest.Mock).mockRejectedValue(
      new Error('This account has no active subscription to cancel'),
    );

    const result = await job.handle(buildEnvelope({}));

    expect(accountsService.hardDelete).toHaveBeenCalledWith('acc_1');
    expect(result).toEqual({ purgedCount: 1, candidateCount: 1 });
  });

  it("one account's failure does not abort the rest of the batch", async () => {
    const { accountsService, job } = build([{ id: 'bad' }, { id: 'good' }]);
    (accountsService.hardDelete as jest.Mock).mockImplementation(
      async (accountId: string) => {
        if (accountId === 'bad') throw new Error('boom');
      },
    );

    const result = await job.handle(buildEnvelope({}));

    expect(result).toEqual({ purgedCount: 1, candidateCount: 2 });
  });

  it('purges nothing when no account is past the grace period', async () => {
    const { accountsService, attachmentsService, job } = build([]);

    const result = await job.handle(buildEnvelope({}));

    expect(attachmentsService.purgeAllForAccount).not.toHaveBeenCalled();
    expect(accountsService.hardDelete).not.toHaveBeenCalled();
    expect(result).toEqual({ purgedCount: 0, candidateCount: 0 });
  });
});
