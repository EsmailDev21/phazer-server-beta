-- Step 3.5: Template + TemplateVersion (diagram 13). A version is IMMUTABLE: a trigger refuses
-- UPDATE, and refuses a direct DELETE (only the cascade from deleting its template is allowed).
BEGIN;

CREATE TYPE "template_kind" AS ENUM ('WORKSPACE', 'PROJECT');
CREATE TYPE "template_visibility" AS ENUM ('PRIVATE', 'ACCOUNT');

CREATE TABLE "templates" (
  "id"                TEXT                   NOT NULL,
  "owner_account_id"  TEXT                   NOT NULL,
  "created_by_id"     TEXT                   NOT NULL,
  "kind"              "template_kind"        NOT NULL,
  "visibility"        "template_visibility"  NOT NULL DEFAULT 'PRIVATE',
  "name"              TEXT                   NOT NULL,
  "description"       TEXT,
  "category"          TEXT,
  "tags"              TEXT[]                 NOT NULL DEFAULT ARRAY[]::TEXT[],
  "source_template_id" TEXT,
  "source_version_id"  TEXT,
  "created_at"        TIMESTAMP(3)           NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"        TIMESTAMP(3)           NOT NULL,
  CONSTRAINT "templates_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "templates_owner_account_id_fkey" FOREIGN KEY ("owner_account_id")
    REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "templates_created_by_id_fkey" FOREIGN KEY ("created_by_id")
    REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "templates_source_template_id_fkey" FOREIGN KEY ("source_template_id")
    REFERENCES "templates"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "ck_templates_name" CHECK (btrim("name") <> '' AND char_length("name") <= 120),
  CONSTRAINT "ck_templates_description" CHECK ("description" IS NULL OR char_length("description") <= 2000),
  CONSTRAINT "ck_templates_category" CHECK ("category" IS NULL OR "category" ~ '^[a-z][a-z0-9-]{0,39}$'),
  CONSTRAINT "ck_templates_tags" CHECK (cardinality("tags") <= 20),
  CONSTRAINT "ck_templates_not_own_fork" CHECK ("source_template_id" IS NULL OR "source_template_id" <> "id")
);

CREATE TABLE "template_versions" (
  "id"             TEXT         NOT NULL,
  "template_id"    TEXT         NOT NULL,
  "sequence"       INTEGER      NOT NULL,
  "semver"         TEXT         NOT NULL,
  "schema_version" INTEGER      NOT NULL,
  "blueprint"      JSONB        NOT NULL,
  "checksum"       TEXT         NOT NULL,
  "stats"          JSONB        NOT NULL,
  "size_bytes"     INTEGER      NOT NULL,
  "changelog"      TEXT,
  "created_by_id"  TEXT         NOT NULL,
  "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "template_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "template_versions_template_id_fkey" FOREIGN KEY ("template_id")
    REFERENCES "templates"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "template_versions_created_by_id_fkey" FOREIGN KEY ("created_by_id")
    REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ck_template_versions_sequence" CHECK ("sequence" >= 1),
  CONSTRAINT "ck_template_versions_semver" CHECK ("semver" ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'),
  CONSTRAINT "ck_template_versions_schema_version" CHECK ("schema_version" >= 1),
  CONSTRAINT "ck_template_versions_checksum" CHECK ("checksum" ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT "ck_template_versions_size" CHECK ("size_bytes" BETWEEN 2 AND 2097152),
  CONSTRAINT "ck_template_versions_blueprint_object" CHECK (jsonb_typeof("blueprint") = 'object'),
  CONSTRAINT "ck_template_versions_changelog" CHECK ("changelog" IS NULL OR char_length("changelog") <= 2000)
);

-- Added after both tables exist (the two reference each other).
ALTER TABLE "templates" ADD CONSTRAINT "templates_source_version_id_fkey"
  FOREIGN KEY ("source_version_id") REFERENCES "template_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "uq_template_versions_template_sequence" ON "template_versions"("template_id", "sequence");
CREATE UNIQUE INDEX "uq_template_versions_template_semver"   ON "template_versions"("template_id", "semver");
CREATE INDEX "idx_templates_owner_account_created" ON "templates"("owner_account_id", "created_at");
CREATE INDEX "idx_templates_source_template"       ON "templates"("source_template_id");
CREATE INDEX "idx_templates_created_by"            ON "templates"("created_by_id");

-- IMMUTABILITY. A version is evidence of what was shared and what an install used: it never
-- changes. UPDATE is refused outright. DELETE is refused unless it is the cascade from deleting
-- the template (that runs inside the foreign-key trigger, so pg_trigger_depth() is >= 2 there).
CREATE FUNCTION "template_versions_immutable"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'template_versions rows are immutable (create a new version instead)'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'DELETE' AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'a template version cannot be deleted on its own (delete the template)'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_template_versions_immutable"
  BEFORE UPDATE OR DELETE ON "template_versions"
  FOR EACH ROW EXECUTE FUNCTION "template_versions_immutable"();

COMMIT;
