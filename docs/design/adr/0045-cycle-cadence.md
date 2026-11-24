# ADR-0045 - Cycles that repeat: auto-create, auto-rollover, the ring (step 6.2)

Status: Proposed. Builds on ADR-0043 (kind profile, `config`) and ADR-0044 (sprint tracking). No schema change: everything a cycle needs is already in `config` (`cadenceWeeks`, `autoCreateNext`, `autoRollover`, `cooldownDays`).

## Problem
A cycle is "the next two weeks, again". Creating each one by hand, then closing it and moving what is left, is the busywork a cycle exists to remove. People also want to see the rhythm: what the last cycles achieved and what comes next.

## Decisions
1. **An hourly sweep does the three chores** (`system.cycle-rollover`, minute 17), in this order, and is safe to repeat and to run on several workers:
   1. *Create the next cycle ahead of time* for an ACTIVE cycle with `autoCreateNext` and a `cadenceWeeks` and an end date, if it has no successor. The new cycle is PLANNED, copies the settings, starts the day after the end plus `cooldownDays`, lasts `7 x cadenceWeeks` days, and is named by counting up the trailing number ("Cycle 12" -> "Cycle 13"; no number -> "... 2"), skipping any name taken in the scope. Creating it early lets people plan into it and lets the ring show it.
   2. *Roll over a finished cycle*: an ACTIVE cycle with `autoRollover` whose end date has passed (the end day itself still counts as running) closes with action MOVE to its successor.
   3. *Start a waiting cycle*: a PLANNED cycle of an automated chain (`autoCreateNext`) whose first day has come and whose end has not passed, when nothing else of its kind in its scope is ACTIVE. This is also how a cooldown ends.
2. **Successor** = the nearest non-closed cycle of the same workspace, project and kind that starts after this one ends. It is found, not stored: a manually created next cycle works as well as an automatic one, and nothing can point at a deleted cycle.
3. **Never guess where work goes.** Without a successor there is no rollover: the cycle stays ACTIVE for a person to close, and the sweep takes no other action. A close that the rules refuse (for example unfinished tasks outside the target's project) is logged, counted as failed, and retried next hour; it never stops the other cycles.
4. **Automatic goes through the manual path.** Closing and starting call `IterationsService.close` / `start`, so every lock and rule of the manual action applies, and the velocity snapshot is written exactly as for a manual close. No activity rows are written (iteration state changes never wrote them).
5. **Two workers cannot both create the next cycle.** Names are not unique in the database, so creating the successor takes a transaction-scoped advisory lock per cycle (`cycle-next:<id>`), looks for a successor again inside the lock, and only then creates. Cheap check first, locked check second.
6. **Dates are calendar time** (UTC days, weekends not special), unlike the sprint's ideal line which skips weekends (ADR-0044 d.7): a cycle is "every N weeks", not "N working days".
7. **The ring** (`GET .../iterations/:id/ring`, CYCLE only, workspace-level read) returns the current cycle with up to 3 before and 2 after in the same scope, ordered by start date. Closed cycles report the numbers saved when they closed (ADR-0008); others are measured now (leaf tasks only). `rolledIn` is the number of unfinished tasks the previous cycle moved into this one when it closed. Trends need no new endpoint: velocity already takes `kind=CYCLE`.

## Not decided here
Skipping holidays or a pause in the chain; a cycle that auto-closes without rolling work anywhere (LEAVE or BACKLOG); several chains in one scope.

## Consequences
New hourly job and `GET .../ring`. Existing endpoints behave as before. A cycle only automates if its settings say so; nothing changes for existing cycles (their `config` is null).
