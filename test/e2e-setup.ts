/** Mirrors test/integration/support/setup-after-env.ts: e2e tests exercise
 * the real HTTP app, so they need the same disposable database, never a
 * developer's real one. */
import { config } from 'dotenv';
config();
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}
