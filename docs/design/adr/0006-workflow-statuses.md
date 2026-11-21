# ADR-0006: Workflow statuses (custom statuses that roll up to the four categories)

- **Status:** ACCEPTED (2026-10). The owner reviewed decisions 1-7 and confirmed all as written.
  Decisions marked **[CONFIRM]** had a real alternative; all were confirmed.
- **Blocks:** step 1.4 (`WorkflowStatus`, `WorkflowTransition`, `Task.workflowStatusId`), and the status
  mapping in imports (4.3, 4.7, 4.8), templates (3.x), GitHub status rules (2.6) and automations (5.x).

## Context

`PLAN.md` fixes the model: `Task.status` stays the four-value enum and now means *category*
(`TODO, IN_PROGRESS, BLOCKED, DONE`); `Task.workflowStatusId` points at the specific, per-project status.
Everything that exists today keeps reading the category. This ADR decides the rules the step text leaves open:
what the defaults are, what a legacy `PATCH {status}` does, what transitions enforce, and what deleting or
re-categorising a status does to tasks and progress.

### Found in the code (after step 1.3)

- **Every reader of `Task.status` wants a category, not a specific status**: progress and `getStats`
  (`ProjectsService`, `groupBy status`), `leafProgress` (`task-tree.ts`), the due-date reminder
  (`status: { not: DONE }`), the "is blocked" check on dependencies (`blockingTask.status !== 'DONE'`),
  the list filter `?status=`. None of them needs to change if the category stays authoritative.
- **Writers:** `TasksService.create` and `createChunk` pass `dto.status` straight to Prisma; `update` spreads the DTO
  (`status` included) into `task.update`, and logs `STATUS_CHANGED` with **no metadata** by comparing
  `dto.status !== task.status`. No code path in `src/snap/` writes `Task.status` today.
- **`ProjectsService.create` is two unrelated statements** (insert project, record activity), not a transaction
  unless a `WriteContext` supplies one. Seeding statuses must join that transaction.
- **`Task.project` is `onDelete: SetNull`** (deleting a project moves its tasks to the Inbox). Statuses belong to a
  project, so they disappear with it; a task's pointer to one must not block that.
- **Inbox tasks have no project**, so they have no workflow. They keep only the category.
- **Progress is computed at read time, never stored.** A category change therefore cannot leave a stale number;
  it only has to update the tasks' `status`.
- `manageWorkflow` already exists (step 0.10): PROJECT + WORKSPACE targets, OWNER/ADMIN only, no plan limit.
  `FEATURE_WORKFLOW` already gates the by-key routes.

### Checked on PostgreSQL 16 (throwaway DB)

Before deciding how to keep "task.status == its workflow status's category" true, I tried to make the database do it
with a composite FK `tasks(workflow_status_id, status) -> workflow_statuses(id, category)`
(`UNIQUE(id, category)` on the target, `ON UPDATE CASCADE`, `ON DELETE SET NULL`):

- **It works for the invariant.** Writing a mismatched `(workflow_status_id, status)` is rejected, and changing a
  status's category cascades into `tasks.status` by itself.
- **It breaks project delete.** `ON DELETE SET NULL` on a composite FK nulls *both* columns, and `tasks.status` is
  `NOT NULL`: `DELETE FROM projects` fails with a not-null violation. PostgreSQL 15+ has `SET NULL (column)`, but
  Prisma cannot express a column list. So the composite FK is **rejected** (decision 1).
- A **partial unique index** `(project_id, category) WHERE is_default` does reject a second default in a category.
  Prisma cannot declare partial indexes (decision 3 says how that is handled).

## Decisions

### 1. The category stays authoritative; the invariant is kept by one service, not by an FK

`Task.status` keeps its meaning and its `NOT NULL` default. `Task.workflowStatusId` is nullable
(`ON DELETE SET NULL`, simple FK to `workflow_statuses.id`).

**Invariant:** if `workflowStatusId` is set, `Task.status` equals that status's `category`; every task that has a
`projectId` has a `workflowStatusId`. Readers tolerate a null (treat it as "the category's default status") so a
violated invariant degrades instead of breaking; the integration suite checks the invariant after every
workflow-related test.

All writes of `status` / `workflowStatusId` go through a single `WorkflowStatusService.resolve(...)` used by
`TasksService.create`, `createChunk`, `update` and the project-move path. No other code sets either column. The
composite-FK alternative is recorded above so nobody re-proposes it without a way around the project-delete
failure.

### 2. Seeding: four statuses per project, always, regardless of the flag

Every project gets four statuses at creation (inside the same transaction as the project): one per category,
`position` 0..3, each `isDefault`. **[CONFIRM]** Display names: **To Do, In Progress, Blocked, Done** (the step
text says "named like the enum"; the enum spelling `TODO`/`IN_PROGRESS` is an identifier, not something to show).
`Project.defaultWorkflowStatusId` points at *To Do*.

Seeding happens even while `FEATURE_WORKFLOW` is off, and tasks keep `workflowStatusId` filled in, so turning the
flag on later needs no migration or backfill. Only the *routes* are flagged (ADR-0002). Existing projects and tasks
are filled by the step's migration (decision 11).

