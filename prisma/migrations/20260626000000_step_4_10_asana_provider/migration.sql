-- Step 4.10: Asana as an import provider. Additive: one new enum value, nothing is rewritten.
ALTER TYPE "integration_provider" ADD VALUE IF NOT EXISTS 'ASANA';
