/**
 * Step 0.10: the four new plan-limit keys and their tier values. Existing keys
 * (workspace/project/task/member) are pinned by the -1.3 characterization
 * suite against a real database; here a small Prisma double is enough.
 */
import { PlanKey } from '@prisma/client';
import { BILLING_TIERS } from '../common/config/billing-tiers.config';
import {
  IMPORT_ITEMS_METRIC,
  PlanLimitsService,
  usagePeriod,
} from './plan-limits.service';

const ctx = { accountId: 'a1', workspaceId: 'w1' };

function svc(planType: PlanKey, usage?: { value: number } | null) {
  const findUnique = jest.fn().mockResolvedValue(usage ?? null);
  const db: any = {
    account: {
      findUnique: async () => ({
        type: planType.endsWith('ORG') ? 'ORGANIZATION' : 'PERSONAL',
        planType,
      }),
    },
    usageMetric: { findUnique },
  };
  return { s: new PlanLimitsService(db), findUnique };
}

describe('counted limits: integration / template / automation', () => {
  const cases = [
    ['integration', 'integrations'],
    ['template', 'templates'],
    ['automation', 'automations'],
  ] as const;

  it.each(cases)(
    '%s: allowed up to the tier cap, denied past it (FREE_PERSONAL)',
    async (key, field) => {
      const cap = BILLING_TIERS.FREE_PERSONAL[field] as number;
      const { s } = svc('FREE_PERSONAL');
      s.registerCounter(key, async () => cap - 1);
      expect(await s.checkLimit(key, 'createTemplate', ctx)).toBe(true); // creating the cap-th
      const full = svc('FREE_PERSONAL').s;
      full.registerCounter(key, async () => cap);
      expect(await full.checkLimit(key, 'createTemplate', ctx)).toBe(false); // one over
    },
  );

  it.each(cases)(
    '%s: `additional` is count + n <= cap (bulk preflight)',
    async (key, field) => {
      const cap = BILLING_TIERS.PRO_PERSONAL[field] as number;
      const { s } = svc('PRO_PERSONAL');
      s.registerCounter(key, async () => cap - 5);
      expect(
        await s.checkLimit(key, 'createTemplate', ctx, { additional: 5 }),
      ).toBe(true);
      expect(
        await s.checkLimit(key, 'createTemplate', ctx, { additional: 6 }),
      ).toBe(false);
    },
  );

  it.each(cases)(
    '%s: unlimited tier answers true without ever needing a counter',
    async (key) => {
      const { s } = svc('ENTERPRISE_ORG'); // nothing registered
      expect(await s.checkLimit(key, 'createTemplate', ctx)).toBe(true);
    },
  );

  it.each(cases)(
    '%s: a CAPPED tier with no counter registered THROWS (never silently allows)',
    async (key) => {
      const { s } = svc('FREE_PERSONAL');
      await expect(s.checkLimit(key, 'createTemplate', ctx)).rejects.toThrow(
        new RegExp(`"${key}" has no counter registered`),
      );
    },
  );

  it('the counter receives the context and the transaction client it should count in', async () => {
    const { s } = svc('FREE_PERSONAL');
    const counter = jest.fn().mockResolvedValue(0);
    s.registerCounter('template', counter);
    const tx: any = {
      account: {
        findUnique: async () => ({
          type: 'PERSONAL',
          planType: 'FREE_PERSONAL',
        }),
      },
    };
    await s.checkLimit('template', 'createTemplate', ctx, { db: tx });
    expect(counter).toHaveBeenCalledWith(ctx, tx);
  });

  it('registering twice: same function is fine, a different one is an error', () => {
    const { s } = svc('FREE_PERSONAL');
    const a = async () => 0;
    s.registerCounter('template', a);
    expect(() => s.registerCounter('template', a)).not.toThrow();
    expect(() => s.registerCounter('template', async () => 1)).toThrow(
      /already registered/,
    );
  });
});

