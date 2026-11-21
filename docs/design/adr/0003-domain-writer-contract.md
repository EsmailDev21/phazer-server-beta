# ADR-0003: `WriteContext` and `DomainWriter` contract

- **Status:** Accepted (2026-09-24)
- **Blocks:** step 0.7, then every writer of tasks/projects/fields outside the
  HTTP controllers (Phase 2 chat, Phase 3 templates, Phase 4 importers,
  Phase 5 automations)

## Context

New modules must create tasks, projects and custom fields without bypassing the
existing services (which carry validation and write the activity row), and
without a 5,000-task import firing 5,000 notification fan-outs. `PLAN.md`
proposes `DomainWriter` wrapping the existing services with a `WriteContext`.
This ADR fixes what the context means and what the writer is and is not
responsible for.

### Found in the code (these change the design)

- **`$transaction` is used exactly once** in `src/` (webhook idempotency).
  Services take `PrismaService` directly; there is no way to run a service
  method inside a caller's transaction today. "One transaction per chunk" and
  "atomic counter inside the create transaction" (ADR-0004) both need this.
- **`TasksService.create` is not transactional.** It inserts the task, then
  calls `ActivityService.record`, which inserts the activity and emits
  `activity.created` immediately. `ActivityService`'s own doc promises fan-out
  "AFTER the source transaction commits", but there is no source transaction.
  A crash between the two inserts leaves a task with no activity.
- **The task-cap plan limit is enforced by the `@RequireAccess` guard, not the
  service.** `TasksService.create` never calls `PlanLimitsService`. A worker
  calling the writer has no guard in its path, so it would bypass the cap.
- `createdVia` is hardcoded `'MANUAL'`, and a characterization test pins that
  (its comment names this step as the deliberate change).
- `ActivityVisibility` has `TIMELINE` and `SILENT`. `AuditLog` fan-out already
  notifies account OWNER/ADMIN, excluding the actor.
- Prisma 5.22's generated client has `createManyAndReturn`, and `createdAt` /
  `updatedAt` are settable on create (checked in the generated types; runtime
  behaviour still has to be confirmed in step 0.7 against a real engine).

## Decision

```ts
interface WriteContext {
  origin: CreationMode;        // MANUAL | SNAP | FOCUS | IMPORT | TEMPLATE | INTEGRATION
  actorId: string | null;      // null = system
  silent?: boolean;
  bulk?: boolean;              // implies silent
  keepOriginalDates?: boolean; // honoured for origin IMPORT only
  importJobId?: string;
  tx?: Prisma.TransactionClient;
  afterCommit?: Array<() => void>; // owned by the writer, not by callers
}
```

1. **No context means today's behaviour, exactly.** Controllers keep calling the
   services unchanged. The characterization suite (-1.3) is the acceptance test
   for step 0.7 and must pass without edits; the pinned `createdVia: 'MANUAL'`
   stays true because the controller path passes no context.
2. **`origin` replaces the hardcoded `createdVia`.** The `CreationMode` enum
   gains `IMPORT`, `TEMPLATE`, `INTEGRATION` in the 0.6 expand migration.
3. **The context is never built from request input.** No DTO has `origin`,
   `keepOriginalDates` or `importJobId` fields (the global pipe already rejects
   unknown fields). `keepOriginalDates` throws unless `origin` is `IMPORT`, so
   the public API cannot backdate anything.
4. **Transactions are explicit, not ambient.** Write methods accept an optional
   `tx`; internally `const db = ctx.tx ?? this.prisma`. Rejected an
   `AsyncLocalStorage` ambient transaction: invisible at the call site, easy to
   lose across an un-awaited callback, and hard to test.
5. **Events fire after commit.** With a `tx`, `ActivityService.record(params,
   ctx)` inserts on the transaction and pushes its `emit` onto
   `ctx.afterCommit`; the writer runs those callbacks only once the transaction
   resolves. A rollback emits nothing. The default (no context) path is left
   non-atomic on purpose, so as not to change pinned behaviour in this step;
   making it atomic is a separate, deliberate change.
