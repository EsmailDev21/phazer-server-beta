-- DropForeignKey
ALTER TABLE "_TaskAssignees" DROP CONSTRAINT "_TaskAssignees_A_fkey";

-- DropForeignKey
ALTER TABLE "_TaskAssignees" DROP CONSTRAINT "_TaskAssignees_B_fkey";

-- DropForeignKey
ALTER TABLE "account_members" DROP CONSTRAINT "fk_account_members_account_id";

-- DropForeignKey
ALTER TABLE "account_members" DROP CONSTRAINT "fk_account_members_user_id";

-- DropForeignKey
ALTER TABLE "accounts" DROP CONSTRAINT "fk_accounts_personal_owner_id";

-- DropForeignKey
ALTER TABLE "activities" DROP CONSTRAINT "fk_activities_actor_id";

-- DropForeignKey
ALTER TABLE "attachments" DROP CONSTRAINT "fk_attachments_uploaded_by_id";

-- DropForeignKey
ALTER TABLE "audit_logs" DROP CONSTRAINT "fk_audit_logs_account_id";

-- DropForeignKey
ALTER TABLE "audit_logs" DROP CONSTRAINT "fk_audit_logs_actor_id";

-- DropForeignKey
ALTER TABLE "comments" DROP CONSTRAINT "fk_comments_author_id";

-- DropForeignKey
ALTER TABLE "comments" DROP CONSTRAINT "fk_comments_parent_comment_id";

-- DropForeignKey
ALTER TABLE "custom_fields" DROP CONSTRAINT "fk_custom_fields_workspace_id";

-- DropForeignKey
ALTER TABLE "invoices" DROP CONSTRAINT "fk_invoices_account_id";

-- DropForeignKey
ALTER TABLE "mentions" DROP CONSTRAINT "fk_mentions_comment_id";

-- DropForeignKey
ALTER TABLE "mentions" DROP CONSTRAINT "fk_mentions_mentioned_user_id";

-- DropForeignKey
ALTER TABLE "notification_deliveries" DROP CONSTRAINT "fk_notification_deliveries_notification_id";

-- DropForeignKey
ALTER TABLE "notifications" DROP CONSTRAINT "fk_notifications_user_id";

-- DropForeignKey
ALTER TABLE "organizations" DROP CONSTRAINT "fk_organizations_account_id";

-- DropForeignKey
ALTER TABLE "payments" DROP CONSTRAINT "fk_payments_account_id";

-- DropForeignKey
ALTER TABLE "project_members" DROP CONSTRAINT "fk_project_members_project_id";

-- DropForeignKey
ALTER TABLE "project_members" DROP CONSTRAINT "fk_project_members_user_id";

-- DropForeignKey
ALTER TABLE "projects" DROP CONSTRAINT "fk_projects_created_by_id";

-- DropForeignKey
ALTER TABLE "projects" DROP CONSTRAINT "fk_projects_workspace_id";

-- DropForeignKey
ALTER TABLE "reactions" DROP CONSTRAINT "fk_reactions_user_id";

-- DropForeignKey
ALTER TABLE "refresh_tokens" DROP CONSTRAINT "fk_refresh_tokens_user_id";

-- DropForeignKey
ALTER TABLE "share_links" DROP CONSTRAINT "fk_share_links_created_by_id";

-- DropForeignKey
ALTER TABLE "snap_clauses" DROP CONSTRAINT "fk_snap_clauses_created_task_id";

-- DropForeignKey
ALTER TABLE "snap_clauses" DROP CONSTRAINT "fk_snap_clauses_session_id";

-- DropForeignKey
ALTER TABLE "snap_sessions" DROP CONSTRAINT "fk_snap_sessions_user_id";

-- DropForeignKey
ALTER TABLE "tags" DROP CONSTRAINT "fk_tags_workspace_id";

-- DropForeignKey
ALTER TABLE "task_custom_values" DROP CONSTRAINT "fk_task_custom_values_field_id";

-- DropForeignKey
ALTER TABLE "task_custom_values" DROP CONSTRAINT "fk_task_custom_values_task_id";

