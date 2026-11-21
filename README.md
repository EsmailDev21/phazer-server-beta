# Backend — Foundations + Permission Resolution

## Setup

```bash
cp .env.example .env    # fill in DATABASE_URL and JWT_SECRET at minimum
npm run db:up           # local Postgres via docker compose (matches .env.example)
npm install             # runs `prisma generate` via postinstall
npm run db:migrate:deploy   # apply the committed migrations to your local DB
npm run start:dev
```

Prisma 8 (what a bare `npx prisma` resolves to right now) ships a completely
different CLI with no `generate`/`migrate` commands, so `package.json` pins
`prisma`/`@prisma/client` to exactly `5.22.0`. Always use the project-local
binary (`npm run db:*` / `npx prisma`), never a global install.

## Local services and tests

`docker-compose.yml` provisions everything the project uses locally:

| Service | Port | Purpose |
|---|---|---|
| `db` | 5432 | dev Postgres (`npm run db:up`) |
| `test-db` | 5433 | disposable Postgres for integration tests, tmpfs-backed (`npm run db:test:up`) |
| `redis` | 6379 | BullMQ / SSE pub-sub, from step 0.1 onward |
| `minio` | 9000 / 9001 | S3-compatible storage; point `S3_ENDPOINT` at it (see `.env.example`) |

```bash
TEST_REDIS_URL=redis://localhost:6379 npm test      # unit specs, incl. the real-Redis ones (skipped without the variable)
npm run db:test:up && npm run test:integration   # real Postgres; truncates every table per test
npm run test:e2e
```

Design for the integrations / import / templates / marketplace work, the
build order, and the dependency graph live in [`docs/design/`](docs/design/README.md).

## Database migrations

Schema changes are versioned in `prisma/migrations/`. The rules:


> **Pre-launch relaxation (owner decision, 2026-10).** The app has no live data yet, so rule 3 below
> (expand -> backfill -> contract) is **suspended until launch**: collapse such changes into one migration and
> reset a dev DB rather than preserving rows. Rules 1, 2 and 4 still apply. Rule 3 applies in full again from
> the first real user row; re-enabling it is a launch-checklist item. The full list of what is relaxed lives in
> the project handoff, `START_HERE.md`.

1. **Change `schema.prisma`, then** `npm run db:migrate:dev -- --name <what_changed>`.
   Commit the generated folder together with the schema change.
2. **Never edit a migration that has been merged.** Add a new one.
3. **Expand -> backfill -> contract** for anything that touches existing rows:
   add nullable/defaulted columns first, backfill with an idempotent, resumable
   script, and only then add `NOT NULL` / unique constraints in a *later*
   migration. Never do all three in one deploy.

4. **CI / pre-merge:** `npm run db:verify` fails if the migrations do not
   reproduce `schema.prisma` exactly (it replays the full history into a scratch
   database, so it also proves the history applies cleanly to an empty DB).
5. **Production:** `npm run db:migrate:deploy` only - never `migrate dev`.

### The baseline migration

The recovered project shipped `schema.prisma` without a migration history.
`prisma/migrations/20260101000000_baseline/` fills that gap. Prisma's
schema-engine (needed for `migrate dev`) wasn't reachable in the environment
that authored it, so it was hand-generated from `schema.prisma` and then
verified against a real Postgres instance — see
`prisma/migrations/20260101000000_baseline/README-BASELINE.md` for exactly
what was checked (37/37 tables, 315/315 columns, 50/50 foreign keys, 35/35
enums, plus a functional smoke test) and what wasn't.

**Do this once, when you have normal network access:**

```bash
npm run db:up
npm run db:migrate:deploy   # apply the baseline to your local DB
npm run db:verify           # ask Prisma's real schema-engine to confirm it
```

If `db:verify` ever disagrees with the baseline, trust `db:verify` — open an
issue with its output. `scripts/create-baseline.sh` remains available (and
will refuse to run) in case the migration history ever needs to be
regenerated from scratch.

## Type-checking without Prisma's engine binaries

`prisma generate` normally downloads engine binaries from `binaries.prisma.sh`.
On networks that block that (sandboxes, some CI), types can still be generated:

```bash
npm run typecheck:offline   # validate schema + generate types (--no-engine) + tsc
```