6. **`silent`:** activity rows are still written (history is preserved) with
   `visibility: SILENT` and `metadata { origin, importJobId }`, but
   `activity.created` is **not emitted**, so there is no fan-out. `bulk`
   implies `silent`.
   *Known wrinkle:* `SILENT` is documented as "drives notifications, never shown
   in the feed" (due-date reminders). Here it means "hidden and not emitted".
   The absence of the emit is the real discriminator; if any consumer ever reads
   `SILENT` rows as notification triggers, introduce a distinct visibility value.
7. **One summary per job, not one per row.** A bulk or template write finishes
   with a single `AuditLog` entry (`IMPORT_COMPLETED` / `TEMPLATE_APPLIED`,
   added to `AuditAction` in 0.6) emitted normally, which the existing
   `auditlog.created` fan-out turns into an `ACCOUNT_ALERT` for OWNER/ADMIN.
8. **`bulk`:** one `$transaction` per chunk, default **100 tasks**, with an
   explicit `timeout` and `maxWait` (Prisma's interactive default is 5 s).
   Rows go in with `createManyAndReturn`, activities with `createMany`, the task
   number block is reserved with one counter update (ADR-0004). Implicit
   many-to-many data (assignees, tags) is written in the same transaction; how
   (per-row connect versus insert into the join table) is settled in 0.7 with a
   benchmark. Chunk size is tuned against the ADR-0004 lock-time measurement.
9. **The writer does not authorise, but it does enforce the task cap.**
   Authorisation stays with the caller: guard on the HTTP path,
   `PermissionResolver` as the linked user for chat commands, job-start plus
   run-time re-check for imports. Because the cap lives in the guard today, the
   writer's bulk path calls `PlanLimitsService` itself before each chunk.
   `checkLimit` gains an `additional` count (with the new limit keys in 0.10).
   Over the cap the chunk fails with a typed `PLAN_LIMIT_EXCEEDED`; the import
   pauses at its gate. **It never silently truncates.**
10. **Retry-safety is the caller's obligation, made possible by `tx`.** A chunk
    may run twice (at-least-once, ADR-0001). Importers look up `ExternalRef`
    (unique on provider + external id within the connection) inside the same
    transaction and skip existing rows. That unique index is a requirement on the
    Phase 4 schema, recorded here so it is not forgotten.
11. **Enforced, not just agreed.** An ESLint `no-restricted-syntax` rule forbids
    `prisma.task|project|customField.create*` and the `update*/delete*`
    equivalents outside `src/projects-tasks/` and `src/domain-writer/`. New
    modules depend on `DomainWriter` only.
12. **Scope of 0.7:** tasks, projects, custom fields. Comments and tags join the
    same contract in the phases that need them.

## Alternatives rejected

- **New module-specific write services duplicating the validation.** Two places
  for the same rules, and the Snap-era invariant ("never bypass services") lost.
- **Ambient (`AsyncLocalStorage`) transactions.** See decision 4.
- **Emit events inside the transaction.** A listener could observe rows that are
  later rolled back.
- **Skipping activity rows for silent writes.** Loses import history and the
  per-task audit trail for a modest storage saving.

## Consequences

- Every service the writer wraps gets a `tx`/`ctx` parameter: a mechanical but
  wide change in 0.7, landed with the characterization suite as the safety net.
- Bulk and silent behaviour cannot be exercised through the HTTP API at all.
- Step 0.7's plan text ("chunked `createMany`") becomes `createManyAndReturn`,
  and its tests gain: rollback emits nothing, cap exceeded fails the chunk
  without partial writes, retry of a chunk creates no duplicates.

## Revisit if

Prisma is upgraded past 5.22 (transaction and `createMany*` behaviour), or a
consumer starts reading `SILENT` activity as a notification trigger.
