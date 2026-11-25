import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerAppModule } from './worker/worker-app.module';
import { assertWorkerEnv } from './worker/assert-worker-env';
import { healthPortFrom, startHealthServer } from './worker/health-server';

/**
 * Worker entrypoint (ADR-0001): no HTTP listener, consumes queues. Started with
 * `npm run start:worker` / `start:worker:prod`.
 */
async function bootstrap() {
  // WorkerAppModule's ConfigModule has already loaded .env at import time.
  assertWorkerEnv();

  const app = await NestFactory.createApplicationContext(WorkerAppModule);
  // SIGTERM/SIGINT -> beforeApplicationShutdown -> drain running jobs.
  app.enableShutdownHooks();
  // Optional: answer on a port so hosts that insist on one (Render web services) keep the process running.
  const healthPort = healthPortFrom();
  if (healthPort !== null) {
    await startHealthServer(healthPort);
    Logger.log(`Worker health endpoint listening on ${healthPort}`, 'Bootstrap');
  }
  Logger.log('Worker started', 'Bootstrap');
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Worker failed to start:', err);
  process.exit(1);
});
