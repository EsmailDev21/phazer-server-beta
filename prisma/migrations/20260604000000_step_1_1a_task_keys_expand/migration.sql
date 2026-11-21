-- Step 1.1a: EXPAND (ADR-0004). Expand -> backfill -> contract: this is only the
-- first third. Everything added here is nullable or defaulted, so it is safe to
-- run against a live database and to have old application instances still
-- writing. The backfill (npm run backfill:task-keys) and the contract migration
-- (a LATER deploy) follow; see docs/design/IMPLEMENTATION.md step 1.1.
BEGIN;

ALTER TYPE "audit_action" ADD VALUE 'WORKSPACE_KEY_CHANGED';

-- workspaces: key (NULL until backfilled) and the next-number counter.
-- ADD COLUMN ... NOT NULL DEFAULT <constant> is metadata-only on PostgreSQL 11+.
ALTER TABLE "workspaces" ADD COLUMN "key" TEXT;
ALTER TABLE "workspaces" ADD COLUMN "next_task_number" INTEGER NOT NULL DEFAULT 1;
-- A non-NULL key must be well formed (ADR-0004 decision 2). NULL passes: it
-- means "not backfilled yet". workspaces is a small table, so a plain
-- (validating) constraint is fine here.
ALTER TABLE "workspaces" ADD CONSTRAINT "ck_workspaces_key_format"
  CHECK ("key" IS NULL OR "key" ~ '^[A-Z][A-Z0-9]{1,9}$');
ALTER TABLE "workspaces" ADD CONSTRAINT "ck_workspaces_next_task_number_positive"
  CHECK ("next_task_number" >= 1);
-- Unique per account. Created NOW, not in the contract step: workspaces is tiny
-- and every key is NULL (NULLs never collide), and concurrent key assignment
-- (workspace create / rename / backfill) needs the database to arbitrate
-- from the first day.
CREATE UNIQUE INDEX "uq_workspaces_account_id_key" ON "workspaces"("account_id", "key");

-- tasks: the number. NULL until backfilled (and for rows written by old app
-- instances during the rollout - the backfill picks those up too).
ALTER TABLE "tasks" ADD COLUMN "number" INTEGER;
-- NOT VALID: enforced for every new/updated row immediately, but the existing
-- (huge) table is NOT scanned under an exclusive lock. The contract migration
-- runs VALIDATE CONSTRAINT, which only takes a SHARE UPDATE EXCLUSIVE lock.
ALTER TABLE "tasks" ADD CONSTRAINT "ck_tasks_number_positive"
  CHECK ("number" IS NULL OR "number" >= 1) NOT VALID;
-- NOTE: UNIQUE ("workspace_id", "number") is deliberately NOT created here. On
-- a large tasks table the index build blocks writes, so it belongs to the
-- contract step, after the backfill has filled the column.

-- Retired keys: stay reserved, stay resolvable (ADR-0004 decision 4).
CREATE TABLE "workspace_key_aliases" (
  "id" TEXT NOT NULL,
  "account_id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "fk_workspace_key_aliases_account_id"
    FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE,
  CONSTRAINT "fk_workspace_key_aliases_workspace_id"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE,
  CONSTRAINT "ck_workspace_key_aliases_key_format"
    CHECK ("key" ~ '^[A-Z][A-Z0-9]{1,9}$')
);
CREATE UNIQUE INDEX "uq_workspace_key_aliases_account_id_key"
  ON "workspace_key_aliases"("account_id", "key");
CREATE INDEX "idx_workspace_key_aliases_workspace_id"
  ON "workspace_key_aliases"("workspace_id");

COMMIT;
