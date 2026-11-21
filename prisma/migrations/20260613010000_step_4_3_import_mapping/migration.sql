-- Step 4.3: the inventory of what the source contains (statuses, priorities, people, types, fields), stored at preview
-- so the Map step can suggest and validate against it. JSON, bounded by the application (INVENTORY_LIMITS).
ALTER TABLE "import_jobs" ADD COLUMN "inventory" JSONB;
