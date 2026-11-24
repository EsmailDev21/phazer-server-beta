# ADR-0044 - Sprint tracking: commitment, burndown, capacity (step 6.1)

Status: Proposed. Builds on ADR-0043 (kind profile and `config`) and ADR-0008 (leaf-only points, velocity).

## Problem
A sprint should answer "what did we promise, how are we burning, who is overloaded, what changed after we started". Estimates and statuses have no history, so none of that can be rebuilt afterwards: it has to be recorded while the sprint runs.

## Decisions
1. **Capabilities come from the profile.** `burndown`, `capacity` and `retro` are `KIND_PROFILE` flags (SPRINT only). The new endpoints answer 400 `KIND_NOT_SUPPORTED` for other kinds; nothing checks `kind === 'SPRINT'` directly.
2. **One ACTIVE sprint per scope.** Scope = the project, or the whole workspace when `projectId` is null (a project sprint and a workspace sprint can both be active). Enforced in the service on start and reopen (409 `SPRINT_ALREADY_ACTIVE`, with the active sprint's id), under a transaction-scoped advisory lock on the scope so two simultaneous starts take turns. No unique index: existing data and importers may already hold several ACTIVE sprints, and a partial unique index would fail the migration. Importers write through DomainWriter and are exempt, as in ADR-0007 d.7. Cycles and milestones keep "several ACTIVE" (ADR-0008).
3. **Commitment is measured once, at the first start**, and stored on `iterations.start_summary` `{at, committedPoints, committedCount, unestimated}` (system-written, separate from the user's `config`, ADR-0043 d.3). Reopening a closed sprint keeps it.
4. **Daily snapshots** (`iteration_snapshots`, one row per iteration per UTC day: total and remaining points and count, leaf-only like velocity). Written at start, at close (before unfinished tasks move away) and by an hourly job for every ACTIVE sprint; the last write of a day stands. Hourly instead of nightly so a worker outage costs an hour, not a day. A missed day stays a gap in the chart, never an invented number.
5. **Scope changes are read from activity, not stored twice.** Moves into or out of the sprint after `start_summary.at` are the existing `ITERATION_CHANGED` rows. Points shown are the task's estimate *now* (estimates have no history); the burndown's total line is the authoritative record of what scope was at each day.
6. **The retro is the one setting editable after close.** It is written when the work is over. `PUT .../retro` (manageWorkflow) edits `config.retro` in any state and runs through the same config validation; every other config change on a closed iteration stays a 409 (ADR-0007 d.7).
7. **Ideal line** burns evenly over working days (Mon-Fri) between start and end date: full commitment on the start day, 0 on the end day, flat over weekends. Holidays are not modelled.
8. **Load per person** counts leaf tasks only; a task with several assignees splits its points equally and counts once for each. Unassigned and unestimated work is reported separately, never hidden in a total.

## Endpoints (`/workspaces/:id/iterations/:iterationId/...`)
`GET burndown`, `GET load`, `GET scope-changes` (workspace-level read), `PUT retro` (manageWorkflow). Capacity itself is `config.capacity` through the existing `PATCH`.

## Not decided here
The sprint UI (client part of this step). Per-day capacity (leave, holidays). Re-estimate history.

## Consequences
Migration `step_6_1_sprint_tracking` (new column and table, no backfill: sprints that started before this step show no commitment and an empty burndown until their next day's snapshot). Existing endpoints behave as before except that starting or reopening a second sprint in a scope is now a 409.