-- DropForeignKey
ALTER TABLE "task_dependencies" DROP CONSTRAINT "fk_task_dependencies_blocked_task_id";

-- DropForeignKey
ALTER TABLE "task_dependencies" DROP CONSTRAINT "fk_task_dependencies_blocking_task_id";

-- DropForeignKey
ALTER TABLE "task_tags" DROP CONSTRAINT "fk_task_tags_tag_id";

-- DropForeignKey
ALTER TABLE "task_tags" DROP CONSTRAINT "fk_task_tags_task_id";

-- DropForeignKey
ALTER TABLE "tasks" DROP CONSTRAINT "fk_tasks_created_by_id";

-- DropForeignKey
ALTER TABLE "tasks" DROP CONSTRAINT "fk_tasks_parent_id";

-- DropForeignKey
ALTER TABLE "tasks" DROP CONSTRAINT "fk_tasks_project_id";

-- DropForeignKey
ALTER TABLE "tasks" DROP CONSTRAINT "fk_tasks_workspace_id";

-- DropForeignKey
ALTER TABLE "team_members" DROP CONSTRAINT "fk_team_members_team_id";

-- DropForeignKey
ALTER TABLE "team_members" DROP CONSTRAINT "fk_team_members_user_id";

-- DropForeignKey
ALTER TABLE "teams" DROP CONSTRAINT "fk_teams_account_id";

-- DropForeignKey
ALTER TABLE "usage_metrics" DROP CONSTRAINT "fk_usage_metrics_account_id";

-- DropForeignKey
ALTER TABLE "user_preferences" DROP CONSTRAINT "fk_user_preferences_user_id";

-- DropForeignKey
ALTER TABLE "watches" DROP CONSTRAINT "fk_watches_user_id";

-- DropForeignKey
ALTER TABLE "workspace_collaborators" DROP CONSTRAINT "fk_workspace_collaborators_invited_user_id";

-- DropForeignKey
ALTER TABLE "workspace_collaborators" DROP CONSTRAINT "fk_workspace_collaborators_workspace_id";

-- DropForeignKey
ALTER TABLE "workspace_guests" DROP CONSTRAINT "fk_workspace_guests_invited_user_id";

-- DropForeignKey
ALTER TABLE "workspace_guests" DROP CONSTRAINT "fk_workspace_guests_workspace_id";

-- DropForeignKey
ALTER TABLE "workspace_key_aliases" DROP CONSTRAINT "fk_workspace_key_aliases_account_id";

-- DropForeignKey
ALTER TABLE "workspace_key_aliases" DROP CONSTRAINT "fk_workspace_key_aliases_workspace_id";

-- DropForeignKey
ALTER TABLE "workspace_team_access" DROP CONSTRAINT "fk_workspace_team_access_team_id";

-- DropForeignKey
ALTER TABLE "workspace_team_access" DROP CONSTRAINT "fk_workspace_team_access_workspace_id";

-- DropForeignKey
ALTER TABLE "workspaces" DROP CONSTRAINT "fk_workspaces_account_id";

-- AlterTable
ALTER TABLE "accounts" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "channel_subscriptions" ALTER COLUMN "events" DROP DEFAULT;

-- AlterTable
ALTER TABLE "comments" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "integration_connections" ALTER COLUMN "scopes" DROP DEFAULT;

-- AlterTable
ALTER TABLE "organizations" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "projects" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "snap_clauses" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "snap_sessions" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "tasks" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "teams" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "user_preferences" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "users" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "workspaces" ALTER COLUMN "updated_at" DROP DEFAULT;

-- RenameForeignKey
ALTER TABLE "automation_messages" RENAME CONSTRAINT "fk_automation_messages_automation" TO "automation_messages_automation_id_fkey";

-- RenameForeignKey
ALTER TABLE "automation_messages" RENAME CONSTRAINT "fk_automation_messages_task" TO "automation_messages_task_id_fkey";

-- RenameForeignKey
ALTER TABLE "automation_messages" RENAME CONSTRAINT "fk_automation_messages_workspace" TO "automation_messages_workspace_id_fkey";

