# Integrations, Import, Templates & Marketplace — Design Plan

Status: **draft for review** · Based on `backend-v5-recovered.zip` (NestJS + Prisma + Postgres) and the scope decisions from our discussion.
Diagram numbers below refer to the `.d2` files in this bundle (open `diagrams.html` to view them all).

---

## 1. Scope (as decided)

| Area | Decision |
|---|---|
| Importers | **ClickUp, Jira Cloud, Linear** — full workflow, not just tasks |
| Chat / dev integrations | **Discord (priority), Slack, GitHub** — notifications, links, commands |
| Discord v1 | channel notifications · slash commands (create/update) · message/forum post → task · server ↔ workspace/project links |
| Integration depth | import + notifications + links. **No two-way continuous sync in v1** |
| Import fidelity | comments · attachments (copied into our storage, count toward quota) · original created/updated dates · activity history |
| Workflow model | **per-project custom statuses that roll up to the existing 4 `TaskStatus` values** |
| Native models added | subtasks (`Task.parentId`) · sprints/cycles/milestones · issue types · automations · saved views/boards |
| Task keys | per-workspace key + sequence (`ENG-123`) |
| Templates | full workspace → settings → tags → custom fields → projects → tasks → subtasks; relative dates; role placeholders; reference comments + attachments |
| Apply target | new workspace **or** merge into existing (default: new for workspace templates) |
| Marketplace | public, **free only**, data model is paid-ready; payouts deferred |
| Moderation | automated checks + human review for new publishers + report handling (new `platformRole`) |
| Infra | **BullMQ + Redis** (also fixes single-instance SSE) |

---

## 2. Core ideas (the parts that make this hang together)

1. **One portable format, two front doors.** Importers emit a `CanonicalBundle`; templates are a `Blueprint` = the same structure plus variables, roles, modules and relative dates (diagram 15). So *"import a Jira project → save as template"* costs nothing extra, and both go through one validator and one writer.
2. **`DomainWriter` is the only write path** for new modules (diagram 01). It wraps the existing services with a `WriteContext { origin, silent, bulk, keepOriginalDates, importJobId }`. This preserves the invariant from the Snap design (never bypass services, or activity/permissions are skipped) while stopping a 5,000-task import from firing 5,000 notification fan-outs.
3. **Connector adapters with capability flags** (diagram 02): `IMPORT · NOTIFY · COMMANDS · LINKS · WEBHOOKS`. A provider declares what it supports; adding a 7th provider is one file + one enum value.
4. **Workflow rolls up to categories** (diagram 07). `Task.status` stays the 4-value enum (now meaning *category*); `Task.workflowStatusId` (nullable) is the specific status. Progress, fan-out, Snap and permissions keep working and existing data needs no migration.
5. **Nothing is silently dropped.** Every source concept lands on a native model (diagram 06). Anything that can't be translated yet (e.g. an automation rule) is stored disabled with its raw JSON and upgraded later, so it never has to be re-imported.

---

## 3. What the current backend forces us to change

These came from reading the code and are the real critical path:

- **No job queue or scheduler exists.** Several TODOs already wait for one (due-date reminders, account purge, attachment cleanup). BullMQ fixes all of them.
- **SSE registry is single-instance** (README). Moving fan-out to Redis pub/sub is part of Phase 0.
- **`TasksService.create` hardcodes `createdVia: 'MANUAL'`** and records activity + fan-out per task → needs the `WriteContext` refactor and bulk/silent modes.
- **No `TagsService`** (tags exist in the schema but only DTO-level use) → importers and templates need it.
- **`ProcessedWebhookEvent` is keyed on the `PaymentProvider` enum** → integration webhooks need their own dedupe table (`IntegrationWebhookEvent`).
- **No secret encryption utility** → `TokenVault` (AES-256-GCM, key ids for rotation).
- **`Comment.authorId` and `Task.createdById` are required** → unmapped external authors are attributed to the importer with a `Name (via Jira)` prefix; history rows keep the external actor in metadata.
- **Plan limits bite imports.** Free tier has a small task cap per project and a workspace cap; the dry-run must show this *before* anything is written, with "import subset / upgrade" options.
- **No platform-staff concept** → `User.platformRole` for moderation, outside account RBAC.
- **`Task` has no parent, number, issue type, iteration or workflow status** → Phase 1 schema work (diagram 11).

