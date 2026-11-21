-- Step 3.7: reference files carried by templates, and the install-item type for the copies an apply makes.
BEGIN;

CREATE TABLE "template_assets" (
  "id"            TEXT         NOT NULL,
  "template_id"   TEXT         NOT NULL,
  "sha256"        TEXT         NOT NULL,
  "file_name"     TEXT         NOT NULL,
  "mime_type"     TEXT         NOT NULL,
  "size_bytes"    INTEGER      NOT NULL,
  "storage_key"   TEXT         NOT NULL,
  "created_by_id" TEXT,
  "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "template_assets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "template_assets_template_id_fkey" FOREIGN KEY ("template_id")
    REFERENCES "templates"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ck_template_assets_sha" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "ck_template_assets_size" CHECK ("size_bytes" > 0)
);
CREATE UNIQUE INDEX "uq_template_assets_template_sha" ON "template_assets"("template_id", "sha256");

ALTER TABLE "template_install_items" DROP CONSTRAINT "ck_template_install_items_type";
ALTER TABLE "template_install_items" ADD CONSTRAINT "ck_template_install_items_type" CHECK (
  "entity_type" IN ('TAG', 'CUSTOM_FIELD', 'ISSUE_TYPE', 'ITERATION', 'PROJECT', 'TASK', 'ATTACHMENT')
);

COMMIT;
