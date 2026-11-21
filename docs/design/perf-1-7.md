# Step 1.7 - indexes and query review

Data: `scripts/perf-seed.sql` - 760k tasks (workspace `w1` = 460k: 400k in 40 projects, 60k Inbox; three noise
workspaces of 100k). Postgres 16, **1 CPU / 4 GB sandbox: compare ratios, not absolutes.**
Harness: `test/integration/perf-list.int-spec.ts` (`PERF=1`), real `TasksService` / `ProjectsService` /
`IterationsService`; 5 warm-ups + 40 timed runs per scenario; VACUUM ANALYZE before each phase.

## What was missing
Spec list vs reality: `(workspaceId, number)`, `parentId`, `workflowStatusId`, `iterationId` (and `issueTypeId`) were
already indexed by 1.1-1.5. Real gaps: **nothing supported the list `ORDER BY created_at DESC`**, and `(projectId, status)`.

Before, `GET /tasks?workspaceId=..` (page 1) was `Parallel Index Scan ix_tasks_workspace_id` -> read ~437k rows ->
top-N heapsort (raw SQL 180 ms; the sort cost grows with workspace size, not page size).

## Change (migration `20260611000000_step_1_7_task_indexes`)
| index | serves |
|---|---|
| `idx_tasks_workspace_archived_created (workspace_id, is_archived, created_at DESC)` | every workspace-scoped list (+ any extra filter), deep pages, index-only `count` |
| `idx_tasks_project_archived_created (project_id, is_archived, created_at DESC)` | project lists, plan-limit count, project `taskCount` |
| `idx_tasks_project_archived_status (project_id, is_archived, status)` | `getStats` groupBy (index-only), spec's `(projectId, status)` |
| dropped `ix_tasks_workspace_id`, `ix_tasks_project_id` | leftmost prefixes of the above |

`is_archived` is in the key on purpose: every list/progress/stats query filters `is_archived = false`; as a key
column it lets Postgres stop after `LIMIT` rows and answer counts without touching the heap.
Variant without `is_archived` in the key was measured and was worse (no index-only count/stats).

## Results (real services, ms)
| scenario | before p50 | before p95 | after p50 | after p95 | p95 x |
|---|---|---|---|---|---|
| A workspace list, page 1 | 430 | 493 | 89 | 111 | **4.5** |
| B project list, page 1 | 53 | 74 | 41 | 48 | 1.5 |
| C project + status | 59 | 75 | 37 | 44 | 1.7 |
| D project + rootsOnly | 54 | 70 | 43 | 62 | 1.1 |
| E children of one parent | 2.7 | 3.9 | 2.8 | 5.3 | - |
| F workflowStatusId filter | 39 | 54 | 40 | 56 | 1.0 |
| G iterationId filter | 2.6 | 2.7 | 2.8 | 3.1 | - |
| H workspace list, skip 5000 | 452 | 498 | 91 | 106 | **4.7** |
| I member-restricted user | 158 | 181 | 63 | 86 | **2.1** |
| K computeProgress | 67 | 84 | 67 | 103 | 0.8 (noise) |
| L getStats | 77 | 106 | 69 | 75 | 1.4 |
| M iteration detail | 2.9 | 5.2 | 2.7 | 4.0 | - |
| N count only, workspace | 76 | 89 | 52 | 207* | p50 1.5x |
| O count only, project | 6.5 | 8.3 | 1.1 | 3.7 | 2.2 |

\* single outlier; p95 on a 1-CPU box is noisy, the regression guard in the spec uses p50.
Bulk insert of 20k tasks: 1071 ms before, 1060 ms after (one extra index net: no measurable write cost).
Raw `EXPLAIN`, after: page 1 = `Index Scan idx_tasks_workspace_archived_created`, 0.09 ms (was 180 ms); deep page 5.9 ms
(was 219 ms); `getStats` groupBy `Index Only Scan`, 0.9 ms (was 7-9 ms).

## What the numbers say is left (NOT changed - these are not index problems)
1. **`count(*)` per list call** is O(matching rows): workspace count 52-76 ms at 437k rows, project count ~10 ms at 10k.
   Index-only now (~2x faster) but still linear. Every list response pays it. Options if it matters: cap/estimate the
   total for large scopes, drop `total` unless asked, or keep a counter. **Behaviour/API decision - owner's call.**
2. **`attachCounts`** issues 2 count queries per row (100 per page of 50). It is why B/C/D/F still sit at ~40 ms after the
   sort is fixed. Needs one grouped query per page (`groupBy targetId in (ids)`); a pure code change, no schema.
3. **`computeProgress`** (also inside `getStats`): ~66 ms for a 10k-task project. Plan is a merge anti-join over *all*
   tasks that have a parent plus a per-child `workflow_statuses` lookup. A covering index on `parent_id` and forcing a
   nested-loop anti-join were both tried: 66 -> 55 ms only. Not worth an index; needs a query rewrite (or a stored
   leaf flag) if projects grow past ~10k tasks.
4. Filters F (`workflowStatusId`) and G/E/M were already served by their single-column indexes; unchanged on purpose.

## Production note
Plain `CREATE INDEX` is fine pre-launch. Once `tasks` holds real data, build the three indexes with
`CREATE INDEX CONCURRENTLY` (outside a transaction) before dropping the old two.
