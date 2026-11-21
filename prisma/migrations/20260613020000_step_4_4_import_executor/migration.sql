-- Step 4.4: links (parent / dependency) whose other end is on a later page of the same import.
CREATE TABLE "import_pending_links" (
  "id"               TEXT NOT NULL,
  "import_job_id"    TEXT NOT NULL,
  "kind"             TEXT NOT NULL,
  "from_external_id"  TEXT NOT NULL,
  "to_external_id"    TEXT NOT NULL,
  "dep_type"         TEXT NOT NULL DEFAULT '',
  "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "import_pending_links_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "import_pending_links_import_job_id_fkey" FOREIGN KEY ("import_job_id") REFERENCES "import_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "uq_import_pending_links" ON "import_pending_links"("import_job_id", "kind", "from_external_id", "to_external_id", "dep_type");
CREATE INDEX "idx_import_pending_links_job" ON "import_pending_links"("import_job_id", "id");
