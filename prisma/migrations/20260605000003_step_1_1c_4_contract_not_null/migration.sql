-- Step 1.1c (4/4): finish. Because the CHECK (number IS NOT NULL) is VALIDATED,
-- PostgreSQL 12+ turns SET NOT NULL into a metadata-only change (no scan, so no
-- long exclusive lock). The helper check is then redundant.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE c.relname = 'uq_tasks_workspace_id_number' AND i.indisvalid
  ) THEN
    RAISE EXCEPTION 'Contract blocked: index uq_tasks_workspace_id_number is missing or INVALID. DROP it if it exists and re-run migration 3.';
  END IF;
END $$;

ALTER TABLE "tasks" ALTER COLUMN "number" SET NOT NULL;
ALTER TABLE "tasks" DROP CONSTRAINT "ck_tasks_number_not_null";

COMMIT;
