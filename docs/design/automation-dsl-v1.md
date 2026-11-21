# Automation rules: DSL v1 (step 5.1)

A rule is **data**, never code: `{ trigger, conditions?, actions }`. Nothing in 5.1 runs a rule (that is 5.2); this step stores, validates and lists them. Source of truth: `src/automations/dsl/`.

## Shape
- **trigger** (one of): `TASK_CREATED` · `STATUS_CHANGED {from?, to?}` (status refs) · `FIELD_CHANGED {field | customFieldId}` · `DUE_APPROACHING {offset: {amount, unit HOURS|DAYS}}` (<= 720 h / 90 d) · `EXTERNAL_LINK_STATE_CHANGED {provider?, kind?, state?}`.
- **conditions**: `{all?: [...], any?: [...]}`, at most 20 in total. A condition is `{field, op, value?}` (+ `customFieldId` for `CUSTOM`). The table of fields, operators and value kinds is `CONDITION_TABLE` (one place); an operator that does not belong to a field, or a value that does not fit it, is refused.
- **actions** (1..10, in order): `SET_STATUS`, `SET_PRIORITY`, `ASSIGN {mode SET|ADD|REMOVE, users}`, `SET_DUE_DATE {inDays|null}`, `SET_CUSTOM_FIELD`, `ADD_TAG`, `REMOVE_TAG`, `COMMENT`, `CREATE_SUBTASK`, `NOTIFY_CHANNEL`.
- **status ref**: `{category}` (works anywhere) or `{statusId}` (only in a rule scoped to ONE project, because statuses are per project).
- **users**: a user id, or `TRIGGERER` (who caused the event) / `CREATOR` (the task's creator).
- **text** (comment body, subtask title, message) may contain only these placeholders: `{{task.title}} {{task.key}} {{task.status}} {{task.priority}} {{trigger.from}} {{trigger.to}} {{actor.name}}`. No expressions, no code; anything else is `UNKNOWN_VARIABLE` / `BAD_TEMPLATE`.

## Two layers of checking
1. **Structure** (`validateRule`, pure): strict (unknown keys are errors, so a typo cannot silently do nothing), bounded (64 KB, depth 12, list lengths, 50 issues reported), issues are `{code, path (JSON Pointer), message}`.
2. **Against the workspace** (`checkRuleSemantics`): every id exists *in this workspace* (tag, issue type, custom field, project, status of the rule's project, user with workspace access); an operator/value fits the custom field's type (real calendar dates; SELECT values must be options); a rule must not create what triggers it (`TASK_CREATED` + `CREATE_SUBTASK` needs `IS_SUBTASK = false` in `all`, else `UNBOUNDED_RECURSION`).

## Unsupported-but-storable
A construct that is valid but this build cannot execute (today: `NOTIFY_CHANNEL`, needs Phase 2) is **stored** with `unsupported: [{path, construct, reason}]` and the rule **cannot be enabled** (409 `NOT_ENABLEABLE`; the database enforces it too). Editing an enabled rule into one that uses such a construct switches it off. The same mechanism will carry foreign rules (5.3): `ruleVersion 0` = raw, kept in `sourceDefinition`, never enabled, until translated.

## API (`workspaces/:id/automations`, 404 while `FEATURE_WORKFLOW` is off)
`GET` list (`projectId`, `enabled`, `triggerType`) · `POST validate` (dry run: `{valid, issues, unsupported, enableable}`, stores nothing) · `POST` create · `GET :id` (adds `problems`: what is wrong NOW, e.g. a tag deleted since) · `GET :id/runs` · `PATCH :id` (name, enabled, trigger/conditions/actions; `projectId` is fixed) · `DELETE :id`. Writes need `manageAutomations` (ADMIN+); reads need workspace access. Errors: 422 `AUTOMATION_INVALID {issues}`, 409 `NAME_TAKEN | NOT_ENABLEABLE | AUTOMATION_LIMIT | AUTOMATION_ENABLED_LIMIT`.

## Limits (`AUTOMATION_LIMITS`)
100 rules and 50 enabled per workspace (workspace row locked while counting, so racing requests cannot exceed them). Runtime limits for 5.2 live in the same object so they are decided once: chain depth 3, 30 runs/rule/minute, 200 due-fires per rule per tick.

## Data (migration `20260625000000_step_5_1_automations`)
`automations` (unique `(workspace, name_key)`, index `(workspace, trigger_type, enabled)` for the runner) and `automation_runs` (unique `(automation, event_id)`: one event runs a rule once; `task_id` is cleared, not cascaded, when a task goes). CHECKs: version 0/1, raw rules inert and sourced, executable rules have a matching trigger type and 1..10 actions, `enabled` implies no unsupported, JSON shapes, size caps, run depth/actions/error bounds.

## Not done on purpose
No execution, no loop guard at runtime, no rate limiting (5.2). No audit-log entries for rule changes (`AuditAction` would need new values: worth deciding with 5.2). No static cross-rule loop detection (rule A re-triggers rule B) beyond the single-rule recursion check. Rules keep ids, so templates (5.5) will need a name-based form that is resolved on apply.

---

# The rule runner (step 5.2)

## What runs a rule
- **People, adapters and other rules** change a task -> an activity row -> `activity.created` -> `AutomationRunnerService`. Only *non-silent* writes emit, so imports, bulk writes and template applies never trigger rules.
- **Time** (`DUE_APPROACHING`) is looked for, not waited for: job `system.automation-due-sweep` every 5 minutes (`DueSweepService`), through the same runner.

Event mapping (`engine/rule-event.ts`): `CREATED` -> TASK_CREATED; `STATUS_CHANGED` -> STATUS_CHANGED (both ends, by id and category); `PRIORITY_CHANGED / DUE_DATE_CHANGED / ASSIGNED+UNASSIGNED / ISSUE_TYPE_CHANGED / ITERATION_CHANGED / TAG_ADDED+REMOVED / DESCRIPTION_UPDATED` -> FIELD_CHANGED on PRIORITY / DUE_DATE / ASSIGNEES / ISSUE_TYPE / ITERATION / TAGS / DESCRIPTION. An assignment of three people is three events, so a rule on ASSIGNEES runs three times.

## Per event, per candidate rule
`enabled rules of the workspace with this trigger type` -> **scope** (project) -> **trigger** -> **conditions** -> **loop guard** -> **rate breaker** -> **claim** -> **actions** -> result. A rule that does not match leaves no trace; one that is blocked or run leaves one row in `automation_runs`.

- **Conditions look at the task as it is when the rule runs**, not as it was when the event happened. Rules for one event run in creation order, so a later rule sees an earlier rule's changes.
- **At most once per (rule, event).** The run row is inserted *before* any action (status FAILED, "INTERRUPTED") and finished afterwards; the unique key makes a redelivered event, or a second instance, a no-op. A crash mid-run leaves the honest interrupted row and is not retried (side effects are never repeated).
- **Loop guard.** Every change a rule makes is stamped in the activity metadata (`origin: AUTOMATION`, `automation: {id, depth}`; `WriteContext.automation`). A rule never reacts to its own change (`LOOP_GUARD: ... own change`), and a chain of rule-made changes stops at depth 3 (`LOOP_GUARD: chain ... 3 steps`); both are recorded as SKIPPED.
- **Rate breaker.** 30 non-skipped runs of one rule in a minute -> the rule is switched off with `pausedReason: RATE_LIMIT ...` (shown in the API; cleared when someone turns it on again).
- **Failures.** Actions run in order and stop at the first failure; what completed stays (no cross-service transaction). The run is FAILED with `actionsRun`, `details {failedAt, of}` and a short human-readable `error` (<= 300 chars; unexpected errors are generic, the detail goes to the log). A failing rule never affects another rule or the change that triggered it.

## Actions
They call the same services a person's request does (workflow transitions, visibility, plan limits, activity rows, notifications all apply), as the **Automations system user** (`system-automations@automations.invalid`, no password, in no account), which is also the author of rule comments (`CommentsService.createSystemComment`, which skips the member check the system user could not pass). `{{placeholders}}` show the task as it was when the rule started and are never re-expanded. `SET_DUE_DATE inDays` counts from today 00:00 UTC.

## Now unsupported (stored, cannot be enabled)
`FIELD_CHANGED` on TITLE / START_DATE / ESTIMATE / a custom field (nothing records those changes), `EXTERNAL_LINK_STATE_CHANGED` (Phase 2 adapters), clearing a priority or due date (the task API cannot), `NOTIFY_CHANNEL` (Phase 2).

## Not done on purpose
Events are in-process (like notifications): one lost while the process dies between commit and run is not replayed; only the sweep is durable. Custom-field changes do not fire rules (no activity exists for them). No retry of failed runs. No "test this rule on a task" endpoint. No retention job for `automation_runs`. Audit-log entries for rule changes (needs new `AuditAction` values).

---

# Richer triggers and actions (step 5.6)

No migration: `trigger_type` is text and a rule is JSON. Everything below is in the DSL (`rule.validator/semantic`), the engine, the runner/sweep and the executor; templates carry them too (`RefWalker` knows the new reference positions).

## New triggers
| Trigger | Fires when | Notes |
|---|---|---|
| `COMMENT_ADDED {contains?, by?}` | a comment is written on a task | `contains` is case-insensitive; `by` = `PEOPLE` (default) or `ANYONE`. **A rule's own comments never trigger rules unless a rule says `ANYONE`**; a comment a rule wrote carries which rule and how deep (system comments are now stamped like every other rule write), so two rules answering each other stop at the loop guard. Also reaches archived tasks ("reopen on comment"). |
| `TASK_ARCHIVED`, `TASK_RESTORED` | a task is archived / restored | |
| `ALL_SUBTASKS_DONE` | the last open subtask of a parent reaches DONE | **Derived**: fires on the PARENT, keyed by the completing change, so reopening one and finishing it again fires again; archived subtasks do not hold a parent open. Only computed when some rule listens. |
| `TASK_OVERDUE {afterHours?}` | a not-done task's due date has passed by `afterHours` (default 0) | The sweep. Only looks back 7 days (a new rule does not fire for every old late task); once per (rule, task, due date); moving the date re-arms it. |
| `SCHEDULE {frequency, hour, weekdays?, dayOfMonth?}` | `DAILY` / `WEEKLY` (ISO weekdays, 1 = Monday) / `MONTHLY` (day 1 to 28, every month has one), at a **UTC** hour | **No task.** The rule must belong to a project (`SCHEDULE_NEEDS_PROJECT`), has no conditions, and can only `CREATE_TASK` with no task placeholders (only `{{date}}`). The sweep (every 5 min) runs the latest due slot if it is under 2 hours old, keyed by the slot: any number of sweeps or workers make one task. Run rows have `task_id` null. |

## New actions
`CREATE_TASK {title, description?, priority?, dueInDays?, tags?, assignees?, status?}` (a new top-level task in the event task's project, or the rule's project for a schedule; `TASK_CREATED` + `CREATE_TASK` needs a condition saying which tasks) · `RENAME_TASK` · `SET_DESCRIPTION {text, mode REPLACE|APPEND}` (append fails loudly past 10000 characters) · `SET_ESTIMATE {number 0-1000 | null}` · `SET_ISSUE_TYPE {id | null}` · `SET_ITERATION {id | null}` · `CHANGE_PRIORITY {UP|DOWN}` (no priority counts as below LOW; the ends stay put) · `SET_START_DATE {inDays, from?}` · `ARCHIVE_TASK` · `RESTORE_TASK`. `SET_DUE_DATE` gains `from: NOW | DUE_DATE` (`DUE_DATE` shifts the task's own date, keeping its time of day, -365..365; a task with no due date fails with that reason). New placeholder `{{date}}` (UTC, YYYY-MM-DD).

All go through the same services a person's request does and carry the rule stamp (`TasksService.archive/restore` and system comments now accept the write context). Still at most 10 actions per rule.

## Not done on purpose
Watchers, mentions in comments, delays ("do X after 2 days"), IF/ELSE inside a rule, outgoing webhooks (an SSRF-sized decision of its own), clearing a priority or due date (the task API cannot), custom-field-changed and title/estimate-changed triggers (nothing records those changes). Schedules are UTC (no per-workspace time zone yet).

## Registry (step 5.8)
Triggers and actions are defined as descriptors, not switches: see `automation-registry-v1.md` (how it works, how to add one) and `automation-catalogue.md` (generated reference).

## If / else (step 5.10)
`{"type":"IF","conditions":{all?,any?},"then":[actions],"else":[actions]?}` is an action. Rules:
- **Conditions are evaluated when the IF runs**, against the task as it is then (an earlier action of the same rule is visible). They use the same fields and operators as a rule's conditions, and at least one is required. A task trigger's conditions still gate the whole rule first.
- `then` is required and non-empty; `else` is optional and, if present, non-empty. Only the branch chosen runs; the first failure anywhere stops the rule, and the run records where (`details.failedPath`, e.g. `/actions/1/then/0`; `failedAt` is the top-level index).
- `actionsRun` counts real actions that ran, not IFs.
- An IF needs a task, so a SCHEDULE rule cannot use it.
- The "must not create what triggers it" checks (`UNBOUNDED_RECURSION`) look inside branches, but a guard must be the RULE's own condition (`IS_SUBTASK` false): a condition on an enclosing IF does not count.
- Same stamp, same services, same loop guards as any rule write.

### Limits (configurable)
| Setting | Default | Hard ceiling | Meaning |
|---|---|---|---|
| `AUTOMATION_MAX_IF_DEPTH` | 3 | 5 | IFs and FOR_EACHs inside one another, combined (`IF_TOO_DEEP`, reported at the offending one) |
| `AUTOMATION_MAX_TOTAL_ACTIONS` | 30 | 100 | every action in the rule, branches and the IFs/loops themselves included (`TOO_MANY_ACTIONS`) |
| `AUTOMATION_MAX_FOR_EACH_ITEMS` | 100 | 1000 | tasks one FOR_EACH may select; more and it does nothing and the run fails |
| `AUTOMATION_MAX_CALL_DEPTH` | 3 | 5 | rules calling rules calling rules (`RUN_RULE`; `RUN_RULE_TOO_DEEP`) |
| `AUTOMATION_MAX_WAIT_DAYS` | 30 | 365 | the longest a WAIT may last (`WAIT_TOO_LONG`; checked on save AND when it starts) |
| `AUTOMATION_MAX_PENDING_WAITS` | 5000 | 100000 | waits one workspace may have pending; the run that would exceed it fails at the WAIT |
| `AUTOMATION_MAX_NOTIFY_RECIPIENTS` | 50 | 500 | people one NOTIFY may reach: over it the action fails and tells no one |
| `AUTOMATION_MAX_ACTIONS_PER_RUN` | 300 | 2000 | actions one run may EXECUTE (a loop multiplies what the rule lists); checked while running |
Each action list (top level, a `then`, an `else`) is still at most 10 (`maxActions`, not configurable). A bad value is ignored (never switches a guard off); nothing can raise a limit past its ceiling. The values are read on every use (`dsl/rule.settings.ts`), so they apply after a restart, and they are shown live in the catalogue (`limits`). Rules are validated when SAVED; the executor checks the CURRENT limits before running, so a stored rule over a lowered limit fails its run with a clear message instead of running. The JSON-depth guard follows the depth setting (default 14, one spare IF level so the specific error wins).

## Loops: FOR_EACH (step 5.12)
`{"type":"FOR_EACH","over":"SUBTASKS"|"SIBLINGS"|"PARENT"|"QUERY","scope"?:"PROJECT"|"WORKSPACE","where"?:{all?,any?},"onError"?:"STOP"|"CONTINUE","do":[actions]}`.
- **The item becomes the current task.** Inside `do`, every task action (set status, tag, comment, create subtask, IF, ...) acts on the item, and `{{task.title}}`, `{{task.key}}`, `{{task.status}}`, `{{task.priority}}` are the item's. `{{trigger.*}}`, `{{actor.name}}` and `{{date}}` stay the run's. The task the rule fired on is not reachable from inside the loop: do those actions outside it.
- **Selectors.** `SUBTASKS` (direct children, not archived), `SIBLINGS` (the other children of its parent), `PARENT` (the parent) are relative to the task the rule fired on and are empty, not errors, when there is none. `QUERY` is every non-archived task in `scope` (default `PROJECT`: the rule's project, or the fired task's for a workspace-wide rule) that matches `where` (the same rule conditions; none = all). Items come in task-id order. The tasks are chosen once, before the first runs, so a body that adds subtasks does not lengthen its own loop. A QUERY may include the task the rule fired on.
- **Limits.** More than `AUTOMATION_MAX_FOR_EACH_ITEMS` tasks selected (or a search that would scan more than `VIEW_RUN_MAX_SCAN` rows) = the loop does NOTHING and the run fails with a message saying why; it is never silently partial. A run may execute at most `AUTOMATION_MAX_ACTIONS_PER_RUN` actions in all.
- **Errors.** `STOP` (default) ends the loop at the first failing task. `CONTINUE` tries every task, then fails the action once ("2 of 5 tasks failed; the first: ..."). Either way the run records `failedPath` (a pointer such as `/actions/0/do/1`) and `failedItem` (`{index, taskId}`); what already succeeded stays done.
- **Nesting.** A loop MAY contain a loop (step 5.13); IF and FOR_EACH share one depth budget (`AUTOMATION_MAX_IF_DEPTH`). What bounds it is the per-run work: `AUTOMATION_MAX_ACTIONS_PER_RUN` (actions executed) and `AUTOMATION_MAX_LOOP_STEPS_PER_RUN` (default 500, ceiling 5000: loops started + tasks processed, which is what stops an inner loop that selects thousands of tasks and does nothing). Inside the inner loop, `SUBTASKS`/`SIBLINGS`/`PARENT` are relative to the OUTER task being processed. A failure records `failedItems` (every loop it was in, outermost first) and `failedItem` (the innermost). `actionsRun` counts real actions executed, not the loop or IFs.
- **SCHEDULE rules.** A FOR_EACH over `QUERY` works in a SCHEDULE rule (it selects its own tasks), e.g. a daily sweep of overdue tasks; the relative selectors need a task and are refused (`ACTION_NEEDS_TASK`). A rule that belongs to one project cannot use `scope: WORKSPACE` (`SCOPE_NEEDS_WORKSPACE_RULE`).
- **Authority (provisional until step 5.9).** A loop sees every non-archived task of the workspace (inside its scope), as the rule itself does today. When rules get an author's authority, a loop will only reach what the author may see.
- A guard against re-triggering must still be the rule's own condition; creating what triggers the rule from inside a loop is refused (`UNBOUNDED_RECURSION`).



## Else if (step 5.13)
`IF` takes an optional `elseIf`: a list of `{conditions, then}` cases, checked in order after the IF's own conditions; the FIRST that holds runs and the rest (and `else`) do not. Each case needs at least one condition and a non-empty `then`. Cases do not add nesting depth: they sit at the IF's own level (the JSON-depth allowance is wider to match: default 21). All conditions are checked against the task at the moment the IF runs. A failure inside a case is reported at e.g. `/actions/0/elseIf/1/then/0`.

## Captured variables and WITH (step 5.13)
Actions can pass results to the actions after them. `CREATE_TASK` and `CREATE_SUBTASK` take an optional `as: "name"` (a letter then letters/digits, at most 30; not `task`, `trigger`, `actor`, `date`, `item`). The task they create is then available:
- **In text**, as `{{name.id}}`, `{{name.key}}` (`ABC-12`), `{{name.title}}`, `{{name.status}}` (its status name), `{{name.priority}}`, `{{name.project}}` (project name), `{{name.assignees}}` (display names, comma separated) and `{{name.dueDate}}` (`YYYY-MM-DD`, or empty). Any text field can use them: comments, titles, descriptions, messages.
- **As the current task**, with `{"type":"WITH","task":"name","do":[actions]}`: inside `do`, every task action (and IF, FOR_EACH, `{{task.*}}`) works on the captured task. WITH counts toward the shared nesting depth and one loop step; it works in a SCHEDULE rule (create a task, then act on it).

Scope is checked when the rule is saved (`UNKNOWN_VARIABLE`, `VARIABLE_EXISTS`): a variable exists after the action that captures it, for the actions that follow it in the same list and everything inside them. It does NOT leave the branch, loop body or WITH it was captured in, and an action's own text cannot use its own capture. Inside a loop body a capture is fresh for each task. If the captured task is gone when a WITH runs, the run fails with `The task "name" no longer exists`; a failure inside a WITH is reported against the captured task (`failedItem`, `failedItems`).

Example: when a task is done, create a follow-up for the person who finished it, say so on the original, and prepare it:
```json
{ "trigger": { "type": "STATUS_CHANGED", "to": [{ "category": "DONE" }] },
  "conditions": { "all": [{ "field": "IS_SUBTASK", "op": "IS_FALSE" }] },
  "actions": [
    { "type": "CREATE_TASK", "title": "{{task.title}} follow-up", "assignees": ["TRIGGERER"], "as": "follow" },
    { "type": "COMMENT", "body": "Created {{follow.key}} for {{follow.assignees}}" },
    { "type": "WITH", "task": "follow", "do": [
      { "type": "ADD_TAG", "tagId": "TAG_ID" },
      { "type": "CREATE_SUBTASK", "title": "Prep {{follow.key}}" } ] } ] }
```
Not variables (yet): numbers or text set by an action, values read back from a task field, variables for entities other than tasks (a created project or iteration will capture the same way when those Create actions exist).

## Calling another rule: RUN_RULE and the CALLED trigger (step 5.14)
`{"type":"RUN_RULE","rule":"<rule id>"}` runs another rule's actions on the CURRENT task, inside this run (same budgets, same stamp, same limits). Rules that exist only to be called use the trigger `{"type":"CALLED"}`, which never fires from an event.
- The called rule's **trigger is ignored**; its **own conditions are checked** against the task as it is then, and if they do not hold it does nothing (that is not a failure).
- It is found by **id**. A rule that is **switched off can still be called** (the switch is about events). It must be in the current format and have nothing that cannot run yet (`RUN_RULE_UNAVAILABLE`).
- **Scope:** a project rule may call rules of its own project or workspace-wide ones; a workspace-wide rule only workspace-wide ones (`RUN_RULE_SCOPE`).
- **No loops:** a rule cannot call itself, directly or through others (`RUN_RULE_CYCLE`, checked on save across the whole call graph), and calls nest at most `AUTOMATION_MAX_CALL_DEPTH` deep (`RUN_RULE_TOO_DEEP`). Both are ALSO checked while running (a rule edited after its caller was saved can still close a loop), so a loop that gets into the data fails the run instead of running forever.
- Captured variables of the caller are in scope at run time but a called rule cannot name them (it is checked on its own).
- A failure inside the called rule is reported at the call (`failedPath` such as `/actions/1/call/0`) and names the INNERMOST rule (`failedRule: {id, name}`).
- **Templates:** a rule that calls another is NOT portable yet: a template keeps it apart with a reason instead of translating it wrongly (carrying rules by name is the next step).

## Telling people: NOTIFY (step 5.14)
`{"type":"NOTIFY","users":[...],"message":"..."}` sends an in-app notification with the rule's own text to people. `users` takes user ids and the tokens `TRIGGERER`, `CREATOR`, and the GROUPS `ASSIGNEES` and `WATCHERS` of the task it is about (as they are at that moment). `{{placeholders}}` and captured variables work in the message.
- Only people who **can see the task** receive it (the one visibility rule); others are skipped, never an error. If nobody can, nothing is stored.
- A group bigger than `AUTOMATION_MAX_NOTIFY_RECIPIENTS` makes the action fail BEFORE sending to anyone. A person in several groups gets one notification. An empty group sends nothing and is not an error.
- Stored as one `automation_messages` row (the rendered text; it survives the rule and the task) and one `notifications` row per person (`type`/`sourceType` `AUTOMATION_MESSAGE`). The notification list returns the text and the task id on the notification, and the live push carries them too. Normal per-user notification preferences apply.
- `ASSIGNEES` and `WATCHERS` also work in every action that takes people (`ASSIGN`, `CREATE_TASK`/`CREATE_SUBTASK` assignees), e.g. copy the assignees onto a follow-up. They are NOT accepted in conditions (a condition compares with one person at a time).

## Waiting: WAIT (step 5.15)
`{"type":"WAIT","for":{"amount":2,"unit":"MINUTES"|"HOURS"|"DAYS"}}` pauses the rule; the actions after it run when the time is up.
- **What happens.** The run reaches the WAIT, stops, and ends as an OK run (`details.waiting` says until when and where). What is left of it is saved in `automation_waits`: a **snapshot of the rule's actions** (editing or even deleting-and-recreating the rule later does not change a wait in flight) and the **position** (for each list the wait was inside: an IF branch, an else-if case, a WITH, the rule itself: where to carry on, and the run context it had, including the current task and every captured variable). A job runs every minute and carries on what is due, so a wait resumes within about a minute of its time. It is its own run row (`eventId: wait:<id>`, `details.resumedFromWait`), so the history shows both halves; a failure after the wait names where, against the snapshot's pointers.
- **It carries on only if** the **rule is still switched on** and the **task still exists**. Otherwise the wait is CANCELLED with the reason (`The rule is switched off`, `The task no longer exists`) and nothing happens; switching the rule back on does not bring an old wait back. Deleting the rule deletes its waits. A task that is archived still exists, so the wait carries on.
- **At most once.** A wait is claimed atomically before it runs, AND the resumed run row is unique per wait: two workers (or a retried job) cannot both carry it on. A wait claimed by a worker that then died is marked FAILED (`INTERRUPTED`) after an hour, never run a second time.
- **Where it may sit.** At the top level, inside an IF branch or else-if case, inside a WITH, and in a SCHEDULE rule (it needs no task: create a task, wait, then act on it). **Not inside a loop** (the tasks the loop has not reached yet cannot be saved; `WAIT_IN_LOOP`) and **not inside a rule that another rule calls** (`RUN_RULE_HAS_WAIT` on the caller). Both are ALSO refused while running, for rules that changed since they were saved. Wait before the loop, or after it.
- **Limits.** The longest wait is `AUTOMATION_MAX_WAIT_DAYS` (30). One workspace may have `AUTOMATION_MAX_PENDING_WAITS` pending (5000); past that the run fails at the WAIT instead of saving it. Carrying on a wait does not count against the rule's runs-per-minute allowance (a burst of waits coming due together must not switch a healthy rule off).
- **Seeing and cancelling.** `GET workspaces/:id/automations/:automationId/waits` lists the waits in flight; `DELETE .../waits/:waitId` cancels one (the rest of that run never happens). Both need `manageAutomations`.
- **Not (yet):** waiting UNTIL a time or a date field (only "for a while"), cancelling a wait automatically when the task changes (say, "wait 2 days, unless it was completed": put an IF after the wait that checks it), and a per-rule cap.

