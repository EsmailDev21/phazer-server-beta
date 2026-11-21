-- Step 5.1: automations (rules as data) and their run log. Nothing executes them yet (5.2).
BEGIN;

CREATE TYPE "automation_origin" AS ENUM ('USER', 'TEMPLATE', 'IMPORT', 'GITHUB_RULE');
CREATE TYPE "automation_run_status" AS ENUM ('OK', 'SKIPPED', 'FAILED');

CREATE TABLE "automations" (
  "id"                TEXT NOT NULL,
  "workspace_id"      TEXT NOT NULL,
  "project_id"        TEXT,
  "name"              TEXT NOT NULL,
  "name_key"          TEXT NOT NULL,
  "enabled"           BOOLEAN NOT NULL DEFAULT false,
  "rule_version"      INTEGER NOT NULL DEFAULT 1,
  "trigger_type"      TEXT NOT NULL,
  "trigger"           JSONB NOT NULL,
  "conditions"        JSONB NOT NULL DEFAULT '{}',
  "actions"           JSONB NOT NULL DEFAULT '[]',
  "unsupported"       JSONB NOT NULL DEFAULT '[]',
  "source_definition" JSONB,
  "created_via"       "automation_origin" NOT NULL DEFAULT 'USER',
  "created_by_id"     TEXT NOT NULL,
  "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "automations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "fk_automations_workspace" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "fk_automations_project" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "fk_automations_creator" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,

  CONSTRAINT "ck_automations_rule_version" CHECK ("rule_version" IN (0, 1)),
  CONSTRAINT "ck_automations_name" CHECK (length("name") BETWEEN 1 AND 120 AND length("name_key") BETWEEN 1 AND 480),
  CONSTRAINT "ck_automations_json_shapes" CHECK (
    jsonb_typeof("trigger") = 'object' AND jsonb_typeof("conditions") = 'object'
    AND jsonb_typeof("actions") = 'array' AND jsonb_typeof("unsupported") = 'array'
  ),
  -- a raw (untranslated) rule: no executable parts, its source kept, never enabled
  CONSTRAINT "ck_automations_raw" CHECK (
    ("rule_version" = 0) = ("trigger_type" = 'RAW')
    AND ("rule_version" <> 0 OR ("source_definition" IS NOT NULL AND NOT "enabled"
         AND "trigger" = '{}'::jsonb AND "conditions" = '{}'::jsonb AND "actions" = '[]'::jsonb))
  ),
  -- an executable rule names its trigger and does something
  CONSTRAINT "ck_automations_executable" CHECK (
    "rule_version" = 0
    OR ("trigger" ->> 'type' = "trigger_type" AND jsonb_array_length("actions") BETWEEN 1 AND 10)
  ),
  -- a rule with something this build cannot execute can be stored, never switched on
  CONSTRAINT "ck_automations_enabled_runnable" CHECK (NOT "enabled" OR jsonb_array_length("unsupported") = 0),
  CONSTRAINT "ck_automations_size" CHECK (
    pg_column_size("trigger") + pg_column_size("conditions") + pg_column_size("actions") <= 65536
    AND ("source_definition" IS NULL OR pg_column_size("source_definition") <= 262144)
  )
);

CREATE UNIQUE INDEX "uq_automations_workspace_name_key" ON "automations" ("workspace_id", "name_key");
CREATE INDEX "idx_automations_runner" ON "automations" ("workspace_id", "trigger_type", "enabled");
CREATE INDEX "automations_project_id_idx" ON "automations" ("project_id");

CREATE TABLE "automation_runs" (
  "id"            TEXT NOT NULL,
  "automation_id" TEXT NOT NULL,
  "workspace_id"  TEXT NOT NULL,
  "task_id"       TEXT,
  "event_id"      TEXT NOT NULL,
  "status"        "automation_run_status" NOT NULL,
  "error"         TEXT,
  "depth"         INTEGER NOT NULL DEFAULT 0,
  "actions_run"   INTEGER NOT NULL DEFAULT 0,
  "details"       JSONB,
  "ran_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "automation_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "fk_automation_runs_automation" FOREIGN KEY ("automation_id") REFERENCES "automations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "fk_automation_runs_workspace" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "fk_automation_runs_task" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "ck_automation_runs_depth" CHECK ("depth" BETWEEN 0 AND 10),
  CONSTRAINT "ck_automation_runs_actions" CHECK ("actions_run" BETWEEN 0 AND 10),
  CONSTRAINT "ck_automation_runs_error" CHECK ("error" IS NULL OR length("error") <= 500),
  CONSTRAINT "ck_automation_runs_event" CHECK (length("event_id") BETWEEN 1 AND 200)
);

CREATE UNIQUE INDEX "uq_automation_runs_event" ON "automation_runs" ("automation_id", "event_id");
CREATE INDEX "automation_runs_automation_id_ran_at_idx" ON "automation_runs" ("automation_id", "ran_at");
CREATE INDEX "automation_runs_workspace_id_ran_at_idx" ON "automation_runs" ("workspace_id", "ran_at");

COMMIT;
