# Implementation Plan — Integrations, Import, Templates & Marketplace

> **Pre-launch stance:** no live data - the strict migration choreography (expand/backfill/contract, `NOT VALID`, `CONCURRENTLY`, populated-DB rehearsals, backfill CLIs) is suspended until launch. Tests, typecheck, lint and the integration suite are still required. See `START_HERE.md`. Where a step below prescribes expand/backfill/contract (e.g. 1.1, 1.4), a single migration is acceptable.

Companion to `PLAN.md` (design) and the diagrams (dependency graph: diagram 20). This document is the **build order**: PR-sized steps, what each touches, how it's tested, and when a phase is allowed to close.
Sizes are relative (S / M / L), not calendar estimates. No code has been written yet.

---

## 0. What the codebase recon changed

Things found in `backend-v5-recovered.zip` that alter or add steps:

| Finding | Consequence |
|---|---|
| **No `prisma/migrations/` folder** (only `schema.prisma`). README says `migrate dev --name init`, and warns that the default `npx prisma` now resolves to a different major with no `generate`/`migrate`. | **Step −1.1:** create + commit a baseline migration and pin the Prisma version *before any schema change*. Every later step depends on this. |
| **Test coverage is one 24-line e2e file, zero unit specs.** | **Step −1.2:** build an integration-test harness and write *characterization tests* for the code we're about to refactor (tasks, progress, permissions, fan-out). Phase 1 is too risky without them. |
| **Literal brace-named directories** under `src/` (e.g. `{config,dto,interfaces,decorators}`) — leftovers of a failed `mkdir -p {a,b}`. | **Step −1.3:** verify empty and delete. |
| **`rawBody: true` is already enabled globally** in `main.ts`. | Webhook signature verification needs no bootstrap change. |
| **Global `ValidationPipe` uses `forbidNonWhitelisted: true`.** Provider payloads (Slack/Discord/GitHub) contain fields we don't declare and would be rejected with 400. | **Step 0.9:** a `@PublicSigned()` decorator that swaps in a permissive per-route pipe. |
| **Global `ThrottlerGuard`.** GitHub/Slack deliver from shared IP ranges; per-IP throttling would drop legitimate events. | Same decorator skips the default throttle; the route is protected by signature + its own limiter. |
| **`assertRequiredEnv()` crashes boot on missing vars.** | New vars (`REDIS_URL`, vault keys) must be required **only when a feature flag is on**, or every environment without Redis stops booting. |
| **Module layout:** `tenancy/`, `projects-tasks/`, `activity-notifications/`, `events/`, `snap/`, `attachments/`, `billing/`, `access-control/`. | New modules: `queue`, `domain-writer`, `workflow`, `integrations`, `imports`, `templates`, `marketplace`, `automations`, `views`. |

---

## 1. Working agreements

- **One step = one PR**, small enough to review in one sitting. Steps marked **[ADR]** start with a short written decision record before any code.
- **Feature flags** (env-driven, default off): `FEATURE_WORKFLOW`, `FEATURE_INTEGRATIONS`, `FEATURE_IMPORTS`, `FEATURE_TEMPLATES`, `FEATURE_MARKETPLACE`. A disabled feature's controllers return 404 and its workers don't start.
- **Schema policy: expand → backfill → contract.** Add nullable/defaulted columns first, backfill with an idempotent resumable script, and only then add `NOT NULL`/unique constraints in a *later* migration. Never edit an applied migration.
- **Test pyramid**
  - Unit: pure logic (mappers, blueprint validator, variable/date resolvers, sanitizer, key parser, ADF→markdown).
  - Integration (real Postgres + Redis in Docker): services, migrations, queues, concurrency.
  - E2E: controllers incl. permission matrices.
  - Adapter contract tests: **recorded provider fixtures** (no live calls in CI); a separate manual "sandbox smoke" per provider before release.
- **Every new endpoint** ships with its `ACTION_CONFIG` entry and a role-matrix test.
- **Definition of done (per step):** tests green · lint/format · migration applies on a fresh DB *and* on a DB with seeded legacy data · flag-gated · README/diagram touched if the design moved.
- **Security review checkpoints** after Phase 0, 2, 4 and 6.

---

## 2. Step −1 — Pre-flight (must finish before Phase 0)

