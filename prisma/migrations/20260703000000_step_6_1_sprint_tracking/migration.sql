-- Step 6.1 (ADR-0044): sprint tracking. What the sprint committed to when it started, and one row per
-- day of what was left, so a burndown can be drawn (estimates have no history to rebuild it from).
BEGIN;

ALTER TABLE "iterations" ADD COLUMN "start_summary" JSONB;
ALTER TABLE "iterations"
  ADD CONSTRAINT "ck_iterations_start_summary_is_object"
  CHECK ("start_summary" IS NULL OR jsonb_typeof("start_summary") = 'object');

CREATE TABLE "iteration_snapshots" (
  "iteration_id"     TEXT             NOT NULL,
  "day"              DATE             NOT NULL,
  "total_points"     DOUBLE PRECISION NOT NULL,
  "total_count"      INTEGER          NOT NULL,
  "remaining_points" DOUBLE PRECISION NOT NULL,
  "remaining_count"  INTEGER          NOT NULL,
  "created_at"       TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"       TIMESTAMP(3)     NOT NULL,
  CONSTRAINT "iteration_snapshots_pkey" PRIMARY KEY ("iteration_id", "day"),
  CONSTRAINT "iteration_snapshots_iteration_id_fkey" FOREIGN KEY ("iteration_id")
    REFERENCES "iterations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ck_iteration_snapshots_non_negative" CHECK (
    "total_points" >= 0 AND "total_count" >= 0 AND "remaining_points" >= 0 AND "remaining_count" >= 0
  ),
  CONSTRAINT "ck_iteration_snapshots_remaining_within_total" CHECK (
    "remaining_points" <= "total_points" AND "remaining_count" <= "total_count"
  )
);

COMMIT;
