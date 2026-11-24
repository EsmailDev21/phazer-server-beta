# ADR-0046 - Milestones: exit criteria, health, date history, release notes (step 6.3)

Status: Proposed. Builds on ADR-0043 (kind profile, `config.requireExitCriteria`), ADR-0008 (leaf-only numbers) and the existing task dependencies and external links.

## Problem
A milestone is "this outcome, by this date". Today it is a bucket of tasks with a date nobody checks. It should say whether it will make its date and why not, say what must be true to call it reached, and remember how often its date moved.

## Decisions
1. **Exit criteria** (`milestone_criteria`): a title and either a plain check or a link to a task. A task-backed criterion is **met while its task is DONE** (a stale `done_at` on it is ignored); a plain one is met when a person checks it. If the task is deleted the row stays (FK `SET NULL`) and becomes a plain, unmet criterion: the promise outlives the ticket. A task backs at most one criterion per milestone (partial unique index), at most 50 criteria per milestone. A milestone's tasks and its criteria are independent: a criterion's task need not be in the milestone.
2. **The gate.** Closing a milestone needs every criterion met, answered 409 `CRITERIA_UNMET` with `{unmet, total}`. `config.requireExitCriteria === false` turns the gate off; no criteria means no gate. Checked first in `close()`, before any task is looked at. Reopening is never gated. Criteria changes and a close take turns (criteria writes take a share lock on the milestone, close the update lock), so a close never judges criteria that are changing under it.
3. **Date history** (`iteration_target_changes`, append-only). Every move of the end (target) date of a milestone, with who moved it, is recorded: the first time a date is chosen is planning and is not recorded; a later move, earlier or later, or removing it, is. `changed_by_id` has no foreign key so the history survives the person. A *slip* is a move to a later date; the summary counts slips and the days added, and gives the first date promised. Kinds without `road` keep no history (turning a sprint into a milestone starts it).
4. **Health is computed when read, never stored** (`milestoneHealth`, pure). Facts only, no opinion:
   - CLOSED is `DONE`; no target date is `NO_DATE`.
   - The day after the target with work still open is `SLIPPED` (the target day itself still counts as on time).
   - Otherwise `AT_RISK` for any of: the pace so far lands after the target (needs 3 days of history and some work done; calendar days; pace = done / days elapsed since the start); nothing done a quarter of the way through the dates; an unfinished task blocked by another unfinished task within 7 days of the target. All the reasons that apply are listed.
   - Otherwise `ON_TRACK`. Work that is all finished is never at risk.
   Thresholds are named constants, not settings.
5. **Progress** is the milestone's leaf tasks (ADR-0008); a milestone with no tasks but with criteria is judged by its criteria; with neither it has none. The basis (`TASKS`, `CRITERIA`, `NONE`) is returned so the UI never shows a number that means something else.
6. **Blockers** are `TaskDependency` links where an unfinished task of the milestone waits on an unfinished task (archived and finished ones do not block). The count is exact; at most 50 are listed.
7. **Release notes** (`GET .../release-notes`) are the milestone's finished leaf tasks plus the pull requests of any of its tasks whose link state is `merged`, deduplicated by URL, as data and as markdown. Tasks have no completion timestamp, so nothing is dated.
8. **Endpoints** (`/workspaces/:id/iterations/:iterationId/...`, MILESTONE only, 400 `KIND_NOT_SUPPORTED` otherwise): `GET road`, `GET release-notes` (workspace-level read); `POST criteria`, `PATCH criteria/:criterionId` (rename, or check/uncheck a plain one: 400 `CRITERION_FOLLOWS_TASK` for a task-backed one), `DELETE criteria/:criterionId` (manageWorkflow). A closed milestone's criteria cannot be changed (409 `ITERATION_CLOSED`). `PATCH :iterationId` now passes the acting user so the date history can say who.

## Not decided here
Drawing milestones on the Gantt; ordering criteria by drag; cross-project milestones (a milestone is still one workspace and optionally one project); notifying stakeholders when health changes; dating completed work in release notes.

## Consequences
Migration `step_6_3_milestones` (two tables, no backfill: existing milestones start with no criteria, no history and the gate off in effect). Existing endpoints behave as before except that closing a milestone with unmet criteria is a 409, and editing a milestone's end date now writes a history row.
