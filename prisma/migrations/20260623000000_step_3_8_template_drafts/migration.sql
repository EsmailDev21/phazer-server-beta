-- Step 3.8: template drafts (the editor's work in progress) and the per-template editor key counter.
BEGIN;

ALTER TABLE "templates" ADD COLUMN "node_key_seq" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "templates" ADD CONSTRAINT "ck_templates_node_key_seq" CHECK ("node_key_seq" >= 0);

-- keys already minted in the editor's style ("n<digits>") inside stored versions must stay behind the counter
UPDATE "templates" t SET "node_key_seq" = COALESCE((
  SELECT MAX((m[1])::int)
  FROM "template_versions" v, LATERAL regexp_matches(v."blueprint"::text, '"(?:nodeKey|key)": "[na]([0-9]{1,9})"', 'g') AS m
  WHERE v."template_id" = t."id"
), 0);

CREATE TABLE "template_drafts" (
  "id"            TEXT         NOT NULL,
  "template_id"   TEXT         NOT NULL,
  "base_sequence" INTEGER      NOT NULL,
  "base_checksum" TEXT         NOT NULL,
  "blueprint"     JSONB        NOT NULL,
  "revision"      INTEGER      NOT NULL DEFAULT 1,
  "created_by_id" TEXT         NOT NULL,
  "updated_by_id" TEXT         NOT NULL,
  "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "template_drafts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "template_drafts_template_id_fkey" FOREIGN KEY ("template_id")
    REFERENCES "templates"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ck_template_drafts_revision" CHECK ("revision" >= 1),
  CONSTRAINT "ck_template_drafts_base" CHECK ("base_sequence" >= 1)
);
CREATE UNIQUE INDEX "template_drafts_template_id_key" ON "template_drafts"("template_id");

COMMIT;
