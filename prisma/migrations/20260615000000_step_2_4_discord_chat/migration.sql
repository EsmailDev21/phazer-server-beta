-- Step 2.4 (ADR-0012): chat command run ledger + "one live connection per provider tenant".
BEGIN;

CREATE TABLE "chat_command_runs" (
  "id"             TEXT NOT NULL,
  "provider"       "integration_provider" NOT NULL,
  "interaction_id" TEXT NOT NULL,
  "status"         TEXT NOT NULL,
  "result"         JSONB,
  "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "chat_command_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ck_chat_command_runs_status" CHECK ("status" IN ('RUNNING', 'DONE'))
);
CREATE UNIQUE INDEX "uq_chat_command_runs_provider_interaction" ON "chat_command_runs"("provider", "interaction_id");
CREATE INDEX "idx_chat_command_runs_created_at" ON "chat_command_runs"("created_at");

-- An interaction arrives with only the guild id: it must map to exactly ONE account. A Discord guild / Slack team /
-- GitHub installation can be live in one account at a time (disconnect first to move it). Partial, so REVOKED rows
-- (kept for reconnect, ADR-0009 d.3) do not block another account. Not expressible in schema.prisma.
CREATE UNIQUE INDEX "uq_integration_connections_live_external"
  ON "integration_connections"("provider", "external_account_id")
  WHERE "status" IN ('ACTIVE', 'NEEDS_REAUTH', 'ERROR');

COMMIT;
