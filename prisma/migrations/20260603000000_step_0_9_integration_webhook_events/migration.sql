BEGIN;

-- CreateTable: delivery-id dedupe for provider webhooks (step 0.9).
-- Expand-only: a new table nothing reads until Phase 2.
CREATE TABLE "integration_webhook_events" (
  "id" TEXT NOT NULL,
  "provider" "integration_provider" NOT NULL,
  "delivery_id" TEXT NOT NULL,
  "received_at" TIMESTAMP(3) NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  -- Bounded key size; the application enforces the same limit with a clear 400.
  CONSTRAINT "ck_integration_webhook_events_delivery_id_len"
    CHECK (char_length("delivery_id") BETWEEN 1 AND 200)
);

-- The dedupe itself: insert-or-ignore targets this index.
CREATE UNIQUE INDEX "uq_integration_webhook_events_provider_delivery_id"
  ON "integration_webhook_events"("provider", "delivery_id");

-- The retention sweep deletes by age.
CREATE INDEX "idx_integration_webhook_events_received_at"
  ON "integration_webhook_events"("received_at");

COMMIT;
