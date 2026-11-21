-- Step 4.6: comments, activity history and attachments of an import.
-- New enum values are only USED by application code shipped in the same release (never by this migration).
ALTER TYPE "activity_visibility" ADD VALUE 'IMPORTED';
ALTER TYPE "activity_action" ADD VALUE 'IMPORTED_CHANGE';

-- Dedupe key of copied files (hex SHA-256), indexed with the account.
ALTER TABLE "attachments" ADD COLUMN "sha256" TEXT;
CREATE INDEX "idx_attachments_account_sha256" ON "attachments"("account_id", "sha256");

-- The files an import still has to copy (diagram 05, lane "Attachment copy").
CREATE TABLE "import_file_items" (
  "id"                TEXT NOT NULL,
  "import_job_id"     TEXT NOT NULL,
  "external_id"       TEXT NOT NULL,
  "task_id"           TEXT NOT NULL,
  "file_name"         TEXT NOT NULL,
  "mime_type"         TEXT,
  "size_bytes"        INTEGER,
  "provider_ref"      TEXT NOT NULL,
  "uploaded_by_id"    TEXT NOT NULL,
  "source_created_at" TIMESTAMP(3),
  "status"            TEXT NOT NULL DEFAULT 'PENDING',
  "attempts"          INTEGER NOT NULL DEFAULT 0,
  "attachment_id"     TEXT,
  "note"              TEXT,
  "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "import_file_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "import_file_items_import_job_id_fkey" FOREIGN KEY ("import_job_id") REFERENCES "import_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "uq_import_file_items" ON "import_file_items"("import_job_id", "task_id", "external_id");
CREATE INDEX "idx_import_file_items_job_status" ON "import_file_items"("import_job_id", "status", "id");
