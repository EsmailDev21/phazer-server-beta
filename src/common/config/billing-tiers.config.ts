import { PlanKey } from '@prisma/client';

/**
 * BILLING_TIERS — canonical, single source of truth, per BILLING_SETUP.md
 * (referenced by the Billing graph; not itself provided to this backend
 * — the NUMBERS below are transcribed directly from the graph's own
 * BILLING__TIERS__PERSONAL/ORG nodes, which is as close to that doc as
 * this backend has access to). Replaces the storage-only placeholder
 * this file held during the Attachments module build (that placeholder
 * is explicitly superseded now that real tier numbers exist — see the
 * doc-vs-code drift the graph itself calls out: old code apparently had
 * 1GB/50GB where the real numbers are 5GB/100GB).
 *
 * getPlanLimits(planKey) is the ONLY place any of these numbers should
 * ever be read from — no parallel hardcoded copy of any limit anywhere
 * else in the codebase (this fixes the exact "hardcoded ternary instead
 * of reading tier.limits.includedSeats" drift bug the graph names).
 *
 * SCOPE ASYMMETRY, taken literally from the graph's own wording (not an
 * inference): PERSONAL tiers cap projects "per workspace" and tasks "per
 * project" (explicit qualifier in the graph). ORG tiers state "N
 * projects" with no "/workspace" qualifier — read as ACCOUNT-TOTAL across
 * every workspace under that account, not per-workspace, since orgs are
 * structured around multiple workspaces/teams and a per-workspace cap
 * would let the total be multiplied by creating more workspaces. ORG
 * tiers mention NO task limit at all, at any tier — read literally as
 * "task counts are never capped for organization accounts," not a
 * missing number to guess at. `PlanLimitsService` (access-control module)
 * is what actually applies these scope rules based on Account.type.
 *
 * SEAT LIMITS: `overageCostPerSeatUsd: null` means NO overage path exists
 * — exceeding `includedSeats` is a hard block (FREE_PERSONAL: 0 free
 * collaborators, FREE_ORG: 1 seat, neither tier's description mentions a
 * per-extra price). A non-null value means exceeding the included count
 * is ALLOWED and simply accrues an overage charge (see
 * BILLING__TIERS__OVERAGE) rather than blocking the invite.
 */
export interface PlanLimits {
  priceUsdPerMonth: number;
  /** null = unlimited */
  workspaces: number | null;
  /** PERSONAL: per-workspace cap. ORG: account-total cap. null = unlimited. */
  projects: number | null;
  /** PERSONAL only — per-project cap. ALWAYS null for every ORG tier (no task limit exists for org accounts at any tier, per the graph's literal silence). */
  tasks: number | null;
  /** null = unlimited (ENTERPRISE_ORG). 0 = no free seats at all (FREE_PERSONAL). */
  includedSeats: number | null;
  /** null = no overage support -> hard block beyond includedSeats. Non-null = allowed beyond the limit, billed as overage. */
  overageCostPerSeatUsd: number | null;
  storageGB: number;
  maxFileSizeBytes: number;
  /**
   * step 0.10 (diagram 18). PROPOSED values - the diagram marks them as a
   * starting point and they need product sign-off. All ACCOUNT-TOTAL (not
   * per workspace), like ORG projects, so creating more workspaces cannot
   * multiply them. null = unlimited.
   *
   * Free tiers sit at the diagram's "free personal" column; PRO_PERSONAL is
   * its "paid personal" column; PROFESSIONAL_ORG is its "organization"
   * column; STARTER_ORG is a step between; ENTERPRISE_ORG is unlimited like
   * every other ENTERPRISE limit above.
   */
  /** Live integration connections (GitHub/Slack/...). */
  integrations: number | null;
  /**
   * Imported items per calendar month (UTC), metered in UsageMetric
   * ('import_items'). FREE_PERSONAL's 250 equals the ceiling it is already
   * bounded by (5 projects x 50 tasks); it is written out rather than left
   * null because null means UNLIMITED here and GET /billing/tiers publishes
   * this object as-is - a null would read as "unlimited imports" on the free
   * plan. FREE_ORG has no task cap at all, so its number is the only bound.
   */
  importItemsPerMonth: number | null;
  /** PRIVATE templates (marketplace listings are not counted). */
  templates: number | null;
  /** Automations (enabled or not). */
  automations: number | null;
}

export const BILLING_TIERS: Record<PlanKey, PlanLimits> = {
  FREE_PERSONAL: {
    priceUsdPerMonth: 0,
    workspaces: 1,
    projects: 5, // per workspace
    tasks: 50, // per project
    includedSeats: 0,
    overageCostPerSeatUsd: null, // hard block — no paid collaborators at all on this tier
    storageGB: 5,
    maxFileSizeBytes: 10 * 1024 * 1024,
    integrations: 1,
    importItemsPerMonth: 250,
    templates: 3,
    automations: 3,
  },
  PRO_PERSONAL: {
    priceUsdPerMonth: 9,
    workspaces: 5,
    projects: null, // unlimited
    tasks: null, // unlimited
    includedSeats: 3,
    overageCostPerSeatUsd: 3,
    storageGB: 100,
    maxFileSizeBytes: 100 * 1024 * 1024,
    integrations: 3,
    importItemsPerMonth: 5000,
    templates: 25,
    automations: 25,
  },
  FREE_ORG: {
    priceUsdPerMonth: 0,
    workspaces: 1,
    projects: 5, // account-total
    tasks: null, // no task limit for org accounts, any tier
    includedSeats: 1,
    overageCostPerSeatUsd: null, // hard block — matches FREE_PERSONAL's no-overage free tier
    storageGB: 5,
    maxFileSizeBytes: 10 * 1024 * 1024,
    integrations: 1,
    importItemsPerMonth: 250,
    templates: 3,
    automations: 3,
  },
  STARTER_ORG: {
    priceUsdPerMonth: 29,
    workspaces: 3,
    projects: 20, // account-total
    tasks: null,
    includedSeats: 5,
    overageCostPerSeatUsd: 5,
    storageGB: 500,
    maxFileSizeBytes: 100 * 1024 * 1024,
    integrations: 5,
    importItemsPerMonth: 10000,
    templates: 25,
    automations: 25,
  },
  PROFESSIONAL_ORG: {
    priceUsdPerMonth: 79,
    workspaces: 10,
    projects: null, // unlimited
    tasks: null,
    includedSeats: 20,
    overageCostPerSeatUsd: 3,
    storageGB: 2000,
    maxFileSizeBytes: 500 * 1024 * 1024,
    integrations: 20,
    importItemsPerMonth: 50000,
    templates: 200,
    automations: 200,
  },
  ENTERPRISE_ORG: {
    priceUsdPerMonth: 299,
    workspaces: null,
    projects: null,
    tasks: null,
    includedSeats: null,
    overageCostPerSeatUsd: null, // no overage possible — nothing to overage against when everything's unlimited
    storageGB: 5000,
    maxFileSizeBytes: 5 * 1024 * 1024 * 1024,
    integrations: null,
    importItemsPerMonth: null,
    templates: null,
    automations: null,
  },
};

const FALLBACK_TIER: PlanLimits = BILLING_TIERS.FREE_PERSONAL;

/**
 * planType is nullable in the schema — any account somehow still missing
 * one (shouldn't happen after the Attachments-module fix that sets it at
 * creation, but defensive regardless) falls back to the most restrictive
 * tier rather than throwing or silently allowing unlimited usage.
 */
export function getPlanLimits(planType: PlanKey | null): PlanLimits {
  if (!planType) return FALLBACK_TIER;
  return BILLING_TIERS[planType];
}
