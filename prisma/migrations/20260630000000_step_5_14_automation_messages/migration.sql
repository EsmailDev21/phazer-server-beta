-- Step 5.14: a rule can notify people with its own text (the NOTIFY action).
--
-- A notification points at a SOURCE (an activity or an audit-log row) and has no text of its own. A
-- rule's message has no activity behind it, so it gets its own source row: one `automation_messages` row
-- per NOTIFY that ran, holding the RENDERED text, and one notification per recipient pointing at it.
--
-- The new enum values are added here and not used here (a value added in a transaction cannot be used in
-- the same one), the same way the earlier enum migrations do it.
BEGIN;

ALTER TYPE "notification_type" ADD VALUE 'AUTOMATION_MESSAGE';
ALTER TYPE "notification_source_type" ADD VALUE 'AUTOMATION_MESSAGE';

CREATE TABLE "automation_messages" (
  "id"            TEXT NOT NULL,
  "workspace_id"  TEXT NOT NULL,
  -- the message outlives the rule and the task it was about
  "automation_id" TEXT,
  "task_id"       TEXT,
  "message"       TEXT NOT NULL,
  "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "automation_messages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "fk_automation_messages_workspace" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "fk_automation_messages_automation" FOREIGN KEY ("automation_id") REFERENCES "automations"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "fk_automation_messages_task" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "ck_automation_messages_message" CHECK (length("message") BETWEEN 1 AND 2000)
);

CREATE INDEX "idx_automation_messages_workspace" ON "automation_messages" ("workspace_id", "created_at");
CREATE INDEX "idx_automation_messages_automation" ON "automation_messages" ("automation_id");
CREATE INDEX "idx_automation_messages_task" ON "automation_messages" ("task_id");

COMMIT;
