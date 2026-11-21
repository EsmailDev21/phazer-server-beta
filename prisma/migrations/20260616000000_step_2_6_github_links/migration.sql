BEGIN;

-- Step 2.6 (ADR-0014). Expand only; first used by application code shipped in the same release.
ALTER TYPE "activity_action" ADD VALUE 'EXTERNAL_LINKED';

-- Per-link provider settings (GitHub REPO links keep their status rules here until Phase 5 moves them to Automations).
ALTER TABLE "channel_links" ADD COLUMN "config" JSONB;

COMMIT;
