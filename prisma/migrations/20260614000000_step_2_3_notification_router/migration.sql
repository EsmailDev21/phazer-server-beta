-- Step 2.3: notification router (ADR-0011).
ALTER TYPE "channel_delivery_status" ADD VALUE 'PENDING';
ALTER TYPE "audit_action" ADD VALUE 'INTEGRATION_SUBSCRIPTION_DISABLED';

BEGIN;
ALTER TABLE "channel_subscriptions" ADD COLUMN "disabled_reason" TEXT;
-- the per-subscription burst cap counts recent rows by (subscription, created_at)
CREATE INDEX "idx_channel_deliveries_subscription_created" ON "channel_deliveries"("subscription_id", "created_at");
COMMIT;
