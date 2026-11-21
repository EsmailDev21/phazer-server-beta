/**
 * Step 5.10. The limits an operator may tune WITHOUT a deploy of new code: how deeply `IF` and `FOR_EACH` may
 * nest (combined), how many actions one rule may hold, and how much a loop may do. Read from the environment on every call (three tiny parses),
 * so a test, or a restart with a new value, takes effect with no module state to reset.
 *
 *   AUTOMATION_MAX_IF_DEPTH       default 3   hard ceiling 5
 *   AUTOMATION_MAX_TOTAL_ACTIONS  default 30  hard ceiling 100
 *   AUTOMATION_MAX_FOR_EACH_ITEMS default 100 hard ceiling 1000   tasks one FOR_EACH may go through
 *   AUTOMATION_MAX_NOTIFY_RECIPIENTS default 50 hard ceiling 500  people one NOTIFY may reach (a group token
 *                                                                  such as WATCHERS can expand to many)
 *   AUTOMATION_MAX_WAIT_DAYS      default 30  hard ceiling 365  the longest a WAIT may last
 *   AUTOMATION_MAX_PENDING_WAITS  default 5000 hard ceiling 100000  waits one workspace may have pending
 *   AUTOMATION_MAX_CALL_DEPTH     default 3   hard ceiling 5    rules calling rules calling rules (RUN_RULE)
 *   AUTOMATION_MAX_LOOP_STEPS_PER_RUN default 500 hard ceiling 5000  loops started + tasks processed in one
 *                                                                  run (what bounds loops inside loops)
 *   AUTOMATION_MAX_ACTIONS_PER_RUN default 300 hard ceiling 2000  actions one run may EXECUTE (a loop
 *                                                                  multiplies what the rule lists)
 *
 * A value that is not a whole number in [1, hard ceiling] is IGNORED (the default applies): a typo in an
 * env file must not switch the guard off, and no setting can lift a limit past its hard ceiling (those
 * protect the run time and the stored size of a rule; they are code, not configuration).
 *
 * Rules are validated when SAVED, so lowering a limit does not rewrite stored rules. The executor checks
 * the CURRENT limits before it runs a rule, and a stored rule over them fails with a clear message
 * instead of running.
 */
export interface TreeLimits {
  /** how many IFs / FOR_EACHs may be inside one another, combined (1 = allowed, none inside another) */
  maxIfDepth: number;
  /** every action in the rule, counting those inside IF branches (and each IF itself) */
  maxTotalActions: number;
  /** how many tasks one FOR_EACH may select; more than this and the loop does nothing and fails */
  maxForEachItems: number;
  /** actions one run may actually execute, loops included */
  maxActionsPerRun: number;
  /** loops started plus tasks processed, in one run: what keeps a loop inside a loop bounded */
  maxLoopSteps: number;
  /** how many RUN_RULE calls may be inside one another (a calls b calls c = 2 deep) */
  maxCallDepth: number;
  /** the longest a WAIT may last, in days */
  maxWaitDays: number;
  /** waits one workspace may have pending at once (each holds a snapshot of a rule) */
  maxPendingWaits: number;
  /** people one NOTIFY may reach; a group (WATCHERS) over this makes it fail instead of sending to some */
  maxNotifyRecipients: number;
}

export const TREE_LIMIT_DEFAULTS: Readonly<TreeLimits> = {
  maxIfDepth: 3,
  maxTotalActions: 30,
  maxForEachItems: 100,
  maxActionsPerRun: 300,
  maxLoopSteps: 500,
  maxCallDepth: 3,
  maxWaitDays: 30,
  maxPendingWaits: 5000,
  maxNotifyRecipients: 50,
};
export const TREE_LIMIT_HARD_MAX: Readonly<TreeLimits> = {
  maxIfDepth: 5,
  maxTotalActions: 100,
  maxForEachItems: 1000,
  maxActionsPerRun: 2000,
  maxLoopSteps: 5000,
  maxCallDepth: 5,
  maxWaitDays: 365,
  maxPendingWaits: 100_000,
  maxNotifyRecipients: 500,
};
export const TREE_LIMIT_ENV: Readonly<Record<keyof TreeLimits, string>> = {
  maxIfDepth: 'AUTOMATION_MAX_IF_DEPTH',
  maxTotalActions: 'AUTOMATION_MAX_TOTAL_ACTIONS',
  maxForEachItems: 'AUTOMATION_MAX_FOR_EACH_ITEMS',
  maxActionsPerRun: 'AUTOMATION_MAX_ACTIONS_PER_RUN',
  maxLoopSteps: 'AUTOMATION_MAX_LOOP_STEPS_PER_RUN',
  maxCallDepth: 'AUTOMATION_MAX_CALL_DEPTH',
  maxWaitDays: 'AUTOMATION_MAX_WAIT_DAYS',
  maxPendingWaits: 'AUTOMATION_MAX_PENDING_WAITS',
  maxNotifyRecipients: 'AUTOMATION_MAX_NOTIFY_RECIPIENTS',
};