describe('importItems: monthly metered', () => {
  it('no usage row yet counts as 0; allowed up to the cap, denied one past', async () => {
    const cap = BILLING_TIERS.PRO_PERSONAL.importItemsPerMonth as number;
    const { s } = svc('PRO_PERSONAL', null);
    expect(
      await s.checkLimit('importItems', 'runImport', ctx, { additional: cap }),
    ).toBe(true);
    expect(
      await s.checkLimit('importItems', 'runImport', ctx, {
        additional: cap + 1,
      }),
    ).toBe(false);
  });

  it('adds to what this month already used', async () => {
    const cap = BILLING_TIERS.PRO_PERSONAL.importItemsPerMonth as number;
    const { s } = svc('PRO_PERSONAL', { value: cap - 10 });
    expect(
      await s.checkLimit('importItems', 'runImport', ctx, { additional: 10 }),
    ).toBe(true);
    expect(
      await s.checkLimit('importItems', 'runImport', ctx, { additional: 11 }),
    ).toBe(false);
  });

  it('reads the (account, "import_items", current UTC month) row', async () => {
    const { s, findUnique } = svc('PRO_PERSONAL', null);
    await s.checkLimit('importItems', 'runImport', ctx, {
      now: new Date('2026-12-31T23:59:59Z'),
    });
    expect(findUnique).toHaveBeenCalledWith({
      where: {
        accountId_metric_period: {
          accountId: 'a1',
          metric: IMPORT_ITEMS_METRIC,
          period: '2026-12',
        },
      },
      select: { value: true },
    });
  });

  it('a new month starts from zero (different period key)', async () => {
    expect(usagePeriod(new Date('2026-12-31T23:59:59Z'))).toBe('2026-12');
    expect(usagePeriod(new Date('2027-01-01T00:00:00Z'))).toBe('2027-01');
    expect(usagePeriod(new Date('2026-03-05T12:00:00+14:00'))).toBe('2026-03'); // UTC, not local
  });

  it('only an unlimited tier (ENTERPRISE_ORG) skips the meter', async () => {
    const { s, findUnique } = svc('ENTERPRISE_ORG', { value: 999_999 });
    expect(
      await s.checkLimit('importItems', 'runImport', ctx, {
        additional: 1_000_000,
      }),
    ).toBe(true);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('FREE_PERSONAL is held to 250 a month', async () => {
    const { s } = svc('FREE_PERSONAL', { value: 200 });
    expect(
      await s.checkLimit('importItems', 'runImport', ctx, { additional: 50 }),
    ).toBe(true);
    expect(
      await s.checkLimit('importItems', 'runImport', ctx, { additional: 51 }),
    ).toBe(false);
  });
});

describe('tier values (PROPOSED in diagram 18; these properties must survive any retune)', () => {
  const fields = [
    'integrations',
    'importItemsPerMonth',
    'templates',
    'automations',
  ] as const;
  const inf = (v: number | null) => (v === null ? Infinity : v);
  const ladders: PlanKey[][] = [
    ['FREE_PERSONAL', 'PRO_PERSONAL'],
    ['FREE_ORG', 'STARTER_ORG', 'PROFESSIONAL_ORG', 'ENTERPRISE_ORG'],
  ];

  it.each(fields)(
    '%s never decreases up a tier ladder (null = unlimited)',
    (f) => {
      for (const ladder of ladders) {
        for (let i = 1; i < ladder.length; i++) {
          expect(inf(BILLING_TIERS[ladder[i]][f])).toBeGreaterThanOrEqual(
            inf(BILLING_TIERS[ladder[i - 1]][f]),
          );
        }
      }
    },
  );

  it('ENTERPRISE_ORG is unlimited on all four, like every other enterprise limit', () => {
    for (const f of fields) expect(BILLING_TIERS.ENTERPRISE_ORG[f]).toBeNull();
  });

  it('free tiers are metered at the free-personal ceiling (5 projects x 50 tasks); null is never used to mean "not metered"', () => {
    const ceiling =
      BILLING_TIERS.FREE_PERSONAL.projects! *
      BILLING_TIERS.FREE_PERSONAL.tasks!;
    expect(ceiling).toBe(250);
    expect(BILLING_TIERS.FREE_PERSONAL.importItemsPerMonth).toBe(ceiling);
    expect(BILLING_TIERS.FREE_ORG.tasks).toBeNull(); // so its own number is the only bound
    expect(BILLING_TIERS.FREE_ORG.importItemsPerMonth).toBe(ceiling);
  });

  it('every tier defines every field (no accidental undefined = unlimited)', () => {
    for (const plan of Object.keys(BILLING_TIERS) as PlanKey[]) {
      for (const f of fields)
        expect(BILLING_TIERS[plan][f]).not.toBeUndefined();
    }
  });
});