-- RenameForeignKey
ALTER TABLE "automation_runs" RENAME CONSTRAINT "fk_automation_runs_automation" TO "automation_runs_automation_id_fkey";

-- RenameForeignKey
ALTER TABLE "automation_runs" RENAME CONSTRAINT "fk_automation_runs_task" TO "automation_runs_task_id_fkey";

-- RenameForeignKey
ALTER TABLE "automation_runs" RENAME CONSTRAINT "fk_automation_runs_workspace" TO "automation_runs_workspace_id_fkey";

-- RenameForeignKey
ALTER TABLE "automation_waits" RENAME CONSTRAINT "fk_automation_waits_automation" TO "automation_waits_automation_id_fkey";

-- RenameForeignKey
ALTER TABLE "automation_waits" RENAME CONSTRAINT "fk_automation_waits_run" TO "automation_waits_run_id_fkey";

-- RenameForeignKey
ALTER TABLE "automation_waits" RENAME CONSTRAINT "fk_automation_waits_task" TO "automation_waits_task_id_fkey";

-- RenameForeignKey
ALTER TABLE "automation_waits" RENAME CONSTRAINT "fk_automation_waits_workspace" TO "automation_waits_workspace_id_fkey";

-- RenameForeignKey
ALTER TABLE "automations" RENAME CONSTRAINT "fk_automations_creator" TO "automations_created_by_id_fkey";

-- RenameForeignKey
ALTER TABLE "automations" RENAME CONSTRAINT "fk_automations_project" TO "automations_project_id_fkey";

-- RenameForeignKey
ALTER TABLE "automations" RENAME CONSTRAINT "fk_automations_workspace" TO "automations_workspace_id_fkey";

-- RenameForeignKey
ALTER TABLE "saved_views" RENAME CONSTRAINT "fk_saved_views_owner" TO "saved_views_owner_id_fkey";

-- RenameForeignKey
ALTER TABLE "saved_views" RENAME CONSTRAINT "fk_saved_views_project" TO "saved_views_project_id_fkey";

-- RenameForeignKey
ALTER TABLE "saved_views" RENAME CONSTRAINT "fk_saved_views_workspace" TO "saved_views_workspace_id_fkey";

-- RenameForeignKey
ALTER TABLE "workflow_statuses" RENAME CONSTRAINT "fk_workflow_statuses_project" TO "workflow_statuses_project_id_fkey";

-- AddForeignKey
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_personal_owner_id_fkey" FOREIGN KEY ("personal_owner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_key_aliases" ADD CONSTRAINT "workspace_key_aliases_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_key_aliases" ADD CONSTRAINT "workspace_key_aliases_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teams" ADD CONSTRAINT "teams_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_members" ADD CONSTRAINT "account_members_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_members" ADD CONSTRAINT "account_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_team_access" ADD CONSTRAINT "workspace_team_access_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_team_access" ADD CONSTRAINT "workspace_team_access_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_collaborators" ADD CONSTRAINT "workspace_collaborators_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_collaborators" ADD CONSTRAINT "workspace_collaborators_invited_user_id_fkey" FOREIGN KEY ("invited_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_guests" ADD CONSTRAINT "workspace_guests_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_guests" ADD CONSTRAINT "workspace_guests_invited_user_id_fkey" FOREIGN KEY ("invited_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_metrics" ADD CONSTRAINT "usage_metrics_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "fk_tasks_parent_id" FOREIGN KEY ("parent_id") REFERENCES "tasks"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_blocking_task_id_fkey" FOREIGN KEY ("blocking_task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_blocked_task_id_fkey" FOREIGN KEY ("blocked_task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_parent_comment_id_fkey" FOREIGN KEY ("parent_comment_id") REFERENCES "comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reactions" ADD CONSTRAINT "reactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mentions" ADD CONSTRAINT "mentions_comment_id_fkey" FOREIGN KEY ("comment_id") REFERENCES "comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mentions" ADD CONSTRAINT "mentions_mentioned_user_id_fkey" FOREIGN KEY ("mentioned_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_fields" ADD CONSTRAINT "custom_fields_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_custom_values" ADD CONSTRAINT "task_custom_values_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_custom_values" ADD CONSTRAINT "task_custom_values_field_id_fkey" FOREIGN KEY ("field_id") REFERENCES "custom_fields"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tags" ADD CONSTRAINT "tags_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_tags" ADD CONSTRAINT "task_tags_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_tags" ADD CONSTRAINT "task_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activities" ADD CONSTRAINT "activities_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "watches" ADD CONSTRAINT "watches_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_notification_id_fkey" FOREIGN KEY ("notification_id") REFERENCES "notifications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "snap_sessions" ADD CONSTRAINT "snap_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "snap_clauses" ADD CONSTRAINT "snap_clauses_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "snap_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "snap_clauses" ADD CONSTRAINT "snap_clauses_created_task_id_fkey" FOREIGN KEY ("created_task_id") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_TaskAssignees" ADD CONSTRAINT "_TaskAssignees_A_fkey" FOREIGN KEY ("A") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_TaskAssignees" ADD CONSTRAINT "_TaskAssignees_B_fkey" FOREIGN KEY ("B") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "ix_account_members_user_id" RENAME TO "account_members_user_id_idx";

