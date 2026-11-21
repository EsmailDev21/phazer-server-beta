-- Baseline migration, hand-authored from prisma/schema.prisma.
-- See prisma/migrations/README-BASELINE.md for how this was produced and verified.
BEGIN;

CREATE TYPE "account_type" AS ENUM ('PERSONAL', 'ORGANIZATION');
CREATE TYPE "role" AS ENUM ('OWNER', 'ADMIN', 'MEMBER', 'VIEWER', 'CLIENT');
CREATE TYPE "collaborator_role" AS ENUM ('VIEWER', 'COMMENTER', 'CONTRIBUTOR');
CREATE TYPE "team_icon" AS ENUM ('USERS', 'MEGAPHONE', 'CODE', 'BRUSH', 'ROCKET');
CREATE TYPE "invite_target_type" AS ENUM ('ACCOUNT', 'WORKSPACE', 'TEAM', 'PROJECT');
CREATE TYPE "project_status" AS ENUM ('ACTIVE', 'ON_HOLD', 'COMPLETED', 'ARCHIVED');
CREATE TYPE "task_status" AS ENUM ('TODO', 'IN_PROGRESS', 'BLOCKED', 'DONE');
CREATE TYPE "priority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');
CREATE TYPE "creation_mode" AS ENUM ('SNAP', 'FOCUS', 'MANUAL');
CREATE TYPE "dependency_type" AS ENUM ('BLOCKS', 'RELATES_TO');
CREATE TYPE "commentable_type" AS ENUM ('TASK', 'PROJECT', 'ACTIVITY');
CREATE TYPE "reactable_type" AS ENUM ('COMMENT', 'ACTIVITY');
CREATE TYPE "reaction_type" AS ENUM ('LIKE', 'LOVE', 'LAUGH', 'CELEBRATE', 'THINKING');
CREATE TYPE "field_type" AS ENUM ('TEXT', 'NUMBER', 'DATE', 'SELECT', 'MULTI_SELECT', 'CHECKBOX', 'USER', 'URL');
CREATE TYPE "activity_action" AS ENUM ('CREATED', 'STATUS_CHANGED', 'PRIORITY_CHANGED', 'DUE_DATE_CHANGED', 'ASSIGNED', 'UNASSIGNED', 'DESCRIPTION_UPDATED', 'COMMENTED', 'MENTIONED', 'ARCHIVED', 'RESTORED', 'DEPENDENCY_ADDED', 'DEPENDENCY_REMOVED', 'DUE_DATE_APPROACHING', 'ATTACHMENT_ADDED', 'REACTED');
CREATE TYPE "activity_visibility" AS ENUM ('TIMELINE', 'SILENT');
CREATE TYPE "activity_target_type" AS ENUM ('TASK', 'PROJECT', 'COMMENT');
CREATE TYPE "watchable_type" AS ENUM ('TASK', 'PROJECT');
CREATE TYPE "audit_action" AS ENUM ('MEMBER_ADDED', 'MEMBER_REMOVED', 'ROLE_CHANGED', 'PLAN_CHANGED', 'BILLING_UPDATED', 'TEAM_CREATED', 'ACCOUNT_SETTINGS_CHANGED');
CREATE TYPE "notification_type" AS ENUM ('TASK_ASSIGNED', 'MENTIONED', 'COMMENT_REPLY', 'STATUS_CHANGED', 'DUE_DATE_APPROACHING', 'REACTION_RECEIVED', 'ACCOUNT_ALERT', 'TASK_CREATED', 'PRIORITY_CHANGED', 'DUE_DATE_CHANGED', 'DESCRIPTION_UPDATED', 'TASK_ARCHIVED', 'TASK_RESTORED', 'DEPENDENCY_ADDED', 'DEPENDENCY_REMOVED', 'ATTACHMENT_ADDED', 'TASK_UNASSIGNED');
CREATE TYPE "notification_source_type" AS ENUM ('ACTIVITY', 'AUDIT_LOG');
CREATE TYPE "notification_channel" AS ENUM ('IN_APP', 'EMAIL', 'PUSH');
CREATE TYPE "delivery_status" AS ENUM ('PENDING', 'SENT', 'FAILED', 'SKIPPED');
CREATE TYPE "snap_session_status" AS ENUM ('PARSING', 'REVIEWING', 'APPROVED', 'PARTIAL', 'EXECUTED', 'FAILED', 'EXPIRED');
CREATE TYPE "snap_review_status" AS ENUM ('PENDING', 'APPROVED', 'CORRECTED', 'REJECTED', 'SKIPPED');
CREATE TYPE "snap_action_type" AS ENUM ('CREATE_WORKSPACE', 'CREATE_PROJECT', 'CREATE_TASK', 'UPDATE_TASK', 'ASSIGN_TASK', 'ADD_TAG', 'SET_DUE_DATE');
CREATE TYPE "snap_rating" AS ENUM ('THUMBS_UP', 'THUMBS_DOWN');
CREATE TYPE "correction_type" AS ENUM ('ACTION_ONLY', 'PAYLOAD_ONLY', 'FULL_CORRECTION');
CREATE TYPE "attachmentable_type" AS ENUM ('TASK', 'PROJECT', 'COMMENT');
CREATE TYPE "attachment_status" AS ENUM ('PENDING', 'CONFIRMED');
CREATE TYPE "storage_provider" AS ENUM ('S3_COMPATIBLE');
CREATE TYPE "shareable_type" AS ENUM ('TASK', 'PROJECT');
CREATE TYPE "share_permission" AS ENUM ('VIEW');
CREATE TYPE "plan_key" AS ENUM ('FREE_PERSONAL', 'PRO_PERSONAL', 'FREE_ORG', 'STARTER_ORG', 'PROFESSIONAL_ORG', 'ENTERPRISE_ORG');
CREATE TYPE "payment_provider" AS ENUM ('STRIPE', 'MOR', 'TUNISIA_GATEWAY');

