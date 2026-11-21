# ADR-0008: Story points, current iteration and velocity

- **Status:** ACCEPTED (2026-10). All three forks were decided by the owner. Follow-up to ADR-0007 (step 1.5).

## Decisions
1. **Velocity is measured in story points AND task count**, reported side by side. New `tasks.estimate` (`Float`, null = not
   estimated, 0..1000, DB CHECK). Settable on create/update (null clears), on bulk create, and returned on every task item.
2. **"Current iteration" = every ACTIVE iteration** (several, or an empty list). No "current" flag, no date logic.
   `projectId` narrows to that project's iterations plus workspace-wide ones.
3. **Velocity takes any kind via a filter.** Default: closed SPRINTs, last 6. Filters: `projectId`, `kind` (SPRINT|CYCLE|MILESTONE|ALL),
   `state` (default CLOSED), `limit` (1..50, default 6). Result is oldest-first (chartable) with the mean of the returned iterations.

## Rules I applied (not asked; flag any you disagree with)
- **Only LEAF tasks are summed** - the same leaves progress uses (`countedLeaves`, ADR-0005/0006): a parent and its subtasks are
  never both counted; archived and Canceled (excluded) tasks never count; a parent whose subtasks are all excluded counts as itself.
- **Completed = Done**; the total includes unfinished tasks. An **unestimated task adds 0 points** and is reported
  (`unestimated` / `unestimatedCompleted`) instead of being guessed.
- **A closed iteration reports a snapshot taken when it closed** (`closeSummary.velocity`), measured BEFORE unfinished tasks are
  moved away. Later edits (a left-behind task finished later, an estimate changed) do not rewrite history. Reopening discards the
  snapshot (the iteration is live again); closing again takes a new one. Iterations closed before this change, or in any
  non-CLOSED state, are measured live (`source: LIVE` vs `SNAPSHOT`).
- Estimate changes are **not** recorded in the activity feed (no `ESTIMATE_CHANGED`); history lives only in the snapshots.
- Half points sum exactly; sums are rounded to 2 decimals (floats, not decimals: the range is small).

## API
`GET /workspaces/:id/iterations/current[?projectId]` -> full iteration details (counts, progress, `points {total, done, unestimated}`).
`GET /workspaces/:id/iterations/velocity[?projectId&kind&state&limit]` -> `{filter, iterations[{..., completedPoints, completedCount,
totalPoints, totalCount, unestimatedCompleted, source}], average}`. Both: `FEATURE_WORKFLOW`, workspace read access. Declared before
`:iterationId` so the words are not read as ids.

## Not decided here
Commitment-at-start (we only snapshot at close, so "committed vs completed" uses the total at close), burndown, per-person velocity,
estimate history, estimate units other than points.
