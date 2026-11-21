# Blueprint v1 (step 3.1)

The portable, **untrusted** document templates are stored as (diagram 15). Code: `src/templates/blueprint/`.
Schema as JSON: `blueprint-v1.schema.json` (a unit test fails if it drifts from `blueprint.schema.ts`).

## Pipeline: `validateBlueprint(input)` / `parseBlueprintJson(text)`
JSON guard (plain JSON only, depth <= 20, clean text, no `__proto__`) -> size <= 2 MiB -> version migration hook ->
JSON Schema (ajv strict, every object closed) -> node limit (<= 5000 projects+tasks+iterations) -> semantic rules.
Each stage runs only if the previous passed. Result: `{ok:true, blueprint, stats, warnings, migratedFrom}` or
`{ok:false, issues:[{code,path(JSON pointer),message}], truncated}` (max 100 issues; `code` is stable).

## Shape (see `blueprint.types.ts`)
`schemaVersion, meta{name,kind WORKSPACE|PROJECT,...}, dateAnchor{variable?,skipWeekends?}, variables[], roles[], modules[],
workspace{name,key,icon,description,tags,customFields,issueTypes,iterations}, projects[{nodeKey,name,workflow,tasks(tree),dependencies,automations,views}], assets[], extensions{}`.

## Rules beyond the schema
- One `nodeKey` namespace for projects, tasks and iterations. Refs must resolve: tags/issue types by normalised name (same
  folding the DB uses), statuses by local `key`, roles, assets, iterations (workspace-wide or the task's own project).
- Placeholders `{{var}}`, `{{slug(v)}}`, `{{addDays(dateVar, n)}}`, `{{format(dateVar, "MMM d")}}` only in: workspace
  name/description, project name/description, task title/description, comment body, iteration name/goal. Everywhere else a
  well-formed placeholder is an **error**. `\{{` is a literal. No nesting, operators, property access. 3.1 only parses and
  statically checks (`blueprint.expressions.ts` AST); **3.2 evaluates** by walking that AST.
- Workflow = ADR-0006 (To Do/In Progress/Done present, one default per category, `excludeFromProgress` Done only, <=30,
  enforced transitions need >=1). Dependencies: same project, no self/duplicate, BLOCKS acyclic.
- Custom values: typed per field; DATE = `{offsetDays}`; URL https only, no credentials; USER values never.
- Task nesting = ADR-0005 (3 levels). `automations`/`views` are opaque JSON, carried and ignored until 5.5.
- `blueprintChecksum()` = sha256 of canonical JSON (sorted keys, array order kept) for TemplateVersion (3.5).

## Deviations from diagram 15 (please confirm)
1. **Depth**: diagram says depth <= 6; v1 enforces the real limit, 3 task levels (ADR-0005), so apply can never refuse it.
2. **No `color` on tags or projects, no `required` on custom fields**: those columns do not exist. Add with a v2 migration if the DB grows them.
3. **No `meta.counts`**: derived by `computeBlueprintStats()` instead (nothing to keep in sync).
4. Strict key patterns: custom field keys `[A-Za-z0-9._-]{1,80}` (stricter than the app), so extractor 3.3 must slug odd keys.
5. Assets limits (10 MiB each, 50 MiB total, 50 files) are **proposals for 3.7**.

## Not done here, on purpose
- **TEMPLATE access-control stub** (PROGRESS 0.10 says 3.1 swaps it): there is no `Template` table until 3.5, so it moves to 3.5 with `registerCounter('template')`.
- nodeKey stability rules across versions (IMPLEMENTATION s13, needed by 3.3).
- `migratedFrom` success path is only tested at hook level (no v2 schema exists to accept a migrated doc).

## Resolution (step 3.2): `resolveBlueprint(blueprint, {variables, modules, roles, eligibleUserIds, today})`
Pure (`src/templates/resolve/`): validate -> variable values -> expand modules -> render text + resolve dates -> roles.
- **Variables** are strict: no coercion, unknown names rejected, TEXT is one clean line (<=500). Unset optional variable renders `""`;
  a helper on an unset DATE is an error. Substitution is **single pass**: a value that looks like `{{x}}` stays literal.
  Resolved text is re-checked (blank / too long / line break) with paths into the ORIGINAL document.
- **Dates**: calendar days in UTC, anchor = the `dateAnchor` variable, else the injected `today`. `skipWeekends` moves Sat/Sun
  FORWARD to Monday (monotone, so start <= due survives). Placeholder `addDays()` is plain calendar math and does not skip.
  Range 1900-2200; leaving it is an error. Output is `"YYYY-MM-DD"` strings (applier converts).
- **Modules**: a task includes its subtree; a node is governed by every module including it or an ancestor; kept if it has no
  governor or ANY governor is enabled (union), never if an ancestor was dropped. Then dependencies with a dropped end, project-scoped
  iterations of dropped projects and assets no kept task uses are removed (reported in `dropped`).
- **Roles**: MEMBER (must be in `eligibleUserIds`), INVITE (email, max 20 per apply, nothing sent), UNASSIGNED (default). Grants no access.

## Extraction (step 3.3): `TemplateExtractionService.extract(workspaceId, {projectId?, includeComments?, includeAttachments?, includeArchived?})`
Read-only; authorization is the caller's. Pure core `buildRawBlueprint(snapshot, options)` + a thin Prisma loader. Output is a **RAW**
blueprint (user ids, absolute dates, comment authors/timestamps, `source` ids): **not storable or shareable until the sanitizer (3.4)**
turns users into roles, dates into offsets and strips ids.
- **nodeKey rule (decided here)**: tasks = `t<number>` (the workspace task number is permanent, ADR-0004: stable across rename/move/re-extract);
  projects `p-<slug>`, iterations `i-<slug>` (clash -> `-2`, `-3`); statuses/assets local keys. Never an id or a timestamp. Projects/iterations
  change key on rename; stability across template VERSIONS is the editor's job (3.8).
- Deterministic: any row order gives the same bytes (25 shuffles tested). Whole-workspace -> WORKSPACE kind; one project -> PROJECT kind with only the tags/fields/types/iterations its tasks use.
- Left out and **reported** (`ExtractionReport`): Inbox tasks (a blueprint task lives in a project), archived tasks and their orphaned children,
  dependencies leaving the project or touching a skipped task, unconfirmed attachments, comment threading (replies flattened), custom-field keys rewritten to the blueprint key format.
- Attachments extract metadata only (no sha256: the bytes are copied in 3.7). Refuses > 5000 tasks before loading them.

## Sanitization (step 3.4): `sanitize(raw, {anchorDate?, onSecret?, assetHashes?})`
Pure. RAW blueprint -> a **validated** BlueprintV1, or a refusal (`SECRETS_FOUND` / `INVALID`). Nothing is "repaired" silently: the output is run through `validateBlueprint`.
- **People**: every distinct assignee becomes a role `person-N` ("Person N"), by first appearance; max 10 per task, 30 per template (extras unassigned + reported).
  Comment authors are dropped (comments anonymous). USER custom-field values dropped (the field definition stays).
- **Dates**: offsets from the earliest date found (or `anchorDate`); a required DATE variable `startDate` is added and set as `dateAnchor`. Dates > 10 years from the anchor are dropped.
  Round trip is tested: extract -> sanitize -> resolve with the same start date returns the original dates exactly. Weekday relationships only hold if the applier picks a start on the same weekday.
- **Text scanning** (every string, fixed order): control chars -> **credentials** -> URLs -> PII -> database ids -> high-entropy tokens -> advisory -> `{{` neutralised.
  - Credentials (AWS/GitHub/GitLab/Slack/Stripe/Google/npm/JWT/sk-/bearer/private keys/URL+DB passwords/`password: value`): **block** the export (`onSecret:'block'`, default) or remove and continue (`'redact'`, the exporter's explicit choice). Entropy-only hits never block: removed + flagged.
  - PII removed: emails, phones, payment cards (Luhn + card shape), SSN-shaped numbers, private IPs. Public-looking IPs, `@handles`, other-task keys (`ENG-12`) are flagged, not changed.
  - Links: `javascript:`/`data:`/`file:`/`http:` and internal hosts removed; links to private trackers/docs (Jira, GitHub issues/PRs, Slack, Notion, Linear, Google Docs, Figma...) removed; other https links kept and listed by host for review.
  - **Report never contains matched text** (kind, rule label, path, count only); tested against every sensitive literal.
- **Assets** are kept only with a sha256 supplied by the asset step (3.7, below); executables/installers, over-size files and path-bearing names are dropped. The deny lists now live in `assets/asset.policy.ts`, shared with the asset store.
- **KNOWN LIMITS**: names/addresses are not detectable and are not scanned; a 32/40/64-hex string is treated as a hash; low-entropy passwords outside `password: ...` forms are missed; unusual phone formats may be partly redacted.
  This is a safety net for accidents, not a guarantee: the exporter still reviews the report, and marketplace publishing (Phase 6) adds a human review.

## Storage (step 3.5): `Template` + `TemplateVersion`
Migration `20260620000000_step_3_5_templates` (hand-written SQL, like the others). `TemplatesService`, `TemplatesController` (404 while `FEATURE_TEMPLATES` is off), `TemplatesModule` (registers the `'template'` plan-limit counter).
- **A version is immutable in the database, not by convention**: a trigger refuses any `UPDATE`, and refuses a direct `DELETE` (only the cascade from deleting its template passes, via `pg_trigger_depth()`). Changing a template = a new version. The envelope (name, description, category, tags, visibility) stays editable.
- Each version stores the canonical blueprint (JSONB), `checksum` (sha256 of canonical JSON, verified to survive the JSONB round trip), `stats`, `sizeBytes`, `schemaVersion`, `semver` + `sequence` (gapless under concurrency, per-template advisory lock), changelog. CHECK constraints pin the shape (semver, checksum format, 2..2 MiB, sequence >= 1, name/description/category/tags limits).
- **Visibility**: `PRIVATE` | `ACCOUNT` (UNLISTED/PUBLIC come with the marketplace, Phase 6). Read = creator, account OWNER/ADMIN, or (`ACCOUNT`) account MEMBERs - and only current account members. An unreadable template answers **404**, identical to a missing one.
- **Permissions**: `createTemplate` (MEMBER+, plan limit), `editTemplate` / `deleteTemplate` (ADMIN+ or the creator; the resolver's `TEMPLATE` stub from 0.10 now loads the template). `exportWorkspaceTemplate` for the export route.
- **Plan limit** `template` = templates owned by the ACCOUNT (account-total), re-checked inside the create transaction under a per-account advisory lock (8 racing creates on a 3-template plan make exactly 3). Forks and exports count.
- **Fork**: a private copy in the same account (cross-account needs the marketplace), same blueprint and checksum, `sourceTemplateId`/`sourceVersionId` set; both become NULL if the source is deleted (the fork is self-contained). `lineage()` hides ancestors the caller cannot read.
- **Delete is a hard delete** (versions cascade). Step 3.6's install records must therefore reference versions with `ON DELETE SET NULL`.
- **Routes**: `POST/GET accounts/:id/templates`, `POST workspaces/:id/export-template`, `GET/PATCH/DELETE templates/:id`, `GET/POST templates/:id/versions`, `GET templates/:id/versions/latest|:sequence`, `POST templates/:id/fork`, `GET templates/:id/lineage`.
- **Body size**: Express's default JSON limit (100 kb) applies, so uploading a blueprint over the API is capped at ~100 kb until the app-wide limit is raised. The export route builds the blueprint server-side and is unaffected. DECISION NEEDED (default: leave as is).

## Applying (step 3.6): `TemplateApplyService`
Routes: `POST templates/:id/apply/preview` (dry run), `POST templates/:id/apply`, `GET workspaces/:id/template-installs`, `GET template-installs/:id`, `GET template-installs/:id/undo-preview[?confirmEdited=true]`, `POST template-installs/:id/undo`. Needs `applyTemplate` on the workspace (MEMBER+); undo needs `editWorkspace` (ADMIN+).
- **"New workspace" = create the workspace first (`createWorkspace`: limit + key), then apply into it** (action-config.ts, step 0.10). `mode: 'NEW_WORKSPACE'` only asserts the target is empty. On a plan at its workspace cap you merge into the existing workspace.
- **Pipeline**: resolve (3.2) with the person's answers -> plan (pure merge rules + limit preflight; the preview IS this plan) -> blockers refuse -> execute -> record -> one `TEMPLATE_APPLIED` audit entry.
- **Merge rules**: tags/issue types reused by name, custom fields by key (a type conflict skips the field and drops its values), projects always new (`Name (2)` on a clash), iterations always new; the workspace's name/key/icon/description are never touched. Existing data is never modified.
- **Execution is CHUNKED, not one transaction** (ADR-0003/0004): a task write holds the workspace task-number row lock for its whole transaction, so one transaction for thousands of tasks would freeze every other task write in a live workspace. Tx 1 = tags, fields, types, projects (+custom workflow via `ProjectsService.create` extras), iterations; then tasks 100 per transaction, parents first, through `DomainWriter.createTasksBulk` (`origin: TEMPLATE`, `importJobId` = install id); then tags/values/comments per slice; then dependencies. 4 990 tasks: apply ~6.8 s, undo ~0.8 s (sandbox Postgres), while 25 concurrent task creates by other users completed with gapless numbers.
- **Failure**: everything created so far is compensated (deleted by the same code as undo), the install is marked FAILED with `compensated: true`, the workspace is as it was. At most ONE apply runs per workspace (partial unique index; the second gets `APPLY_IN_PROGRESS`).
- **Install record**: `TemplateInstall` (snapshots of template name/semver/checksum, answers, status, report; `versionId` is SET NULL when the template is deleted) + one `TemplateInstallItem` per created/reused/skipped entity.
- **Undo** deletes what the install CREATED and nobody else depends on, per entity: untouched -> deleted; **edited** since (`updatedAt` after the apply) -> deleted only with `confirmEdited`; **in use** (a task with the user's own subtasks/comments/attachments, a project holding tasks that are not the template's, a tag/field/type/iteration a remaining task uses, any ancestor of a kept task) -> NEVER deleted, even with confirmation. REUSED/SKIPPED items are never touched. One transaction; the preview runs the same code and rolls back. Fully undone -> status UNDONE; otherwise the install stays APPLIED and can be undone again.
- **Not done yet**: automations/saved views (Phase 5), sending invitations (INVITE roles are reported, not sent), a BullMQ job (the apply runs inside the request; fine at the measured sizes, a job is the next step if the 5 000-node ceiling is raised), crash-proof item recording (a process death between a task chunk and its item rows leaves tasks tagged only in activity metadata `importJobId`).

## Assets (step 3.7): reference files
Migration `20260622000000_step_3_7_template_assets`: table `template_assets` (CHECK sha256 shape and size > 0, unique per template+sha256) and `ATTACHMENT` added to the `template_install_items.entity_type` CHECK. Code: `src/templates/assets/` (`asset.policy.ts` pure, `template-assets.service.ts`), changes in `templates.service.ts`, `apply/*`, two routes.
- **Where the bytes live**: object storage under `template-assets/<templateId>/<sha256>`; `TemplateAsset` is scoped to the TEMPLATE (shared by all its versions, copied on fork, removed with the template; objects are deleted after the commit, best effort). `blueprint.assets[].sha256` + `sizeBytes` point at it. A version (or new template) may only list files that are stored with that template with the same hash AND size (`ASSET_MISSING`).
- **`StorageProvider` grew server-side methods**: `putObject`, `getObject(key, maxBytes)` (refuses before reading when bigger), `copyObject` (inside the store, bytes do not pass through the app), `headObject`. `AttachmentsModule` now exports `STORAGE_PROVIDER`.
- **One policy, applied to the BYTES** (`refuseAsset`): MIME deny list, extension deny list, magic numbers (PE/MZ, ELF, Mach-O, `#!`) whatever the name or declared type says, bad name/type, empty, over the cap. Used by the sanitizer, the upload route and the export path; nothing refused is ever written to storage.
- **Export** (`includeAttachments`): each source attachment is read one at a time, checked, hashed, stored; the attachment row's declared size is not trusted (the real length is used). Refused / unreadable / over-cap files are left out (the sanitizer then drops them and reports it); the response lists `assets.refused` with reasons only. Same bytes attached twice are stored once. If the export fails afterwards, what was stored is removed.
- **Upload route** `POST templates/:id/assets` (guard `editTemplate`): the request BODY is the file (`content-type` = its type, `x-file-name` header), read with a size cap, so the JSON body limit does not apply. Per-template caps (50 files / 50 MiB total, 10 MiB per file) are checked under a per-template advisory lock. Returns `{sha256, fileName, mimeType, sizeBytes}`; put those in the blueprint's `assets`, then POST a version. `GET templates/:id/assets` lists them. A NEW template cannot declare files (nothing is stored yet): create it, upload, add a version. Export and fork are the paths that create a template WITH files.
- **Apply**: one copy per task attachment (the same file on two tasks = two copies = two lots of quota). Plan: `counts.assets {copies, bytes}`; blockers `STORAGE_LIMIT` (bytes > plan limit minus live use incl. reservations), `FILE_TOO_LARGE` (plan per-file cap), `ASSET_MISSING` (template bytes gone). The old `ASSETS_NOT_COPIED` warning is gone.
- **Quota reservation**: before anything is copied, under a per-account advisory lock, the limit is re-checked and one PENDING `Attachment` row per copy is inserted (the existing live storage sum already counts un-expired PENDING rows, so every other upload/apply sees it at once; two applies cannot take the last bytes). Per 100-task slice: server-side copy, then the rows are flipped to CONFIRMED on the real task in the slice's transaction, and ATTACHMENT install items are recorded.
- **Release**: any failure -> compensation (undo code) removes confirmed copies, then leftover PENDING reservations (rows + objects) are released; this release also runs when the compensation itself fails. A crash leaves PENDING rows that the existing 24 h abandoned-upload job removes.
- **Undo**: the copies go with their task (rows in the transaction, objects after the commit; a dry run touches nothing); the template's own copies never make a task "in use", a file the person attached still does.
- **Not done / limits**: template-store bytes are NOT charged to the owner's attachment quota (bounded by 50 MiB x the template limit); the apply copies by key and does not re-hash the stored bytes; `createUploadUrl` still checks the quota without a lock (pre-existing, so an upload racing an apply can overshoot by one file); no virus scanning (policy is deny-list + magic numbers); no in-app preview of template files.

## Editor and diff (step 3.8)
Migration `20260623000000_step_3_8_template_drafts`: table `template_drafts` (one per template, unique `template_id`, CHECK revision >= 1) and `templates.node_key_seq` (backfilled from `n<k>`/`a<k>` keys already inside stored versions). Code: `src/templates/diff/` (pure), `src/templates/editor/` (`editor.apply.ts` pure, `template-editor.service.ts`), `TemplatesService.addVersionInTx` / `diffVersions`, routes in `templates.controller.ts`.

### Routes
`GET templates/:id/diff?from=1&to=latest` (anyone who can read the template) · `POST|GET|PATCH|DELETE templates/:id/draft` · `GET templates/:id/draft/diff` · `POST templates/:id/draft/publish` (all `editTemplate`).

### The draft
One mutable, ALWAYS-VALID blueprint per template, started from the latest version. It changes only through a batch of operations (max 200); the batch is applied to a copy, the whole result is re-validated, and it is saved only if everything passed (`OP_FAILED` with the op index, or `BLUEPRINT_INVALID` with the validator issues; nothing is half-applied). Every write quotes `ifRevision` (required); the draft row is locked FOR UPDATE for the request, so two writers with the same revision cannot both win (the loser gets `409 DRAFT_REVISION_CONFLICT` + `currentRevision`). Publish = version lock, draft lock, revision check, "base is still the latest version" check (`DRAFT_STALE` otherwise: nothing is published over someone else's version), then the same code path as the full-blueprint version route (`addVersionInTx`: assets, kind, NO_CHANGES, semver), then the draft is deleted, all in one transaction. The changelog defaults to a one-line summary of the diff. Lock order is version lock -> draft row -> template row everywhere.

### Operations (`editor.types.ts`)
`setMeta`, `setDateAnchor`, `setWorkspace` · `upsert` / `remove` / `rename` / `reorder` on variables, roles, modules, tags, customFields, issueTypes, iterations (`rename` only for tags, issue types, roles, custom fields) · `addProject`, `updateProject`, `moveProject`, `removeProject` · `addTask`, `updateTask {set, unset}`, `moveTask {project, parent, index, clear}`, `duplicateTask`, `removeTask` · `addDependency`, `removeDependency` · `addAsset {sha256}` (only a file stored with the template), `removeAsset`. Unknown ops/fields are refused; `kind` cannot change.
- **Identity**: an existing node's nodeKey never changes (rename, update, move, reorder keep it). New projects/tasks/iterations get `n<seq>`, new assets `a<seq>`, from `templates.node_key_seq`, which only moves forward: a key is not reused even after the node is deleted, a draft is discarded, or a version is published (versions created through the full-blueprint route and new templates push the counter past any `n<k>`/`a<k>` they contain). A batch that is rejected does not spend keys.
- **`ref`**: `{"op":"addTask","ref":"a",...}` then `"parent":"$a"` lets one batch build a subtree; `$ref` works wherever a key goes, including a task's `iteration` and `attachments`. The response returns `created: {ref: key}`.
- **Cascades** (reported in `cascaded`): removing a task removes its sub-tasks, its dependencies and its module entries (a module left empty is removed); removing a tag/issue type/role/custom field/iteration clears it from tasks; removing a project takes its tasks and project-scoped iterations; `rename` rewrites references; `duplicateTask` gives the whole copied subtree fresh keys, copies inner dependencies and puts the copy in the same modules as the original. Variables cannot be renamed or removed while text uses them (validation says so). `moveTask` across projects drops dependencies that would tie it to tasks left behind; `clear: ["status","iteration"]` drops what belongs to the old project (otherwise validation refuses the move).
- Deliberately NOT editable here: nodeKeys, statuses' keys (replace the workflow with `updateProject`), automations/views (Phase 5), the asset bytes (upload route).

### The diff (`diff/`)
Pure `diffBlueprints(a, b)`. The document is flattened into entities with identities (nodeKey, key, folded name, `from>to`, content hash for comments/automations/views) and fields (dotted paths); every leaf of both documents takes part, so `identical` is true **exactly** when the canonical JSON is equal. Reports `added`, `removed`, `modified` (field before/after; scalar lists say what was added/removed or `reordered`), `moved` (a task whose `project` or `parent` changed: one entry with just those two fields) and `reordered` (one entry on the container, naming the keys in both orders over the members both sides have; `minor` for lists whose order does not change an apply: tags, transitions, dependencies, automations, views). Output is deterministic and sorted; values over 2000 characters are replaced by `<N characters>` (`clipped`); `changes` is cut at 1000 but the summary counts everything (`truncated`). The function never throws on a malformed document (odd shapes are compared as plain fields; repeated keys get `#2`).
- **Not interpreted**: defaults (absent vs an explicit default value is a change), meaning of text (a re-worded description is one `modified`), and a changed comment is a removed + an added one (comments have no identity).
- **Limits of 3.8**: one draft per template (not per person); no rebase of a stale draft; the diff has no "apply this change" or three-way merge (that is the upgrade story, later); no HTTP-level tests of the new routes (the service and pure engines are tested; guards are the existing `editTemplate`).

## First-party templates (step 3.9)

**Visibility.** `TemplateVisibility` gains `PUBLIC`: readable, appliable and forkable by every signed-in user (membership not needed), editable by nobody outside the owning account. Only the **system account** may own one (`PUBLIC_RESERVED`, 403, on create and on edit); the HTTP DTOs do not accept `PUBLIC` at all. Every read path already went through `TemplatesService.canRead`, so apply, versions, diff, lineage and the file list needed no other change. `GET templates/public[?kind&category]` is the gallery (declared before `templates/:id`).

**System account.** `accounts.is_system` (partial unique index: at most one). A PERSONAL account on `FREE_PERSONAL` whose owner is a user with no password/Google id and an `@templates.invalid` address, so nobody can sign in as it. It is exempt from the template plan limit; customers' reading/applying never counts against theirs (the counter is "owned by the account"); a **fork** is the customer's own template and does count.

**Seeds.** `templates.seed_key` (unique, `^[a-z][a-z0-9-]{1,63}$`) is the stable identity; only the seeder sets it (`SEED_RESERVED` otherwise) and a fork never inherits it. Content lives in `src/templates/seeds/definitions/` (the three golden blueprints, copied so test fixtures can evolve; `student-workspace` now ships a real `essay-rubric.md`; `assets` entries are derived from the file bytes). `TemplateSeedService.seedAll()`: validates every definition first (nothing written if one is bad), holds one advisory lock, finds seeds by key; same checksum as the latest version = no write; different = a new version through `addVersionInTx` (bump minor by default, `bump` per definition); the envelope (name, description, category, tags, visibility) is re-synced. Run: `npm run seed:templates` (dev) / `seed:templates:prod` (built), after `migrate deploy`.

**Not done on purpose.** No platform-admin edit route for seeds (changes go through the definitions, i.e. code review); no moderation/quarantine (Phase 6); no DB constraint that PUBLIC implies system owner (the marketplace will widen it, so it stays in the service).
