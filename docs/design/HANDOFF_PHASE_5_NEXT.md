> **UPDATE after step 5.8 (the registry is done).** Section 5's step 5.8 is complete: see `automation-registry-v1.md` and `PROGRESS-phase5.md`. Adding a trigger or action is now ONE descriptor in `src/automations/registry/`; the "~8 places" in section 5 and the file list in section 1 (`rule.validator`, `rule.semantic`, `portable.refs`, the executor switch) are historical. Baseline is now **1533 unit / 569 integration**. Start at 5.9, but send the owner questions 1-3 and 6 first.

# Handoff: automations and views, round two

You are continuing a NestJS + Prisma + Postgres backend (a project/task manager: accounts, workspaces, projects, tasks, workflows, templates, automations, saved views). This document is everything the previous conversation knew. Read sections 0 to 3 before touching anything; sections 4 to 8 are the brief.

**The brief in one paragraph.** Phase 5 built a rule engine (a rule = trigger + conditions + actions, stored as data) and saved views. It is wide but flat: 11 triggers, 20 actions, one straight line per rule. Your job has two parts: **(A)** finish the "depth" items (delays, mentions/watchers/notifications, acting on parent/subtasks/related tasks, running saved views, if/else), and **(B)** make **most of what a user can do by hand available to automations, including project-level and workspace-level actions**. (B) is mostly NOT "add 30 more cases to a switch": it needs an action registry, an authority model, target selectors and non-task events first. Section 5 explains why and in what order.

---

## 0. Start here (15 minutes)

```bash
mkdir work && cd work && unzip ../phase5-handoff-package.zip && cd phase5-handoff-package
mkdir ../w && cd ../w
unzip -q ../phase5-handoff-package/backend-after-1_7.zip          # the base: Phase 1.7 backend
cd backend
unzip -q -o ../../phase5-handoff-package/phase5-step5_7.zip       # CUMULATIVE: every change since the base, through step 5.7
mkdir -p tools && cp ../../phase5-handoff-package/tools/* tools/
npm ci --ignore-scripts
bash scripts/typecheck-offline.sh                                 # expect: OK ... tsc clean
npx jest                                                          # expect: 1354 passed, 28 skipped
bash tools/sandbox-int.sh setup $PWD                              # FOREGROUND, ~2 min, one time per conversation
bash tools/sandbox-int.sh run $PWD test/integration/automations.int-spec.ts   # expect: 53 passed
```
The design docs (plans, ERDs, ADRs) are in `integrations-templates-design__1_.zip`; the living specs of what was built are in the repo under `docs/design/` (section 8).

**Every delivery of yours should be a CUMULATIVE zip** (all files changed vs the base zip, so it can be unzipped over the base), plus docs and a progress note. The snippet that builds it is in section 10.

---

## 1. State of the world (verified at the end of the previous conversation)

| Check | Result |
|---|---|
| Unit tests | **1354 passed**, 28 skipped (66 suites) |
| Integration tests (sandbox) | **569 passed**, 1 skipped (Prisma 7 + Postgres 16 in the sandbox, **NOT the pinned Prisma 5.22 stack**) |
| `tsc` / `nest build` | clean |
| eslint | clean on every file written or touched in Phase 5; **3 pre-existing ADR-0003 errors** in `src/templates/apply/apply.service.ts` (undo uses `tx.task/project/customField.deleteMany`), an unused `maybe` in `sanitize.blueprint.ts`, an unused `clone` in a validator spec |
| NOT run, ever | a real stack (docker compose), Redis/BullMQ worker process, the pinned Prisma version, HTTP-level tests of the new routes, the seed CLI against a full app |

**The owner must run `npm run test:integration` on docker compose.** Say so in every delivery.

