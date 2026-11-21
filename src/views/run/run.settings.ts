import { readEnvLimit } from '../../automations/dsl/rule.settings';

/**
 * Step 5.11. How much running a view may cost. Same rules as the automation limits: read from the
 * environment on every call, a value that is not a whole number in [1, ceiling] is IGNORED, nothing can
 * lift a limit past its ceiling.
 *
 *   VIEW_RUN_MAX_PAGE   default 100   ceiling 500     tasks returned per page
 *   VIEW_RUN_MAX_SCAN   default 5000  ceiling 50000   rows looked at per call (what the database narrowed
 *                                                      to; a filter it cannot narrow is checked in memory)
 */
export interface ViewRunLimits {
  maxPage: number;
  maxScan: number;
}
export const VIEW_RUN_DEFAULTS: Readonly<ViewRunLimits> = {
  maxPage: 100,
  maxScan: 5000,
};
export const VIEW_RUN_HARD_MAX: Readonly<ViewRunLimits> = {
  maxPage: 500,
  maxScan: 50_000,
};
export const VIEW_RUN_ENV: Readonly<Record<keyof ViewRunLimits, string>> = {
  maxPage: 'VIEW_RUN_MAX_PAGE',
  maxScan: 'VIEW_RUN_MAX_SCAN',
};

export function viewRunLimits(
  env: NodeJS.ProcessEnv = process.env,
): ViewRunLimits {
  return {
    maxPage: readEnvLimit(
      env[VIEW_RUN_ENV.maxPage],
      VIEW_RUN_DEFAULTS.maxPage,
      VIEW_RUN_HARD_MAX.maxPage,
    ),
    maxScan: readEnvLimit(
      env[VIEW_RUN_ENV.maxScan],
      VIEW_RUN_DEFAULTS.maxScan,
      VIEW_RUN_HARD_MAX.maxScan,
    ),
  };
}
