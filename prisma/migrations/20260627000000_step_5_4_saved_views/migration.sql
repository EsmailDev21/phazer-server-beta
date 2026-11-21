-- Step 5.4: saved views (personal and shared). Running a view is not part of this step.
BEGIN;

CREATE TYPE "saved_view_layout" AS ENUM ('LIST', 'BOARD', 'TABLE', 'CALENDAR', 'TIMELINE');

CREATE TABLE "saved_views" (
  "id"           TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "project_id"   TEXT,
  "owner_id"     TEXT,
  "name"         TEXT NOT NULL,
  "name_key"     TEXT NOT NULL,
  "layout"       "saved_view_layout" NOT NULL,
  "config"       JSONB NOT NULL,
  "is_shared"    BOOLEAN NOT NULL DEFAULT false,
  "position"     INTEGER NOT NULL DEFAULT 0,
  "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "saved_views_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "fk_saved_views_workspace" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "fk_saved_views_project" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  -- a shared view outlives the person who made it; a personal one cannot exist without its owner
  CONSTRAINT "fk_saved_views_owner" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "ck_saved_views_personal_has_owner" CHECK ("is_shared" OR "owner_id" IS NOT NULL),
  CONSTRAINT "ck_saved_views_name" CHECK (length("name") BETWEEN 1 AND 120 AND length("name_key") BETWEEN 1 AND 480),
  CONSTRAINT "ck_saved_views_config" CHECK (jsonb_typeof("config") = 'object' AND octet_length("config"::text) <= 16384),
  CONSTRAINT "ck_saved_views_position" CHECK ("position" BETWEEN 0 AND 100000)
);

-- names: unique per owner for personal views, per workspace for shared ones; within one scope (project or whole workspace)
CREATE UNIQUE INDEX "uq_saved_views_personal_name" ON "saved_views" ("workspace_id", COALESCE("project_id", ''), "owner_id", "name_key") WHERE NOT "is_shared";
CREATE UNIQUE INDEX "uq_saved_views_shared_name" ON "saved_views" ("workspace_id", COALESCE("project_id", ''), "name_key") WHERE "is_shared";
CREATE INDEX "idx_saved_views_workspace_shared" ON "saved_views" ("workspace_id", "is_shared");
CREATE INDEX "saved_views_owner_id_idx" ON "saved_views" ("owner_id");
CREATE INDEX "saved_views_project_id_idx" ON "saved_views" ("project_id");

-- Deleting a user removes their PERSONAL views (nobody else could ever see them) and leaves shared ones
-- ownerless (the foreign key's SET NULL). The trigger runs BEFORE the foreign key's own action, which
-- would otherwise try to null the owner of a personal view and trip ck_saved_views_personal_has_owner.
CREATE FUNCTION "saved_views_delete_personal_of_user"() RETURNS trigger AS $$
BEGIN
  DELETE FROM "saved_views" WHERE "owner_id" = OLD."id" AND NOT "is_shared";
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_users_delete_personal_views" BEFORE DELETE ON "users"
  FOR EACH ROW EXECUTE FUNCTION "saved_views_delete_personal_of_user"();

COMMIT;
