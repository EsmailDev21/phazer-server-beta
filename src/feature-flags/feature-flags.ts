import { checkRedisUrl } from '../redis/redis-url';

/**
 * ADR-0002. Pure functions only - no Nest, no I/O - so the rules that decide
 * whether the app may boot are unit-testable and shared by every entrypoint
 * (API now, worker in step 0.2).
 */
export const FEATURE_FLAGS = [
  'WORKFLOW',
  'INTEGRATIONS',
  'IMPORTS',
  'TEMPLATES',
  'MARKETPLACE',
] as const;

export type FeatureFlag = (typeof FEATURE_FLAGS)[number];
export type FlagState = Readonly<Record<FeatureFlag, boolean>>;

const ENV_PREFIX = 'FEATURE_';
const TRUTHY = new Set(['true', '1']);
const FALSY = new Set(['', 'false', '0']);

/** Flags whose queues/workers need Redis. Only these make REDIS_URL mandatory. */
export const FLAGS_REQUIRING_REDIS: readonly FeatureFlag[] = [
  'INTEGRATIONS',
  'IMPORTS',
];

/** flag -> flags that must also be on. */
export const FLAG_PREREQUISITES: Readonly<
  Partial<Record<FeatureFlag, readonly FeatureFlag[]>>
> = {
  MARKETPLACE: ['TEMPLATES'],
};

export function envNameOf(flag: FeatureFlag): string {
  return `${ENV_PREFIX}${flag}`;
}

export interface ParsedFlags {
  flags: FlagState;
  /** FEATURE_* variables that are not one of the known flags (typo guard). */
  unknown: string[];
  /**
   * Known flags set to a value that is neither clearly on nor clearly off
   * (e.g. "yes", "on"). They are treated as OFF; surfaced so nobody believes a
   * flag is on when it is not.
   */
  ambiguous: Array<{ name: string; value: string }>;
}

export function parseFeatureFlags(env: NodeJS.ProcessEnv): ParsedFlags {
  const flags = {} as Record<FeatureFlag, boolean>;
  const ambiguous: ParsedFlags['ambiguous'] = [];

  for (const flag of FEATURE_FLAGS) {
    const name = envNameOf(flag);
    const raw = (env[name] ?? '').trim().toLowerCase();
    flags[flag] = TRUTHY.has(raw);
    if (!TRUTHY.has(raw) && !FALSY.has(raw)) {
      ambiguous.push({ name, value: env[name] ?? '' });
    }
  }

  const known = new Set(FEATURE_FLAGS.map(envNameOf));
  const unknown = Object.keys(env)
    .filter((key) => key.startsWith(ENV_PREFIX) && !known.has(key))
    .sort();

  return { flags, unknown, ambiguous };
}

export interface FeatureEnvReport {
  flags: FlagState;
  /** Boot must fail. */
  problems: string[];
  /** Boot continues; someone should read these. */
  warnings: string[];
}

/**
 * Decides whether the current environment is a valid combination of flags and
 * the config they need. A flag being OFF requires nothing, so every existing
 * environment keeps booting.
 */
export function validateFeatureEnv(env: NodeJS.ProcessEnv): FeatureEnvReport {
  const { flags, unknown, ambiguous } = parseFeatureFlags(env);
  const problems: string[] = [];
  const warnings: string[] = [];

  for (const [flag, needs] of Object.entries(FLAG_PREREQUISITES) as Array<
    [FeatureFlag, readonly FeatureFlag[]]
  >) {
    if (!flags[flag]) continue;
    for (const required of needs) {
      if (!flags[required]) {
        problems.push(
          `${envNameOf(flag)} is on but requires ${envNameOf(required)} to be on too.`,
        );
      }
    }
  }

  const redisFlags = FLAGS_REQUIRING_REDIS.filter((flag) => flags[flag]);
  if (redisFlags.length > 0) {
    const check = checkRedisUrl(env.REDIS_URL);
    if (!check.ok) {
      problems.push(
        `REDIS_URL ${check.reason}, but it is required while ${redisFlags
          .map(envNameOf)
          .join(' / ')} is on.`,
      );
    }
  }

  for (const name of unknown) {
    warnings.push(
      `${name} is not a known feature flag and is ignored (known: ${FEATURE_FLAGS.map(envNameOf).join(', ')}).`,
    );
  }
  for (const { name, value } of ambiguous) {
    warnings.push(
      `${name}="${value}" is treated as OFF. Only "true" or "1" turns a flag on.`,
    );
  }

  return { flags, problems, warnings };
}