CREATE TABLE "users" (
  "id" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "username" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "avatar" TEXT,
  "google_id" TEXT,
  "password" TEXT,
  "email_verified" BOOLEAN NOT NULL DEFAULT false,
  "onboarded_at" TIMESTAMP(3),
  "bio" TEXT,
  "location" TEXT,
  "website" TEXT,
  "github" TEXT,
  "twitter" TEXT,
  "linkedin" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
,
  PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "uq_users_email" ON "users"("email");
CREATE UNIQUE INDEX "uq_users_username" ON "users"("username");
CREATE UNIQUE INDEX "uq_users_google_id" ON "users"("google_id");

CREATE TABLE "user_preferences" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "preferred_mode" "creation_mode" NOT NULL DEFAULT 'SNAP',
  "notification_settings" JSONB,
  "ui_preferences" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
,
  PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "uq_user_preferences_user_id" ON "user_preferences"("user_id");

CREATE TABLE "refresh_tokens" (
  "id" TEXT NOT NULL,
  "token_hash" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "device_info" TEXT,
  "last_used_at" TIMESTAMP(3),
  "revoked" BOOLEAN NOT NULL DEFAULT false,
  "revoked_at" TIMESTAMP(3),
  "expires_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT now()
,
  PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "uq_refresh_tokens_token_hash" ON "refresh_tokens"("token_hash");

CREATE TABLE "accounts" (
  "id" TEXT NOT NULL,
  "type" "account_type" NOT NULL,
  "plan_type" "plan_key",
  "payment_provider" "payment_provider",
  "external_customer_id" TEXT,
  "external_subscription_id" TEXT,
  "subscription_status" TEXT,
  "billing_country" TEXT,
  "seats_included" INTEGER NOT NULL DEFAULT 1,
  "seats_used" INTEGER NOT NULL DEFAULT 1,
  "current_period_start" TIMESTAMP(3),
  "current_period_end" TIMESTAMP(3),
  "canceled_at" TIMESTAMP(3),
  "trial_ends_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deleted_at" TIMESTAMP(3),
  "personal_owner_id" TEXT
,
  PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "uq_accounts_external_customer_id" ON "accounts"("external_customer_id");
CREATE UNIQUE INDEX "uq_accounts_personal_owner_id" ON "accounts"("personal_owner_id");
CREATE INDEX "ix_accounts_type" ON "accounts"("type");
CREATE INDEX "ix_accounts_deleted_at" ON "accounts"("deleted_at");

CREATE TABLE "organizations" (
  "id" TEXT NOT NULL,
  "account_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "logo" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
,
  PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "uq_organizations_account_id" ON "organizations"("account_id");

CREATE TABLE "workspaces" (
  "id" TEXT NOT NULL,
  "account_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "icon" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
,
  PRIMARY KEY ("id")
);
CREATE INDEX "ix_workspaces_account_id" ON "workspaces"("account_id");

CREATE TABLE "teams" (
  "id" TEXT NOT NULL,
  "account_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "type" TEXT,
  "icon" "team_icon" NOT NULL DEFAULT 'USERS',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
,
  PRIMARY KEY ("id")
);
CREATE INDEX "ix_teams_account_id" ON "teams"("account_id");

CREATE TABLE "account_members" (
  "id" TEXT NOT NULL,
  "account_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "role" "role" NOT NULL DEFAULT 'MEMBER',
  "permissions" JSONB,
  "joined_at" TIMESTAMP(3) NOT NULL DEFAULT now()
,
  PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "uq_account_members_account_id_user_id" ON "account_members"("account_id", "user_id");
CREATE INDEX "ix_account_members_user_id" ON "account_members"("user_id");

CREATE TABLE "team_members" (
  "id" TEXT NOT NULL,
  "team_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT now()
,
  PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "uq_team_members_team_id_user_id" ON "team_members"("team_id", "user_id");

CREATE TABLE "workspace_team_access" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "team_id" TEXT NOT NULL,
  "role" "role" NOT NULL DEFAULT 'MEMBER',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT now()
,
  PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "uq_workspace_team_access_workspace_id_team_id" ON "workspace_team_access"("workspace_id", "team_id");

CREATE TABLE "workspace_collaborators" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "invited_user_id" TEXT NOT NULL,
  "role" "collaborator_role" NOT NULL DEFAULT 'VIEWER',
  "is_free_slot" BOOLEAN NOT NULL DEFAULT true,
  "invited_at" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "accepted_at" TIMESTAMP(3)
,
  PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "uq_workspace_collaborators_workspace_id_invited_user_id" ON "workspace_collaborators"("workspace_id", "invited_user_id");

CREATE TABLE "workspace_guests" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "invited_user_id" TEXT NOT NULL,
  "role" "collaborator_role" NOT NULL DEFAULT 'VIEWER',
  "invited_at" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "accepted_at" TIMESTAMP(3)
,
  PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "uq_workspace_guests_workspace_id_invited_user_id" ON "workspace_guests"("workspace_id", "invited_user_id");

CREATE TABLE "project_members" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "role" "role" NOT NULL DEFAULT 'MEMBER',
  "joined_at" TIMESTAMP(3) NOT NULL DEFAULT now()
,
  PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "uq_project_members_project_id_user_id" ON "project_members"("project_id", "user_id");

CREATE TABLE "invites" (
  "id" TEXT NOT NULL,
  "token_hash" TEXT NOT NULL,
  "email" TEXT,
  "target_type" "invite_target_type" NOT NULL,
  "target_id" TEXT NOT NULL,
  "role" "role" NOT NULL,
  "collaborator_role" "collaborator_role",
  "inviter_id" TEXT NOT NULL,
  "expires_at" TIMESTAMP(3),
  "max_uses" INTEGER,
  "uses_count" INTEGER NOT NULL DEFAULT 0,
  "is_public" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT now()
,
  PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "uq_invites_token_hash" ON "invites"("token_hash");
CREATE INDEX "ix_invites_target_type_target_id" ON "invites"("target_type", "target_id");

CREATE TABLE "payments" (
  "id" TEXT NOT NULL,
  "account_id" TEXT NOT NULL,
  "provider" "payment_provider" NOT NULL,
  "external_transaction_id" TEXT NOT NULL,
  "amount" DOUBLE PRECISION NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'usd',
  "status" TEXT NOT NULL,
  "receipt_url" TEXT,
  "failure_reason" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT now()
,
  PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "uq_payments_provider_external_transaction_id" ON "payments"("provider", "external_transaction_id");
CREATE INDEX "ix_payments_account_id" ON "payments"("account_id");

CREATE TABLE "invoices" (
  "id" TEXT NOT NULL,
  "account_id" TEXT NOT NULL,
  "provider" "payment_provider" NOT NULL,
  "invoice_number" TEXT NOT NULL,
  "external_invoice_id" TEXT NOT NULL,
  "amount" DOUBLE PRECISION NOT NULL,
  "currency" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "due_date" TIMESTAMP(3) NOT NULL,
  "paid_at" TIMESTAMP(3),
  "line_items" JSONB NOT NULL,
  "pdf_url" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT now()
,
  PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "uq_invoices_invoice_number" ON "invoices"("invoice_number");
CREATE UNIQUE INDEX "uq_invoices_provider_external_invoice_id" ON "invoices"("provider", "external_invoice_id");
CREATE INDEX "ix_invoices_account_id" ON "invoices"("account_id");

CREATE TABLE "usage_metrics" (
  "id" TEXT NOT NULL,
  "account_id" TEXT NOT NULL,
  "metric" TEXT NOT NULL,
  "value" INTEGER NOT NULL,
  "period" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT now()
,
  PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "uq_usage_metrics_account_id_metric_period" ON "usage_metrics"("account_id", "metric", "period");

CREATE TABLE "attachments" (
  "id" TEXT NOT NULL,
  "account_id" TEXT NOT NULL,
  "target_type" "attachmentable_type" NOT NULL,
  "target_id" TEXT NOT NULL,
  "uploaded_by_id" TEXT NOT NULL,
  "filename" TEXT NOT NULL,
  "mime_type" TEXT NOT NULL,
  "size_bytes" INTEGER NOT NULL,
  "storage_key" TEXT NOT NULL,
  "storage_provider" "storage_provider" NOT NULL DEFAULT 'S3_COMPATIBLE',
  "status" "attachment_status" NOT NULL DEFAULT 'PENDING',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "confirmed_at" TIMESTAMP(3)
,
  PRIMARY KEY ("id")
);
CREATE INDEX "ix_attachments_target_type_target_id" ON "attachments"("target_type", "target_id");
CREATE INDEX "ix_attachments_account_id_status" ON "attachments"("account_id", "status");

CREATE TABLE "share_links" (
  "id" TEXT NOT NULL,
  "token_hash" TEXT NOT NULL,
  "target_type" "shareable_type" NOT NULL,
  "target_id" TEXT NOT NULL,
  "permission_level" "share_permission" NOT NULL DEFAULT 'VIEW',
  "created_by_id" TEXT NOT NULL,
  "expires_at" TIMESTAMP(3),
  "revoked" BOOLEAN NOT NULL DEFAULT false,
  "view_count" INTEGER NOT NULL DEFAULT 0
,
  PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "uq_share_links_token_hash" ON "share_links"("token_hash");
CREATE INDEX "ix_share_links_target_type_target_id" ON "share_links"("target_type", "target_id");

CREATE TABLE "processed_webhook_events" (
  "id" TEXT NOT NULL,
  "provider" "payment_provider" NOT NULL,
  "external_event_id" TEXT NOT NULL,
  "processed_at" TIMESTAMP(3) NOT NULL DEFAULT now()
,
  PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "uq_processed_webhook_events_provider_external_event_id" ON "processed_webhook_events"("provider", "external_event_id");

CREATE TABLE "projects" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "status" "project_status" NOT NULL DEFAULT 'ACTIVE',
  "created_by_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
,
  PRIMARY KEY ("id")
);
CREATE INDEX "ix_projects_workspace_id" ON "projects"("workspace_id");

CREATE TABLE "tasks" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "project_id" TEXT,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "status" "task_status" NOT NULL DEFAULT 'TODO',
  "priority" "priority",
  "created_by_id" TEXT NOT NULL,
  "start_date" TIMESTAMP(3),
  "due_date" TIMESTAMP(3),
  "created_via" "creation_mode" NOT NULL DEFAULT 'SNAP',
  "is_archived" BOOLEAN NOT NULL DEFAULT false,
  "archived_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
,
  PRIMARY KEY ("id")
);
CREATE INDEX "ix_tasks_workspace_id" ON "tasks"("workspace_id");
CREATE INDEX "ix_tasks_project_id" ON "tasks"("project_id");
CREATE INDEX "ix_tasks_workspace_id_status" ON "tasks"("workspace_id", "status");

CREATE TABLE "task_dependencies" (
  "id" TEXT NOT NULL,
  "blocking_task_id" TEXT NOT NULL,
  "blocked_task_id" TEXT NOT NULL,
  "type" "dependency_type" NOT NULL DEFAULT 'BLOCKS',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT now()
,
  PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "uq_task_dependencies_blocking_task_id_blocked_task_id" ON "task_dependencies"("blocking_task_id", "blocked_task_id");

CREATE TABLE "comments" (
  "id" TEXT NOT NULL,
  "target_type" "commentable_type" NOT NULL,
  "target_id" TEXT NOT NULL,
  "author_id" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "parent_comment_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "edited_at" TIMESTAMP(3)
,
  PRIMARY KEY ("id")
);
CREATE INDEX "ix_comments_target_type_target_id" ON "comments"("target_type", "target_id");

CREATE TABLE "reactions" (
  "id" TEXT NOT NULL,
  "target_type" "reactable_type" NOT NULL,
  "target_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "reaction" "reaction_type" NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT now()
,
  PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "uq_reactions_target_type_target_id_user_id_reaction" ON "reactions"("target_type", "target_id", "user_id", "reaction");
CREATE INDEX "ix_reactions_target_type_target_id" ON "reactions"("target_type", "target_id");

CREATE TABLE "mentions" (
  "id" TEXT NOT NULL,
  "comment_id" TEXT NOT NULL,
  "mentioned_user_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT now()
,
  PRIMARY KEY ("id")
);

CREATE TABLE "custom_fields" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "data_type" "field_type" NOT NULL,
  "options" JSONB,
  "order" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT now()
,
  PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "uq_custom_fields_workspace_id_key" ON "custom_fields"("workspace_id", "key");

CREATE TABLE "task_custom_values" (
  "id" TEXT NOT NULL,
  "task_id" TEXT NOT NULL,
  "field_id" TEXT NOT NULL,
  "value" JSONB NOT NULL
,
  PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "uq_task_custom_values_task_id_field_id" ON "task_custom_values"("task_id", "field_id");

CREATE TABLE "tags" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "name" TEXT NOT NULL
,
  PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "uq_tags_workspace_id_name" ON "tags"("workspace_id", "name");

CREATE TABLE "task_tags" (
  "task_id" TEXT NOT NULL,
  "tag_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT now()
,
  PRIMARY KEY ("task_id", "tag_id")
);

CREATE TABLE "activities" (
  "id" TEXT NOT NULL,
  "actor_id" TEXT,
  "action" "activity_action" NOT NULL,
  "visibility" "activity_visibility" NOT NULL DEFAULT 'TIMELINE',
  "target_type" "activity_target_type" NOT NULL,
  "target_id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT now()
,
  PRIMARY KEY ("id")
);
CREATE INDEX "ix_activities_workspace_id_created_at" ON "activities"("workspace_id", "created_at");
CREATE INDEX "ix_activities_target_type_target_id" ON "activities"("target_type", "target_id");

CREATE TABLE "audit_logs" (
  "id" TEXT NOT NULL,
  "actor_id" TEXT NOT NULL,
  "action" "audit_action" NOT NULL,
  "account_id" TEXT NOT NULL,
  "metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT now()
,
  PRIMARY KEY ("id")
);
CREATE INDEX "ix_audit_logs_account_id_created_at" ON "audit_logs"("account_id", "created_at");

CREATE TABLE "watches" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "target_type" "watchable_type" NOT NULL,
  "target_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT now()
,
  PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "uq_watches_user_id_target_type_target_id" ON "watches"("user_id", "target_type", "target_id");

CREATE TABLE "notifications" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "type" "notification_type" NOT NULL,
  "source_type" "notification_source_type" NOT NULL,
  "source_id" TEXT NOT NULL,
  "read_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT now()
,
  PRIMARY KEY ("id")
);
CREATE INDEX "ix_notifications_user_id_read_at" ON "notifications"("user_id", "read_at");

CREATE TABLE "notification_deliveries" (
  "id" TEXT NOT NULL,
  "notification_id" TEXT NOT NULL,
  "channel" "notification_channel" NOT NULL,
  "status" "delivery_status" NOT NULL DEFAULT 'PENDING',
  "sent_at" TIMESTAMP(3),
  "error" TEXT
,
  PRIMARY KEY ("id")
);
CREATE INDEX "ix_notification_deliveries_notification_id" ON "notification_deliveries"("notification_id");

CREATE TABLE "snap_sessions" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "workspace_id" TEXT,
  "raw_input" TEXT NOT NULL,
  "anonymized_input" TEXT NOT NULL,
  "input_length" INTEGER NOT NULL,
  "word_count" INTEGER NOT NULL,
  "has_mentions" BOOLEAN NOT NULL,
  "has_tags" BOOLEAN NOT NULL,
  "has_symbols" BOOLEAN NOT NULL,
  "has_emails" BOOLEAN NOT NULL,
  "consent_given" BOOLEAN NOT NULL,
  "data_retention_days" INTEGER NOT NULL,
  "status" "snap_session_status" NOT NULL DEFAULT 'PARSING',
  "previous_session_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
,
  PRIMARY KEY ("id")
);
CREATE INDEX "ix_snap_sessions_user_id_created_at" ON "snap_sessions"("user_id", "created_at");
CREATE INDEX "ix_snap_sessions_status" ON "snap_sessions"("status");

CREATE TABLE "snap_clauses" (
  "id" TEXT NOT NULL,
  "session_id" TEXT NOT NULL,
  "clause_index" INTEGER NOT NULL,
  "text" TEXT NOT NULL,
  "char_start" INTEGER NOT NULL,
  "char_end" INTEGER NOT NULL,
  "m1_confidence" DOUBLE PRECISION,
  "m1_time_ms" INTEGER,
  "predicted_action" "snap_action_type",
  "action_confidence" DOUBLE PRECISION,
  "m2_time_ms" INTEGER,
  "extracted_entities" JSONB,
  "entity_confidence" DOUBLE PRECISION,
  "m3_time_ms" INTEGER,
  "fuzzy_matches_used" JSONB,
  "review_status" "snap_review_status" NOT NULL DEFAULT 'PENDING',
  "corrected_action" "snap_action_type",
  "corrected_entities" JSONB,
  "correction_type" "correction_type",
  "rejection_reason" TEXT,
  "user_rating" "snap_rating",
  "executed_action" "snap_action_type",
  "executed_at" TIMESTAMP(3),
  "execution_error" TEXT,
  "execution_time_ms" INTEGER,
  "created_task_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
,
  PRIMARY KEY ("id")
);
CREATE INDEX "ix_snap_clauses_session_id_clause_index" ON "snap_clauses"("session_id", "clause_index");
CREATE INDEX "ix_snap_clauses_predicted_action_review_status" ON "snap_clauses"("predicted_action", "review_status");
CREATE INDEX "ix_snap_clauses_corrected_action_correction_type" ON "snap_clauses"("corrected_action", "correction_type");

-- Foreign keys (all tables now exist)
ALTER TABLE "user_preferences" ADD CONSTRAINT "fk_user_preferences_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "fk_refresh_tokens_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
ALTER TABLE "accounts" ADD CONSTRAINT "fk_accounts_personal_owner_id" FOREIGN KEY ("personal_owner_id") REFERENCES "users"("id") ON DELETE NO ACTION;
ALTER TABLE "organizations" ADD CONSTRAINT "fk_organizations_account_id" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE;
ALTER TABLE "workspaces" ADD CONSTRAINT "fk_workspaces_account_id" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE;
ALTER TABLE "teams" ADD CONSTRAINT "fk_teams_account_id" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE;
ALTER TABLE "account_members" ADD CONSTRAINT "fk_account_members_account_id" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE;
ALTER TABLE "account_members" ADD CONSTRAINT "fk_account_members_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
ALTER TABLE "team_members" ADD CONSTRAINT "fk_team_members_team_id" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE;
ALTER TABLE "team_members" ADD CONSTRAINT "fk_team_members_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
ALTER TABLE "workspace_team_access" ADD CONSTRAINT "fk_workspace_team_access_workspace_id" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;
ALTER TABLE "workspace_team_access" ADD CONSTRAINT "fk_workspace_team_access_team_id" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE;
ALTER TABLE "workspace_collaborators" ADD CONSTRAINT "fk_workspace_collaborators_workspace_id" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;
ALTER TABLE "workspace_collaborators" ADD CONSTRAINT "fk_workspace_collaborators_invited_user_id" FOREIGN KEY ("invited_user_id") REFERENCES "users"("id") ON DELETE CASCADE;
ALTER TABLE "workspace_guests" ADD CONSTRAINT "fk_workspace_guests_workspace_id" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;
ALTER TABLE "workspace_guests" ADD CONSTRAINT "fk_workspace_guests_invited_user_id" FOREIGN KEY ("invited_user_id") REFERENCES "users"("id") ON DELETE CASCADE;
ALTER TABLE "project_members" ADD CONSTRAINT "fk_project_members_project_id" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE;
ALTER TABLE "project_members" ADD CONSTRAINT "fk_project_members_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
ALTER TABLE "payments" ADD CONSTRAINT "fk_payments_account_id" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE;
ALTER TABLE "invoices" ADD CONSTRAINT "fk_invoices_account_id" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE;
ALTER TABLE "usage_metrics" ADD CONSTRAINT "fk_usage_metrics_account_id" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE;
ALTER TABLE "attachments" ADD CONSTRAINT "fk_attachments_uploaded_by_id" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE CASCADE;
ALTER TABLE "share_links" ADD CONSTRAINT "fk_share_links_created_by_id" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE;
ALTER TABLE "projects" ADD CONSTRAINT "fk_projects_workspace_id" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;
ALTER TABLE "projects" ADD CONSTRAINT "fk_projects_created_by_id" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE NO ACTION;
ALTER TABLE "tasks" ADD CONSTRAINT "fk_tasks_workspace_id" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;
ALTER TABLE "tasks" ADD CONSTRAINT "fk_tasks_project_id" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL;
ALTER TABLE "tasks" ADD CONSTRAINT "fk_tasks_created_by_id" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE NO ACTION;
ALTER TABLE "task_dependencies" ADD CONSTRAINT "fk_task_dependencies_blocking_task_id" FOREIGN KEY ("blocking_task_id") REFERENCES "tasks"("id") ON DELETE CASCADE;
ALTER TABLE "task_dependencies" ADD CONSTRAINT "fk_task_dependencies_blocked_task_id" FOREIGN KEY ("blocked_task_id") REFERENCES "tasks"("id") ON DELETE CASCADE;
ALTER TABLE "comments" ADD CONSTRAINT "fk_comments_author_id" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE CASCADE;
ALTER TABLE "comments" ADD CONSTRAINT "fk_comments_parent_comment_id" FOREIGN KEY ("parent_comment_id") REFERENCES "comments"("id") ON DELETE CASCADE;
ALTER TABLE "reactions" ADD CONSTRAINT "fk_reactions_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
ALTER TABLE "mentions" ADD CONSTRAINT "fk_mentions_comment_id" FOREIGN KEY ("comment_id") REFERENCES "comments"("id") ON DELETE CASCADE;
ALTER TABLE "mentions" ADD CONSTRAINT "fk_mentions_mentioned_user_id" FOREIGN KEY ("mentioned_user_id") REFERENCES "users"("id") ON DELETE CASCADE;
ALTER TABLE "custom_fields" ADD CONSTRAINT "fk_custom_fields_workspace_id" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;
ALTER TABLE "task_custom_values" ADD CONSTRAINT "fk_task_custom_values_task_id" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE;
ALTER TABLE "task_custom_values" ADD CONSTRAINT "fk_task_custom_values_field_id" FOREIGN KEY ("field_id") REFERENCES "custom_fields"("id") ON DELETE CASCADE;
ALTER TABLE "tags" ADD CONSTRAINT "fk_tags_workspace_id" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;
ALTER TABLE "task_tags" ADD CONSTRAINT "fk_task_tags_task_id" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE;
ALTER TABLE "task_tags" ADD CONSTRAINT "fk_task_tags_tag_id" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE;
ALTER TABLE "activities" ADD CONSTRAINT "fk_activities_actor_id" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE NO ACTION;
ALTER TABLE "audit_logs" ADD CONSTRAINT "fk_audit_logs_actor_id" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE NO ACTION;
ALTER TABLE "audit_logs" ADD CONSTRAINT "fk_audit_logs_account_id" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE;
ALTER TABLE "watches" ADD CONSTRAINT "fk_watches_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
ALTER TABLE "notifications" ADD CONSTRAINT "fk_notifications_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "fk_notification_deliveries_notification_id" FOREIGN KEY ("notification_id") REFERENCES "notifications"("id") ON DELETE CASCADE;
ALTER TABLE "snap_sessions" ADD CONSTRAINT "fk_snap_sessions_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
ALTER TABLE "snap_clauses" ADD CONSTRAINT "fk_snap_clauses_session_id" FOREIGN KEY ("session_id") REFERENCES "snap_sessions"("id") ON DELETE CASCADE;
ALTER TABLE "snap_clauses" ADD CONSTRAINT "fk_snap_clauses_created_task_id" FOREIGN KEY ("created_task_id") REFERENCES "tasks"("id") ON DELETE NO ACTION;

CREATE TABLE "_TaskAssignees" (
  "A" TEXT NOT NULL REFERENCES "tasks"(id) ON DELETE CASCADE,
  "B" TEXT NOT NULL REFERENCES "users"(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX "_TaskAssignees_AB_unique" ON "_TaskAssignees"("A", "B");
CREATE INDEX "_TaskAssignees_B_index" ON "_TaskAssignees"("B");

COMMIT;