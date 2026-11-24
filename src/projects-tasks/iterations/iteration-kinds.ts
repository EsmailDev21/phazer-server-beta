import { BadRequestException } from '@nestjs/common';
import { IterationKind } from '@prisma/client';

/**
 * ADR-0043. What makes a sprint different from a cycle or a milestone. Pure, no database:
 * `KIND_PROFILE` says which capabilities a kind has (later steps read it instead of
 * scattering `kind === 'SPRINT'` checks), and `parseConfig` validates the user-editable
 * `Iteration.config` object per kind. System-written data (commitment, snapshots) never
 * goes in `config`.
 */

export const INVALID_ITERATION_CONFIG = 'INVALID_ITERATION_CONFIG';
/** A feature of one kind was asked of another (e.g. a burndown of a cycle). */
export const KIND_NOT_SUPPORTED = 'KIND_NOT_SUPPORTED';

export interface KindProfile {
  /** Per-person capacity, and how much each person is loaded with. */
  capacity: boolean;
  /** Commitment at start, a daily snapshot and a burndown (ADR-0044). */
  burndown: boolean;
  /** A retro note that can be written even after the iteration is closed. */
  retro: boolean;
  /** Repeats on a schedule: the next one can be created automatically. */
  cadence: boolean;
  /** Has exit criteria that can gate closing. */
  exitCriteria: boolean;
  /** A target date with history, a health, release notes and a road (ADR-0046). */
  road: boolean;
  /** At most one ACTIVE per scope (project, or whole workspace). Not enforced for importers. */
  singleActivePerScope: boolean;
}

export const KIND_PROFILE: Record<IterationKind, KindProfile> = {
  SPRINT: {
    capacity: true,
    burndown: true,
    retro: true,
    cadence: false,
    exitCriteria: false,
    road: false,
    singleActivePerScope: true,
  },
  CYCLE: {
    capacity: false,
    burndown: false,
    retro: false,
    cadence: true,
    exitCriteria: false,
    road: false,
    singleActivePerScope: false,
  },
  MILESTONE: {
    capacity: false,
    burndown: false,
    retro: false,
    cadence: false,
    exitCriteria: true,
    road: true,
    singleActivePerScope: false,
  },
};

export interface SprintConfig {
  /** userId -> points that person can take this sprint. */
  capacity?: Record<string, number>;
  retro?: string;
}

export interface CycleConfig {
  cadenceWeeks?: number;
  autoCreateNext?: boolean;
  /** Close without asking: unfinished tasks move to the next cycle. */
  autoRollover?: boolean;
  cooldownDays?: number;
}

export interface MilestoneConfig {
  /** Closing needs every exit criterion met. Default true when criteria exist. */
  requireExitCriteria?: boolean;
}

export type IterationConfig = SprintConfig | CycleConfig | MilestoneConfig;

export const MAX_CAPACITY_ENTRIES = 200;
export const MAX_CAPACITY_POINTS = 1000;
export const MAX_RETRO_LENGTH = 4000;
export const MAX_CADENCE_WEEKS = 12;
export const MAX_COOLDOWN_DAYS = 14;

const ALLOWED_KEYS: Record<IterationKind, readonly string[]> = {
  SPRINT: ['capacity', 'retro'],
  CYCLE: ['cadenceWeeks', 'autoCreateNext', 'autoRollover', 'cooldownDays'],
  MILESTONE: ['requireExitCriteria'],
};

const round2 = (n: number) => Math.round(n * 100) / 100;

