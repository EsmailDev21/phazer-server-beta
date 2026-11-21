# ADR-0007: Issue types and iterations

- **Status:** ACCEPTED (2026-10). The owner decided the three open forks (close handling, who manages, reopening);
  the remaining defaults were stated up front and not vetoed.
- **Blocks:** step 1.5, and the type/iteration mapping in imports (4.x), templates (3.x), GitHub (2.x).

## Decisions

**Owner decisions**
1. **Closing with unfinished tasks is asked every time.** `POST .../close {action: LEAVE | MOVE | BACKLOG, moveToIterationId?}`.
   With unfinished tasks (not Done, not archived) and no `action` the answer is **409 `UNFINISHED_TASKS_DECISION_REQUIRED`**
   `{details: {unfinishedCount}}` and nothing changes. There is no default. Done and archived tasks always stay.
2. **Admins and owners only** create/edit/start/close/delete iterations and issue types: the existing `manageWorkflow`
   action on the WORKSPACE (route guard). Reads need only workspace access (like tags). Assigning a task to an
   iteration or giving it a type is an ordinary task edit.
3. **A closed iteration can be reopened** (`CLOSED -> ACTIVE`). Reopening clears `closedAt`/`closeSummary` and does
   **not** pull back tasks that were moved or backlogged when it closed.

**Defaults applied (stated before building)**
4. Issue types are workspace-level; names unique ignoring case (`name_key`, DB-enforced, 409); **none seeded** (a task with
   no type is just a task); at most **50** per workspace. `level` (EPIC/STANDARD/SUBTASK) is a **label only**, not enforced against
   ADR-0005 nesting. Deleting a type leaves its tasks untyped (`ON DELETE SET NULL`).
5. Iterations (SPRINT/CYCLE/MILESTONE) are workspace-wide (`projectId` null) or one project's; **scope is fixed at creation**;
   dates are calendar dates (both optional, end >= start, DB CHECK); names are **not** unique (Jira-style repeats); at most **1000** per workspace.
6. **State machine:** PLANNED->ACTIVE, PLANNED->CLOSED (skip), ACTIVE->CLOSED, CLOSED->ACTIVE (reopen); everything else 409.
   **Several ACTIVE at once are allowed** (importers bring them; a uniqueness rule can be added later, relaxing one cannot).
   DB CHECK: `closed_at` is set exactly when `state = CLOSED`.
7. **Closed = read-only**: edit 409, delete 409 (reopen first), takes **no new tasks** (409 `ITERATION_CLOSED`). Leaving a task in it,
   re-sending its own id, and moving a task OUT of it are fine; clearing (`null`) is always allowed. **IMPORT/TEMPLATE writers may replay
   a closed iteration** (like transitions in ADR-0006); MANUAL/INTEGRATION may not.
8. **Assignment rules:** type and iteration must belong to the task's workspace (400); a project-scoped iteration only takes tasks of
   that project (400), the Inbox only takes workspace-wide ones. **Subtasks are planned independently** of their parent (no inheritance).
9. **Moving a task (or subtree) to another project clears a project-scoped iteration that no longer fits** (never fails the move;
   workspace-wide iterations stay); the count goes into `TASK_MOVED` metadata as `iterationsCleared`.
10. **MOVE target on close** must be PLANNED/ACTIVE, same workspace, and - if project-scoped - every unfinished task must be in that project (409).
11. **Iteration progress** reuses the leaf-only rule (ADR-0005) and the excluded-status rule (ADR-0006) over the tasks *in* the iteration;
    detail returns counts by category (real counts) and `progress {done,total,percent} | null`.
12. **History:** per-task `ISSUE_TYPE_CHANGED` / `ITERATION_CHANGED` (metadata `{from,to}`, fan-out ignores them); bulk effects of close/delete
    write **no per-task rows** (same stance as status edits); the outcome of a close is stored on the iteration as `closeSummary
    {unfinished, action, movedToId, completed}`.

## Concurrency
Every iteration state change takes the iteration row `FOR UPDATE`; every task write that assigns an iteration takes it `FOR SHARE`
**before writing any task row** (close updates tasks afterwards - the opposite order would deadlock). Rows are locked in id order
(two iterations closing into each other cannot deadlock). Lock order everywhere: workflow-shared, then tree, then iteration rows.

## Consequences
- Behaviour of every existing endpoint is unchanged except: task create/update accept `issueTypeId`/`iterationId` (null clears on update);
  list/detail/table/subtree items carry both ids; detail carries `issueType` and `iteration`; `?issueTypeId=` and `?iterationId=` filters;
  a project move may clear an iteration (see 9).
- Not decided here: a "current sprint" concept (needs the uniqueness rule above), velocity/burndown (derive from `closeSummary`),
  per-project default issue types, templates carrying types/iterations (3.x).