### What exists (one line each; the details are in `docs/design/*.md` and `PROGRESS-phase3.md` / `PROGRESS-phase5.md`)
- **Templates (Phase 3, done)**: immutable versions, blueprint (JSON, names not ids), apply/undo ledger, extract from a workspace, editor drafts, assets, **first-party seeds** under a system account (`PUBLIC` visibility, `npm run seed:templates`).
- **5.1 Automations as data**: `automations` / `automation_runs`; DSL v1 in `src/automations/dsl/` (structural validator + workspace-aware semantic checks); CRUD API `workspaces/:id/automations`; raw (`ruleVersion 0`) rules; "unsupported but storable" constructs; limits (100 rules / 50 enabled per workspace).
- **5.2 Runner**: `AutomationRunnerService` (listens to `activity.created`), `ActionExecutor`, `DueSweepService` + job `system.automation-due-sweep` (every 5 min); exactly-once per (rule, event) via the run row; loop guard (stamp in activity metadata: `origin: AUTOMATION`, `automation {id, depth}`), depth cap 3, rate breaker (30/min then paused with a reason).
- **5.4 Saved views**: `saved_views`; config DSL in `src/views/dsl/`; personal vs shared; CRUD + duplicate + dry-run validate. **Views are stored and validated but NOT RUN.**
- **5.5 Templates carry rules and views**: portable form (names not ids) in `src/templates/portable/`; publish-time validation, preview, apply (rules always created OFF), undo, extract. **This is the ONLY place that knows where references live (`RefWalker`).**
- **5.6 Richer automations**: 6 new triggers, 10 new actions (below).
- **5.7 Seeds ship rules and views**; 16 behaviour tests prove they do what they say.
- **Step 5.3 was skipped on purpose** (GitHub-rule migration needs Phase 2's `ChannelLink`; the raw-rule translator has no input yet. Raw rules ARE stored with their source, ready for it).

### Catalogue today
- **Triggers (11)**: `TASK_CREATED`, `STATUS_CHANGED{from,to}`, `FIELD_CHANGED{field|customFieldId}` (only PRIORITY, ASSIGNEES, DUE_DATE, ISSUE_TYPE, ITERATION, TAGS, DESCRIPTION have events; the rest are "unsupported"), `DUE_APPROACHING{offset}`, `EXTERNAL_LINK_STATE_CHANGED` (unsupported until Phase 2), `COMMENT_ADDED{contains,by}`, `TASK_ARCHIVED`, `TASK_RESTORED`, `ALL_SUBTASKS_DONE` (derived, fires on the parent), `TASK_OVERDUE{afterHours}`, `SCHEDULE{DAILY|WEEKLY|MONTHLY, hour UTC}` (task-less).
- **Actions (20)**: `SET_STATUS`, `SET_PRIORITY` (null = unsupported), `ASSIGN{SET|ADD|REMOVE}`, `SET_DUE_DATE{inDays,from}` (null = unsupported), `SET_CUSTOM_FIELD`, `ADD_TAG`, `REMOVE_TAG`, `COMMENT`, `CREATE_SUBTASK`, `NOTIFY_CHANNEL` (unsupported until Phase 2), `CREATE_TASK`, `RENAME_TASK`, `SET_DESCRIPTION{REPLACE|APPEND}`, `SET_ESTIMATE`, `SET_ISSUE_TYPE`, `SET_ITERATION`, `CHANGE_PRIORITY{UP|DOWN}`, `SET_START_DATE`, `ARCHIVE_TASK`, `RESTORE_TASK`.
- **Conditions**: 11 fields (status, status category, priority, assignees, tags, issue type, project, estimate, due date, is-subtask, custom fields), `all`/`any` of up to 20 (no nesting). Views add iteration, title, start date, created-by and `DUE_WITHIN_DAYS`.
- **Limits** (`AUTOMATION_LIMITS`, `VIEW_LIMITS`): 10 actions/rule, 20 conditions, 64 KB/rule, 100 rules + 50 enabled per workspace, chain depth 3, 30 runs/rule/min, 200 due-sweep fires per rule per tick; views: 100 personal per person, 50 shared per workspace, 16 KB config.

### Files you will live in
```
src/common/dsl/schema.ts                  generic JSON-schema-lite combinators (obj, arr, tagged, ...) shared by rules and views
src/automations/dsl/                      rule.types / rule.limits / rule.validator / rule.semantic / workspace-context.loader
src/automations/engine/                   PURE: rule-event (activity -> event), trigger-match, conditions-eval, render-text, guards (loop, rate, due/overdue/schedule windows)
src/automations/automation-runner.service.ts    event -> candidate rules -> scope/trigger/conditions -> guard -> claim -> execute
src/automations/action-executor.service.ts      the big switch (one case per action type)
src/automations/due-sweep.service.ts            time-based triggers (due, overdue, schedule)
src/automations/automations.service.ts          CRUD + validation + caps + stale-rule `problems`
src/views/                                      dsl/ + service/controller (CRUD, duplicate, validate)
src/templates/portable/                         RefWalker, entity model, evaluateRuleItem/ViewItem
src/templates/apply/apply.portable.ts           planning (pure) ; apply.service.ts createPortable + undo
src/templates/seeds/                            seed definitions (TS objects), seeder, `prepareSeed`
src/domain-writer/write-context.ts              WriteContext {origin, actorId, silent, automation?{id,depth}}
test/integration/*.int-spec.ts                  automations, automation-runner, automation-richer, seed-behaviour, template-portable, views, template-seeds ...
```

---

## 2. Invariants (do not break these; each one has a test that will tell you)

1. **A rule is data, never code.** No expression language, no `eval`, no templates beyond a fixed list of `{{placeholders}}` that are substituted once and never re-scanned.
2. **At most once per (rule, event).** The run row is inserted BEFORE any action (status FAILED/"INTERRUPTED") and finished after; `UNIQUE (automation_id, event_id)` is the idempotency key. A crash mid-run is NOT retried. Keep this property for anything new (delays, bulk items: give each item its own key).
3. **Every write a rule makes goes through the SAME service a person's request uses**, with a `WriteContext` stamp `{origin: AUTOMATION, actorId: <system user>, automation: {id, depth+1}}`. The stamp is how the loop guard works and how the feed attributes changes. A service that does not accept `ctx` yet must get it (pass it only when present: `ctx ? svc(params, ctx) : svc(params)`; unit tests assert exact call args).
4. **Loop safety is layered**: a rule never reacts to its own write (`causedBy`), chains stop at depth 3, rate breaker pauses a rule. Comments written by rules are stamped too (and `COMMENT_ADDED` defaults to people only).
5. **Templates never switch anything on.** Rules from templates are created OFF (`createdVia TEMPLATE`), always. Plans/previews carry names, counts and reasons, never rule text. Personal views are never exported. Shared views from a template become personal unless the applier is an admin.
6. **Rule-made changes obey the workflow.** `enforceTransitions` applies to `SET_STATUS` exactly as to a person; a rule that asks for an illegal move FAILS with the reason. Author conditions so rules say "only when in review" instead of failing.
7. **Workspace isolation**: every id a rule or view names is looked up INSIDE its workspace (`WorkspaceContextLoader`), so an id from another workspace simply "does not exist".
8. **The database enforces what the service could get wrong** (CHECKs and partial unique indexes: raw rules inert, enabled implies no unsupported, personal view has an owner, unique names per scope...). Add a CHECK test for each new invariant (direct SQL, expect rejection).
9. **Events are in-process** (like notifications): an event lost while the process dies between commit and run is not replayed. Only the sweep (time-based) is durable. If you add delays, THEY must be durable (section 6.5).
10. **Silent writes do not fire rules** (imports, bulk, template apply). Keep it that way.

---

## 3. Conventions and traps learned the hard way

- **Run prettier/eslint `--fix` on your own files FIRST**, because scripted patches that anchor on exact text break once a file has been reformatted (this cost the previous conversation many round trips). When patching, `assert old in text` and re-read the file after formatting.
- **TS config is non-strict** (`strictNullChecks` off): discriminated unions do NOT narrow on `if (!r.ok)`. Use `r.ok === false` / `=== true`. `taskId: string | null` does not flag null uses: check them by hand (the runner has `scheduled` branches).
- **Sandbox tool limits**: `sandbox-int.sh setup` must run in the FOREGROUND (background processes are reaped between tool calls). A tool call dies at **300 s**. The full integration run (569 tests) already needed a 290 s timeout to fit: **it will not fit once you add more.** Split full runs by area (`bash tools/sandbox-int.sh run $PWD test/integration/a.int-spec.ts test/integration/b.int-spec.ts`) and run the whole thing in 2 to 3 calls. Extra jest args pass through (`-t "name"`).
- `resetDb` deletes users between tests: **never cache ids across tests** (a cached system-user id caused a real bug).
- Tests that drive rules call `await runner.whenIdle()` (waits for in-flight event handlers); sweeps take an explicit `now` (no wall-clock flakiness); the due-date SQL compares an event key built with `to_char(... 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`, keep it identical to `dueEventId`/`overdueEventId`.
- **Test world**: look at `automation-richer.int-spec.ts` (real services wired by hand, `emitter.on('activity.created', a => runner.onActivity(a))` replaces `@OnEvent`) and copy its setup. `seed-behaviour.int-spec.ts` shows applying a seed and driving real changes.
- A blueprint is JSON: a test object with `key: undefined` is rejected as `NOT_JSON`. Exported templates carry a required `startDate` variable. `exportFromWorkspace(workspaceId, userId, dto)` (argument order!).
- **Mutation-check what you build** (`tools/mutate.sh`, one mutation per call): break the rule on purpose, see a test fail, restore. The previous conversation found a race test that was too weak this way (2 racers did not catch a removed lock; 8 did). Beware equivalent mutants (a clamp whose absence hands `undefined` to an updater that ignores it).
- Zip hygiene: exclude `node_modules`, `dist`, `tools`, `*.zip` (a build leaves `dist/`: delete it).
- The task API cannot CLEAR a priority or a due date (the DTOs have no null). Rules using those are stored as "unsupported". Fixing the API is a prerequisite for those two actions.
- **Custom-field value changes write no activity**, so nothing can trigger on them (and a rule conditioned on a custom field at task CREATION never sees the value: values are set after creation). A seed rule like that shipped once; the behaviour tests caught it. Add the event before offering the trigger.

---

## 4. Part A: the "depth" items (each is a step; sizes are rough)

| # | Item | What it needs | Size |
|---|---|---|---|
| A1 | **Delays** ("do X 2 days after Y") | durable pending actions (6.5) | L |
| A2 | **Mentions, watchers, in-app notify** | `COMMENT.mentions`, `ADD_WATCHER`/`REMOVE_WATCHER` (WatchesService.create(userId, 'TASK', id) checks the target is viewable), `NOTIFY_USERS` (NotificationsService.createNotification; likely a new `NotificationType`) | M |
| A3 | **Act on parent / subtasks / siblings / related** | target selectors (6.3) | L |
| A4 | **Run saved views** (config -> task query) | shared filter engine (6.6); also unlocks "for each task in view" | L |
| A5 | **If/else inside a rule** | nested action tree, recursion in schema/walkers/limits (do AFTER the registry) | M |
| A6 | **Dry-run / "test this rule on a task"**, per-action run detail | registry `describe`, run `details` array | M |

## 5. Part B: "most manual actions become automation actions"

**The inventory** is `docs/design/manual-actions-inventory.md`: all **113 state-changing routes**, classified. Totals: **10 already covered, 11 worth adding, 32 only behind guards, 60 never offered** (auth, billing, webhooks, account/role/membership changes, template authoring, deletes of containers, comment edit/delete, ...). Read it before designing; every row says the required access today, the proposed action(s), the authority ceiling and whether the service already accepts a write context.

**Why this is not "add cases to a switch".** Adding one action today touches ~8 places: the TS union (`rule.types.ts`), the schema + `ACTION_TYPES` + `TASKLESS_ACTIONS` + placeholder rules (`rule.validator.ts`), reference collection AND workspace checks AND recursion checks (`rule.semantic.ts`), the template reference positions (`portable.refs.ts`), the executor switch, tests, docs. At 20 actions that is manageable; at 50+ (and with ceilings, portability flags, targets) it will rot. And three problems appear that the current design does not solve:

1. **Authority.** Most controllers for tasks, projects, comments, custom-field values, watches, attachments and workspaces have NO `@RequireAccess` (the inventory's `(in service)` rows); iterations, issue types, workflow, tags (mostly), templates and automations/views do. Where there is none, the SERVICE authorises, and a rule calls the service directly as a system user that is a member of nothing. Today the only authority is "an admin saved the rule" (`manageAutomations`, ADMIN+) and nothing is re-checked at run time. That was fine for tagging a task; it is NOT fine for "create a project" or "grant team access".
2. **Targets.** Every action acts on "the event's task" (or creates a new one). Project/workspace actions and "the parent / each subtask / a task by key" need explicit targets.
3. **Events.** The runner only understands task activities. Project/iteration/workspace-level triggers ("sprint closed", "project archived", "member joined") have no event source.

### Recommended order (do not skip the first three)
| Step | What | Why first |
|---|---|---|
| **5.8 Action registry** (no behaviour change) | One descriptor per trigger and action: schema, reference positions (collect + map for templates), semantic checks, `needs` (task / project / none), `ceiling`, `portable`, `execute`, `describe`. Migrate all 20 actions and 11 triggers; delete the switches; add a **catalogue endpoint** (the registry is exactly what a rule-editor UI needs). | Everything after it is "add a descriptor". A test asserts every descriptor has a schema, a fixture, an executor and a docs line. |
| **5.9 Authority model** | 6.2 | Needed before ANY guarded action. |
| **5.10 Event generalisation** | 6.4 | Project/iteration/workspace triggers and actions need an event source. |
| 5.11 Run saved views | 6.6 | Unlocks bulk selectors. |
| 5.12 Target selectors + "for each" | 6.3 | Parent/subtasks/siblings/related/by key/in view. |
| 5.13 Delays | 6.5 | Needs run-status `WAITING`. |
| 5.14 Notify / mentions / watchers | A2 | Small, high value; can go earlier if wanted. |
| 5.15 Project-level actions | create/update/archive project, apply template, project triggers | After authority. |
| 5.16 Iteration actions | create/start/close with rollover (the valuable bulk one), iteration triggers | After selectors (rollover = bulk). |
| 5.17 Workspace-level admin actions | tags, custom fields (options), issue types, enable/disable automations, ... | Guarded; low value each, high coverage. |
| 5.18 If/else, dry-run, per-action detail, revert-where-possible | A5, A6 | Polish; needs the registry. |
| (maybe never) membership/invite actions | open question 1 | A rule that changes who has access is a decision for the owner, not an engineering default. |

## 6. Design notes for part B

### 6.1 The registry (sketch, adapt freely)
```ts
interface ActionDescriptor<P> {
  type: string;                              // 'ARCHIVE_TASK'
  schema: Check;                             // structural, from common/dsl/schema.ts
  needs: { task?: boolean; project?: boolean };   // replaces TASKLESS_ACTIONS; SCHEDULE rules may only use needs.task === false
  refs?: RefSpec;                            // WHERE ids live (one declaration drives collectReferences, workspace checks AND template RefWalker)
  semantic?: (a: P, scope, ctx) => RuleIssue[];
  ceiling: Role;                             // minimum role of the rule's AUTHOR to include it (6.2)
  portable: boolean;                         // may travel in a template (false for guarded/destructive)
  unsupported?: (a: P) => string | null;     // "stored but cannot be enabled" reasons
  execute(a: P, run: ActionRun, ctx: WriteContext): Promise<void>;
  describe(a: P, run): string;               // rendered, human sentence: dry-run + run log
}
```
The existing code to absorb: `rule.validator.ts` (action variants), `rule.semantic.ts` (`collectReferences`, `checkRuleSemantics`), `portable.refs.ts` (`RefWalker.rule`/`viewConfig`), `action-executor.service.ts`. Keep the DSL JSON shape stable (`ruleVersion 1` rows must keep working; adding actions is additive; if you change a shape bump `ruleVersion`).

### 6.2 Authority model (needs the owner's confirmation, see section 11)
Recommended:
- Each action has a `ceiling` role. **At save time**, the author's role must reach the highest ceiling among the rule's actions (ADMIN today for everything; OWNER for guarded ones).
- **Rules run under the authority of the last person who created, edited or enabled them** (add `automations.authority_user_id`, set on create/update/enable). **At run time re-check** that person's CURRENT role in the workspace against the rule's ceiling (cheap: one resolver call per run). If they left or were downgraded: do not run, record `SKIPPED` with `AUTHOR_LOST_AUTHORITY`, pause the rule with that `pausedReason`. This closes "an admin writes a powerful rule, is demoted, the rule keeps running".
- Enabling a template-created rule makes the enabler its authority (and requires THEIR role to reach the ceiling).
- `portable: false` actions cannot be published in a template (`AUTOMATION_INVALID: ACTION_NOT_PORTABLE`) and are dropped (with a report line) on export.
- **Audit**: every guarded action execution writes an audit-log entry (extend `AuditAction`; workspace/project-level changes made by a machine must be attributable to rule + authority user). Rule create/update/enable/disable need audit entries too (still missing from 5.1).
- **Quotas for guarded actions** (e.g. at most N projects created by rules per day per workspace) on top of the existing per-rule rate breaker.
- **Plan limits**: a worker never passes through controller guards, so each service must enforce plan limits internally (`DomainWriter` comments say so; verify this for projects/workspaces/iterations before offering `CREATE_*`).

### 6.3 Target selectors and bulk
Today: THIS task. Add an optional `target` to task actions (and a `where` filter for multi-targets):
`THIS | PARENT | SUBTASKS | SIBLINGS | RELATED(dependency) | KEY("TGT-12") | IN_VIEW(name)` (the last after 5.11).
Rules for multi-target: hard cap per run (suggest 50 tasks), **each item gets its own idempotency key** (`${eventId}#${taskId}`; the run row stays one-per-event, items recorded in `details`), per-item failure does not abort the others (decide and document: today the first failure stops the run), evaluate `where` with the SAME `evaluateConditions` over a fresh `TaskSnapshot` per item, rate-limit by items not runs. Project-level actions need `target: THIS_PROJECT | PROJECT(name)`; in templates, names resolve through `RefWalker` (add `project` positions).

### 6.4 Events beyond tasks
`activityToRuleEvent` accepts only `ActivityTargetType.TASK`. `ActivityTargetType` has only `TASK`, `PROJECT` and `COMMENT` (and `WORKFLOW_CHANGED` project-level activities exist). Missing events: iteration created/started/closed (the "sprint ended" trigger and rollover), project created/archived/updated, member/collaborator added, template applied, invite accepted, custom-field value changed. Options: (a) write activities for them (add `ITERATION`/`WORKSPACE` target types, visibility SILENT where noisy) and extend the mapper, or (b) a separate `domain.event` emit. (a) keeps one stream, one dedupe key (activity id), one place for the stamp. `RuleEvent.taskId` is already nullable (SCHEDULE uses it); add `projectId`/`iterationId`. Time-based project/iteration triggers ("iteration ends in 1 day") go in `DueSweepService`.

### 6.5 Delays
Add action `WAIT{amount, unit}` as a SPLIT POINT: the actions after it become a continuation. Table `automation_pending {id, automation_id, run_id, workspace_id, task_id?, resume_index, run_at, depth, caused_by, status PENDING|DONE|CANCELLED|SKIPPED, UNIQUE(run_id, resume_index)}`; `AutomationRunStatus` gains `WAITING`; the 5-minute sweep (or a delayed BullMQ job) resumes due rows. On resume RE-CHECK: rule still enabled, author authority (6.2), task still exists and not archived, and optionally "only if these conditions still hold" (`waitUntil`). Cancel pending rows when the rule is disabled/deleted. Bounds: max wait 30 days, max pending per rule. Depth/causedBy are preserved across the wait so loop guards still work. Tests need an injectable clock.

### 6.6 Running saved views (also the engine for IN_VIEW)
`GET workspaces/:id/views/:viewId/tasks?cursor=&limit=` (and a filterless "run this config" for the editor). Build a pure `buildTaskWhere(filters, ctx): Prisma.TaskWhereInput` + sort + group + cursor paging. **The key test**: generate ~200 varied tasks and every condition in `VIEW_FILTER_TABLE` / `CONDITION_TABLE`, and assert the SQL result set equals the in-memory `evaluateConditions` result (they must mean the same thing; the in-memory evaluator lacks the view-only fields TITLE contains, START_DATE, CREATED_BY, ITERATION: add them). `ME` resolves to the caller; `DUE_WITHIN_DAYS`/overdue need a clock and a time-zone decision. Respect project access (a view is per caller).

### 6.7 Templates and every new action
Each new action needs: its reference positions in the registry (so `RefWalker` handles it), a `portable` decision, a publish-time test, a round-trip test (extract -> apply). Seed rules (section 8) should keep being exercised by `seed-behaviour.int-spec.ts`.

---

## 7. Definition of done for each step (the previous conversation's bar; keep it)
1. Pure logic in pure modules with table-driven unit tests (including hostile input).
2. Integration tests on a real DB through the REAL services (not mocks), covering: happy path, each refusal with its code and JSON-pointer path, workspace isolation, permissions, caps, races (8 parallel), cascades, DB CHECKs by direct SQL.
3. **Mutation checks**: at least one deliberate break per safety rule; each must fail a test.
4. Full unit suite, `tsc`, `nest build` (then delete `dist/`), eslint on files you touched.
5. Full integration suite in the sandbox (split into several calls when it nears 300 s).
6. A doc (`docs/design/...`), a `PROGRESS` section stating **what was NOT done and NOT run**, and a cumulative zip that is a superset of the previous one (check with `comm`).
7. Say plainly what you found wrong in your own earlier work (the previous conversation found: a restore rule that could never work, a creation-time custom-field rule that could never fire, a story rule the workflow would reject, sanitizer rewriting `{{`, a cached user id, a date V8 accepts but is not real).

## 8. Seeds and docs to keep in sync
Seeds (`src/templates/seeds/definitions/*.blueprint.ts`) carry 13 rules and 14 views and are published by `seedAll`; changing one publishes a NEW version (`changelog` = what is new, `initialChangelog` = "First release."). New actions should appear in at least one seed rule when sensible, with a behaviour test.
Living docs: `docs/design/automation-dsl-v1.md` (DSL, runner, 5.6 section), `saved-views-v1.md`, `template-automations-views-v1.md` (portable form, apply/undo/extract, seeds), `blueprint-v1.md` (3.9 section: PUBLIC seeds, system account), `manual-actions-inventory.md`, `PROGRESS-phase3.md`, `PROGRESS-phase5.md`.

## 9. Migrations added so far (in order, after the Phase 1/2 ones in the base)
`20260624000000_step_3_9_system_templates` (PUBLIC visibility, `accounts.is_system`, `templates.seed_key`) · `20260625000000_step_5_1_automations` · `20260626000000_step_5_2_automation_runner` (`creation_mode` + AUTOMATION, `automations.paused_reason`) · `20260627000000_step_5_4_saved_views` (incl. a trigger that deletes a deleted user's personal views) · `20260628000000_step_5_5_template_automations_views` (install ledger accepts AUTOMATION, SAVED_VIEW). Steps 5.6 and 5.7 needed none. **Migration dates are invented** (the owner asked to be told): confirm they sort after the real latest migration.

## 10. Cumulative zip
```bash
cd backend && rm -rf dist
rm -rf /tmp/base && mkdir /tmp/base && unzip -q ../../phase5-handoff-package/backend-after-1_7.zip -d /tmp/base
python3 - <<'PY'
import os
base='/tmp/base/backend'; out=[]
for r,d,f in os.walk('.'):
    d[:]=[x for x in d if x not in('node_modules','dist','tools')]
    for n in f:
        p=os.path.join(r,n)[2:]
        if p.endswith('.zip'): continue
        b=os.path.join(base,p)
        if not os.path.exists(b) or open(b,'rb').read()!=open(p,'rb').read(): out.append(p)
open('/tmp/changed.txt','w').write('\n'.join(sorted(out)))
PY
zip -q /mnt/user-data/outputs/phase5-stepX.zip -@ < /tmp/changed.txt
# superset check against the previous zip:  comm -23 <(unzip -Z1 prev.zip|sort) <(unzip -Z1 new.zip|sort)   -> must print nothing
```

## 11. Open questions for the owner (ask early; they change the design)
1. **Authority**: is "runs as the last person who created/edited/enabled it, re-checked every run, pauses if they lose the role" (6.2) acceptable? Alternative: a fixed per-rule ceiling with no re-check (simpler, weaker).
2. **Membership actions** (invite, add collaborator/guest, team access, add to team): allow at all? Recommendation: not in this round; if yes, OWNER ceiling, rate-limited, audited, never portable.
3. **Destructive actions**: confirm "rules archive, never delete" (the inventory marks task/project/workspace delete as never or archived-only).
4. **Delays**: max duration (30 days?), and should a pending delay be cancelled when the task changes ("cancel if condition no longer true")?
5. **Time zones**: schedules and "due within N days" are UTC. Add a workspace time zone now or later?
6. **Bulk caps**: 50 tasks per run per rule acceptable? What should happen above it (truncate and report, or fail)?
7. **Marketplace (Phase 6) policy**: may public templates carry automations? Recommendation: only `portable` actions, always OFF, with a visible "this template adds N automations" diff before apply.
8. **Notifications**: new `NotificationType` for rule-made notices? In-app only (chat needs Phase 2).
9. **Audit retention** and visibility of the run log to non-admins.
10. Who needs the **catalogue endpoint** (rule-editor UI) and in what shape.

## 12. What the previous conversation did NOT verify
The pinned Prisma 5.22 + docker compose stack; Redis/BullMQ and the real worker process (the job is registered and unit-wired, not run); HTTP-level behaviour of any new route (controller guards are pinned by metadata unit tests only); the seed CLI against a full app; concurrency across processes (races are tested in-process against one database); performance of the due/overdue sweep at scale (it is bounded by `maxDueFiresPerTick`, not load-tested).
