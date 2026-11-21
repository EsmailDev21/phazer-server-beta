import { Injectable } from '@nestjs/common';
import { AccountType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { getPlanLimits } from '../common/config/billing-tiers.config';
import { ActionName, PlanLimitKey } from './interfaces/access-control.types';

export interface PlanLimitContext {
  accountId: string;
  workspaceId?: string;
  projectId?: string;
}

/** The count-based limits whose backing table is owned by a later phase. */
export type CountedLimitKey = 'integration' | 'template' | 'automation';

/** How many of the resource the account currently has. Account-total. */
export type ResourceCounter = (
  context: PlanLimitContext,
  db: Prisma.TransactionClient | PrismaService,
) => Promise<number>;

/** UsageMetric.metric for the monthly import-items meter. */
export const IMPORT_ITEMS_METRIC = 'import_items';

/** UsageMetric.period for a moment: 'YYYY-MM' in UTC. */
export function usagePeriod(at: Date = new Date()): string {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`;
}

export interface CheckLimitOptions {
  /**
   * How many MORE of the resource the caller is about to create (default 1,
   * the single-create case every existing caller is). `count < limit` is
   * exactly `count + 1 <= limit`, so the default changes nothing. Bulk
   * writers (ADR-0003 decision 9) pass the chunk size.
   */
  additional?: number;
  /** Count inside the caller's transaction instead of on the shared client. */
  db?: Prisma.TransactionClient;
  /** Clock for the monthly 'importItems' period. Tests only. */
  now?: Date;
}

/**
 * Real implementation of PermissionResolver step 8 — per the Billing
 * graph's CONSOLIDATE__CANCHECKS: "planLimit checks are step 8 of that
 * SAME algorithm now, not a parallel billing-specific surface." Replaces
 * the old 8 granular can-do/remaining-capacity endpoints entirely; there
 * is no other place in the codebase these numbers are checked.
 *
 * 'storage' is DELIBERATELY excluded here, still handled as its own
 * explicit check inside AttachmentsService, not through this generic
 * path — count-based limits (workspace/project/task/member) only need
 * "how many rows already exist," answerable from (action, targetType,
 * targetId) alone. Storage needs the SIZE of the specific upload being
 * attempted, which PermissionResolver.resolve()'s signature has no slot
 * for. Forcing it through this generic step-8 shape would either lose
 * that information or require changing resolve()'s signature for every
 * caller just to serve one action — not worth it when Attachments
 * already has a correct, working, more precise check of its own.
 */
@Injectable()
export class PlanLimitsService {
  private readonly counters = new Map<CountedLimitKey, ResourceCounter>();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * The phase that adds the table behind 'integration' (2.x), 'template'
   * (3.1) or 'automation' (5.x) registers how to count it, once, in
   * onModuleInit. Until then checkLimit THROWS for that key rather than
   * answering: "no table yet" really is a count of 0, but a counter someone
   * forgets to register after the table exists would turn into "unlimited"
   * with nothing failing. Loud beats silent here.
   */
  registerCounter(key: CountedLimitKey, counter: ResourceCounter): void {
    const existing = this.counters.get(key);
    if (existing && existing !== counter) {
      throw new Error(
        `A counter for plan limit "${key}" is already registered`,
      );
    }
    this.counters.set(key, counter);
  }

  async checkLimit(
    planLimit: PlanLimitKey,
    action: ActionName,
    context: PlanLimitContext,
    options: CheckLimitOptions = {},
  ): Promise<boolean> {
    if (planLimit === 'storage') return true; // handled elsewhere — see class doc

    const additional = options.additional ?? 1;
    if (!Number.isInteger(additional) || additional < 0) {
      throw new Error(`checkLimit: invalid additional=${additional}`);
    }
    const db = options.db ?? this.prisma;

    const account = await db.account.findUnique({
      where: { id: context.accountId },
      select: { type: true, planType: true },
    });
    if (!account) return false; // target account doesn't exist — let the caller's own NotFoundException surface, not a plan-limit denial

    const limits = getPlanLimits(account.planType);

    switch (planLimit) {
      case 'workspace': {
        if (limits.workspaces === null) return true;
        const count = await db.workspace.count({
          where: { accountId: context.accountId },
        });
        return count + additional <= limits.workspaces;
      }

      case 'project': {
        if (limits.projects === null) return true;
        if (!context.workspaceId) return true; // can't scope the check without a workspace — fail open rather than block on a malformed call

        // PERSONAL: per-workspace cap. ORG: account-total cap (see
        // billing-tiers.config.ts's SCOPE ASYMMETRY note).
        const count =
          account.type === AccountType.PERSONAL
            ? await db.project.count({
                where: { workspaceId: context.workspaceId },
              })
            : await db.project.count({
                where: { workspace: { accountId: context.accountId } },
              });
        return count + additional <= limits.projects;
      }

      case 'task': {
        // No task limit exists for ORGANIZATION accounts at any tier —
        // literal reading of the graph's silence, not a gap to fill.
        if (account.type === AccountType.ORGANIZATION) return true;
        if (limits.tasks === null) return true;
        if (!context.projectId) return true; // Inbox tasks (no project) aren't counted against the per-project cap — no natural scope to check against

        const count = await db.task.count({
          where: { projectId: context.projectId, isArchived: false },
        });
        return count + additional <= limits.tasks;
      }

      case 'member': {
        if (limits.includedSeats === null) return true; // unlimited (ENTERPRISE_ORG)

        const count = await db.accountMember.count({
          where: { accountId: context.accountId },
        });
        if (count + additional <= limits.includedSeats) return true;

        // Overage-capable tiers ALLOW exceeding the included count — the
        // seat is billed later (see BILLING__TIERS__OVERAGE), never
        // blocked at invite time. Only a tier with NO overage price
        // (FREE_PERSONAL, FREE_ORG) hard-blocks here.
        return limits.overageCostPerSeatUsd !== null;
      }

      case 'integration':
      case 'template':
      case 'automation': {
        const cap =
          planLimit === 'integration'
            ? limits.integrations
            : planLimit === 'template'
              ? limits.templates
              : limits.automations;
        if (cap === null) return true; // unlimited: no counter needed
        const counter = this.counters.get(planLimit);
        if (!counter) {
          throw new Error(
            `Plan limit "${planLimit}" has no counter registered: the module that owns its table must call PlanLimitsService.registerCounter("${planLimit}", ...)`,
          );
        }
        const count = await counter(context, db);
        return count + additional <= cap;
      }

      case 'importItems': {
        // Monthly metered, not a row count: used = this month's UsageMetric.
        if (limits.importItemsPerMonth === null) return true;
        const row = await db.usageMetric.findUnique({
          where: {
            accountId_metric_period: {
              accountId: context.accountId,
              metric: IMPORT_ITEMS_METRIC,
              period: usagePeriod(options.now),
            },
          },
          select: { value: true },
        });
        return (row?.value ?? 0) + additional <= limits.importItemsPerMonth;
      }

      default:
        // Compile-time exhaustiveness: a new PlanLimitKey must be handled
        // above, never fall through to "allowed".
        return planLimit satisfies never;
    }
  }
}