> Verify exact plan numbers in `billing-tiers.config` when implementing; the limits table in diagram 18 is a proposal.

---

## 4. Integrations

Full connect flow: diagram 03. Tokens are encrypted at rest, never returned by any API, refreshed under a per-connection Redis lock (Jira rotates refresh tokens — a race would brick the connection).

| Provider | Role in v1 | Notes (verify against current provider docs when building each adapter) |
|---|---|---|
| **Discord** | notify · commands · message→task · server link | HTTP interactions with Ed25519 verification; ack within 3 s with a deferred response, follow up within 15 min. Forum-post *auto*-creation needs a persistent Gateway worker → later phase; v1 uses a context-menu command on the post. |
| **Slack** | notify · commands · shortcut · unfurl | Signing secret + timestamp window; Block Kit modals. |
| **GitHub** | repo↔project link · PR↔task link · status rules · optional issue import | GitHub App (installation tokens); HMAC + delivery-id dedupe; keys like `ENG-123` parsed from PR title / branch / commits. |
| **Linear** | importer | GraphQL; state types map cleanly to categories. Build first. |
| **ClickUp** | importer | Space→Folder→List→Task; statuses per list; strict rate limits. |
| **Jira Cloud** | importer | OAuth 3LO; descriptions arrive as ADF and need a markdown converter; sprints via Agile API; workflows + status categories. Build last. |

Chat commands always run **as the linked user** (`IdentityLink` → `User`) through the normal `PermissionResolver` — the bot never gets ambient authority (diagram 09). Notifications are routed by `ChannelSubscription` filters with an echo guard so a task created from a Discord message doesn't re-notify the same channel (diagram 08).

---

## 5. Import pipeline

Lifecycle and gates: diagram 04. Worker loop: diagram 05. Mapping tables: diagrams 06 and 07.

- **Steps:** connect → discover sources → select scope → **map** (statuses, priorities, users, fields, types — all auto-suggested and overridable) → **dry-run preview** (counts, warnings, unmapped users, quota + plan impact) → run → report.
- **Run phases:** structure first (statuses, types, iterations, fields, tags) → people → projects → tasks (parents before children) → relations → comments → activity history → attachments (separate queue) → automations/views → finalize.
- **Idempotent and resumable:** `ExternalRef(connection, type, externalId) → localId` + content hash; checkpoints per phase; a failed job resumes instead of restarting.
- **Rollback:** everything an import created is tagged with `importJobId`, so *"undo import"* is a query, not a guess.
- **People:** auto-match by verified email, else manual map, else importer attribution. Importing never invites users or consumes seats silently — inviting unmatched people is an explicit post-import step through the existing invite service.
- **Source keys survive:** `ExternalRef.externalKey` stores `PROJ-42`, so old links and PR references can still be resolved.
- **Attachments are the expensive part:** streamed provider → S3 with quota reserved first (same PENDING pattern as uploads). Preview shows the storage impact.
- **Activity history:** written silent, with original timestamps; external actors live in metadata.

---

## 6. Templates

Lifecycle: diagram 14. Blueprint format: diagram 15. Apply engine: diagram 16.

- **Sources:** save current workspace/project · import-as-template · marketplace "Get" (creates a private fork) · editor/duplicate.
- **Extractor → Sanitizer:** users become **role placeholders**; dates become **offsets from an anchor**; comment authors are anonymized; ids, emails and external refs are stripped; PII + secret + URL scans run; assets are size-capped. The user gets a sanitizer report of everything removed or needing review.
- **Customization:** variables (`{{startDate}}`), roles (`Reviewer`, `Student`), optional modules, plus edit/rename/reorder and version diffs.
- **Versions are immutable** (semver + checksum). Forks keep lineage (`sourceTemplateId`, `sourceVersionId`).
- **Apply:** wizard → dry-run plan → limit/quota preflight → preview → job. **Merge rules:** reuse tags by name and custom fields by `key` (type conflict → skip + warn); always create new projects (rename on clash); never overwrite the workspace's name/icon/description/key. Every apply records `TemplateInstall` + per-entity `TemplateInstallItem`, which powers **undo** and, later, three-way upgrades.
- **Security:** blueprints are untrusted content — strict schema, size/depth limits, substitution only into string/date leaves, **no expression evaluation**, https-only URLs, unknown fields rejected.
- **Free-plan wrinkle:** creating a new workspace can hit the workspace cap → the wizard offers merge instead of failing.

