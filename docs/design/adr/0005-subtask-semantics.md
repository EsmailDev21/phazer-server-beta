# ADR-0005: Subtask semantics

- **Status:** ACCEPTED (2026-10). The owner reviewed the seven decisions that had real
  alternatives and confirmed every recommendation as written; the rest follow from them.
  Step 1.3 is unblocked.
- **Implemented in:** step 1.3 (see "As built" notes in decisions 11 and 12). **Unblocked:** step 1.3 (`Task.parentId`), and the parts of templates (3.x), imports
  (4.x) and automations (5.x) that create or read task trees.

## Context

A subtask is a `Task` row with a `parentId`. It therefore has its own number and
key (`ENG-124`, ADR-0004), its own activity, assignees, dates and status. The plan
calls Phase 1 the riskiest change because subtasks touch progress, visibility and
every list query. This ADR fixes the rules before any of that is written.

### Found in the code (today, before subtasks)

- **Progress is flat.** `ProjectsService.computeProgress` is `done / total` over
  every non-archived task in the project, rounded. It is pinned by a
  characterization test. With subtasks, "total" would count a parent *and* its
  children, which double-counts the same work.
- **The per-project task cap counts every non-archived task row**
  (`PlanLimitsService`, `case 'task'`). FREE_PERSONAL is 50 per project;
  ORGANIZATION accounts have no task cap. Inbox tasks (no project) are not counted.
- **Delete is a hard delete** (`prisma.task.delete`), **archive is a flag**
  (`isArchived` + `archivedAt`) with no cascade. `TaskDependency` rows cascade away
  with either task.
- **A task can change project today**: `update` spreads the DTO into
  `prisma.task.update`, and `projectId` is in it (validated only to be in the same
  workspace). It cannot change workspace.
- **Visibility is a function of (workspace, project) only.** Workspace-level users
  see every task in the workspace; a user with only `ProjectMember` rows sees only
  that project's tasks; Inbox tasks are workspace-level only. Assignment does not
  affect visibility.
- **`Task.project` is `onDelete: SetNull`; `Task.workspace` is `onDelete: Cascade`.**
  Deleting a project therefore moves its tasks to the Inbox.
- **`TaskDependency` cycle prevention is app-layer** (no DB constraint). Same
  approach is needed here.

## Decisions (all confirmed; see "Decisions confirmed")

### 1. Depth: at most 3 levels (a root, its subtasks, and their subtasks)

`MAX_TASK_DEPTH = 2` edges below a root, enforced in the service from the ancestor
chain, as a named constant.

