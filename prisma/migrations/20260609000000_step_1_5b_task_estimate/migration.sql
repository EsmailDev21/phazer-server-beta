-- Step 1.5 follow-up (ADR-0008): story points on tasks, for velocity.
BEGIN;
ALTER TABLE "tasks" ADD COLUMN "estimate" DOUBLE PRECISION;
ALTER TABLE "tasks" ADD CONSTRAINT "ck_tasks_estimate_range"
  CHECK ("estimate" IS NULL OR ("estimate" >= 0 AND "estimate" <= 1000));
COMMIT;
