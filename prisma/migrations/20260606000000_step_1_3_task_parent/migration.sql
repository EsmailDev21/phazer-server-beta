-- Step 1.3 (ADR-0005): subtasks. One migration (pre-launch stance: no live data,
-- so no expand/backfill/contract split is needed for a new nullable column).
BEGIN;

ALTER TYPE "activity_action" ADD VALUE 'PARENT_CHANGED';
ALTER TYPE "activity_action" ADD VALUE 'TASK_MOVED';

ALTER TABLE "tasks" ADD COLUMN "parent_id" TEXT;

-- NO ACTION (not CASCADE / SET NULL): deleting a task that still has subtasks
-- is refused by the database; the application offers an explicit ?cascade=true.
ALTER TABLE "tasks" ADD CONSTRAINT "fk_tasks_parent_id"
  FOREIGN KEY ("parent_id") REFERENCES "tasks"("id") ON DELETE NO ACTION;
ALTER TABLE "tasks" ADD CONSTRAINT "ck_tasks_parent_not_self"
  CHECK ("parent_id" IS NULL OR "parent_id" <> "id");
CREATE INDEX "idx_tasks_parent_id" ON "tasks"("parent_id");

COMMIT;
