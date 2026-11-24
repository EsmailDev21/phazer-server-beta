import { BadRequestException } from '@nestjs/common';
import { IterationKind } from '@prisma/client';
import {
  INVALID_ITERATION_CONFIG,
  KIND_PROFILE,
  kindsWith,
  MAX_CAPACITY_ENTRIES,
  MAX_RETRO_LENGTH,
  parseConfig,
  reconcileConfig,
} from './iteration-kinds';

const K = IterationKind;

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof BadRequestException) {
      return (e.getResponse() as { code?: string }).code;
    }
    throw e;
  }
  return undefined;
}

describe('kind profile (ADR-0043)', () => {
  it('gives each kind a different set of capabilities', () => {
    expect(KIND_PROFILE.SPRINT).toMatchObject({
      capacity: true,
      burndown: true,
      retro: true,
      singleActivePerScope: true,
    });
    expect(KIND_PROFILE.CYCLE).toMatchObject({
      cadence: true,
      capacity: false,
    });
    expect(KIND_PROFILE.MILESTONE).toMatchObject({
      exitCriteria: true,
      cadence: false,
    });
  });

  it('has no two kinds with the same profile', () => {
    const seen = new Set(
      Object.values(KIND_PROFILE).map((p) => JSON.stringify(p)),
    );
    expect(seen.size).toBe(3);
  });
});

describe('kindsWith', () => {
  it('lists the kinds that have a capability', () => {
    expect(kindsWith('burndown')).toEqual(['SPRINT']);
    expect(kindsWith('cadence')).toEqual(['CYCLE']);
    expect(kindsWith('exitCriteria')).toEqual(['MILESTONE']);
    expect(kindsWith('road')).toEqual(['MILESTONE']);
  });
});

describe('parseConfig: shared rules', () => {
  it.each([undefined, null, {}])('%j means no config', (raw) => {
    expect(parseConfig(K.SPRINT, raw)).toBeNull();
  });

  it.each(['x', 4, true, []])('rejects a non-object (%j)', (raw) => {
    expect(codeOf(() => parseConfig(K.CYCLE, raw))).toBe(
      INVALID_ITERATION_CONFIG,
    );
  });

  it('rejects a setting that belongs to another kind', () => {
    expect(codeOf(() => parseConfig(K.SPRINT, { cadenceWeeks: 2 }))).toBe(
      INVALID_ITERATION_CONFIG,
    );
    expect(codeOf(() => parseConfig(K.CYCLE, { capacity: {} }))).toBe(
      INVALID_ITERATION_CONFIG,
    );
    expect(codeOf(() => parseConfig(K.MILESTONE, { retro: 'x' }))).toBe(
      INVALID_ITERATION_CONFIG,
    );
  });

  it('rejects a typo instead of dropping it', () => {
    expect(codeOf(() => parseConfig(K.CYCLE, { cadenceWeek: 2 }))).toBe(
      INVALID_ITERATION_CONFIG,
    );
  });
});

describe('parseConfig: sprint', () => {
  it('keeps and rounds capacity, trims the retro', () => {
    expect(
      parseConfig(K.SPRINT, {
        capacity: { u1: 8.004, u2: 0 },
        retro: '  went well  ',
      }),
    ).toEqual({ capacity: { u1: 8, u2: 0 }, retro: 'went well' });
  });

  it('drops an empty capacity and a blank retro', () => {
    expect(parseConfig(K.SPRINT, { capacity: {}, retro: '   ' })).toBeNull();
  });

  it.each([-1, 1001, Number.NaN, '5'])(
    'rejects capacity points %j',
    (points) => {
      expect(
        codeOf(() => parseConfig(K.SPRINT, { capacity: { u1: points } })),
      ).toBe(INVALID_ITERATION_CONFIG);
    },
  );

  it('rejects too many people and an over-long retro', () => {
    const many = Object.fromEntries(
      Array.from({ length: MAX_CAPACITY_ENTRIES + 1 }, (_, i) => [`u${i}`, 1]),
    );
    expect(codeOf(() => parseConfig(K.SPRINT, { capacity: many }))).toBe(
      INVALID_ITERATION_CONFIG,
    );
    expect(
      codeOf(() =>
        parseConfig(K.SPRINT, { retro: 'x'.repeat(MAX_RETRO_LENGTH + 1) }),
      ),
    ).toBe(INVALID_ITERATION_CONFIG);
  });
});

describe('parseConfig: cycle', () => {
  it('accepts a full cadence', () => {
    expect(
      parseConfig(K.CYCLE, {
        cadenceWeeks: 2,
        autoCreateNext: true,
        autoRollover: true,
        cooldownDays: 2,
      }),
    ).toEqual({
      cadenceWeeks: 2,
      autoCreateNext: true,
      autoRollover: true,
      cooldownDays: 2,
    });
  });

  it('needs a cadence to auto-create the next cycle', () => {
    expect(codeOf(() => parseConfig(K.CYCLE, { autoCreateNext: true }))).toBe(
      INVALID_ITERATION_CONFIG,
    );
    expect(parseConfig(K.CYCLE, { autoCreateNext: false })).toEqual({
      autoCreateNext: false,
    });
  });

  it.each([
    ['cadenceWeeks', 0],
    ['cadenceWeeks', 13],
    ['cadenceWeeks', 1.5],
    ['cooldownDays', -1],
    ['cooldownDays', 15],
  ])('rejects %s = %j', (key, value) => {
    expect(codeOf(() => parseConfig(K.CYCLE, { [key]: value }))).toBe(
      INVALID_ITERATION_CONFIG,
    );
  });

  it('rejects a non-boolean flag', () => {
    expect(codeOf(() => parseConfig(K.CYCLE, { autoRollover: 'yes' }))).toBe(
      INVALID_ITERATION_CONFIG,
    );
  });
});

describe('parseConfig: milestone', () => {
  it('accepts the gate flag', () => {
    expect(parseConfig(K.MILESTONE, { requireExitCriteria: false })).toEqual({
      requireExitCriteria: false,
    });
  });
});

describe('reconcileConfig (kind change)', () => {
  it('keeps nothing that does not fit the new kind', () => {
    expect(
      reconcileConfig(K.CYCLE, { capacity: { u1: 5 }, retro: 'x' }),
    ).toBeNull();
  });

  it('keeps what fits', () => {
    expect(
      reconcileConfig(K.SPRINT, { capacity: { u1: 5 }, cadenceWeeks: 2 }),
    ).toEqual({
      capacity: { u1: 5 },
    });
  });

  it('drops a value that no longer validates instead of failing the edit', () => {
    expect(reconcileConfig(K.CYCLE, { autoCreateNext: true })).toBeNull();
  });

  it('copes with a missing or odd stored value', () => {
    expect(reconcileConfig(K.SPRINT, null)).toBeNull();
    expect(reconcileConfig(K.SPRINT, 'junk')).toBeNull();
  });
});
