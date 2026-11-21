import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { IMPORT_ITEMS_METRIC, usagePeriod } from '../access-control/plan-limits.service';
import { newEntityId } from '../domain-writer/entity-id';
import { PrismaService } from '../prisma/prisma.service';

type Db = Prisma.TransactionClient | PrismaService;

/**
 * Step 4.1. The monthly 'import_items' meter (ADR-0030 d.5). PlanLimitsService only READS it
 * (checkLimit('importItems')); this is the writer. The executor charges per committed chunk and records the
 * period in ImportProgress.chargedByPeriod, so a rollback refunds the month the items were actually charged in.
 * An item = one imported TASK (subtasks included). Projects, comments and files are not metered.
 */
@Injectable()
export class ImportUsageService {
  constructor(private readonly prisma: PrismaService) {}

  /** Adds `items` to this month's counter; returns the period charged. One atomic statement (no read-modify-write). */
  async charge(accountId: string, items: number, now: Date = new Date(), db: Db = this.prisma): Promise<string> {
    if (!Number.isInteger(items) || items < 0) throw new Error(`charge: invalid items=${items}`);
    const period = usagePeriod(now);
    if (items === 0) return period;
    await db.$executeRaw`
      INSERT INTO usage_metrics (id, account_id, metric, value, period)
      VALUES (${newEntityId()}, ${accountId}, ${IMPORT_ITEMS_METRIC}, ${items}, ${period})
      ON CONFLICT (account_id, metric, period)
      DO UPDATE SET value = usage_metrics.value + EXCLUDED.value
    `;
    return period;
  }

  /** Gives items back, per period, never below zero. Idempotency is the caller's job (it clears chargedByPeriod). */
  async refund(accountId: string, byPeriod: Readonly<Record<string, number>>, db: Db = this.prisma): Promise<void> {
    for (const [period, items] of Object.entries(byPeriod)) {
      if (!Number.isInteger(items) || items <= 0) continue;
      await db.$executeRaw`
        UPDATE usage_metrics SET value = GREATEST(value - ${items}, 0)
        WHERE account_id = ${accountId} AND metric = ${IMPORT_ITEMS_METRIC} AND period = ${period}
      `;
    }
  }

  async used(accountId: string, now: Date = new Date()): Promise<number> {
    const row = await this.prisma.usageMetric.findUnique({
      where: {
        accountId_metric_period: { accountId, metric: IMPORT_ITEMS_METRIC, period: usagePeriod(now) },
      },
      select: { value: true },
    });
    return row?.value ?? 0;
  }
}
