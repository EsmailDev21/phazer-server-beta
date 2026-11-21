BEGIN;

-- AlterEnum: creation_mode gains IMPORT, TEMPLATE, INTEGRATION (step 0.6).
-- Ahead of their consumers - Phase 1 imports, Phase 3 templates, Phase 2
-- integrations respectively - same "expand the enum before the feature
-- that sets it" pattern as everything else added in this migration.
ALTER TYPE "creation_mode" ADD VALUE 'IMPORT';
ALTER TYPE "creation_mode" ADD VALUE 'TEMPLATE';
ALTER TYPE "creation_mode" ADD VALUE 'INTEGRATION';

-- AlterEnum: audit_action gains integration/import/template events (step 0.6).
-- No caller yet - AuditLogService.record() is a thin pass-through.
ALTER TYPE "audit_action" ADD VALUE 'INTEGRATION_CONNECTED';
ALTER TYPE "audit_action" ADD VALUE 'INTEGRATION_DISCONNECTED';
ALTER TYPE "audit_action" ADD VALUE 'IMPORT_STARTED';
ALTER TYPE "audit_action" ADD VALUE 'IMPORT_COMPLETED';
ALTER TYPE "audit_action" ADD VALUE 'IMPORT_ROLLED_BACK';
ALTER TYPE "audit_action" ADD VALUE 'TEMPLATE_PUBLISHED';
ALTER TYPE "audit_action" ADD VALUE 'TEMPLATE_APPLIED';

-- CreateEnum
CREATE TYPE "integration_provider" AS ENUM ('DISCORD', 'SLACK', 'GITHUB', 'CLICKUP', 'JIRA', 'LINEAR');

-- CreateEnum
CREATE TYPE "platform_role" AS ENUM ('NONE', 'MODERATOR', 'ADMIN');

-- AlterTable: outside account RBAC (PlatformGuard / @RequirePlatformRole).
-- NOT NULL DEFAULT 'NONE' - every existing row is unaffected.
ALTER TABLE "users" ADD COLUMN "platform_role" "platform_role" NOT NULL DEFAULT 'NONE';

COMMIT;