---

## 7. Marketplace

Diagram 17. Data model: diagram 13.

- Public, SEO-friendly browse/search (`@Public()` + throttling, Postgres FTS + trigram first; a search engine later).
- **Get** = grant a license (`TemplateLicense`, FREE) + private fork copy → customization never breaks and takedowns are handled by quarantine, not deletion of your workspace.
- Reviews only after a successful apply; reports feed a moderation queue.
- **Moderation:** automated checks on every version → new publishers go to a human queue → trusted publishers auto-publish with post-hoc review → reports can trigger takedown, which sets `quarantinedAt` on all forks.
- **Paid-ready, not paid:** `pricingModel` accepts only `FREE` in v1; `TemplateLicense.grantedVia`, `priceCents/currency` and a dormant `PayoutProfile` are the hooks.
- **Non-code work this needs:** marketplace terms, publisher licence grant, takedown/DMCA process.

---

## 8. Schema changes at a glance

Existing tables: `Task` (+`parentId`, `number`, `workflowStatusId`, `issueTypeId`, `iterationId`; `createdVia` gains `IMPORT|TEMPLATE|INTEGRATION`), `Workspace` (+`key`, `nextTaskNumber`), `Project` (+`enforceTransitions`), `User` (+`platformRole`), `AuditAction` enum (integration/import/template events).

New: `WorkflowStatus`, `WorkflowTransition`, `IssueType`, `Iteration`, `Automation`, `AutomationRun`, `SavedView`, `ExternalLink` (diagram 11) · `OAuthState`, `IntegrationConnection`, `IntegrationCredential`, `IdentityLink`, `ChannelLink`, `ChannelSubscription`, `IntegrationWebhookEvent`, `NotificationDelivery`, `ExternalRef`, `ImportJob`, `ImportJobIssue` (diagram 12) · `Template`, `TemplateVersion`, `TemplateAsset`, `TemplateInstall`, `TemplateInstallItem`, `PublisherProfile`, `MarketplaceListing`, `ListingSubmission`, `ListingReview`, `ListingReport`, `TemplateLicense`, `PayoutProfile` (dormant) (diagram 13).

`Task.number` backfill: assign numbers per workspace by `createdAt` order in the migration, then enforce `@@unique([workspaceId, number])`.

---

## 9. API surface (sketch)

```
Integrations   GET  /integrations/providers
               POST /integrations/:provider/connect          → { authUrl }
               GET  /integrations/:provider/callback         (@Public, state-bound)
               GET  /accounts/:id/integrations   DELETE /integrations/:id
               POST /webhooks/integrations/:provider         (@Public, signature-verified)
               POST /interactions/slack | /interactions/discord   (@Public, signature-verified)
               PUT  /integrations/:id/channel-links   PUT /channel-links/:id/subscription
Imports        POST /imports   GET /imports/:id/sources   PUT /imports/:id/selection
               PUT  /imports/:id/mapping   POST /imports/:id/preview
               POST /imports/:id/start | /cancel | /resume | /rollback   GET /imports/:id[/report]
Templates      POST /workspaces/:id/export-template
               CRUD /templates   POST /templates/:id/versions | /fork
               POST /templates/:id/apply/preview | /apply    POST /template-installs/:id/undo
Marketplace    GET  /marketplace/listings[?q&category&sort]   GET /marketplace/listings/:slug   (@Public)
               POST /templates/:id/publish   POST /marketplace/listings/:id/get | /review | /report
               (staff) GET/POST /moderation/submissions/:id/decision
Workflow       CRUD /projects/:id/workflow   /workspaces/:id/issue-types | /iterations | /automations | /views
```

---

## 10. Security checklist

- Public routes authenticate by **signature** (HMAC / Ed25519), verify against the **raw body**, use constant-time compare, enforce timestamp windows, and dedupe by delivery id.
- OAuth: PKCE + single-use, short-lived `state` bound to user + account; permission re-checked at callback.
- Tokens: AES-256-GCM with key ids; excluded from every `select`; revocation calls the provider and wipes ciphertext.
- Chat identity: unlinked callers get a link prompt, never anonymous execution; commands are authorized as the linked user.
- Imports/templates: schema-validated, size-capped, no code execution, sanitized markdown at render, https-only URLs.
- Cross-tenant guards: a repo/channel link only ever resolves inside its own workspace.
- Rate limits: per-connection provider buckets outbound; Throttler on all public routes inbound.

