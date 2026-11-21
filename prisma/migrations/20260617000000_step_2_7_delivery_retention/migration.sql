BEGIN;

-- Step 2.7 (ADR-0015). The retention sweep and the "last hour" metrics query filter channel_deliveries by created_at alone;
-- the existing index leads with subscription_id, so without this one both would scan the whole table.
CREATE INDEX "idx_channel_deliveries_created_at" ON "channel_deliveries"("created_at");

COMMIT;
