-- Step 6.0 (ADR-0043): per-kind settings of an iteration. One nullable JSONB object, validated by the
-- app per kind (iteration-kinds.ts); the database only guarantees it is an object when present.
ALTER TABLE "iterations" ADD COLUMN "config" JSONB;
ALTER TABLE "iterations"
  ADD CONSTRAINT "ck_iterations_config_is_object"
  CHECK ("config" IS NULL OR jsonb_typeof("config") = 'object');