---

## 11. Phases

Diagram 19. Sizes are relative (S/M/L), not calendar estimates.

0. **Foundations [M]** — BullMQ/Redis, SSE via pub/sub, TokenVault, `DomainWriter` + `TagsService`, enums, `platformRole`, ACTION_CONFIG/limits.
1. **Workflow core schema [L]** — subtasks, keys + backfill, custom statuses/transitions, issue types, iterations, `ExternalLink`.
2. **Chat & links [L]** — identity linking → **Discord** → Slack → GitHub.
3. **Templates core, private [L]** — blueprint, extractor/sanitizer, applier (new/merge), versions, fork, undo.
4. **Importers [L]** — framework → **Linear** → ClickUp → Jira (+ attachments, history, rollback).
5. **Automations engine + saved views [L]** — until this lands, imported/template automations are stored disabled with raw JSON, then upgraded.
6. **Marketplace, free [L]** — publisher profiles, submissions, moderation, public browse, reviews, quarantine.
7. **Later** — paid templates + payouts, Discord Gateway worker, two-way sync, template three-way upgrades.

Phases 2, 3 and 4 can run in parallel once Phase 1 lands.

---

## 12. Risks and open items

- **Phase 1 is the riskiest change** — subtasks, keys and workflow statuses touch progress calculation, visibility, Snap and every list query. Worth its own design review before coding.
- **Automation engine and saved views** are each a feature-sized build; imports must carry them as raw data until they exist.
- **Provider APIs change** (rate limits, webhook lifetimes, automation export). Re-check current docs per adapter; treat diagram 02 notes as a starting point, not a contract.
- **Attachment volume** can dominate cost and time; consider per-import size caps and a "skip attachments" default for very large sources.
- **Provider terms of service** for bulk export/import and **template licensing/IP** need a legal pass before launch.
- **Moderation staffing** is a product decision, not just code: who is on the queue, and what's the SLA?
- **Paid templates** need a payout route that works for your entity/region before the dormant hooks are switched on.

---

## 13. Diagram index

| # | File | What it shows |
|---|---|---|
| 01 | `01-architecture-overview.d2` | Layered system view: new vs existing modules |
| 02 | `02-connector-framework.d2` | Adapter contract, capabilities, six providers |
| 03 | `03-oauth-connect-sequence.d2` | Connect flow with TokenVault |
| 04 | `04-import-job-lifecycle.d2` | Import state machine + run phases |
| 05 | `05-import-run-dataflow.d2` | One worker chunk, error taxonomy, attachment copy |
| 06 | `06-concept-mapping.d2` | Source concept → native model grid |
| 07 | `07-status-workflow-mapping.d2` | Status + priority mapping |
| 08 | `08-webhooks-and-notifications.d2` | Inbound webhooks, outbound channel notifications |
| 09 | `09-chat-commands-slack-discord.d2` | Slash commands, message→task, identity, linking |
| 10 | `10-github-links-flow.d2` | Repo links, PR↔task keys, status rules |
| 11 | `11-erd-workflow-core.d2` | Task/workflow/iteration/automation/view models |
| 12 | `12-erd-integrations-import.d2` | Connections, identity, channels, import models |
| 13 | `13-erd-templates-marketplace.d2` | Templates, listings, licensing |
| 14 | `14-template-lifecycle.d2` | Source → sanitize → customize → apply → publish |
| 15 | `15-blueprint-anatomy.d2` | Blueprint structure + resolution pipeline |
| 16 | `16-apply-merge-engine.d2` | New vs merge, limits, undo |
| 17 | `17-marketplace.d2` | Moderation state machine, consumer journey, paid hooks |
| 18 | `18-access-and-limits.d2` | New actions and plan limits |
| 19 | `19-rollout-phases.d2` | Phases and dependencies |
| 20 | `20-implementation-dependencies.d2` | Step-level dependency graph: gates, critical path, parallel waves (see `IMPLEMENTATION.md`) |

Render: `./render.sh` (needs the `d2` CLI; uses the ELK layout). Shared styling lives in `_shared.d2`.
