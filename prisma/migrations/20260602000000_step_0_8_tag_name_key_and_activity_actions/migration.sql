BEGIN;

-- AlterEnum: tag attach/detach history (step 0.8). Expand-only; first used by
-- application code shipped in the same release, never by this migration.
ALTER TYPE "activity_action" ADD VALUE 'TAG_ADDED';
ALTER TYPE "activity_action" ADD VALUE 'TAG_REMOVED';

-- AlterTable: normalized tag name, the thing uniqueness is enforced on.
ALTER TABLE "tags" ADD COLUMN "name_key" TEXT;

-- Backfill. Must stay in step with normalizeTagName() in the application:
--   NFKC -> collapse whitespace runs to one space -> trim -> lower-case.
-- (Postgres lower()/\s and JS toLowerCase()/\s can differ on exotic Unicode;
-- that can only make a LEGACY tag's key differ from what the app would compute
-- for the same text, never produce a false duplicate.)
UPDATE "tags"
SET "name_key" = lower(btrim(regexp_replace(normalize("name", NFKC), '\s+', ' ', 'g')));

-- Merge case-variant duplicates ("Bug"/"bug") that the old case-sensitive
-- unique index allowed. Keeper = smallest id per (workspace, key), so the
-- outcome is deterministic. Every task keeps its tag: links are re-pointed to
-- the keeper first (ON CONFLICT: the task already had both), then the losers
-- are deleted (their remaining task_tags rows cascade away).
WITH ranked AS (
  SELECT "id", "workspace_id", "name_key",
         first_value("id") OVER (
           PARTITION BY "workspace_id", "name_key" ORDER BY "id"
         ) AS "keeper_id"
  FROM "tags"
),
losers AS (
  SELECT "id" AS "loser_id", "keeper_id" FROM ranked WHERE "id" <> "keeper_id"
),
repoint AS (
  INSERT INTO "task_tags" ("task_id", "tag_id", "created_at")
  SELECT tt."task_id", l."keeper_id", min(tt."created_at")
  FROM "task_tags" tt
  JOIN losers l ON l."loser_id" = tt."tag_id"
  GROUP BY tt."task_id", l."keeper_id"
  ON CONFLICT ("task_id", "tag_id") DO NOTHING
  RETURNING 1
)
DELETE FROM "tags" WHERE "id" IN (SELECT "loser_id" FROM losers);

-- Contract: now safe.
ALTER TABLE "tags" ALTER COLUMN "name_key" SET NOT NULL;
ALTER TABLE "tags" ADD CONSTRAINT "ck_tags_name_key_not_blank" CHECK (btrim("name_key") <> '');
CREATE UNIQUE INDEX "uq_tags_workspace_id_name_key" ON "tags"("workspace_id", "name_key");
DROP INDEX "uq_tags_workspace_id_name";

COMMIT;