/** A whole number in [1, hardMax] from an environment value; anything else gives the fallback. */
export function readEnvLimit(
  raw: string | undefined,
  fallback: number,
  hardMax: number,
): number {
  if (raw === undefined || !/^\s*\d{1,6}\s*$/.test(raw)) return fallback;
  const n = Number(raw);
  return n >= 1 && n <= hardMax ? n : fallback;
}

export function treeLimits(env: NodeJS.ProcessEnv = process.env): TreeLimits {
  return {
    maxIfDepth: readEnvLimit(
      env[TREE_LIMIT_ENV.maxIfDepth],
      TREE_LIMIT_DEFAULTS.maxIfDepth,
      TREE_LIMIT_HARD_MAX.maxIfDepth,
    ),
    maxTotalActions: readEnvLimit(
      env[TREE_LIMIT_ENV.maxTotalActions],
      TREE_LIMIT_DEFAULTS.maxTotalActions,
      TREE_LIMIT_HARD_MAX.maxTotalActions,
    ),
    maxForEachItems: readEnvLimit(
      env[TREE_LIMIT_ENV.maxForEachItems],
      TREE_LIMIT_DEFAULTS.maxForEachItems,
      TREE_LIMIT_HARD_MAX.maxForEachItems,
    ),
    maxActionsPerRun: readEnvLimit(
      env[TREE_LIMIT_ENV.maxActionsPerRun],
      TREE_LIMIT_DEFAULTS.maxActionsPerRun,
      TREE_LIMIT_HARD_MAX.maxActionsPerRun,
    ),
    maxLoopSteps: readEnvLimit(
      env[TREE_LIMIT_ENV.maxLoopSteps],
      TREE_LIMIT_DEFAULTS.maxLoopSteps,
      TREE_LIMIT_HARD_MAX.maxLoopSteps,
    ),
    maxCallDepth: readEnvLimit(
      env[TREE_LIMIT_ENV.maxCallDepth],
      TREE_LIMIT_DEFAULTS.maxCallDepth,
      TREE_LIMIT_HARD_MAX.maxCallDepth,
    ),
    maxWaitDays: readEnvLimit(
      env[TREE_LIMIT_ENV.maxWaitDays],
      TREE_LIMIT_DEFAULTS.maxWaitDays,
      TREE_LIMIT_HARD_MAX.maxWaitDays,
    ),
    maxPendingWaits: readEnvLimit(
      env[TREE_LIMIT_ENV.maxPendingWaits],
      TREE_LIMIT_DEFAULTS.maxPendingWaits,
      TREE_LIMIT_HARD_MAX.maxPendingWaits,
    ),
    maxNotifyRecipients: readEnvLimit(
      env[TREE_LIMIT_ENV.maxNotifyRecipients],
      TREE_LIMIT_DEFAULTS.maxNotifyRecipients,
      TREE_LIMIT_HARD_MAX.maxNotifyRecipients,
    ),
  };
}

/**
 * The JSON nesting a rule may have. A rule with no IF keeps today's 12 at least; each level of IF adds a
 * `then` array and an action object, and through an `elseIf` case 4 levels, and the allowance has ONE SPARE level on top of the
 * configured depth, so a rule that is one level too deep is refused by the specific `IF_TOO_DEEP` (which
 * points at the offending IF) rather than by this generic guard. Default depth 3 -> 21.
 */
export function maxJsonDepthFor(
  baseDepth: number,
  limits: TreeLimits = treeLimits(),
): number {
  return Math.max(baseDepth, 4 * (limits.maxIfDepth + 1) + 5);
}