| Step | Work | Size |
|---|---|---|
| **−1.1** | Pin Prisma to the version the team actually generates with. Produce a **baseline migration** from the current `schema.prisma`, apply it to an empty DB, commit `prisma/migrations/`. Document the workflow in README (`migrate dev` locally, `migrate deploy` in CI/prod). | S |
| **−1.2** | **Test harness:** Jest integration config, Postgres + Redis + MinIO via `docker-compose.yml`, `resetDb()`, factories (`account`, `workspace`, `user` with each role, `project`, `task`), CI job. | M |
| **−1.3** | **Characterization tests** that pin *current* behavior of: `TasksService.create/update` (incl. `createdVia`, activity rows, fan-out), progress calculation, `PermissionResolver` role matrix per existing action, plan-limit enforcement, task visibility, attachments quota. These must stay green through Phase 1. | M |
| **−1.4** | Repo hygiene: delete the brace-named dirs, add `docker-compose.yml` + `.env.example` entries, add `docs/design/` and commit the diagrams there. | S |
| **−1.5 [ADR]** ✅ [`adr/0001-0004`](adr/README.md) | Decide and record: worker topology (API + separate worker process — recommended), feature-flag mechanism, DomainWriter contract, task-key uniqueness scope (recommended: unique per **account**, so `ENG-123` is unambiguous for account-level Slack/Discord/GitHub connections). | S |

**Exit:** baseline migration in repo; characterization suite green in CI.

---

## 3. Phase 0 — Foundations (M)

| Step | Work | Tests |
|---|---|---|
| **0.1** | `RedisModule` (ioredis), health indicator, `REDIS_URL` required only when a Redis-backed flag is on. | connection failure degrades health, not boot |
| **0.2** | `QueueModule` on BullMQ: queue registry, standard job envelope `{traceId, accountId, actorId}`, default retry/backoff, dead-letter handling. Add `main.worker.ts` + `start:worker` script so workers run as a separate process (**[ADR-0001](adr/0001-worker-topology.md):** worker imports the same domain modules, so `FanoutService` runs there too; API is producer-only). | retry/backoff, idempotent job ids, graceful shutdown |
| **0.3** | **Prove the queue with existing TODOs:** implement attachment-cleanup (and, if trivial, due-date reminders / account purge) as repeatable jobs. | jobs run once across two workers |
| **0.4** | **SSE over Redis pub/sub:** local connection map per instance + `sse:user:{id}` channel; fan-out publishes instead of writing to a local registry. | two app instances: user connected to A receives event triggered on B |
| **0.5** | `CryptoModule` / **TokenVault**: AES-256-GCM, key ring from env (`kid:key`), `encrypt/decrypt/reencrypt`, current-key rotation. | tamper detection, rotation, wrong-key failure |
| **0.6** | Expand-only schema: `CreationMode += IMPORT, TEMPLATE, INTEGRATION`; new `AuditAction` values; `IntegrationProvider` enum; `User.platformRole` (default `NONE`); `PlatformGuard` + `@RequirePlatformRole`. | migration on seeded DB; guard matrix |
| **0.7** | **`WriteContext` + `DomainWriter`:** `TasksService.create` (and Projects/CustomFields) accept an optional context `{createdVia, keepDates, silent, bulk, importJobId}`. Default path unchanged. `ActivityService.record` gets a no-emit/silent path; add chunked `createManyAndReturn`. **[ADR-0003](adr/0003-domain-writer-contract.md) adds:** explicit `tx` plumbing (no transaction support exists today), events emitted after commit, and a plan-limit check in the bulk path (the cap lives in the guard, which a worker never passes through). | **characterization suite unchanged**; silent path emits nothing; bulk = one tx per chunk |
| **0.8** | **`TagsService` + controller** (the `manageTags` action already exists): CRUD, case-insensitive unique per workspace, attach/detach with activity. | CRUD + permissions |
| **0.9** | **`@PublicSigned()`** decorator: public route, skips default throttle, permissive validation pipe, exposes raw body. `IntegrationWebhookEvent` dedupe service (insert-or-ignore on `(provider, deliveryId)`) + sweep job. | duplicate delivery → single processing |
| **0.10** | Add all new actions to `ACTION_CONFIG` / `ROLE_PERMISSIONS` and new `PlanLimitKey`s (values from diagram 18, tuned against `billing-tiers.config`). `PlanLimitsService.checkLimit` gains an `additional` count for bulk writes ([ADR-0003](adr/0003-domain-writer-contract.md)). | snapshot test of the full role × action matrix |

