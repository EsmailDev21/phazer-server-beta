/**
 * Runs before EACH test FILE (Jest setupFilesAfterEnv) — has access to
 * global expect/describe/etc. and to per-file jest.setTimeout, unlike
 * global-setup.ts.
 */
import { config } from 'dotenv';
config();
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}