*Why not 1 level (Jira's model)?* It is the simplest, but GitHub sub-issues and
Linear allow much deeper trees, and the Phase 4 importers must map those onto
whatever we allow. Three levels carries real-world structure (feature -> task ->
step) while keeping every tree query a bounded 3-step walk.
*Why not unlimited?* Unbounded depth needs recursive queries everywhere, makes
cycles and rollups expensive, and cannot be walked safely by a client.
*The asymmetry that decides it:* raising the limit later is a one-line change that
breaks nothing; lowering it later would strand existing deeper trees. Start low.
*Consequence:* importers/templates deeper than the limit must **flatten the excess
to the deepest allowed level and record a warning** (never fail the whole import);
this is the "orphan subtasks" edge case already listed in 4.9.

### 2. Same project, same workspace - always

A child's `projectId` must equal its parent's (including both being `null`, i.e.
both in the Inbox). Workspace equality follows from that.

This is what makes visibility and the cap need no new rules (see 7 and 8): a whole
tree lives in one project. It also survives project deletion: `SetNull` clears the
project of every task in the subtree at once, so the tree stays consistent.

### 3. Cycles and depth are checked by walking the ancestor chain, under a lock

To set `child.parentId = P`: walk up from `P` (at most `MAX_TASK_DEPTH + 1` steps);
reject if `child` appears (cycle), if `P` is archived, or if
`depth(P) + 1 + height(child's subtree) > MAX_TASK_DEPTH`.

No recursive SQL is needed while depth is bounded. A walk is not enough on its own:
two concurrent reparent operations (A under B, B under A) would each pass the check.
Every write that sets or changes `parentId` therefore takes a **per-workspace
advisory lock** inside its transaction (`task-tree:<workspaceId>`), the same
mechanism ADR-0004's key assignment uses. Reparenting is rare; contention is not a
concern.

### 4. Deleting a parent: blocked while it has children, with an explicit cascade

- `DELETE /tasks/:id` on a task that has children answers **409** stating how many
  descendants there are. Nothing is deleted.
- `DELETE /tasks/:id?cascade=true` deletes the task and its whole subtree in one
  transaction.
- The foreign key is `ON DELETE NO ACTION`, so the database refuses to orphan a
  child even if some other code path forgets (verified on PostgreSQL: deleting a
  parent with children fails; deleting the workspace still cascades through the
  whole tree).

*Rejected: silent cascade* (one mis-click deletes a subtree). *Rejected: promote
children to roots* (changes their meaning and silently breaks the same-project
rule's intent, and surprises people who expect "delete" to mean the thing they
selected).

### 5. Archiving a parent archives its whole subtree; restoring undoes exactly that

Archive sets the **same** `archivedAt` timestamp on the task and every
non-archived descendant. Restoring the parent restores the descendants whose
`archivedAt` equals the parent's (so children that were archived on their own,
earlier, stay archived). No new column. Restoring a child whose parent is archived
is rejected ("restore the parent first"), and a subtask cannot be created under an
archived parent.

### 6. Progress rolls up from leaves only

- **Project progress** = done leaves / all leaves, over non-archived tasks, where a
  *leaf* is a task with no non-archived children. A parent is a container and is
  not counted itself.
- **A task's own progress** (shown on a parent) = done leaves / all leaves among its
  non-archived descendants. `null` for a task with no children.
- **Status is never changed automatically.** Completing every child does not
  complete the parent, and completing a parent does not complete its children.
  (A "when all subtasks are done, close the parent" rule is exactly what the
  Phase 5 automations are for.)
- Computed on read; **no denormalized counters** to drift. Revisit only if the 1.7
  load test shows list endpoints suffering.

*Why this formula:* for a project with no subtasks every task is a leaf, so the
result is **identical to today's number**: the existing characterization test stays
valid unchanged and is the regression guard. Counting parents too (the "flat"
option) double-counts work; averaging children into the parent makes a project's
percentage depend on tree shape.
*Known sharp edge:* closing a parent while children are open does not move project
progress. That is the honest reading of "the work is not done", and the UI should
say so; we are deliberately not guessing the user's intent.

### 7. Subtasks count toward the task cap

Every `Task` row counts, subtask or not. The cap exists to bound rows per project on
the free tier; exempting subtasks would make 50 roots with unlimited children.
Bulk tree creation (templates, imports) passes the tree size as `additional`, which
`checkLimit` already supports. FREE_PERSONAL users will reach 50 sooner; that is the
intended pressure, and organizations are unaffected (no task cap).

### 8. Visibility is inherited by construction - no new rule

Because a tree lives in one project (decision 2), `TaskVisibilityService` already
answers correctly for every node. The rule to protect is that **visibility stays a
function of (workspace, project) only**: no per-subtask restriction exists, and none
should be added without revisiting this ADR.
Creating a subtask additionally requires that the caller can **see the parent**
(`canViewTask`), answered with the same "Task not found" as a missing parent, so the
parent id cannot be probed.

### 9. Moving a parent moves its subtree; a subtask cannot change project alone

- Changing a root's `projectId` moves the whole subtree in one transaction.
- Changing a *subtask's* `projectId` is rejected with a message to detach it first
  (`parentId: null`) or move the root. (Silently detaching would be a surprise;
  silently moving the parent would be worse.)
- **The cap is checked on move** with `additional = subtree size`. Today moving a
  task between projects is not cap-checked at all; with subtasks that loophole gets
  larger, so this closes it. (Decision to confirm: this adds a check to an existing
  path.)

