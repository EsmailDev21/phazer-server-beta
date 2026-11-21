import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { JobEnvelope } from '../../queue/job-envelope';
import {
  JobHandler,
  JobHandlerRegistry,
} from '../../queue/job-handler.registry';
import { QUEUES } from '../../queue/queue.definitions';
import { AccountsService } from './accounts.service';
import { BillingService } from '../../billing/billing.service';
import { AttachmentsService } from '../../attachments/attachments.service';

declare module '../../queue/queue.definitions' {
  interface JobPayloads {
    'system.account-purge': Record<string, never>;
  }
}

/**
 * Step 0.3: `Account.delete()` (AccountsController) has only ever set
 * `deletedAt` — the hard-delete side of it did not exist as callable code
 * anywhere (unlike the other four jobs this step wires up, which were all
 * complete-but-uncalled). This job is genuinely NEW logic, not just a
 * rewire, kept here (rather than inside `AccountsService` itself)
 * specifically so `TenancyModule` doesn't have to depend on
 * `BillingModule`/`AttachmentsModule` for its everyday CRUD path — only
 * this job, and only in the worker process, needs all three.
 *
 * Order matters and is deliberate:
 *   1. Best-effort cancel any live subscription — the whole point is to
 *      stop a deleted account from continuing to be billed; a failure
 *      here (already canceled, provider unreachable, no subscription at
 *      all) must NOT block the purge itself.
 *   2. Purge attachments (storage objects + rows) — `Attachment.accountId`
 *      has no cascading FK (see `AttachmentsService.purgeAllForAccount`),
 *      so this is the one thing that would otherwise leak.
 *   3. Hard-delete the Account row — every other account-scoped table
 *      cascades from this via Prisma's `onDelete: Cascade`.
 *
 * Idempotent per account (each step tolerates "already done"), and
 * idempotent overall: `listExpiredSoftDeletes` only returns accounts
 * still past the grace period, so a retried run simply finds fewer (or
 * zero) of them. One account's failure is caught and logged, not allowed
 * to abort the rest of the batch.
 */
@Injectable()
export class AccountPurgeJob
  implements JobHandler<'system.account-purge'>, OnModuleInit
{
  private readonly logger = new Logger(AccountPurgeJob.name);
  readonly queue = QUEUES.SYSTEM.name;
  readonly jobName = 'system.account-purge' as const;

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly accountsService: AccountsService,
    private readonly billingService: BillingService,
    private readonly attachmentsService: AttachmentsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
    this.registry.registerSchedule({
      queue: this.queue,
      schedulerId: 'account-purge-daily',
      jobName: this.jobName,
      payload: {},
      cron: '0 3 * * *', // 03:00 server time, daily
    });
  }

  async handle(envelope: JobEnvelope) {
    const expired = await this.accountsService.listExpiredSoftDeletes();
    let purgedCount = 0;

    for (const { id: accountId } of expired) {
      try {
        await this.cancelSubscriptionBestEffort(accountId);
        await this.attachmentsService.purgeAllForAccount(accountId);
        await this.accountsService.hardDelete(accountId);
        purgedCount++;
      } catch (error) {
        this.logger.error(
          `Account purge failed for ${accountId} (trace ${envelope.traceId}), will retry next run: ${(error as Error).message}`,
        );
      }
    }

    this.logger.log(
      `Account purge job ${envelope.traceId}: ${purgedCount}/${expired.length} account(s) purged`,
    );
    return { purgedCount, candidateCount: expired.length };
  }

  /** A missing/already-canceled subscription must never block the purge. */
  private async cancelSubscriptionBestEffort(accountId: string): Promise<void> {
    try {
      await this.billingService.cancelSubscription(accountId);
    } catch (error) {
      this.logger.debug(
        `No subscription to cancel for account ${accountId} being purged: ${(error as Error).message}`,
      );
    }
  }
}
