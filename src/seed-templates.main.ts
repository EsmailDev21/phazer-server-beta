import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { TemplateSeedService } from './templates/seeds';

/**
 * Step 3.9. One-shot: publishes (or updates) the first-party templates, prints what happened, exits.
 * Idempotent; run it after `prisma migrate deploy` on every deploy.
 *   npm run seed:templates          (dev)        npm run seed:templates:prod   (built)
 */
async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn', 'log'] });
  try {
    const report = await app.get(TemplateSeedService).seedAll();
    for (const r of report.results) {
      Logger.log(`${r.seedKey}: ${r.action} (${r.semver})${r.metaUpdated ? ' + details re-synced' : ''}`, 'SeedTemplates');
    }
  } finally {
    await app.close();
  }
}

bootstrap().then(
  () => process.exit(0),
  (err) => {
    // eslint-disable-next-line no-console
    console.error('Seeding templates failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
