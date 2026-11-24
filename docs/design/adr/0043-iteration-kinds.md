# ADR-0043 - What makes a sprint, a cycle and a milestone different (step 6.0)

Status: Proposed. Extends ADR-0007 and ADR-0008; decisions 5-7 of ADR-0007 stand unless a point below says otherwise.

## Problem
`IterationKind` (SPRINT / CYCLE / MILESTONE) is only a label: same endpoints, same rules, same UI. Each kind should get its own features (sprint: commitment, burndown, capacity; cycle: cadence, rollover, trends; milestone: exit criteria, health, slip history).

## Decisions
1. **One table, one `config` column.** Per-kind user settings live in `iterations.config` (JSONB, nullable, CHECK: null or an object). No table per kind. Data that has its own lifecycle (daily snapshots, exit criteria, target-date changes) gets its own tables in the step that needs it, not here.
2. **Config is validated per kind** by the pure `iteration-kinds.ts` (`parseConfig`). Unknown keys are a 400 (`INVALID_ITERATION_CONFIG`): a typo is never silently dropped and a sprint cannot carry cycle settings. Empty normalises to null.
   - SPRINT: `capacity` (userId -> 0..1000 points, at most 200 people), `retro` (text, at most 4000).
   - CYCLE: `cadenceWeeks` (1..12), `autoCreateNext`, `autoRollover`, `cooldownDays` (0..14). `autoCreateNext` needs `cadenceWeeks`.
   - MILESTONE: `requireExitCriteria`.
3. **System-written data never goes in `config`.** Config is what an admin edits; snapshots (commitment at start, burndown points) are written by the system in their own columns/tables. Editing config can never forge history.
4. **Update replaces the whole config** (no merge); `null` clears; omitted leaves it unchanged. **Changing `kind` keeps only the settings that still fit** (`reconcileConfig`) and never fails the edit.
5. **`KIND_PROFILE` is the one place that says what a kind can do** (`capacity`, `cadence`, `exitCriteria`, `singleActivePerScope`). Later steps read the profile, not `kind === 'SPRINT'`.
6. **Closed iterations stay read-only (ADR-0007 d.7), config included**, with one exception: the sprint retro note, written after the work is over (ADR-0044 d.6).

## Not decided here (later steps)
Commitment snapshot and burndown (6.1), cycle auto-close and auto-create jobs (6.2), milestone criteria, health and slip history (6.3), epic rules (6.4), templates / imports carrying `config` (6.5). One active sprint per scope is a **profile flag only** until 6.1 enforces it at the app layer (importers exempt, like ADR-0007 d.7).

## Consequences
- `IterationDto` gains `config` (null when none). Create and update accept `config`.
- Nothing else changes: every existing endpoint behaves as before, and existing rows have `config = null`.
