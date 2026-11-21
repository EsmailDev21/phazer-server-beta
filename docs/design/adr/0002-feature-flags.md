# ADR-0002: Feature flags - env-driven, one service, 404 when off

- **Status:** Accepted (2026-09-24)
- **Blocks:** every flag-gated step (0.1 onward)

## Context

`IMPLEMENTATION.md` fixes five flags, default off: `FEATURE_WORKFLOW`,
`FEATURE_INTEGRATIONS`, `FEATURE_IMPORTS`, `FEATURE_TEMPLATES`,
`FEATURE_MARKETPLACE`. A disabled feature's controllers return 404 and its
workers do not start. This ADR decides the mechanism.

### Found in the code

- `assertRequiredEnv()` in `main.ts` runs before `NestFactory.create` and exits
  with a clear message. New required config should follow that convention, but
  conditionally on the flag that needs it.
- Global guard order is Throttler, then `JwtAuthGuard`, then
  `AccessControlGuard`. A flag check placed *after* auth would answer 401 for a
  disabled route, revealing that it exists.
- `.env.example` already reserves the five names (commented, marked unread).

## Decision

1. **One `FeatureFlagsService`** (global module) reads the five env vars once at
   boot. `true` or `1`, case-insensitive, is on; anything else, including unset,
   is off. Any other `FEATURE_*` variable logs a warning at boot (typo guard).
   Call sites use `isEnabled(flag, { accountId? })`; the optional argument is
   reserved so per-account rollout can be added later without touching callers.
2. **HTTP: a `FeatureGuard` registered as the first global guard**, driven by a
   `@RequireFeature('WORKFLOW')` decorator on controllers or routes. Off means
   `NotFoundException`, before any auth, so a disabled route is
   indistinguishable from one that does not exist. This includes `@PublicSigned`
   webhook routes (0.9).
3. **Worker: processors and repeatable jobs register only if their flag is on.**
   At worker boot, for every queue whose flag is off, the worker *removes* that
   queue's repeatable job definitions. Otherwise they keep firing into a queue
   nobody consumes and pile up.
4. **Modules are always imported; flags never change the DI graph.**
   Conditional `imports: [flag ? X : []]` gives every flag combination a
   different, mostly untested application. Gating happens at the controller
   (404) and the worker registration only.
5. **Flag dependencies are validated at boot by both entrypoints**, in the same
   fail-fast style as `assertRequiredEnv`:
   - `MARKETPLACE` requires `TEMPLATES`.
   - `INTEGRATIONS` and `IMPORTS` require `REDIS_URL` and the vault key ring
     (variable names are decided in 0.5).
   - `WORKFLOW` and `TEMPLATES` need neither.
   A flag being on with its prerequisite missing is a boot failure, not a
   runtime surprise. A flag being off requires nothing, which keeps every
   existing environment booting.
6. **Schema is never flag-gated.** Migrations are expand-only and apply
   regardless of flags. Flag off means behaviour identical to today.
7. **Turning a flag off hides a feature; it does not delete its data.**

## Verification

- A test enumerates every controller route in each flagged module and asserts
  404 with the flag off.
- **The characterization suite (-1.3) runs with all flags off, and from step 1.4
  onward a second time with `FEATURE_WORKFLOW=true`.** The second run is the
  concrete check behind Phase 1's "existing clients unaffected" exit criterion.

## Alternatives rejected

- **DB-backed per-account flags.** Real staged rollout, but needs an admin
  surface, caching and its own tests, and nothing in the plan requires it yet.
  The reserved `accountId` argument keeps the door open.
- **A third-party flag service.** New runtime dependency and network hop on
  every request, for five flags.
- **Conditional module imports.** See decision 4.

## Consequences

- Flipping a flag needs a restart (env). Acceptable at this scale.
- Rollout is per deployment, not per customer.

## Revisit if

A customer-by-customer rollout or an instant kill switch without redeploy
becomes a requirement. Then supersede this with a DB-backed implementation
behind the same `isEnabled` signature.
