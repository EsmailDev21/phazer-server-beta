-- Step 3.9: first-party (seed) templates.
--   * template_visibility gains PUBLIC (readable/appliable/forkable by every signed-in user)
--   * accounts.is_system marks THE system account that owns the seeds (at most one)
--   * templates.seed_key is the stable identity of a seed, so re-seeding finds it instead of duplicating it
-- ADD VALUE cannot be used in the transaction that adds it, so nothing below refers to 'PUBLIC'.
ALTER TYPE "template_visibility" ADD VALUE IF NOT EXISTS 'PUBLIC';

BEGIN;

ALTER TABLE "accounts" ADD COLUMN "is_system" BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX "uq_accounts_one_system" ON "accounts" ("is_system") WHERE "is_system";

ALTER TABLE "templates" ADD COLUMN "seed_key" TEXT;
CREATE UNIQUE INDEX "uq_templates_seed_key" ON "templates" ("seed_key");
ALTER TABLE "templates" ADD CONSTRAINT "ck_templates_seed_key_shape"
  CHECK ("seed_key" IS NULL OR "seed_key" ~ '^[a-z][a-z0-9-]{1,63}$');

COMMIT;
