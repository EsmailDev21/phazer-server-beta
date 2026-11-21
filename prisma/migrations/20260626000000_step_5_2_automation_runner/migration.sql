-- Step 5.2: the rule runner.
--   * creation_mode gains AUTOMATION (WriteContext.origin of a write a rule made)
--   * automations.paused_reason: why the runner switched a rule off (loop / rate breaker); only ever set while off
-- ADD VALUE cannot be used in the transaction that adds it, so nothing below refers to 'AUTOMATION'.
ALTER TYPE "creation_mode" ADD VALUE IF NOT EXISTS 'AUTOMATION';

BEGIN;
ALTER TABLE "automations" ADD COLUMN "paused_reason" TEXT;
ALTER TABLE "automations" ADD CONSTRAINT "ck_automations_paused" CHECK (
  "paused_reason" IS NULL OR (NOT "enabled" AND length("paused_reason") <= 300)
);
COMMIT;