-- RenameIndex
ALTER INDEX "uq_account_members_account_id_user_id" RENAME TO "account_members_account_id_user_id_key";

-- RenameIndex
ALTER INDEX "ix_accounts_deleted_at" RENAME TO "accounts_deleted_at_idx";

-- RenameIndex
ALTER INDEX "ix_accounts_type" RENAME TO "accounts_type_idx";

-- RenameIndex
ALTER INDEX "uq_accounts_external_customer_id" RENAME TO "accounts_external_customer_id_key";

-- RenameIndex
ALTER INDEX "uq_accounts_personal_owner_id" RENAME TO "accounts_personal_owner_id_key";

-- RenameIndex
ALTER INDEX "ix_activities_target_type_target_id" RENAME TO "activities_target_type_target_id_idx";

-- RenameIndex
ALTER INDEX "ix_activities_workspace_id_created_at" RENAME TO "activities_workspace_id_created_at_idx";

-- RenameIndex
ALTER INDEX "ix_attachments_account_id_status" RENAME TO "attachments_account_id_status_idx";

-- RenameIndex
ALTER INDEX "ix_attachments_target_type_target_id" RENAME TO "attachments_target_type_target_id_idx";

-- RenameIndex
ALTER INDEX "ix_audit_logs_account_id_created_at" RENAME TO "audit_logs_account_id_created_at_idx";

-- RenameIndex
ALTER INDEX "ix_comments_target_type_target_id" RENAME TO "comments_target_type_target_id_idx";

-- RenameIndex
ALTER INDEX "uq_custom_fields_workspace_id_key" RENAME TO "custom_fields_workspace_id_key_key";

-- RenameIndex
ALTER INDEX "ix_invites_target_type_target_id" RENAME TO "invites_target_type_target_id_idx";

-- RenameIndex
ALTER INDEX "uq_invites_token_hash" RENAME TO "invites_token_hash_key";

-- RenameIndex
ALTER INDEX "ix_invoices_account_id" RENAME TO "invoices_account_id_idx";

-- RenameIndex
ALTER INDEX "uq_invoices_invoice_number" RENAME TO "invoices_invoice_number_key";

-- RenameIndex
ALTER INDEX "uq_invoices_provider_external_invoice_id" RENAME TO "invoices_provider_external_invoice_id_key";

-- RenameIndex
ALTER INDEX "ix_notification_deliveries_notification_id" RENAME TO "notification_deliveries_notification_id_idx";

-- RenameIndex
ALTER INDEX "ix_notifications_user_id_read_at" RENAME TO "notifications_user_id_read_at_idx";

-- RenameIndex
ALTER INDEX "uq_organizations_account_id" RENAME TO "organizations_account_id_key";

-- RenameIndex
ALTER INDEX "ix_payments_account_id" RENAME TO "payments_account_id_idx";

-- RenameIndex
ALTER INDEX "uq_payments_provider_external_transaction_id" RENAME TO "payments_provider_external_transaction_id_key";

