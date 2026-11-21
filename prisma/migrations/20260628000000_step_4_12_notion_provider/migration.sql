-- Step 4.12: Notion as an import provider. Additive: one new enum value, nothing is rewritten.
ALTER TYPE "integration_provider" ADD VALUE IF NOT EXISTS 'NOTION';
