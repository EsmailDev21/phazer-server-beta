-- Step 1.6: ExternalLink (diagram 11). Model + read only; adapters write in Phase 2.
BEGIN;

CREATE TYPE "external_link_kind" AS ENUM ('PR', 'ISSUE', 'COMMIT', 'BRANCH', 'MESSAGE', 'THREAD');

CREATE TABLE "external_links" (
  "id"          TEXT         NOT NULL,
  "task_id"     TEXT         NOT NULL,
  "provider"    "integration_provider" NOT NULL,
  "kind"        "external_link_kind"   NOT NULL,
  "external_id" TEXT         NOT NULL,
  "url"         TEXT         NOT NULL,
  "title"       TEXT         NOT NULL,
  "state"       TEXT,
  "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"  TIMESTAMP(3) NOT NULL,
  CONSTRAINT "external_links_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "external_links_task_id_fkey" FOREIGN KEY ("task_id")
    REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  -- the UI renders url as a link: never store javascript:, data:, file: ...
  CONSTRAINT "ck_external_links_url_http" CHECK ("url" ~* '^https?://' AND length("url") <= 2048),
  CONSTRAINT "ck_external_links_external_id_not_blank" CHECK (btrim("external_id") <> '')
);
CREATE UNIQUE INDEX "uq_external_links_task_provider_kind_external_id"
  ON "external_links"("task_id", "provider", "kind", "external_id");
CREATE INDEX "idx_external_links_provider_kind_external_id"
  ON "external_links"("provider", "kind", "external_id");

COMMIT;
