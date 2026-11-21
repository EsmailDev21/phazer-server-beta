/**
 * Truncates every application table between tests, so each test starts from
 * a genuinely empty database without the cost of re-running migrations.
 *
 * The table list is read from information_schema at call time rather than
 * hardcoded, so this never goes stale as new tables are added in later
 * phases (Phase 1 alone adds half a dozen). `_prisma_migrations` is excluded
 * on purpose - wiping it would make Prisma think the schema was never
 * migrated.
 *
 * RESTART IDENTITY resets any serial sequences (none exist yet - all ids are
 * cuid() - but this keeps the helper correct if one is ever added). CASCADE
 * is required because most tables have foreign keys to each other; TRUNCATE
 * of a subset would otherwise fail or need a precise dependency order.
 */
import type { PrismaService } from '../../../src/prisma/prisma.service';

export async function resetDb(prisma: PrismaService): Promise<void> {
  const tables: { tablename: string }[] = await prisma.$queryRawUnsafe(`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename NOT IN ('_prisma_migrations')
  `);

  if (tables.length === 0) {
    return;
  }

  const quoted = tables.map((t) => `"${t.tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE`,
  );
}
