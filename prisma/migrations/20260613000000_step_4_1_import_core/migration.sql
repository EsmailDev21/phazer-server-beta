-- Step 4.1: import core (ImportJob, ExternalRef, ImportJobIssue). Pre-launch: single migration, no choreography.
-- audit_action already has IMPORT_STARTED / IMPORT_COMPLETED / IMPORT_ROLLED_BACK (step 0.6).
BEGIN;

CREATE TYPE "import_job_status" AS ENUM (
  'DRAFT', 'SOURCES_SELECTED', 'MAPPING', 'PREVIEW_READY', 'QUEUED', 'RUNNING', 'PAUSED',
  'COMPLETED', 'COMPLETED_WITH_WARNINGS', 'FAILED', 'CANCELED', 'ROLLING_BACK', 'ROLLED_BACK'
);
CREATE TYPE "import_issue_severity" AS ENUM ('INFO', 'WARN', 'ERROR');

CREATE TABLE "import_jobs" (
  "id"              TEXT NOT NULL,
  "connection_id"   TEXT NOT NULL,
  "workspace_id"    TEXT NOT NULL,
  "created_by_id"   TEXT NOT NULL,
  "status"          "import_job_status" NOT NULL DEFAULT 'DRAFT',
  "selection"       JSONB,
  "mapping_config"  JSONB,
  "preview_summary" JSONB,
  "progress"        JSONB,
  "checkpoint"      JSONB,
  "options"         JSONB NOT NULL,
  "attempt"         INTEGER NOT NULL DEFAULT 0,
  "pause_reason"    TEXT,
  "started_at"      TIMESTAMP(3),
  "finished_at"     TIMESTAMP(3),
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "import_jobs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "import_jobs_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "integration_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "import_jobs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "import_jobs_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "idx_import_jobs_workspace_created" ON "import_jobs"("workspace_id", "created_at");
CREATE INDEX "idx_import_jobs_connection_status" ON "import_jobs"("connection_id", "status");
CREATE INDEX "idx_import_jobs_status" ON "import_jobs"("status");

CREATE TABLE "external_refs" (
  "id"            TEXT NOT NULL,
  "connection_id" TEXT NOT NULL,
  "import_job_id" TEXT NOT NULL,
  "external_type" TEXT NOT NULL,
  "external_id"   TEXT NOT NULL,
  "external_key"  TEXT,
  "local_type"    TEXT NOT NULL,
  "local_id"      TEXT NOT NULL,
  "content_hash"  TEXT,
  "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "external_refs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "external_refs_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "integration_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "external_refs_import_job_id_fkey" FOREIGN KEY ("import_job_id") REFERENCES "import_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "uq_external_refs_connection_type_external" ON "external_refs"("connection_id", "external_type", "external_id");
CREATE INDEX "idx_external_refs_job_local_type" ON "external_refs"("import_job_id", "local_type");
CREATE INDEX "idx_external_refs_local" ON "external_refs"("local_type", "local_id");

CREATE TABLE "import_job_issues" (
  "id"            TEXT NOT NULL,
  "import_job_id" TEXT NOT NULL,
  "severity"      "import_issue_severity" NOT NULL,
  "code"          TEXT NOT NULL,
  "external_ref"  TEXT,
  "message"       TEXT NOT NULL,
  "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "import_job_issues_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "import_job_issues_import_job_id_fkey" FOREIGN KEY ("import_job_id") REFERENCES "import_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "idx_import_job_issues_job_severity" ON "import_job_issues"("import_job_id", "severity", "created_at");

COMMIT;
