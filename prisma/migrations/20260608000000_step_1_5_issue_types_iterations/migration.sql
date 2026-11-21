-- Step 1.5 (ADR-0007): issue types and iterations. One migration (pre-launch stance).
BEGIN;

ALTER TYPE "activity_action" ADD VALUE 'ISSUE_TYPE_CHANGED';
ALTER TYPE "activity_action" ADD VALUE 'ITERATION_CHANGED';

CREATE TYPE "issue_type_level" AS ENUM ('EPIC', 'STANDARD', 'SUBTASK');
CREATE TYPE "iteration_kind"   AS ENUM ('SPRINT', 'CYCLE', 'MILESTONE');
CREATE TYPE "iteration_state"  AS ENUM ('PLANNED', 'ACTIVE', 'CLOSED');

CREATE TABLE "issue_types" (
  "id"           TEXT         NOT NULL,
  "workspace_id" TEXT         NOT NULL,
  "name"         TEXT         NOT NULL,
  "name_key"     TEXT         NOT NULL,
  "icon"         TEXT,
  "color"        TEXT         NOT NULL DEFAULT '#94A3B8',
  "level"        "issue_type_level" NOT NULL DEFAULT 'STANDARD',
  "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "issue_types_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "issue_types_workspace_id_fkey" FOREIGN KEY ("workspace_id")
    REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ck_issue_types_name_key_not_blank" CHECK (btrim("name_key") <> '')
);
CREATE UNIQUE INDEX "uq_issue_types_workspace_name_key" ON "issue_types"("workspace_id", "name_key");

CREATE TABLE "iterations" (
  "id"            TEXT         NOT NULL,
  "workspace_id"  TEXT         NOT NULL,
  "project_id"    TEXT,
  "kind"          "iteration_kind"  NOT NULL,
  "name"          TEXT         NOT NULL,
  "goal"          TEXT,
  "start_date"    DATE,
  "end_date"      DATE,
  "state"         "iteration_state" NOT NULL DEFAULT 'PLANNED',
  "closed_at"     TIMESTAMP(3),
  "close_summary" JSONB,
  "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "iterations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "iterations_workspace_id_fkey" FOREIGN KEY ("workspace_id")
    REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  -- a project's iterations go with the project (its tasks fall back to the Inbox anyway)
  CONSTRAINT "iterations_project_id_fkey" FOREIGN KEY ("project_id")
    REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ck_iterations_dates_ordered"
    CHECK ("start_date" IS NULL OR "end_date" IS NULL OR "end_date" >= "start_date"),
  CONSTRAINT "ck_iterations_closed_at_matches_state"
    CHECK (("state" = 'CLOSED') = ("closed_at" IS NOT NULL))
);
CREATE INDEX "iterations_workspace_id_state_idx" ON "iterations"("workspace_id", "state");
CREATE INDEX "iterations_project_id_idx" ON "iterations"("project_id");

ALTER TABLE "tasks"
  ADD COLUMN "issue_type_id" TEXT,
  ADD COLUMN "iteration_id"  TEXT;
ALTER TABLE "tasks" ADD CONSTRAINT "fk_tasks_issue_type"
  FOREIGN KEY ("issue_type_id") REFERENCES "issue_types"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "tasks" ADD CONSTRAINT "fk_tasks_iteration"
  FOREIGN KEY ("iteration_id") REFERENCES "iterations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "idx_tasks_issue_type_id" ON "tasks"("issue_type_id");
CREATE INDEX "idx_tasks_iteration_id" ON "tasks"("iteration_id");

COMMIT;
