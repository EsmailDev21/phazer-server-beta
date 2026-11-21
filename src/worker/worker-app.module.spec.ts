/**
 * DI-resolution smoke test for WorkerAppModule, same technique that caught
 * the three boot-blocking bugs fixed in patch 0004 (a real Nest DI graph,
 * only Prisma/storage faked — no database or object storage needed). This
 * is exactly how the missing WebhookIdempotencyModule import (step 0.3) was
 * actually found: `nest build`/`tsc` are silent about it because it's a
 * runtime DI error, not a type error.
 *
 * Needs a real Redis (QueueService/RedisService both fail fast without a
 * reachable one) — reuses the same TEST_REDIS_URL convention and CI
 * enforcement as worker-host.service.spec.ts.
 */
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { STORAGE_PROVIDER } from '../attachments/storage/storage-provider.interface';
import { WorkerAppModule } from './worker-app.module';

const REAL = process.env.TEST_REDIS_URL;
const describeReal = REAL ? describe : describe.skip;
if (!REAL && process.env.CI) {
  throw new Error(
    'TEST_REDIS_URL must be set in CI for worker-app.module.spec.ts',
  );
}
if (!REAL) {
  // eslint-disable-next-line no-console
  console.warn('worker-app.module.spec: TEST_REDIS_URL not set - skipping.');
}

describeReal('WorkerAppModule DI graph', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('resolves and boots end to end (Prisma + storage faked, real Redis)', async () => {
    process.env.REDIS_URL = REAL;
    process.env.JWT_SECRET ??= 'test-secret-test-secret-test-secret-000000';
    process.env.JWT_REFRESH_SECRET ??=
      'test-refresh-secret-test-refresh-secret-000000';

    const moduleRef = await Test.createTestingModule({
      imports: [WorkerAppModule],
    })
      .overrideProvider(PrismaService)
      .useValue({
        $connect: async () => undefined,
        $disconnect: async () => undefined,
      })
      .overrideProvider(STORAGE_PROVIDER)
      .useValue({ deleteObject: async () => undefined })
      .compile();

    const app = moduleRef.createNestApplication();
    await app.init();
    await app.close();
  }, 30_000);
});
