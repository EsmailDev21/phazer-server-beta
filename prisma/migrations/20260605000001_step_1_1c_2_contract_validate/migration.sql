-- Step 1.1c (2/4): validate the existing rows. VALIDATE CONSTRAINT takes only a
-- SHARE UPDATE EXCLUSIVE lock, so reads AND writes continue while it scans.
BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "tasks" WHERE "number" IS NULL) THEN
    RAISE EXCEPTION 'Contract blocked: some tasks still have no number. Run `npm run backfill:task-keys` until it reports "remaining: 0 ... 0", then retry this migration.';
  END IF;
END $$;

ALTER TABLE "tasks" VALIDATE CONSTRAINT "ck_tasks_number_positive";
ALTER TABLE "tasks" VALIDATE CONSTRAINT "ck_tasks_number_not_null";

COMMIT;
