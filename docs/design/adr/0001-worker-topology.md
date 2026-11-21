# ADR-0001: Worker topology - API plus a separate worker process

- **Status:** Accepted (2026-09-24)
- **Blocks:** steps 0.1-0.4 (Redis, queue, first jobs, SSE over pub/sub)

## Context

Everything runs in one process started by `src/main.ts`. Imports (thousands of
tasks), provider webhooks, outbound notifications, token refresh and
repeatable sweeps are all long-running or periodic work that must not share an
event loop with request handling, must survive a deploy, and must run once
even when several instances are up.

### Found in the code

- **Six jobs are already written and waiting for a scheduler**, each with a
  comment saying so: due-date reminders (`DueDateReminderService.scanAndNotify`),
  account hard-delete after the 30-day grace, Snap session cleanup, abandoned
  attachment cleanup, Lemon Squeezy seat-overage billing, and Paymee recurring
  billing. Step 0.3 can give these a home.
- **Fan-out is an in-process `EventEmitter2` listener.** `ActivityService.record`
  emits `activity.created`; `FanoutService` (`@OnEvent`) creates `Notification`
  rows. A write made in a *worker* process emits in the worker's own emitter, so
  the worker must also register `FanoutService`, or nothing is notified.
- **SSE is an in-memory `Map<userId, Set<Subject>>`.** A worker has no browser
  connections, so a notification created there cannot reach a browser until
  step 0.4 (Redis pub/sub) exists. The `Notification` table stays the source of
  truth (README), so nothing is lost, only delayed until the next fetch.

## Decision

1. **Two entrypoints, one codebase, one image.**
   `src/main.ts` (HTTP; queue *producers* only) and `src/main.worker.ts`
   (`NestFactory.createApplicationContext`, no HTTP listener; queue
   *consumers* and repeatable jobs). Started by `start:prod` / `start:worker`.
2. **The API never runs a BullMQ `Worker`; the worker never listens for HTTP.**
   Roles are decided by the entrypoint, not by an env var, so a misconfigured
   environment cannot run both by accident.
3. **The worker imports the same domain modules as the API**, so services and
   the `DomainWriter` (ADR-0003) are the same code on both sides. Controllers in
   those modules are constructed but unmounted. Consequence: `FanoutService` is
   live in the worker (see above).
4. **Until step 0.4 lands, worker-originated writes are silent or bulk**
   (imports), which by ADR-0003 emit nothing per row. The one job-level audit
   entry they emit is a notification-table write and appears on the next fetch.
5. **One Redis, `maxmemory-policy noeviction`** (BullMQ requires it; an evicting
   Redis silently drops jobs). Queue names live in one registry file; a key
   prefix per environment.
6. **Job rules (all queues):**
   - At-least-once delivery, therefore every job is idempotent.
   - Envelope `{ traceId, accountId, actorId }` on every job.
   - Repeatable jobs use a deterministic `jobId` so N workers schedule one run.
   - Long work is chunked so one chunk finishes inside the shutdown grace
     (target under 30 s; container stop grace must exceed it). On SIGTERM the
     worker calls `worker.close()`, which waits for active jobs.
7. **Health:** the API's `/health` gains a Redis indicator that *degrades*,
   never blocks boot (0.1). The worker writes a heartbeat key with a short TTL
   for liveness checks.

## Alternatives rejected

- **Everything in the API process.** A 5,000-task import shares the event loop
  with request traffic; a deploy kills it mid-run; N instances all run every
  repeatable job.
- **A separate deployable / repository for the worker.** Duplicates the domain
  code the `DomainWriter` exists to keep single.
- **An external scheduler hitting admin endpoints** (the option the existing
  TODO comments suggest). No retries, no backoff, no dead-letter handling, and
  a public attack surface for internal work.
- **An `EMBEDDED_WORKER=true` mode.** Convenient for tiny deployments, but it
  reintroduces the failure mode in the first rejected option. Tests build the
  worker module directly instead.

## Consequences

- Two processes to deploy, scale and monitor. Compose and CI gain a worker.
- Dev needs `start:worker` running for anything queue-backed.
- Step 0.2's exit criterion ("queue + worker running in CI") is now precise: CI
  starts `main.worker.ts` against the Redis service already in `ci.yml`.

## Revisit if

Import volume needs its own pool (split queues across worker deployments), or a
target platform cannot run a second process (then add an embedded mode as a
new, explicitly dev-only ADR).
