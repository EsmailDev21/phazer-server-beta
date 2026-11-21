-- Step 1.7: task list / count / progress indexes (evidence: docs/design/perf-1-7.md).
--
-- The list endpoint runs  WHERE workspace_id = ? AND is_archived = false [AND project_id = ?]
-- ORDER BY created_at DESC LIMIT n.  No index supported that ORDER BY, so Postgres read and
-- sorted EVERY matching row (437k in the 760k-row test set: ~180 ms for page 1). The two
-- (scope, is_archived, created_at DESC) indexes below let it stop after n rows.
-- is_archived sits in the key (not only a filter) so counts and group-bys over the live
-- tasks can be answered from the index alone.
--
-- (workspace_id, number) -> uq_tasks_workspace_id_number, parent_id, workflow_status_id,
-- iteration_id, issue_type_id already have indexes from steps 1.1-1.5; nothing to add there.
--
-- The old single-column ix_tasks_workspace_id / ix_tasks_project_id are the leftmost prefix
-- of the new composites, so they are dropped (write cost + size). The measurement run checked
-- there is no regression without them.
--
-- Production note: pre-launch a plain CREATE INDEX is fine. Once the table holds real data
-- build these with CREATE INDEX CONCURRENTLY, outside a transaction, one statement at a time.
BEGIN;

CREATE INDEX "idx_tasks_workspace_archived_created"
  ON "tasks"("workspace_id", "is_archived", "created_at" DESC);
CREATE INDEX "idx_tasks_project_archived_created"
  ON "tasks"("project_id", "is_archived", "created_at" DESC);
CREATE INDEX "idx_tasks_project_archived_status"
  ON "tasks"("project_id", "is_archived", "status");

DROP INDEX "ix_tasks_workspace_id";
DROP INDEX "ix_tasks_project_id";

COMMIT;