This gives a real compile check (types only - no DB access, no runtime). It is
what caught `ActivityAction.REACTED` missing from the schema and `TokenPair`
not being exported: the earlier note here that the only type errors were the
"no generated client" cascade was wrong; those two were hidden underneath it.

## What's built

**Foundations**
- `PrismaModule`/`PrismaService` (global)
- `PaginationDto` — shared `take`/`skip` (Rule 3)
- `AllExceptionsFilter` — single global filter, fixed error envelope, Prisma error mapping
- `UserEntity` + global `ClassSerializerInterceptor` — `@Exclude()` on `password` (Rule 4)
- `WebhookIdempotencyService` — generic helper over `ProcessedWebhookEvent` for future webhook handlers
- `HealthModule` — `GET /health` via Terminus + a Prisma `SELECT 1` check
- `AuthModule` — JWT strategy (minimal `{userId, email}` payload, no nested fetch), global `JwtAuthGuard` with `@Public()` opt-out, register/login/refresh/logout/verify-email/resend-verification/Google OAuth (scaffolded)/`me`
- `main.ts` — fails fast before `NestFactory.create()` if `JWT_SECRET` or `DATABASE_URL` is unset, helmet, compression, global `ValidationPipe` (whitelist + forbidNonWhitelisted + transform)
- `ThrottlerModule` — 100 req/min/IP default; `/auth/login`, `/auth/register`, `/auth/refresh` overridden to 5 req/min/IP

**Permission Resolution**
- `ACTION_CONFIG` — all 34 actions from the graph, with scopes/ownershipField/planLimit/minRole
- `ROLE_PERMISSIONS` (Role: OWNER/ADMIN/MEMBER/VIEWER/CLIENT) and `COLLABORATOR_ROLE_PERMISSIONS` (CollaboratorRole: CONTRIBUTOR/COMMENTER/VIEWER) matrices
- `PermissionResolver.resolve()` — the 9-step algorithm: target resolution (incl. multi-hop for Comment/Attachment/ShareLink) → Tier1 ProjectMember → Tier2 WorkspaceCollaborator/team access → Tier3 AccountMember/personal owner → baseline lookup → additive overrides → ownership grant → (planLimit skipped, see below)
- `AccessControlGuard` + `@RequireAccess(action, options?)` — global guard, no-op on routes without the decorator
- `POST /access-control/check` — same resolver, for frontend UI gating

## Decisions made per your earlier answers

