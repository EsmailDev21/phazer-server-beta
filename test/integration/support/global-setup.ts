/**
 * Runs ONCE before the whole integration suite (Jest globalSetup — no access
 * to global expect/describe, and nothing here is shared with test files
 * directly; it only prepares the database on disk).
 *
 * Deliberately uses `prisma migrate deploy`, the exact command CI/production
 * uses, rather than `db push` or applying migration.sql by hand — so this
 * suite is also, incidentally, a check that the committed migrations apply
 * cleanly to an empty database every time it runs.
 */
import { execSync } from 'child_process';

module.exports = async () => {
  const url = requireTestDatabaseUrl();
  process.env.DATABASE_URL = url;

  execSync('npx prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'inherit',
  });
};

function requireTestDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Integration tests refuse to guess a database ' +
        '(pointing this at a real dev/prod database by accident would be destructive - ' +
        'every test truncates all tables). Copy .env.example and start it with `npm run db:up`.',
    );
  }
  if (!/\/appdb_test(\?|$)/.test(url)) {
    throw new Error(
      `TEST_DATABASE_URL ("${url}") does not look like the disposable test database ` +
        '(expected a database named appdb_test). Refusing to run - this suite truncates ' +
        'every table before each test.',
    );
  }
  return url;
}
