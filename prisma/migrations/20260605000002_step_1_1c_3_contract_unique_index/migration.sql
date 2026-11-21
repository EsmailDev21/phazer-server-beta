-- Step 1.1c (3/4): the permanent-numbers guarantee. UNIQUE (workspace_id, number).
--
-- CONCURRENTLY: building this index non-concurrently would block all writes to
-- tasks for the duration of the build. It cannot run inside a transaction, so
-- this file is exactly ONE statement and has no BEGIN/COMMIT.
--
-- If it fails (e.g. a duplicate number, which the counter makes impossible
-- unless something wrote around it) PostgreSQL leaves an INVALID index behind:
-- `DROP INDEX "uq_tasks_workspace_id_number";`, fix the data, and re-run.
CREATE UNIQUE INDEX CONCURRENTLY "uq_tasks_workspace_id_number"
  ON "tasks"("workspace_id", "number");