### 3. Defaults: one per category; a separate "initial status" per project

- `WorkflowStatus.isDefault`: exactly one per `(project, category)` that has any status. **This is what a legacy
  `PATCH {status}` lands on.** Enforced by the service under a per-project advisory lock (same mechanism as the
  task-tree lock) and by a partial unique index added as **raw SQL in the migration** (Prisma cannot declare it).
  **Open item for your real run:** `npm run db:verify` / `migrate dev` must show no drift because of that index; if it
  does, drop the index and keep the service rule + invariant test (the index is a seat belt, not the mechanism).
- `Project.defaultWorkflowStatusId`: the status new tasks start in. Must be in category `TODO`. It is usually the TODO
  default but may be another TODO-category status (Linear's *Backlog* vs *Todo*). Nullable at the database (a project
  and its statuses reference each other, so one insert order has to be null first); the service guarantees it is
  non-null for every project and falls back to the TODO default if it is ever null.

### 4. Required categories **[CONFIRM]**

A project must always keep at least one status in each of **TODO, IN_PROGRESS and DONE**. **BLOCKED is optional**:
diagram 07 shows imports only create it when the source has one (confirmed in the Map step), so imported projects
will often have none.

Consequence for old clients: `PATCH {status: "BLOCKED"}` on a project with no Blocked status answers **409**
("this project's workflow has no Blocked status"), it does not invent one. Seeded projects always have all four.

### 5. What `PATCH {status}` and `POST {status}` mean now

| Request | Result |
|---|---|
| `status` only, task's current status already has that category | **nothing changes** (a task in *In Review* stays there when an old client sends `IN_PROGRESS`) |
| `status` only, different category | task moves to that category's **default** status |
| create without `status` or status id | `Project.defaultWorkflowStatusId` (Inbox: category `TODO`, no status) |
| create with `status` only | that category's default |
| `workflowStatusId` only | sets both (category derived) |
| both, and they disagree | **400** |
| status id from another project | **400** |

New optional `workflowStatusId` on create/update DTOs; list filter `?workflowStatusId=` added, `?status=` keeps
filtering by category. Task list items gain `workflowStatusId`; detail gains `workflowStatus: {id, name, color,
category}`. All additive.

The legacy suite is the acceptance test: with seeded statuses and nothing customised, every existing request and
response behaves as before (new fields aside).

### 6. Moving a task between projects remaps its status

A project change picks the target status by **exact name match (case-insensitive) within the same category in the
target project, else that category's default** there. Into the Inbox: `workflowStatusId = null`, category kept.
From the Inbox into a project: the category's default. Category never changes on a move, so progress arithmetic is
unaffected. (Subtree moves from ADR-0005 apply the same rule to every descendant in the same transaction.)

### 7. Transitions

`WorkflowTransition(projectId, fromStatusId, toStatusId)`, unique per pair, both ends in the project, cascade on
status delete. `Project.enforceTransitions` (default `false`) decides whether they bind.

- Enforcement applies to **changes of a task's specific status**, on the resolved `(from, to)` pair: staying put is
  always allowed; creating a task is never restricted; a move between projects is never restricted (decision 6).
- Violation: **409** with `{code: 'TRANSITION_NOT_ALLOWED', allowedStatusIds}`. **[CONFIRM] No admin override** (an
  admin who needs a task elsewhere edits the workflow or turns enforcement off). A legacy `PATCH {status}` on an
  enforcing project can therefore 409 when the category default is not reachable; that is intended, old clients
  only meet it once someone enables enforcement.
- System writers with an `IMPORT` / `TEMPLATE` `WriteContext` skip enforcement (they reproduce source history).
  Automations (5.x) and chat commands obey it.
- `enforceTransitions=true` with **zero** transitions is rejected (it would freeze every task).

### 8. Deleting a status requires a target **[CONFIRM]**

