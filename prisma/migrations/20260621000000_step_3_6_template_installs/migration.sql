-- Step 3.6: TemplateInstall + TemplateInstallItem. The record of what an apply created / reused;
-- it powers undo (and, later, upgrades).
BEGIN;

CREATE TYPE "template_install_mode"   AS ENUM ('NEW_WORKSPACE', 'MERGE');
CREATE TYPE "template_install_status" AS ENUM ('APPLYING', 'APPLIED', 'FAILED', 'UNDONE');
CREATE TYPE "template_install_action" AS ENUM ('CREATED', 'REUSED', 'SKIPPED');

CREATE TABLE "template_installs" (
  "id"               TEXT                      NOT NULL,
  "version_id"       TEXT,
  "template_name"    TEXT                      NOT NULL,
  "version_semver"   TEXT                      NOT NULL,
  "version_checksum" TEXT                      NOT NULL,
  "account_id"       TEXT                      NOT NULL,
  "workspace_id"     TEXT                      NOT NULL,
  "applied_by_id"    TEXT                      NOT NULL,
  "mode"             "template_install_mode"   NOT NULL,
  "variables"        JSONB                     NOT NULL DEFAULT '{}',
  "role_assignments" JSONB                     NOT NULL DEFAULT '{}',
  "module_selection" JSONB                     NOT NULL DEFAULT '{}',
  "status"           "template_install_status" NOT NULL DEFAULT 'APPLYING',
  "report"           JSONB                     NOT NULL DEFAULT '{}',
  "started_at"       TIMESTAMP(3)              NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finished_at"      TIMESTAMP(3),
  "undone_at"        TIMESTAMP(3),
  "created_at"       TIMESTAMP(3)              NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "template_installs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "template_installs_version_id_fkey" FOREIGN KEY ("version_id")
    REFERENCES "template_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "template_installs_account_id_fkey" FOREIGN KEY ("account_id")
    REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "template_installs_workspace_id_fkey" FOREIGN KEY ("workspace_id")
    REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "template_installs_applied_by_id_fkey" FOREIGN KEY ("applied_by_id")
    REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ck_template_installs_finished" CHECK (
    ("status" = 'APPLYING' AND "finished_at" IS NULL) OR ("status" <> 'APPLYING')
  )
);

CREATE TABLE "template_install_items" (
  "id"          TEXT                      NOT NULL,
  "install_id"  TEXT                      NOT NULL,
  "entity_type" TEXT                      NOT NULL,
  "entity_id"   TEXT                      NOT NULL,
  "node_key"    TEXT,
  "action"      "template_install_action" NOT NULL,
  "undone_at"   TIMESTAMP(3),
  "created_at"  TIMESTAMP(3)              NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "template_install_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "template_install_items_install_id_fkey" FOREIGN KEY ("install_id")
    REFERENCES "template_installs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ck_template_install_items_type" CHECK (
    "entity_type" IN ('TAG', 'CUSTOM_FIELD', 'ISSUE_TYPE', 'ITERATION', 'PROJECT', 'TASK')
  )
);

CREATE UNIQUE INDEX "uq_template_install_items_entity" ON "template_install_items"("install_id", "entity_type", "entity_id");
CREATE INDEX "idx_template_install_items_install_type" ON "template_install_items"("install_id", "entity_type");
CREATE INDEX "idx_template_install_items_entity"       ON "template_install_items"("entity_type", "entity_id");
CREATE INDEX "idx_template_installs_workspace_created" ON "template_installs"("workspace_id", "created_at");
CREATE INDEX "idx_template_installs_version"           ON "template_installs"("version_id");
CREATE INDEX "idx_template_installs_applied_by"        ON "template_installs"("applied_by_id");

-- At most ONE apply running per workspace: two concurrent applies would interleave their chunks
-- and their undo records. A second request fails fast instead of waiting.
CREATE UNIQUE INDEX "uq_template_installs_one_applying_per_workspace"
  ON "template_installs"("workspace_id") WHERE "status" = 'APPLYING';

COMMIT;
