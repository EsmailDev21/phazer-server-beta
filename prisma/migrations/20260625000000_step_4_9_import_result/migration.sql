-- Step 4.9: the outcome of a finished import job that is not rows (import-as-template: the template it made).
ALTER TABLE "import_jobs" ADD COLUMN "result" JSONB;
