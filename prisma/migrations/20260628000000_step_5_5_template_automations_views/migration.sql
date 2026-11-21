-- Step 5.5: a template install can now create automations and saved views, so the install ledger
-- (what an undo removes) accepts those two entity types.
BEGIN;
ALTER TABLE "template_install_items" DROP CONSTRAINT "ck_template_install_items_type";
ALTER TABLE "template_install_items" ADD CONSTRAINT "ck_template_install_items_type" CHECK (
  "entity_type" IN ('TAG', 'CUSTOM_FIELD', 'ISSUE_TYPE', 'ITERATION', 'PROJECT', 'TASK', 'ATTACHMENT', 'AUTOMATION', 'SAVED_VIEW')
);
COMMIT;
