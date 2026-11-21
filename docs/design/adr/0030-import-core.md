# ADR-0030 - Import core: jobs, state machine, ExternalRef, preflight

Status: ACCEPTED (step 4.1). Number 0030 is deliberately far from the Phase 2/3 agents' range (0009-0029) to avoid a filename clash; renumber on merge if you prefer.

## Context
Phase 4 imports another tool's projects into a workspace. Step 4.1 is the control plane only: the job record, who may do what to it when,
the idempotency table, and the plan preflight. The executor that actually writes tasks is 4.4; the provider adapters are 4.5 / 4.7 / 4.8.

## Decisions
1. **One job = one connection into one workspace of the SAME Account.** Authority is `runImport` (WORKSPACE, ADMIN) on the target workspace, checked on every call
   (guard for create/list, service for every `:id` route). A foreign or missing connection is the same 404. Importing needs an ACTIVE connection.
2. **State machine** (`import-state-machine.ts`, diagram 04). 13 statuses; the table is pure and tested against a literal 13x13 expectation. Every transition in the
   service is `UPDATE ... WHERE id AND status IN (from)`, so racing requests cannot both win (tested with 3 concurrent starts). Additions to diagram 04:
   `RUNNING -> QUEUED` (executor hands a job back), `PAUSED -> QUEUED` (the person resumed), `QUEUED -> CANCELED`, `PAUSED -> CANCELED`,
   `ROLLING_BACK -> ROLLING_BACK` (re-request a rollback whose queue job was lost).
3. **Editing invalidates.** A new selection resets to SOURCES_SELECTED and clears the preview; a new mapping resets to MAPPING and clears the preview. The mapping is kept
   across a selection edit (4.3 reconciles it). Selection / mapping are frozen once QUEUED.
4. **start / resume / rollback flip the status and enqueue in ONE database transaction.** Queue down = 503 and the flip rolls back (tested). Commit failing after a successful enqueue leaves an
   orphan queue job: **executor rule for 4.4 - a job whose row is not in the expected status (QUEUED for run, ROLLING_BACK for rollback) does nothing and acks.** jobIds are
   deterministic (`import-run-<id>-<attempt>`, `import-rollback-<id>`; BullMQ forbids ':') so a retry cannot double up, and `attempt` is bumped on every start/resume so a resume is never swallowed by dedupe.
5. **Import item = one imported TASK** (subtasks included; projects, comments and files are not metered): FREE_PERSONAL's 250 = 5 projects x 50 tasks, which is how step 0.10 sized it.
   `ImportUsageService` is the writer of the `import_items` UsageMetric (one atomic upsert; refund per period, never below 0). The executor charges per committed chunk and records
   `progress.chargedByPeriod`, so a rollback refunds the month actually charged. 4.1 only reads it (preflight).
6. **G1 preflight** = connection ACTIVE, something to import, project cap (`checkLimit('project')`), **per-project task cap read from the tier table** (new projects have no rows, so `checkLimit('task')` cannot see
   them; ORGANIZATION has no task cap), monthly import allowance. Computed at preview and **re-run at start from the stored counts** (plan or usage may have changed; no provider call).
   **Storage is NOT a G1 check**: attachment bytes are enforced per file in 4.6, where hitting the cap pauses the job. Known limitation: a re-run's preview counts items that already exist (4.4 skips them; the preview over-states).
7. **ExternalRef** is the idempotency key, unique on `(connection, externalType, externalId)`. `upsertMany` (one statement per chunk, usable inside the caller's transaction) on conflict **keeps `importJobId` and `localId`**
   (the job that created a row owns it, so rolling back a later re-run cannot delete the first run's data) and only refreshes `contentHash` / `externalKey`. `localId` is deliberately not a foreign key (polymorphic).
8. **Adapter contract lives in `src/imports/import-adapter.ts`, not in `integrations/core/integration.types.ts`**: `ImportCapableAdapter extends ConnectorAdapter` with `discover` and `estimate` (read-only, through ProviderHttpClient).
   Reason: another agent is editing `integration.types.ts` in parallel; a type guard (`isImportCapable`) keeps `ConnectorRegistry` untouched. 4.4 adds `fetchBundle`, 4.6 `fetchAttachment` here too. A selection must be selectable nodes of the tree the provider just returned.
9. **Issues are bounded** (5000 per job + one `ISSUES_TRUNCATED` row); stored JSON is bounded (selection <= 500 sources, mapping <= 256 KB / depth 8, no `__proto__`/`constructor` keys); unknown option keys are a 400.
10. **Queue `imports`** (flag `IMPORTS`, concurrency 2). Attachments get their own queue in 4.6. With no handler registered (until 4.4) a started job sits QUEUED; `FEATURE_IMPORTS` is off by default and the worker does not consume the queue while it is off.

## Not in 4.1 (by design)
Executor / chunking / checkpoints / rollback deletion (4.4); mapping shape and suggestions (4.3; 4.1 stores `mappingConfig` opaque); `CanonicalBundle` (4.2); any real provider (4.5+);
`saveAsTemplateId` column (4.9, needs the Template table from 3.3); downloadable report file (4.9; 4.1 has JSON `report` + paged `issues`); SSE progress (4.4).

## Consequences
- A stuck QUEUED job (Redis lost the entry) needs the 4.4 sweep; there is no re-kick for QUEUED in 4.1.
- `GET /imports/:id/report` is JSON, not a download.