function bad(message: string): never {
  throw new BadRequestException({ message, code: INVALID_ITERATION_CONFIG });
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function readBool(
  src: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const v = src[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') bad(`config.${key} must be true or false`);
  return v;
}

function readInt(
  src: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | undefined {
  const v = src[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    bad(`config.${key} must be a whole number from ${min} to ${max}`);
  }
  return v;
}

function parseSprint(src: Record<string, unknown>): SprintConfig {
  const out: SprintConfig = {};
  if (src.capacity !== undefined) {
    if (!isPlainObject(src.capacity))
      bad('config.capacity must be an object of userId -> points');
    const entries = Object.entries(src.capacity);
    if (entries.length > MAX_CAPACITY_ENTRIES) {
      bad(`config.capacity can have at most ${MAX_CAPACITY_ENTRIES} people`);
    }
    const capacity: Record<string, number> = {};
    for (const [userId, points] of entries) {
      if (userId.trim() === '' || userId.length > 64)
        bad('config.capacity has an invalid user id');
      if (
        typeof points !== 'number' ||
        !Number.isFinite(points) ||
        points < 0 ||
        points > MAX_CAPACITY_POINTS
      ) {
        bad(`config.capacity points must be from 0 to ${MAX_CAPACITY_POINTS}`);
      }
      capacity[userId] = round2(points);
    }
    if (entries.length > 0) out.capacity = capacity;
  }
  if (src.retro !== undefined) {
    if (typeof src.retro !== 'string') bad('config.retro must be text');
    const retro = src.retro.trim();
    if (retro.length > MAX_RETRO_LENGTH) {
      bad(`config.retro can be at most ${MAX_RETRO_LENGTH} characters`);
    }
    if (retro !== '') out.retro = retro;
  }
  return out;
}

function parseCycle(src: Record<string, unknown>): CycleConfig {
  const out: CycleConfig = {};
  const cadenceWeeks = readInt(src, 'cadenceWeeks', 1, MAX_CADENCE_WEEKS);
  const cooldownDays = readInt(src, 'cooldownDays', 0, MAX_COOLDOWN_DAYS);
  const autoCreateNext = readBool(src, 'autoCreateNext');
  const autoRollover = readBool(src, 'autoRollover');
  if (autoCreateNext === true && cadenceWeeks === undefined) {
    bad('config.autoCreateNext needs config.cadenceWeeks');
  }
  if (cadenceWeeks !== undefined) out.cadenceWeeks = cadenceWeeks;
  if (cooldownDays !== undefined) out.cooldownDays = cooldownDays;
  if (autoCreateNext !== undefined) out.autoCreateNext = autoCreateNext;
  if (autoRollover !== undefined) out.autoRollover = autoRollover;
  return out;
}

function parseMilestone(src: Record<string, unknown>): MilestoneConfig {
  const out: MilestoneConfig = {};
  const require = readBool(src, 'requireExitCriteria');
  if (require !== undefined) out.requireExitCriteria = require;
  return out;
}

/**
 * Validates `raw` for `kind` and returns the normalised object, or null when there is
 * nothing to keep (null / undefined / an object that normalises to empty). Unknown keys
 * are a 400, so a typo is never silently dropped and a sprint cannot carry cycle settings.
 */
export function parseConfig(
  kind: IterationKind,
  raw: unknown,
): IterationConfig | null {
  if (raw === undefined || raw === null) return null;
  if (!isPlainObject(raw)) bad('config must be an object');
  const unknown = Object.keys(raw).filter(
    (k) => !ALLOWED_KEYS[kind].includes(k),
  );
  if (unknown.length > 0) {
    bad(`config.${unknown[0]} is not a setting of a ${kind.toLowerCase()}`);
  }
  let parsed: IterationConfig;
  switch (kind) {
    case IterationKind.SPRINT:
      parsed = parseSprint(raw);
      break;
    case IterationKind.CYCLE:
      parsed = parseCycle(raw);
      break;
    default:
      parsed = parseMilestone(raw);
  }
  return Object.keys(parsed).length === 0 ? null : parsed;
}

/**
 * Changing the kind of an iteration keeps the settings that still fit and drops the rest
 * (a sprint turned into a cycle loses its capacity, never fails the edit).
 */
export function reconcileConfig(
  kind: IterationKind,
  existing: unknown,
): IterationConfig | null {
  if (!isPlainObject(existing)) return null;
  const kept: Record<string, unknown> = {};
  for (const key of ALLOWED_KEYS[kind]) {
    if (existing[key] !== undefined) kept[key] = existing[key];
  }
  try {
    return parseConfig(kind, kept);
  } catch {
    return null;
  }
}

/** The kinds that have a capability, e.g. `kindsWith('burndown')` for the daily snapshot sweep. */
export function kindsWith(capability: keyof KindProfile): IterationKind[] {
  return (Object.keys(KIND_PROFILE) as IterationKind[]).filter(
    (k) => KIND_PROFILE[k][capability],
  );
}