**Exit:** queue + worker running in CI; SSE works across instances; vault + DomainWriter + Tags in place; characterization suite still green. → *Security review #1.*

---

## 4. Phase 1 — Workflow core schema (L) · highest risk

Do these in order; each is independently shippable behind `FEATURE_WORKFLOW`.

| Step | Work | Notes / tests |
|---|---|---|
| **1.1** | **Keys.** Expand: `Workspace.key` (nullable), `Workspace.nextTaskNumber` (default 1), `Task.number` (nullable). Backfill script: generate unique keys per account from workspace names, number tasks per workspace by `createdAt`. Contract migration: `NOT NULL` + `@@unique([workspaceId, number])` + unique `(accountId, key)`. Create path increments the counter with a single atomic `UPDATE … RETURNING` inside the create transaction. Endpoint `GET /tasks/by-key/:key` **takes `accountId`** (a key is ambiguous across accounts). Key rename allowed; numbers permanent; **retired keys stay reserved and resolvable via `WorkspaceKeyAlias`**; `CHECK` on key format ([ADR-0004](adr/0004-task-key-scope.md)). | 100 parallel creates → gapless, unique; backfill is idempotent and resumable; legacy tasks addressable; renamed key still resolves the old reference and cannot be reissued |
| **1.2 [ADR]** | **Subtask semantics — decide first.** Depth limit; same-project constraint; cycle prevention; parent deletion/archival behavior (recommend: block delete while children exist, or explicit cascade choice); progress rollup formula; whether subtasks count toward task-cap plan limits; visibility inheritance; moving a parent moves its subtree; independent assignees/dates. | Short written doc, reviewed before code |
| **1.3** | **`Task.parentId`** self-relation + validation in `TasksService`; `includeSubtasks`/tree endpoints; progress rollup per the ADR; activity entries. | cycle/depth/cross-project rejections; progress golden cases |
| **1.4** | **Workflow statuses.** `WorkflowStatus`, `WorkflowTransition`, `Project.defaultWorkflowStatusId`, `Project.enforceTransitions`. Seed four default statuses (named like the enum) for **every existing project**; backfill `Task.workflowStatusId` to the default of its category. Moving a task sets category + status in one transaction. **`PATCH {status}` keeps working** (maps to the category's default status) so existing clients and Snap don't change. Deleting a status requires a reassignment target; changing a status's category recomputes tasks and progress; `excludeFromProgress` honoured. | legacy-API compatibility suite; category recompute; transition enforcement on/off |
| **1.5** | `IssueType` and `Iteration` (kind SPRINT/CYCLE/MILESTONE, PLANNED→ACTIVE→CLOSED) CRUD; `Task.issueTypeId`, `Task.iterationId`. | permissions; closing an iteration handles unfinished tasks |
| **1.6** | `ExternalLink` model + read in task detail DTO. | serialization |
| **1.7** | Indexes and query review: `(projectId, status)`, `(workspaceId, number)`, `parentId`, `workflowStatusId`, `iterationId`. Load-test list endpoints with joins. Update `api_contract_graph_v2.d2` and `schema_graph_v2.d2`. | list p95 before/after |

**Exit:** characterization suite green; migrations verified against a large seeded DB; existing clients unaffected. → *Design review of the ADR outcome.*

---

## 5. Phase 2 — Chat & links (L) · Discord first

| Step | Work | Tests |
|---|---|---|
| **2.1** | **Integration core.** Models: `OAuthState`, `IntegrationConnection`, `IntegrationCredential`, `IdentityLink`, `ChannelLink`, `ChannelSubscription`, `NotificationDelivery`. `ConnectorAdapter` interface + capability set, `ConnectorRegistry`, `ProviderHttpClient` (Redis token bucket, `Retry-After`, circuit breaker), `OAuthService` (PKCE, single-use state), token refresh under a per-connection Redis lock. Connect / callback / list / revoke endpoints; audit events; `integration` plan limit. | state replay rejected; concurrent refresh → one refresh; ciphertext never in any response |
| **2.2** | **Identity linking:** OAuth `identify` flow, verified-email auto-match, manual link endpoint, "link your account" reply builder for unlinked callers. | unlinked caller never executes |
| **2.3** | **Notification router:** activity listener → `ChannelSubscription` match (project, events, visibility) → `notify.deliver` job → adapter; provider-neutral `RichMessage`; delivery log; disable after repeated failures + `ACCOUNT_ALERT`; **echo guard**. | silent/bulk writes never notify; echo suppressed; failure disabling |
| **2.4** | **Discord adapter.** Ed25519 verification, `PING`, command registration (per-guild on connect), `/task create\|update\|assign\|list\|link`, message context-menu command, modals, **deferred responses + follow-ups**, guild↔workspace and channel↔project links (requires Manage Server), bot REST notify honouring rate-limit headers. Forum posts via a context-menu command on the post (auto-create is a later Gateway worker). | signed-fixture tests; unsigned/expired rejected; commands authorized as the linked user; 3-second ack path |
| **2.5** | **Slack adapter.** OAuth v2, signing-secret + timestamp verification, URL-verification challenge, slash command, message shortcut + modal (trigger id within 3 s), `link_shared` unfurl for task URLs, `chat.postMessage` notify. | same as 2.4 |
| **2.6** | **GitHub adapter.** GitHub App JWT → installation tokens, webhook verification + delivery dedupe, repo↔project `ChannelLink`, **key parser** (`ENG-123` in PR title/branch/commits, resolved only inside the linked workspace), `ExternalLink` upsert, simple per-project status rules stored in `ChannelLink.config` (migrated to Automations in Phase 5), installation lifecycle events. | cross-workspace key never links; merged PR → configured status |
| **2.7** | Hardening: limiter tuning, replay tests, key-rotation runbook, connection health endpoint, metrics (queue depth, delivery failures). | — |

**Exit:** Discord end-to-end on a real test server (create task from message, notifications, link/unlink); Slack + GitHub on sandbox accounts. → *Security review #2.*

---

## 6. Phase 3 — Templates core, private (L)

| Step | Work | Tests |
|---|---|---|
| **3.1** | **Blueprint v1:** TypeScript types + JSON Schema (ajv), limits (size/nodes/depth), version-migration hook, golden fixtures (student workspace with `exam` tag and `prof-review` field, sprint board, content calendar). | valid/invalid corpus; unknown fields rejected |
| **3.2** | Pure resolvers: variable substitution (whitelisted helpers, **no evaluation**), date anchor + offsets (weekend skip), module expansion, role resolution. | property tests; injection attempts |
| **3.3** | **Extractor:** workspace/project → blueprint (settings, tags, fields, types, iterations, workflows, task tree, dependencies; comments/attachments opt-in), deterministic stable `nodeKey`s. | round-trip fixtures |
| **3.4** | **Sanitizer:** users → role placeholders, dates → offsets, comment authors anonymized, id/email/external-ref stripping, PII + secret (regex + entropy) + URL scanners, structured report. | adversarial fixtures (leaked tokens, emails in titles) |
| **3.5** | `Template` / `TemplateVersion` (immutable, checksum) / fork lineage; PRIVATE + ACCOUNT visibility; template-count plan limit; permissions. | immutability; fork lineage |
| **3.6** | **Applier:** dry-run plan builder, merge rules (tags by name, fields by key, new projects, never overwrite workspace identity), plan-limit + storage preflight, chunked executor via `DomainWriter`, key numbering, `TemplateInstall` + `TemplateInstallItem`, completion notification, **undo** (only untouched entities). | **round trip: workspace → template → apply → structurally equal**; merge collisions; free-plan workspace-cap path |
| **3.7** | Template assets: upload/attach reference files (size-capped), copy-on-apply with quota reservation. | quota reservation/release |
| **3.8** | Editor API: draft edit → new version, version diff endpoint. | diff correctness |
| **3.9** | Seed first-party templates (student workspace etc.) under a system account. | applies cleanly |

**Exit:** round-trip and merge golden tests green; apply/undo verified on a large workspace.

---

## 7. Phase 4 — Importers (L)

| Step | Work | Tests |
|---|---|---|
| **4.1** | Import core: `ImportJob` state machine, `ExternalRef`, `ImportJobIssue`, controllers (create → sources → selection → mapping → preview → start / cancel / resume / rollback / report), `import_items` usage metric. | state-transition matrix |
| **4.2** | `CanonicalBundle` types + validator (shared with blueprint where possible); normalizers (ADF→markdown, HTML→markdown). | conversion corpus |
| **4.3** | **Mapping engine + suggestions:** status by category/type, priority tables, users by verified email, fields by type; persisted overrides. | table-driven from recorded fixtures |
| **4.4** | **Executor:** phase runner, chunking, checkpoints, transient/permanent/systemic error handling, pause/resume/cancel, **rollback by `importJobId`** in dependency order, progress over SSE. | kill worker mid-phase → resume without duplicates; rollback leaves zero orphans |
| **4.5** | **Linear adapter** (GraphQL pagination, complexity limits). Sandbox smoke run. | recorded-fixture contract tests |
| **4.6** | Comments, **activity history** (silent, original timestamps, external actor in metadata), **attachments** (streamed copy, quota reserved first, sha dedupe, resumable). | large-file and quota-exhausted paths |
| **4.7** | **ClickUp adapter** (hierarchy, per-list statuses, rate limits). | contract tests |
| **4.8** | **Jira adapter:** OAuth 3LO with rotating refresh tokens, ADF, sprints (Agile API), workflows + status categories, issue links, custom-field type mapping, paging. | contract tests |
| **4.9** | Import-as-template wiring; downloadable report; edge cases (cycles, orphan subtasks, deleted users, huge descriptions, rate-limit storms). | edge-case suite |

**Exit:** golden sandbox project per provider imports with matching counts; **re-running is a no-op**; rollback clean. → *Security review #3.*

---

## 8. Phase 5 — Automations engine + saved views (L)

| Step | Work |
|---|---|
| **5.1** | `Automation` / `AutomationRun`; rule DSL (JSON-schema validated): triggers (task created, status changed, field changed, due approaching, external link state changed), conditions (all/any), actions (set status/field/assignee/tag, comment, notify channel, create subtask). No code execution; action-count cap; **loop guard** (execution depth, origin tag, per-rule rate limit). |
| **5.2** | Rule runner worker: domain events → rules indexed by `(workspaceId, trigger)` → queue; idempotency key `(ruleId, eventId)`; run log. |
| **5.3** | Migrate GitHub status rules from `ChannelLink.config` into Automations; **upgrade job** translating stored `sourceDefinition` from imports/templates (unsupported ones stay disabled with a report). |
| **5.4** | `SavedView` CRUD, config schema (filters, grouping, sort, columns) validated against real fields; personal vs shared. |
| **5.5** | Extractor/applier/importers now carry automations and views. |

**Exit:** loop-guard tests (rule A ↔ rule B), a rule cannot exceed limits, imported raw rules upgrade cleanly.

---

## 9. Phase 6 — Marketplace, free (L)

| Step | Work | Tests |
|---|---|---|
| **6.1** | `PublisherProfile`, listing CRUD, version pinning, cover/screenshot assets. | handle uniqueness |
| **6.2** | Submission pipeline + **auto-checks** job (schema, limits, secrets/PII, URLs, MIME/size, duplicate similarity, quality floor); results stored on the submission. | malicious-blueprint fuzz corpus |
| **6.3** | Moderation console API (platform role): queue, decisions with notes, trust-tier changes, publisher notifications, audit. | role gating |
| **6.4** | Public browse/search: `tsvector` + GIN + trigram, filters/sort/pagination, cache headers, own limiter; listing preview derived from the blueprint (structure only, no comment bodies). | search relevance fixtures; load test |
| **6.5** | **Get** (license + private fork), reviews (apply-gated), reports with auto-flag threshold, **takedown → quarantine propagation** to forks, denormalized counters via queue. | quarantined fork cannot apply; existing workspaces untouched |
| **6.6** | Legal gates: publisher agreement acceptance (version + timestamp), takedown contact. `FEATURE_MARKETPLACE` stays off until legal sign-off. | — |
| **6.7** | Publisher analytics (views, gets, applies, ratings). | — |

**Exit:** abuse suite (XSS in markdown, oversized payloads, secret-laden submissions) passes. → *Security review #4.*

---

## 10. Cross-cutting tracks (run alongside)

- **Observability:** structured logs carrying `traceId`, `jobId`, `importJobId`, `connectionId`; metrics for queue depth/latency, delivery failures, import throughput, provider 429s; alerting on dead-letter growth.
- **Retention sweeps (repeatable jobs):** `IntegrationWebhookEvent` (7 d), expired `OAuthState`, finished `ImportJob` checkpoints, orphaned template assets.
- **Runbooks:** key rotation, provider outage, revoked-connection recovery, import rollback, marketplace takedown.
- **Docs:** keep `docs/design/` diagrams and README current whenever a step changes the design.

---

## 11. Dependencies and parallelism

```
−1 pre-flight → 0 foundations → 1 workflow core ─┬→ 2 chat & links ────────────┐
                                                 ├→ 3 templates core ──────────┼→ 6 marketplace
                                                 └→ 4 importers (needs 3.3/3.4 for import-as-template)
                                    2.6 GitHub rules ─┐
                                    4.x raw rules ────┴→ 5 automations & views → (carried by 3 & 4 afterwards)
```

- Phases 2, 3 and 4 are independent once Phase 1 lands — they can be separate people/branches.
- Phase 6 needs Phase 3; it does **not** need Phase 5, but templates can't ship automations/views until 5.5.

**Suggested first PRs (in order):** −1.1 baseline migration → −1.2 harness → −1.3 characterization tests → −1.4 hygiene → 0.1 Redis → 0.2 queue → 0.5 vault.

---

## 11b. What the dependency graph shows (diagram 20)

The graph is generated from the step table (`gen_deps.py`), so the critical path and waves are computed, not eyeballed. Weights are my relative sizing (S=1, M=2, L=3) — adjust them and re-run.

- **Critical path (weight 37):** pre-flight → Redis → queue → `@PublicSigned` → Gate 0 → task keys → indexes/load test → Gate 1 → blueprint schema → **importer chain** (CanonicalBundle → mapping → executor → Linear → comments/history/attachments → ClickUp → Jira) → automation-rule migration → Gate 5. **Importers are the long pole**, not templates or the marketplace.
- **The importer chain is serial by choice, not by necessity.** ClickUp and Jira both need only the executor (4.4) and shared comment/history/attachment work (4.6) — Jira does not need ClickUp. With two people on importers, 4.7 and 4.8 can run in parallel and the critical path shrinks.
- **Discord can ship before Phase 1 finishes.** 2.1–2.3 need only Gate 0. The Discord adapter (2.4) then waits on **task keys (1.1) alone**, not on subtasks, workflow statuses or issue types. If Discord is the priority, run 1.1 first and Discord right behind it while 1.3–1.6 continue in parallel.
- **The subtask ADR (1.2) has no code dependency.** It only needs the pre-flight ADR, so write and review it *during* Phase 0 (dashed edge) — otherwise 1.3 sits idle waiting on a document.
- **Parallelism:** 17 sequential waves; the widest wave has 7 independent steps, so up to ~7 parallel workstreams are usable at the peak.
- **Gates are the sync points** (hexagons). Nothing crosses a gate until its exit criteria and any security review pass.

---

## 12. Risks to watch while building

- **Phase 1 regressions** — the characterization suite is the safety net; do not merge Phase 1 steps without it.
- **`Task.number` backfill on a large table** — run in batches, off-peak, resumable; verify on a production-sized copy first.
- **Discord bot verification and privileged-intent approvals** apply as the bot grows to many servers — check current Discord policy early, since it can gate distribution.
- **Provider API drift** (rate limits, webhook lifetimes, automation export) — treat fixtures as snapshots and re-validate each adapter against current docs and a sandbox account before release.
- **Attachment copy volume** can dominate cost/time — default to a per-import size cap and a clear "skip attachments" option.
- **Legal:** provider ToS for bulk export, marketplace terms, publisher licence grant and takedown process must be settled before `FEATURE_MARKETPLACE` goes on.

---

## 13. Decisions needed before specific steps

| Needed by | Decision |
|---|---|
| −1.5 | ~~Worker topology · flag mechanism · key uniqueness scope~~ — decided, see [`adr/`](adr/README.md) |
| 1.2 | Subtask semantics (the ADR) — including whether subtasks count toward plan task caps |
| 2.4 / 2.5 | One product-owned Discord/Slack app (recommended) vs bring-your-own-bot |
| 3.3 | `nodeKey` stability rules across template versions (needed later for three-way upgrades) |
| 5.1 | Automation DSL scope for v1 (triggers/actions list above is the proposal) |
| 6.3 | Who staffs the moderation queue and the response-time target |