1. **BillingService / planLimit (step 8):** skipped entirely, marked with `TODO` comments in `access-control.types.ts` and `access-control.service.ts`. Nothing calls a Billing service anywhere yet.
2. **JWT lifetimes:** access token 15m, refresh token 30d.
3. **Email verification / Google OAuth:** `EmailService` logs the verification link instead of sending it. `GoogleStrategy` reads `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`GOOGLE_CALLBACK_URL` from env and is only registered if both are set — otherwise `/auth/google*` 404s with a boot-time warning logged, rather than crashing.

## Deviations from the graphs (schema took precedence, as instructed)

- **RefreshToken rotation:** the graph mentions a "replacedBy chain," but `schema.prisma`'s `RefreshToken` model has no `replacedBy` column. Rotation is implemented as revoke-old + insert-new instead — same one-time-use guarantee, no linked-list pointer.
- **Tier 2 scope extension:** the algorithm text names only `WorkspaceCollaborator` (personal) and `WorkspaceTeamAccess` (org) for Tier 2. I added `WorkspaceGuest` to Tier 2 for organization accounts, since its own schema comment describes it as the org-side individual analogue of `WorkspaceCollaborator` — the algorithm just doesn't call it out explicitly.
- **Attachment/ShareLink multi-hop resolution:** the graph only spells out the Comment 2-hop case ("only comments whose own target is TASK or PROJECT support this"). `deleteFile` (scope: attachment) and `revokeShareLink` (scope: task/project, ownership on the ShareLink itself) need the same treatment since Attachment and ShareLink are equally polymorphic, so I extended the same pattern to both and added `ATTACHMENT` and `SHARE_LINK` as resolvable target types.
- **`ROLE_PERMISSIONS`/`COLLABORATOR_ROLE_PERMISSIONS` matrix cell values:** the graph gives prose per role ("MEMBER: create/edit own+assigned tasks... no delete on others' work"), not a literal cell-by-cell table for all 34 actions × 5 roles × 3 collaborator roles. I filled in every cell consistently with that prose and with the `ownershipField`/`minRole` annotations in `ACTION_CONFIG`. Worth a review pass against your intent, especially the less-obvious ones (`archiveProject`, `archiveTask`, `assignTask` for MEMBER).

## Not built yet (per your instructions)

No further domain modules — Projects/Tasks, Comments/Attachments, Activity/Notifications, Billing, Snap. Send those next in the dependency order they were designed.

---

## Tenancy Module (Account, Workspace, Team, Invite)

### Schema additions (ground truth altered per your explicit approval, not guessed)

- **`Account.deletedAt DateTime?`** — the graph's `DELETE /accounts/:id` requires soft-delete; the original schema had no field for it. Added additively with an index. No scheduled purge job exists yet (no job scheduler in this codebase) — the 30-day hard-delete sweep is a documented TODO, not implemented.
- **`Invite.collaboratorRole CollaboratorRole?`** — `Invite.role` is typed `Role`, but accepting a WORKSPACE-target invite creates a `WorkspaceCollaborator`/`WorkspaceGuest`, both typed `CollaboratorRole` (a genuinely different enum — only `VIEWER` overlaps by name). Added this nullable field as the authoritative role for WORKSPACE-target invites; `role` is a required-but-unused placeholder (`VIEWER`) on those rows. `CreateInviteDto` validates `role` XOR `collaboratorRole` based on `targetType`.

### Permission engine extensions (approved)

- Added `TEAM` as a resolvable `TargetType` (resolves straight to its `Account` — Teams have no workspace/project of their own).
- Added `editTeam`, `deleteTeam`, `manageTeamMembers` actions — same OWNER/ADMIN-only profile as `createTeam` — since Team CRUD/membership wasn't in the original 34 actions.

### Reused actions where no dedicated one exists (documented, not asked — pattern already established)

- `GET /accounts/:id/members`, `GET /accounts/:id/workspaces`, `GET /accounts/:id/teams` → `viewAccount` (list visibility tracks account visibility).
- `GET /workspaces/:id`, `GET /workspaces/:id/members` → `viewActivity` (workspace-scoped, already excludes CLIENT — matches "a project-scoped CLIENT shouldn't see the workspace shell").
- `GET /teams/:id`, `GET /teams/:id/members` → `editTeam` (view bundled with edit; Teams are OWNER/ADMIN-structural entities per the graph, and a 4th new action wasn't part of what was approved).
- `GET`/`POST`/`DELETE /workspaces/:id/collaborators` (and `/guests`) → `manageWorkspaceCollaborators`/`manageWorkspaceGuests` for all three verbs, not just the writes.
- PROJECT-target invites (`POST /invites` with `targetType: PROJECT`) → permission-checked against `editProject` as a placeholder, since ProjectMember management doesn't have its own action yet and that table is owned by the not-yet-built Project/Task module. Revisit when that module lands.

### Other notable decisions

- `DELETE /invites/cleanup/expired` has no per-resource target (it's a global sweep), so it doesn't use `@RequireAccess`/PermissionResolver at all — `InvitesService.cleanupExpired()` instead requires the caller to be OWNER/ADMIN on at least one `AccountMember` row, or the personal owner of an account.
- `POST /invites` has no `@RequireAccess` decorator — the correct action depends on `targetType` (and, for WORKSPACE, the target account's type), which is only known at request time. `InvitesService` calls `PermissionResolver.resolve()` directly instead.
- `PATCH /accounts/:id` folds Organization name/logo in as described (`Organization.upsert`), 400s if `name`/`logo` are sent for a PERSONAL account.
- Workspace deletion relies on Prisma's cascading `onDelete: Cascade` chain rather than manual cleanup — confirm that's sufficient once the Project/Task module's tables are in play.

---

## Projects/Tasks Module

### The one real design decision: TaskVisibilityService

The graph described this service as "confirmed good in the old audit, preserve as-is" — but this is a from-scratch rebuild, so there was no prior implementation to preserve. Confirmed explicitly with you before building:

- A user with genuine **workspace-level** access (Tier2 `WorkspaceCollaborator`/`WorkspaceGuest`/team-access, or Tier3 `AccountMember`/personal owner) sees **all** tasks in the workspace, regardless of assignment.
- A user whose **only** access is one or more `ProjectMember` (Tier1) rows — no workspace-level tier at all — sees **only** tasks in the project(s) they're a member of. This applies to **any** Tier1-only role, not just CLIENT (confirmed via the "Sarah" example: a Tier1-only MEMBER is scoped exactly like CLIENT).
- Inbox tasks (`projectId === null`) are only visible to workspace-level users — a Tier1-only ProjectMember has no route to them.
- **Documented assumption, left to my judgment per your answer:** no additional team-based task filtering beyond what workspace-tier access already implies via `WorkspaceTeamAccess`/`TeamMember`. The schema has no per-task or per-project Team link (`Task.assignees` is `User[]`, not `Team[]`), so "team-scoped visibility" in the graph is read as describing *how* org users obtain their workspace tier, not a separate per-task team filter. Revisit if that's wrong.

This is implemented as `PermissionResolver.hasWorkspaceLevelAccess()`/`hasProjectLevelAccess()` (new methods — "CAN you see into this workspace/project at all," deliberately independent of the named-action boolean matrix, since CLIENT is `false` for nearly every action by design) plus `TaskVisibilityService` (the "WHICH tasks" layer on top). `GET /tasks`, `GET /tasks/:id`, `GET /tasks/:id/table-row`, `GET /projects/:id`, `GET /projects/:id/stats`, and `GET /projects/:id/members` are all gated this way instead of `@RequireAccess`, since no single named action both has a real per-role boolean and returns `true` for CLIENT.

### Other notable decisions

- **Progress formula:** `DONE / total non-archived tasks * 100`, rounded, `0` when there are no tasks. Not specified precisely in the graph — implemented via `groupBy`, computed at read time (never stored), reused by both `getStats` and the list/detail `progress` field.
- **Table view `blocked` boolean:** `true` if the task has any `BLOCKS` dependency where the blocking task isn't `DONE` yet (not merely "has a dependency defined").
- **Project detail `recentActivity`:** queries the `Activity` table (`targetType: PROJECT`, last 5, `visibility: TIMELINE`) — but nothing writes to `Activity` yet (that module isn't built), so this will return empty until it exists. Revisit whether project activity should also include child-task activity once the Activity/Notifications module lands.
- **Custom field value validation:** `TaskCustomValuesController`/`CustomFieldsService.setValue` validates the value's shape against `field.dataType` (string/number/boolean/ISO-date/one-of-options/subset-of-options) before every write, per `PT__CF__VALUE_VALIDATION`.
- **`PATCH /custom-fields/:id` and `DELETE /custom-fields/:id`** don't use `@RequireAccess` — the route's `:id` is the field's own id, not a workspace id, so the decorator's auto-extraction would resolve the wrong resource. `CustomFieldsService` resolves the field's `workspaceId` first, then calls `PermissionResolver.resolve()` manually (same pattern as `InvitesService`'s dynamic checks).
- Dependency cycle detection only runs for `type: BLOCKS` (walks the `blockedTaskId`'s existing BLOCKS chain) — `RELATES_TO` isn't a blocking relationship, so no cycle risk there.
- `setAssignees` is a full replace (`{ set: [...] }`), not a union — matches the graph's explicit fix for the old add-only bug.

---

## Attachments Module

### Real bugs found and fixed while building this (unrelated to Attachments directly, but blocking)

- **`Account.planType` was never set anywhere.** The schema comment says it should be set explicitly at creation (`FREE_PERSONAL`/`FREE_ORG`), but neither `AuthService.register`/`findOrCreateGoogleUser` nor `AccountsService.createOrganization` ever did it — every account had `planType: null` forever. This directly blocked the storage-tier lookup this module needs, so it's fixed now: `FREE_PERSONAL` on every PERSONAL account, `FREE_ORG` on every ORGANIZATION account, set at creation.
- **`getStorageLimits()` falls back to the most restrictive tier (`FREE_PERSONAL`)** for any account somehow still missing a `planType` (pre-fix accounts, or any future edge case), rather than throwing or silently allowing unlimited storage.

### Architecture

- **`BILLING_TIERS`** (`src/common/config/billing-tiers.config.ts`) is new — the graph assumes a config object already existing from Billing (which isn't built) holding workspace/project/task/seat limits too. **Deliberately narrow**: only `storageGB`/`maxFileSizeBytes` per `PlanKey` are defined, since that's the only thing any enforcement code actually reads. The numbers themselves are **placeholders** — no real pricing decision was made, they exist so storage enforcement has something real to check against. Replace when the actual Billing module/pricing page defines real tiers. `PermissionResolver` step 8 (`planLimit`) remains a no-op for `member`/`workspace`/`project`/`task` — only `storage` is now actually enforced, and it's enforced **inside `AttachmentsService` directly, not through the generic engine** (the engine's step 8 was always meant to be a placeholder hook, not itself the enforcement mechanism).
- **`PlanLimitExceededException`** (402 Payment Required) — deliberately distinct from 403. A 403 means "no permission"; 402 means "you have permission, your quota is exhausted" — an actionable-by-upgrading condition the frontend should render differently (e.g. an upgrade prompt).
- **`StorageProvider` interface + `S3StorageProvider`** — works against real AWS S3, Cloudflare R2, or self-hosted MinIO by setting/omitting `S3_ENDPOINT`. New env vars: `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`.
- **The two-phase upload flow**: `POST /files/upload-url` creates a `PENDING` `Attachment` row and returns a presigned PUT URL (15min expiry) the client uploads directly to — bytes never touch the app server. `POST /files/:id/confirm` (ownership-only check, not a full permission re-check) flips it to `CONFIRMED` and is the **only** place `ATTACHMENT_ADDED` fires — an abandoned, never-confirmed upload never appears in the target's Activity feed.
- **Storage accounting counts `CONFIRMED` + not-yet-expired `PENDING`** (a 24h reservation window), not `CONFIRMED` alone — otherwise a burst of concurrent upload-url requests could all pass the limit check simultaneously (none confirmed yet), then all confirm together and blow past it.
- **`cleanupAbandoned()`** (purges `PENDING` rows older than 24h) is a complete, callable implementation, **not wired to an actual scheduler** — no job scheduler exists in this codebase, same constraint as `DueDateReminderService` and the Tenancy module's account-purge job.
- **No `@RequireAccess` on `POST /files/upload-url`, `GET /files`, or `GET /files/:id/download-url`** — upload has three valid target scopes (only one known per-request, same pattern as `createComment`), and the two reads are visibility-gated (CLIENT-inclusive), not permission-gated, same established pattern as `GET /tasks`/`GET /projects/:id`/`GET /comments`. `DELETE /files/:id` **does** use `@RequireAccess('deleteFile')` normally — it's single-scope (`ATTACHMENT`) and was already fully wired in the original Permission Resolution module, including the COMMENT-must-target-TASK/PROJECT multi-hop restriction this graph also calls for. No permission-engine changes were needed for delete at all.
- **20 req/min/IP throttle** on `POST /files/upload-url` only, per the graph's explicit rate limit.

---

## Collaboration + Activity/Notifications Modules

### Schema addition (approved)

`NotificationType` had no matching value for 10 of the 17 `ActivityAction`s the fan-out algorithm groups into its "assignees + creator" recipient bucket (only `STATUS_CHANGED` had one). Per your explicit choice, added one distinct value per action rather than a generic `TASK_UPDATED`: `TASK_CREATED`, `PRIORITY_CHANGED`, `DUE_DATE_CHANGED`, `DESCRIPTION_UPDATED`, `TASK_ARCHIVED`, `TASK_RESTORED`, `DEPENDENCY_ADDED`, `DEPENDENCY_REMOVED`, `ATTACHMENT_ADDED`, `TASK_UNASSIGNED`.

### Architecture

- **`EventsModule`** (new, `@Global`): houses `ActivityService`/`AuditLogService` and the single `EventEmitterModule.forRoot()` call. Pulled out of `ActivityNotificationsModule` specifically to avoid a circular dependency — `ActivitiesService` needs `TaskVisibilityService` (from Projects/Tasks), while `TasksService`/`ProjectsService` need to emit activity events, and Tenancy services need to emit audit-log events. Being global sidesteps it: any module can inject `ActivityService`/`AuditLogService`/`EventEmitter2` without listing `EventsModule` in its own `imports`.
- **Async fan-out trigger**: `ActivityService.record()`/`AuditLogService.record()` await the INSERT (so the row exists before the response returns) but do **not** await the emitted event's listener (`FanoutService`) — `EventEmitter2.emit()` runs the listener synchronously up to its first `await`, then returns control immediately. No job queue exists in this codebase (same constraint as the rest of the project), so this is the closest approximation of "asynchronously, after commit" available.
- **`FanoutService`** implements the full recipient-resolution algorithm per action: the generic assignees+creator bucket, `ASSIGNED`/`UNASSIGNED` (single recipient via `metadata.assigneeId`), `COMMENTED` (creator + assignees + prior distinct commenters + watchers, with mentions split out to `MENTIONED`), `REACTED` (comment author only), and the separate `AuditLog` fan-out (`OWNER`/`ADMIN` `AccountMember`s only). `EXCLUDE_ACTOR` is applied unconditionally everywhere, including a no-op when `actorId` is `null` (system-generated events like due-date reminders).
- **Retrofit**: `TasksService`/`ProjectsService` now call `ActivityService.record()` on every mutation (create, status/priority/due-date/description changes — diffed per-field, one Activity row each — archive/restore, assign/unassign, dependency add/remove). `AccountsService`/`TeamsService`/`InvitesService` now call `AuditLogService.record()` on role changes, member removal, org settings edits, team creation, and account-join-via-invite. Without this the Activity/AuditLog tables would stay permanently empty despite all the fan-out machinery existing — flagged as a gap in the Projects/Tasks module's README section, now closed.
- **SSE** (`GET /notifications/stream`): a real `@Sse()` endpoint backed by an in-memory `Map<userId, Set<Subject>>` registry — single-instance only, as the graph flagged; scaling to multiple instances would need Redis pub/sub, not built. The REST `Notification` table is always the source of truth; SSE is a best-effort push, never relied on for correctness.
- **Real bug caught and fixed**: SSE requires cookie-based auth (`EventSource` can't set custom headers), but `JwtStrategy` only ever read the `Authorization` header. Extended it to also check the `accessToken` httpOnly cookie, and extended `login`/`register`/`refresh` to set that cookie too (previously only the Google OAuth callback did) — otherwise SSE would have silently only worked for users who signed in via Google.
- **`DueDateReminderService.scanAndNotify()`** is a complete, callable implementation (writes `DUE_DATE_APPROACHING` activities with `actorId: null` for tasks due within N hours) but isn't wired to an actual scheduler — none exists in this codebase (same "no job scheduler" constraint as the Tenancy module's account-purge job). Calling it more than once per task/day would currently double-notify; add a dedup check when a scheduler is introduced.

### Collaboration specifics

- Extended `PermissionResolver` with `ACTIVITY` as a resolvable target type (resolves via `Activity.workspaceId`, no multi-hop through the activity's own target) and a new `reactToTarget` action (`COMMENT|ACTIVITY` scopes) — the old `reactToComment` is left in place, unused, rather than removed.
- `createComment`'s scopes widened from `TASK|PROJECT` to `TASK|PROJECT|ACTIVITY`.
- **`POST /comments` and `POST /reactions` have no `@RequireAccess` decorator** — `targetType` (and thus which scope applies) is only known at request time, so the static decorator can't infer it. Both services call `PermissionResolver.resolve()` manually instead, same pattern as `InvitesService`/`CustomFieldsService`.
- **Real bug caught and fixed**: the graph's DTO spec says `@IsUUID()` on `parentCommentId`, but every id in this schema is a `cuid()`, not a UUID — that validator would have rejected every real comment id and silently broken nested replies. Switched to `@IsString()`.
- The `ACTIVITY`-target terminal case (commenting/reacting directly on a feed item) is genuinely terminal — no new `Activity` row, straight to a `Notification` for the original activity's `actorId`. If that `actorId` is `null` (system-generated source) or equals the actor, it's skipped — not an error; the comment/reaction itself still succeeds.
- `canEdit`/`canDelete` are precomputed per comment row via two `PermissionResolver.resolve()` calls each — an accepted N+1-per-list-fetch cost, as specified, rather than making the frontend call `/access-control/check` per rendered comment.
- Mentions are explicit (`mentionedUserIds` in the request body), not parsed from comment text — no mention syntax was specified in the graph, and text-parsing would be a much larger, riskier feature to invent unprompted.

