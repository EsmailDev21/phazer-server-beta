-- Step 5.15: a rule can WAIT (a durable delay).
--
-- When a run reaches a WAIT it stops, and what is left of it is saved here: a snapshot of the rule's
-- actions (so editing the rule later does not change a wait already in flight) and the position in that
-- tree (`frames`: for each enclosing list, where to carry on, and the run context it had). A job picks up
-- the waits that are due and finishes them.
--
-- Statuses: PENDING (waiting) -> RESUMING (claimed: at most once, like every run) -> DONE | FAILED, or
-- CANCELLED (the rule is off, the task is gone, or someone cancelled it). A RESUMING wait that is never
-- finished (the worker died) is marked FAILED by the job, not retried.
BEGIN;

CREATE TYPE "automation_wait_status" AS ENUM ('PENDING', 'RESUMING', 'DONE', 'FAILED', 'CANCELLED');

CREATE TABLE "automation_waits" (
  "id"            TEXT NOT NULL,
  "workspace_id"  TEXT NOT NULL,
  -- deleting the rule deletes its waits
  "automation_id" TEXT NOT NULL,
  -- the run that started the wait, and the task it is about, may go away
  "run_id"        TEXT,
  "task_id"       TEXT,
  "resume_at"     TIMESTAMP(3) NOT NULL,
  "status"        "automation_wait_status" NOT NULL DEFAULT 'PENDING',
  "actions"       JSONB NOT NULL,
  "frames"        JSONB NOT NULL,
  "error"         TEXT,
  "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resumed_at"    TIMESTAMP(3),
  CONSTRAINT "automation_waits_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "fk_automation_waits_workspace" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "fk_automation_waits_automation" FOREIGN KEY ("automation_id") REFERENCES "automations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "fk_automation_waits_run" FOREIGN KEY ("run_id") REFERENCES "automation_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "fk_automation_waits_task" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "ck_automation_waits_size" CHECK (pg_column_size("actions") + pg_column_size("frames") <= 262144)
);

-- the job's question: which waits are due?
CREATE INDEX "idx_automation_waits_due" ON "automation_waits" ("status", "resume_at");
CREATE INDEX "idx_automation_waits_workspace" ON "automation_waits" ("workspace_id", "status");
CREATE INDEX "idx_automation_waits_automation" ON "automation_waits" ("automation_id", "status");
CREATE INDEX "idx_automation_waits_task" ON "automation_waits" ("task_id");

COMMIT;
