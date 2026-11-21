-- Step 1.4 (ADR-0006): workflow statuses. One migration (pre-launch stance).
BEGIN;

ALTER TYPE "activity_action" ADD VALUE 'WORKFLOW_CHANGED';

CREATE TABLE "workflow_statuses" (
  "id"                    TEXT         NOT NULL,
  "project_id"            TEXT         NOT NULL,
  "name"                  TEXT         NOT NULL,
  "name_key"              TEXT         NOT NULL,
  "color"                 TEXT         NOT NULL DEFAULT '#94A3B8',
  "position"              INTEGER      NOT NULL,
  "category"              "task_status" NOT NULL,
  "exclude_from_progress" BOOLEAN      NOT NULL DEFAULT false,
  "is_default"            BOOLEAN      NOT NULL DEFAULT false,
  "created_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"            TIMESTAMP(3) NOT NULL,
  CONSTRAINT "workflow_statuses_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "fk_workflow_statuses_project" FOREIGN KEY ("project_id")
    REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ck_workflow_statuses_name_key_not_blank" CHECK (btrim("name_key") <> ''),
  -- only a DONE-category status may be left out of progress (ADR-0006 decision 10)
  CONSTRAINT "ck_workflow_statuses_exclude_only_done"
    CHECK (NOT "exclude_from_progress" OR "category" = 'DONE')
);
CREATE UNIQUE INDEX "uq_workflow_statuses_project_name_key" ON "workflow_statuses"("project_id", "name_key");
CREATE INDEX "workflow_statuses_project_id_position_idx" ON "workflow_statuses"("project_id", "position");
-- Prisma cannot declare a partial unique index; this is the seat belt behind the
-- service's per-project lock: at most one default status per (project, category).
CREATE UNIQUE INDEX "uq_workflow_statuses_one_default_per_category"
  ON "workflow_statuses"("project_id", "category") WHERE "is_default";

CREATE TABLE "workflow_transitions" (
  "id"             TEXT NOT NULL,
  "project_id"     TEXT NOT NULL,
  "from_status_id" TEXT NOT NULL,
  "to_status_id"   TEXT NOT NULL,
  CONSTRAINT "workflow_transitions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "workflow_transitions_project_id_fkey" FOREIGN KEY ("project_id")
    REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "workflow_transitions_from_status_id_fkey" FOREIGN KEY ("from_status_id")
    REFERENCES "workflow_statuses"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "workflow_transitions_to_status_id_fkey" FOREIGN KEY ("to_status_id")
    REFERENCES "workflow_statuses"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ck_workflow_transitions_not_self" CHECK ("from_status_id" <> "to_status_id")
);
CREATE UNIQUE INDEX "uq_workflow_transitions_pair" ON "workflow_transitions"("from_status_id", "to_status_id");
CREATE INDEX "workflow_transitions_project_id_idx" ON "workflow_transitions"("project_id");

ALTER TABLE "projects"
  ADD COLUMN "enforce_transitions" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "default_workflow_status_id" TEXT;
ALTER TABLE "projects" ADD CONSTRAINT "fk_projects_default_workflow_status"
  FOREIGN KEY ("default_workflow_status_id") REFERENCES "workflow_statuses"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- SET NULL, not RESTRICT: deleting a project cascades its statuses while its tasks
-- fall back to the Inbox (tasks.project_id is SET NULL), and that must not be blocked.
-- "Deleting a status needs a reassignment target" is the service's rule (ADR-0006 d.8).
ALTER TABLE "tasks" ADD COLUMN "workflow_status_id" TEXT;
ALTER TABLE "tasks" ADD CONSTRAINT "fk_tasks_workflow_status"
  FOREIGN KEY ("workflow_status_id") REFERENCES "workflow_statuses"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "idx_tasks_workflow_status_id" ON "tasks"("workflow_status_id");

-- Seed: four statuses per EXISTING project (one per category, each the category default).
-- Ids are uuid-derived text (any unique string is a valid id; app-created ones are cuids).
INSERT INTO "workflow_statuses"
  ("id","project_id","name","name_key","color","position","category","is_default","updated_at")
SELECT 'wfs_' || replace(gen_random_uuid()::text, '-', ''), p."id", v.name, lower(v.name), v.color, v.pos, v.cat::"task_status", true, CURRENT_TIMESTAMP
FROM "projects" p
CROSS JOIN (VALUES
  ('To Do',       '#94A3B8', 0, 'TODO'),
  ('In Progress', '#3B82F6', 1, 'IN_PROGRESS'),
  ('Blocked',     '#EF4444', 2, 'BLOCKED'),
  ('Done',        '#22C55E', 3, 'DONE')
) AS v(name, color, pos, cat);

UPDATE "projects" p SET "default_workflow_status_id" = s."id"
FROM "workflow_statuses" s
WHERE s."project_id" = p."id" AND s."category" = 'TODO' AND s."is_default";

UPDATE "tasks" t SET "workflow_status_id" = s."id"
FROM "workflow_statuses" s
WHERE t."project_id" IS NOT NULL
  AND s."project_id" = t."project_id" AND s."category" = t."status" AND s."is_default";

COMMIT;
