-- Step 2.2: identity linking. OAuth state gains a purpose + the connection it is for; one-time link tokens.
ALTER TYPE "audit_action" ADD VALUE 'INTEGRATION_IDENTITY_LINKED';
ALTER TYPE "audit_action" ADD VALUE 'INTEGRATION_IDENTITY_UNLINKED';
ALTER TYPE "identity_link_method" ADD VALUE 'LINK_TOKEN';

BEGIN;
CREATE TYPE "oauth_state_purpose" AS ENUM ('CONNECT', 'IDENTITY');
ALTER TABLE "oauth_states"
  ADD COLUMN "purpose" "oauth_state_purpose" NOT NULL DEFAULT 'CONNECT',
  ADD COLUMN "connection_id" TEXT,
  ADD CONSTRAINT "oauth_states_connection_id_fkey" FOREIGN KEY ("connection_id")
    REFERENCES "integration_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ck_oauth_states_identity_has_connection"
    CHECK ("purpose" <> 'IDENTITY' OR "connection_id" IS NOT NULL);

CREATE TABLE "identity_link_tokens" (
  "id"               TEXT NOT NULL,
  "token_hash"       TEXT NOT NULL,
  "connection_id"    TEXT NOT NULL,
  "external_user_id" TEXT NOT NULL,
  "expires_at"       TIMESTAMP(3) NOT NULL,
  "consumed_at"      TIMESTAMP(3),
  "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "identity_link_tokens_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "identity_link_tokens_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "integration_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "uq_identity_link_tokens_token_hash" ON "identity_link_tokens"("token_hash");
CREATE INDEX "idx_identity_link_tokens_connection_external" ON "identity_link_tokens"("connection_id", "external_user_id");
CREATE INDEX "idx_identity_link_tokens_expires_at" ON "identity_link_tokens"("expires_at");
COMMIT;