### 10. Assignees, dates, priority and status are independent

No constraint between a parent's and a child's dates (a subtask may be due after its
parent), assignees, priority or status. Dependencies (`TaskDependency`) are also
independent of the hierarchy. Each can be revisited as a *warning* in the UI, not a
rule in the API.

### 11. API surface, defaults and compatibility

- `POST /tasks` accepts `parentId`. `PATCH /tasks/:id` accepts `parentId`
  (`null` detaches). **The update path currently spreads the DTO straight into
  Prisma**; `parentId` must be destructured out and validated, or it would bypass
  every rule above. Reparent runs in one transaction under the tree lock.
- **List endpoints return all tasks by default, exactly as today**, each item now
  carrying `parentId`. `?rootsOnly=true` (step text: `includeSubtasks=false`) returns
  roots only; `?parentId=` returns one task's children. Existing clients and the
  existing list behaviour are unaffected.
- `GET /tasks/:id/subtasks` returns the subtree (bounded by decision 1).
  *As built:* a flat list, each row with its `depth` (1 = direct child), ordered by
  depth then number, archived rows excluded. Authorised exactly like `GET /tasks/:id`.
- Task detail also returns `parentId`, `subtaskCount` (direct, non-archived) and
  `subtaskProgress` `{done,total,percent}` (null with no subtasks).
- Activity: creation records `CREATED` with `parentId` in metadata; a change of
  parent records one `PARENT_CHANGED` `{from, to}` on the child; a subtree
  archive/move records one entry on the root with the descendant count. No
  notifications for hierarchy changes in 1.3 (the fan-out gets an explicit no-op,
  as for tags).
- **Keys:** a subtask draws its number from the workspace counter like any task.

### 12. Trees created in bulk (templates, imports)

`DomainWriter`'s bulk path generates task ids client-side before insert, so a chunk
can contain a parent and its children and reference them in a single `INSERT` (the
foreign key is checked at the end of the statement; verified on PostgreSQL in 1.3).

**As built in 1.3:** a bulk item names its parent either as `parentId` (an
already-existing task) or `parentIndex`: a 0-based index into **the list passed to
`createTasksBulk`**, which must point at an EARLIER item (so a cycle is impossible and
depth is computed in one pass). The writer remaps it per chunk, so a tree may span
chunk boundaries; a parent created by an earlier chunk is resolved to its real id.
Bulk children must carry the same `projectId` as the parent (no inheritance in bulk:
the cap preflight needs it up front). `createdIds` now comes back **in input order**.
*Limitation:* if `filterChunk` (retry-safety) drops a parent as already imported, its
children cannot use `parentIndex` for it and fail with a message asking for `parentId`;
a resumable importer knows the existing id from its ExternalRef and passes that.

## Consequences

- Existing data and the existing progress number are unchanged (every current task
  is a leaf).
- One new column (`parentId`, nullable, `NO ACTION`, indexed), one new activity
  action, one lock key. No change to permissions or the role matrix.
- Parent status can disagree with children (decision 6, 10). Deliberate, and
  surfaced in the UI rather than enforced.
- A client that wants a hierarchy builds it from `parentId`; one that ignores
  subtasks sees them as ordinary tasks.

## Decisions confirmed

These are the choices with real alternatives; the rest follow from them. All seven were
confirmed as recommended.

| # | Decision | Confirmed | Rejected alternative |
|---|---|---|---|
| 1 | Max depth | **3 levels** | 2 levels (Jira-style): simpler, but loses imported structure |
| 4 | Delete a parent | **Block, `?cascade=true` to delete the subtree** | Silent cascade |
| 5 | Archive a parent | **Archives the subtree; restore reverses exactly that** | Archive only the parent |
| 6 | Project progress | **Leaves only** | Count every task (flat, double-counts) |
| 7 | Cap | **Subtasks count** | Subtasks free |
| 9 | Cap on move | **Check it (closes an existing gap)** | Leave moves unchecked |
| 11 | Default list | **All tasks, `rootsOnly` to filter** | Roots only by default |
