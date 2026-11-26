import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { assertFeatureFlagEnv } from './feature-flags/assert-feature-env';
import { VALIDATION_PIPE_OPTIONS } from './common/validation-pipe.options';
/**
 * Foundations Operational Hardening — "no fallback secret, fail fast at
 * boot if unset." This check runs BEFORE NestFactory.create() so a missing
 * JWT_SECRET crashes the process immediately with a clear message instead
 * of silently falling back to a default (the audit finding this fixes: a
 * hardcoded fallback secret shipped to production).
 */
function assertRequiredEnv(): void {
  const required = ['JWT_SECRET', 'DATABASE_URL'];
  const missing = required.filter(
    (key) => !process.env[key] || process.env[key]?.trim() === '',
  );

  if (missing.length > 0) {
    // eslint-disable-next-line no-console
    console.error(
      `FATAL: missing required environment variable(s): ${missing.join(', ')}. ` +
        'Refusing to start — there is no fallback secret.',
    );
    process.exit(1);
  }
}

async function bootstrap() {
  assertRequiredEnv();
  assertFeatureFlagEnv();

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Required for the 3 billing webhook routes — Stripe/Lemon Squeezy
    // signature verification needs the EXACT raw request bytes, not the
    // JSON-reparsed body Express's default parser produces (re-serializing
    // parsed JSON is not guaranteed byte-identical to what was signed).
    // Attaches `req.rawBody: Buffer` to every request without disabling
    // normal `req.body` parsing for everything else.
    rawBody: true,
  });
  app.set('trust proxy', 1);
  const logger = new Logger('Bootstrap');

  app.use(helmet());
  app.use(compression());
  app.use(cookieParser());

  // CORS was never enabled — with a separate Next.js frontend this blocks
  // every request before any frontend code even runs. credentials: true is
  // required for the httpOnly auth cookie (SSE, and now the default cookie
  // path set on every login/register/refresh) to be sent cross-origin at
  // all; a wildcard origin is incompatible with credentials: true by the
  // CORS spec, so CORS_ORIGIN must be an explicit, comma-separated list.
  const corsOrigins = (process.env.CORS_ORIGIN ?? 'http://localhost:3001')
    .split(',')
    .map((origin) => origin.trim());
  app.enableCors({
    origin: corsOrigins,
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe(VALIDATION_PIPE_OPTIONS),
  );

  app.useGlobalFilters(new AllExceptionsFilter());

  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
  await app.listen(port);
  logger.log(`Application listening on port ${port}`);
}

bootstrap();
