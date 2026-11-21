-- Step 1.1c (1/4): CONTRACT, part 1. ADR-0004. DO NOT DEPLOY in the same release
-- as the expand migration (README rule 3). Preconditions, all of them:
--   * the expand migration (1.1a) has been deployed,
--   * EVERY application instance is on that release or later (instances from
--     before it insert workspaces without a key; after this migration those
--     inserts FAIL, by design),
--   * `npm run backfill:task-keys` has reported "remaining: 0 ... 0".
--
-- The contract is four migration files so that no lock on the (large) tasks
-- table is held across a table scan or index build. If a later one fails, fix
-- the cause and use `prisma migrate resolve` as usual; nothing here is
-- destructive and every step is safe to re-run after it is fixed.
BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "workspaces" WHERE "key" IS NULL) THEN
    RAISE EXCEPTION 'Contract blocked: some workspaces still have no key. Run `npm run backfill:task-keys` until it reports "remaining: 0 ... 0", then retry.';
  END IF;
END $$;

-- workspaces is small: a plain SET NOT NULL (brief scan) is fine.
ALTER TABLE "workspaces" ALTER COLUMN "key" SET NOT NULL;

-- tasks is large. NOT VALID adds the rule for every row written FROM NOW ON
-- without scanning the existing ones, so the window in which a stray NULL can
-- still appear closes immediately. Part 2 validates the old rows without
-- blocking writes.
ALTER TABLE "tasks" ADD CONSTRAINT "ck_tasks_number_not_null"
  CHECK ("number" IS NOT NULL) NOT VALID;

COMMIT;