-- RenameIndex
ALTER INDEX "uq_processed_webhook_events_provider_external_event_id" RENAME TO "processed_webhook_events_provider_external_event_id_key";

-- RenameIndex
ALTER INDEX "uq_project_members_project_id_user_id" RENAME TO "project_members_project_id_user_id_key";

-- RenameIndex
ALTER INDEX "ix_projects_workspace_id" RENAME TO "projects_workspace_id_idx";

-- RenameIndex
ALTER INDEX "ix_reactions_target_type_target_id" RENAME TO "reactions_target_type_target_id_idx";

-- RenameIndex
ALTER INDEX "uq_reactions_target_type_target_id_user_id_reaction" RENAME TO "reactions_target_type_target_id_user_id_reaction_key";

-- RenameIndex
ALTER INDEX "uq_refresh_tokens_token_hash" RENAME TO "refresh_tokens_token_hash_key";

-- RenameIndex
ALTER INDEX "ix_share_links_target_type_target_id" RENAME TO "share_links_target_type_target_id_idx";

-- RenameIndex
ALTER INDEX "uq_share_links_token_hash" RENAME TO "share_links_token_hash_key";

-- RenameIndex
ALTER INDEX "ix_snap_clauses_corrected_action_correction_type" RENAME TO "snap_clauses_corrected_action_correction_type_idx";

-- RenameIndex
ALTER INDEX "ix_snap_clauses_predicted_action_review_status" RENAME TO "snap_clauses_predicted_action_review_status_idx";

-- RenameIndex
ALTER INDEX "ix_snap_clauses_session_id_clause_index" RENAME TO "snap_clauses_session_id_clause_index_idx";

-- RenameIndex
ALTER INDEX "ix_snap_sessions_status" RENAME TO "snap_sessions_status_idx";

-- RenameIndex
ALTER INDEX "ix_snap_sessions_user_id_created_at" RENAME TO "snap_sessions_user_id_created_at_idx";

-- RenameIndex
ALTER INDEX "uq_task_custom_values_task_id_field_id" RENAME TO "task_custom_values_task_id_field_id_key";

-- RenameIndex
ALTER INDEX "uq_task_dependencies_blocking_task_id_blocked_task_id" RENAME TO "task_dependencies_blocking_task_id_blocked_task_id_key";

-- RenameIndex
ALTER INDEX "ix_tasks_workspace_id_status" RENAME TO "tasks_workspace_id_status_idx";

-- RenameIndex
ALTER INDEX "uq_team_members_team_id_user_id" RENAME TO "team_members_team_id_user_id_key";

-- RenameIndex
ALTER INDEX "ix_teams_account_id" RENAME TO "teams_account_id_idx";

-- RenameIndex
ALTER INDEX "uq_usage_metrics_account_id_metric_period" RENAME TO "usage_metrics_account_id_metric_period_key";

-- RenameIndex
ALTER INDEX "uq_user_preferences_user_id" RENAME TO "user_preferences_user_id_key";

-- RenameIndex
ALTER INDEX "uq_users_email" RENAME TO "users_email_key";

-- RenameIndex
ALTER INDEX "uq_users_google_id" RENAME TO "users_google_id_key";

-- RenameIndex
ALTER INDEX "uq_users_username" RENAME TO "users_username_key";

-- RenameIndex
ALTER INDEX "uq_watches_user_id_target_type_target_id" RENAME TO "watches_user_id_target_type_target_id_key";

-- RenameIndex
ALTER INDEX "uq_workspace_collaborators_workspace_id_invited_user_id" RENAME TO "workspace_collaborators_workspace_id_invited_user_id_key";

-- RenameIndex
ALTER INDEX "uq_workspace_guests_workspace_id_invited_user_id" RENAME TO "workspace_guests_workspace_id_invited_user_id_key";

-- RenameIndex
ALTER INDEX "uq_workspace_team_access_workspace_id_team_id" RENAME TO "workspace_team_access_workspace_id_team_id_key";

-- RenameIndex
ALTER INDEX "ix_workspaces_account_id" RENAME TO "workspaces_account_id_idx";
