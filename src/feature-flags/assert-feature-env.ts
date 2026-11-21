import { validateFeatureEnv } from './feature-flags';

/**
 * Boot-time check shared by every entrypoint (main.ts now, main.worker.ts in
 * step 0.2), in the same fail-fast style as assertRequiredEnv: a flag that is
 * on without what it needs stops the process before it serves anything.
 * `exit` and `log` are injectable so this is unit-testable.
 */
export function assertFeatureFlagEnv(
  env: NodeJS.ProcessEnv = process.env,
  exit: (code: number) => never = process.exit,
  log: Pick<Console, 'error' | 'warn'> = console,
): void {
  const { problems, warnings } = validateFeatureEnv(env);

  for (const warning of warnings) log.warn(`WARN: ${warning}`);

  if (problems.length > 0) {
    log.error(
      `FATAL: invalid feature-flag configuration:\n${problems
        .map((p) => `  - ${p}`)
        .join('\n')}\nRefusing to start.`,
    );
    exit(1);
  }
}
