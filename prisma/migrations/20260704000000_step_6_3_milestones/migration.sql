-- Step 6.3 (ADR-0046): milestones. Exit criteria (what must be true to call it done, optionally tied to a
-- task) and the history of the target date, so "slipped" is a fact and not a feeling.
BEGIN;

CREATE TABLE "milestone_criteria" (
  "id"           TEXT         NOT NULL,
  "iteration_id" TEXT         NOT NULL,
  "title"        TEXT         NOT NULL,
  "task_id"      TEXT,
  "done_at"      TIMESTAMP(3),
  "position"     INTEGER      NOT NULL,
  "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "milestone_criteria_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "milestone_criteria_iteration_id_fkey" FOREIGN KEY ("iteration_id")
    REFERENCES "iterations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  -- Deleting the task keeps the criterion (it becomes a plain, unmet one): the promise outlives the ticket.
  CONSTRAINT "milestone_criteria_task_id_fkey" FOREIGN KEY ("task_id")
    REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "ck_milestone_criteria_title" CHECK (char_length(btrim("title")) BETWEEN 1 AND 200),
  CONSTRAINT "ck_milestone_criteria_position" CHECK ("position" >= 0)
);
CREATE INDEX "idx_milestone_criteria_iteration" ON "milestone_criteria" ("iteration_id", "position");
CREATE INDEX "idx_milestone_criteria_task" ON "milestone_criteria" ("task_id");
-- A task backs at most one criterion of a milestone (Prisma cannot express a partial unique).
CREATE UNIQUE INDEX "uq_milestone_criteria_iteration_task"
  ON "milestone_criteria" ("iteration_id", "task_id") WHERE "task_id" IS NOT NULL;

CREATE TABLE "iteration_target_changes" (
  "id"            TEXT         NOT NULL,
  "iteration_id"  TEXT         NOT NULL,
  "previous_date" DATE,
  "new_date"      DATE,
  -- Who moved it. No foreign key on purpose: the history must survive the person leaving.
  "changed_by_id" TEXT,
  "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "iteration_target_changes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "iteration_target_changes_iteration_id_fkey" FOREIGN KEY ("iteration_id")
    REFERENCES "iterations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ck_iteration_target_changes_moved" CHECK ("previous_date" IS DISTINCT FROM "new_date")
);
CREATE INDEX "idx_iteration_target_changes_iteration" ON "iteration_target_changes" ("iteration_id", "created_at");

COMMIT;
