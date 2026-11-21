-- Step 2.1 (ADR-0009): integration core tables. Pre-launch: single migration, no choreography.
ALTER TYPE "audit_action" ADD VALUE 'INTEGRATION_NEEDS_REAUTH';

BEGIN;

CREATE TYPE "integration_connection_status" AS ENUM ('ACTIVE', 'NEEDS_REAUTH', 'REVOKED', 'ERROR');
CREATE TYPE "identity_link_method" AS ENUM ('AUTO_EMAIL', 'OAUTH_LINK', 'MANUAL', 'SKIPPED');
CREATE TYPE "channel_link_kind" AS ENUM ('CHANNEL', 'GUILD', 'REPO');
CREATE TYPE "channel_delivery_status" AS ENUM ('SENT', 'FAILED', 'SKIPPED');

CREATE TABLE "oauth_states" (
  "id"            TEXT NOT NULL,
  "provider"      "integration_provider" NOT NULL,
  "nonce"         TEXT NOT NULL,
  "pkce_verifier" TEXT,
  "user_id"       TEXT NOT NULL,
  "account_id"    TEXT NOT NULL,
  "expires_at"    TIMESTAMP(3) NOT NULL,
  "consumed_at"   TIMESTAMP(3),
  "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "oauth_states_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "oauth_states_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "oauth_states_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "uq_oauth_states_nonce" ON "oauth_states"("nonce");
CREATE INDEX "idx_oauth_states_expires_at" ON "oauth_states"("expires_at");

CREATE TABLE "integration_connections" (
  "id"                    TEXT NOT NULL,
  "account_id"            TEXT NOT NULL,
  "provider"              "integration_provider" NOT NULL,
  "external_account_id"   TEXT NOT NULL,
  "external_account_name" TEXT NOT NULL,
  "scopes"                TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "status"                "integration_connection_status" NOT NULL DEFAULT 'ACTIVE',
  "last_error"            TEXT,
  "created_by_id"         TEXT NOT NULL,
  "last_used_at"          TIMESTAMP(3),
  "created_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"            TIMESTAMP(3) NOT NULL,
  CONSTRAINT "integration_connections_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "integration_connections_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "integration_connections_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "uq_integration_connections_account_provider_external"
  ON "integration_connections"("account_id", "provider", "external_account_id");
CREATE INDEX "idx_integration_connections_account_status" ON "integration_connections"("account_id", "status");

CREATE TABLE "integration_credentials" (
  "id"            TEXT NOT NULL,
  "connection_id" TEXT NOT NULL,
  "kid"           TEXT NOT NULL,
  "ciphertext"    TEXT NOT NULL,
  "expires_at"    TIMESTAMP(3),
  "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "integration_credentials_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "integration_credentials_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "integration_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "uq_integration_credentials_connection_id" ON "integration_credentials"("connection_id");
CREATE INDEX "idx_integration_credentials_kid" ON "integration_credentials"("kid");

CREATE TABLE "identity_links" (
  "id"               TEXT NOT NULL,
  "connection_id"    TEXT NOT NULL,
  "external_user_id" TEXT NOT NULL,
  "external_email"   TEXT,
  "user_id"          TEXT,
  "method"           "identity_link_method" NOT NULL,
  "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "identity_links_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "identity_links_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "integration_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "identity_links_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "uq_identity_links_connection_external_user" ON "identity_links"("connection_id", "external_user_id");
CREATE INDEX "idx_identity_links_user_id" ON "identity_links"("user_id");

CREATE TABLE "channel_links" (
  "id"               TEXT NOT NULL,
  "connection_id"    TEXT NOT NULL,
  "kind"             "channel_link_kind" NOT NULL,
  "external_id"      TEXT NOT NULL,
  "workspace_id"     TEXT NOT NULL,
  "project_id"       TEXT,
  "configured_by_id" TEXT NOT NULL,
  "paused_at"        TIMESTAMP(3),
  "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "channel_links_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "channel_links_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "integration_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "channel_links_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "channel_links_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "channel_links_configured_by_id_fkey" FOREIGN KEY ("configured_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "uq_channel_links_connection_kind_external" ON "channel_links"("connection_id", "kind", "external_id");
CREATE INDEX "idx_channel_links_workspace_id" ON "channel_links"("workspace_id");
CREATE INDEX "idx_channel_links_project_id" ON "channel_links"("project_id");

CREATE TABLE "channel_subscriptions" (
  "id"              TEXT NOT NULL,
  "channel_link_id" TEXT NOT NULL,
  "events"          "activity_action"[] NOT NULL DEFAULT ARRAY[]::"activity_action"[],
  "min_visibility"  "activity_visibility" NOT NULL DEFAULT 'TIMELINE',
  "enabled"         BOOLEAN NOT NULL DEFAULT true,
  "failure_count"   INTEGER NOT NULL DEFAULT 0,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "channel_subscriptions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "channel_subscriptions_channel_link_id_fkey" FOREIGN KEY ("channel_link_id") REFERENCES "channel_links"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "idx_channel_subscriptions_channel_link_id" ON "channel_subscriptions"("channel_link_id");

CREATE TABLE "channel_deliveries" (
  "id"              TEXT NOT NULL,
  "subscription_id" TEXT NOT NULL,
  "activity_id"     TEXT NOT NULL,
  "status"          "channel_delivery_status" NOT NULL,
  "attempts"        INTEGER NOT NULL DEFAULT 0,
  "error"           TEXT,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "channel_deliveries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "channel_deliveries_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "channel_subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "channel_deliveries_activity_id_fkey" FOREIGN KEY ("activity_id") REFERENCES "activities"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "uq_channel_deliveries_subscription_activity" ON "channel_deliveries"("subscription_id", "activity_id");
CREATE INDEX "idx_channel_deliveries_activity_id" ON "channel_deliveries"("activity_id");

COMMIT;