`DELETE .../statuses/:id?reassignTo=<statusId>` - mandatory whenever any task (archived ones included) uses it,
optional otherwise. The target must be in the same project and differ from the deleted status; it **may be in another
category** (tasks' categories are then recomputed, decision 9). Refused with 409 when it would leave a required
category empty (decision 4), or when the status is the project's initial status and the target is not a TODO status
(the target then becomes the initial status). If the deleted status was a category default, the lowest-position
remaining status of that category becomes the default. Transitions touching it are removed with it. All of it in
one transaction under the project lock.

### 9. Changing a status's category recomputes tasks; no per-task noise

`PATCH .../statuses/:id {category}` updates `status` on every task pointing at it, in the same transaction, and
re-elects defaults (the status is no longer the old category's default; it becomes the new category's default only
if that category has none). Refused (409) when it would empty a required category or when it is the initial status
and the new category is not TODO. Progress needs nothing further (computed at read time).

**No per-task `STATUS_CHANGED` and no notifications for these bulk effects** (decisions 8 and 9): the same stance
already taken for tag and custom-field deletion. One project-level activity row, **new `ActivityAction`
`WORKFLOW_CHANGED`**, with `{op, statusId, from, to, tasksAffected}`. Single-task status changes keep logging
`STATUS_CHANGED`, now with metadata `{fromStatusId, toStatusId, fromCategory, toCategory}`; the diff also fires when
only the specific status changed inside one category (To Do -> Backlog), which is a real change to the user.

### 10. `excludeFromProgress` **[CONFIRM]**

Allowed only on **DONE-category** statuses (the one use is *Canceled*; on any other category the "done / total"
arithmetic stops meaning anything). An excluded task is **removed from the task set before leaves are computed**: it
behaves as if it did not exist for progress. So a parent whose only subtasks are all Canceled becomes a leaf
itself and counts as itself; a Canceled parent with live children simply drops out while its children count. Applies
to `computeProgress`, `getStats().progress` and `leafProgress`. `getStats().counts/total` stay real task counts by
category (excluded tasks included). Due-date reminders and "blocked by" keep reading the category, so a Canceled
task (DONE) sends no reminder and no longer blocks anything. For projects with no excluded status the number is
unchanged (the progress characterization test must pass untouched).

### 11. Schema, migration, API

One migration, single step (pre-launch stance): `workflow_statuses` (`project_id` cascade, `name`, `name_key`
unique per project - same normalisation as tags, `color`, `position`, `category`, `exclude_from_progress`,
`is_default`, partial unique index above), `workflow_transitions`, `projects.enforce_transitions` (not null, default
false), `projects.default_workflow_status_id`, `tasks.workflow_status_id` (+ index), `activity_action +=
WORKFLOW_CHANGED`. The same migration seeds four statuses per existing project and points every existing task at its
category's default (plain SQL, ids from `gen_random_uuid()`). Hard cap **30 statuses per project** (so transitions
stay <= 900 rows and boards stay usable).

Routes (all `@RequireFeature('WORKFLOW')`, writes `manageWorkflow`, reads = anyone who can view the project):
`GET /projects/:id/workflow`; `POST /projects/:id/workflow/statuses`; `PATCH|DELETE
/projects/:id/workflow/statuses/:statusId`; `PUT /projects/:id/workflow/order`; `PUT
/projects/:id/workflow/transitions` (replace the set); `PATCH /projects/:id/workflow` (`enforceTransitions`,
`defaultStatusId`). Because the route id is a project id, authorisation resolves in the service (the custom-fields
pattern), not through the route guard's workspace lookup.

### 12. What later steps get

`WorkflowStatusService.seedDefaults(tx, projectId, definitions?)` takes optional definitions, so templates (3.x) and
importers (4.x) create a project with their own statuses/transitions through the same code and the same invariants.
Mapping tables, `ExternalRef` for statuses and the name-heuristic for BLOCKED stay in 4.3.

## Consequences

- **Zero change for existing readers** (progress, reminders, dependencies, filters, Snap): they never see anything
  but the category. The cost is one rule in one service that every status write must use.
- **Behaviour changes to existing endpoints:** `STATUS_CHANGED` metadata is new; a same-category `PATCH` no longer
  resets a custom status; project moves remap the status; `PATCH {status}` can now 409 (missing BLOCKED, or enforced
  transitions) - both only on projects someone customised.
- **Known edges, accepted:** `ON DELETE SET NULL` on `tasks.workflow_status_id` means a status deleted *outside* the
  service would orphan its tasks to null (readers tolerate it; the service is the only intended deleter). Reordering
  statuses does not change which one is the category default. Status deletion/recategorisation is O(tasks in the
  status) in one transaction - fine at current sizes, the load test in 1.7 is where to look.
- **Not decided here:** per-issue-type workflows (one workflow per project, as planned), workflow templates/sharing
  across projects (3.x), board column configuration (UI).

## Test plan (what "done" means for 1.4)

Legacy-API compatibility (existing characterization suites unchanged, also with `FEATURE_WORKFLOW=true`); the
decision-5 table row by row; invariant check (status == category, project tasks have a status) after every test;
category recompute; delete-with-reassign incl. cross-category and the refusals; required-category refusals;
transition enforcement on/off, import-ctx bypass, no-transitions rejection; excluded-status progress incl. the
all-children-canceled case; project move remap (name match, default fallback, Inbox both ways); project delete still
works with tasks that have statuses; concurrent default-election (one winner); migration on a DB with existing
projects/tasks.

## Decisions to confirm

1. Default display names: To Do / In Progress / Blocked / Done (decision 2).
2. TODO, IN_PROGRESS, DONE required; BLOCKED optional, legacy `PATCH BLOCKED` 409s without it (decision 4).
3. Transition violation = 409, no admin override; system import/template writers bypass (decision 7).
4. Delete needs `reassignTo`, may cross categories, no per-task activity (decisions 8-9).
5. `excludeFromProgress` only on DONE statuses; excluded tasks removed before leaf computation (decision 10).
6. Cross-project move: name match within category, else default (decision 6).
7. 30-status cap per project (decision 11).
