import {
  CanActivate,
  Controller,
  Get,
  Module,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AllExceptionsFilter } from '../common/filters/all-exceptions.filter';
import { FeatureFlagsService } from './feature-flags.service';
import { FeatureGuard } from './feature.guard';
import { RequireFeature } from './require-feature.decorator';

/** Stand-in for JwtAuthGuard: rejects everyone, like an anonymous caller. */
class DenyAllAuthGuard implements CanActivate {
  canActivate(): boolean {
    throw new UnauthorizedException('Unauthorized');
  }
}

@RequireFeature('WORKFLOW')
@Controller('workflow-things')
class WorkflowController {
  @Get()
  list() {
    return ['ok'];
  }

  // class flag AND method flag: both must be on
  @RequireFeature('TEMPLATES')
  @Post()
  create() {
    return { created: true };
  }
}

@Controller('plain')
class PlainController {
  @Get()
  list() {
    return ['plain'];
  }
}

async function buildApp(
  env: NodeJS.ProcessEnv,
  { authFirst = false }: { authFirst?: boolean } = {},
): Promise<NestExpressApplication> {
  @Module({
    controllers: [WorkflowController, PlainController],
    providers: [
      { provide: FeatureFlagsService, useValue: new FeatureFlagsService(env) },
      FeatureGuard,
      { provide: APP_FILTER, useClass: AllExceptionsFilter },
      // Same relative order as AppModule: FeatureGuard, then auth.
      ...(authFirst
        ? [
            { provide: APP_GUARD, useClass: DenyAllAuthGuard },
            { provide: APP_GUARD, useClass: FeatureGuard },
          ]
        : [
            { provide: APP_GUARD, useClass: FeatureGuard },
            { provide: APP_GUARD, useClass: DenyAllAuthGuard },
          ]),
    ],
  })
  class TestModule {}

  const moduleRef = await Test.createTestingModule({
    imports: [TestModule],
  }).compile();
  moduleRef.useLogger(false); // AllExceptionsFilter logs every 4xx; keep test output readable
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  await app.init();
  return app;
}

/** requestId / timestamp differ per request; everything else must match. */
function shape(body: Record<string, unknown>) {
  const { requestId, timestamp, ...rest } = body;
  expect(typeof requestId).toBe('string');
  expect(typeof timestamp).toBe('string');
  return rest;
}

describe('FeatureGuard', () => {
  let app: NestExpressApplication;
  afterEach(async () => app?.close());

  it('flag OFF: 404 - and NOT 401 - for an anonymous caller', async () => {
    app = await buildApp({});
    await request(app.getHttpServer()).get('/workflow-things').expect(404);
  });

  it('flag OFF: the response is indistinguishable from a route that does not exist', async () => {
    app = await buildApp({});
    // Unknown route: Nest 404s before any guard runs.
    const missing = await request(app.getHttpServer())
      .get('/workflow-things-typo')
      .expect(404);
    const disabled = await request(app.getHttpServer())
      .get('/workflow-things')
      .expect(404);

    // Identical apart from the echoed path (which is the point: Nest itself
    // echoes the path in its own 404s) and the per-request id/timestamp.
    const strip = (body: Record<string, unknown>, path: string) => {
      const { message, ...rest } = shape(body);
      expect(message).toBe(`Cannot GET ${path}`);
      return rest;
    };
    expect(strip(disabled.body, '/workflow-things')).toEqual(
      strip(missing.body, '/workflow-things-typo'),
    );
    expect(strip(disabled.body, '/workflow-things')).toEqual({
      statusCode: 404,
      error: 'NOT_FOUND', // whatever AllExceptionsFilter emits for a 404
    });
    expect(Object.keys(disabled.body).sort()).toEqual(
      Object.keys(missing.body).sort(),
    );
  });

  it('flag OFF: the query string is echoed exactly as Nest does for a missing route', async () => {
    app = await buildApp({});
    const res = await request(app.getHttpServer())
      .get('/workflow-things?x=1')
      .expect(404);
    expect(res.body.message).toBe('Cannot GET /workflow-things?x=1');
  });

  it('flag ON: the request continues to the next guard (auth answers 401)', async () => {
    app = await buildApp({ FEATURE_WORKFLOW: 'true' });
    await request(app.getHttpServer()).get('/workflow-things').expect(401);
  });

  it('routes without @RequireFeature are untouched by the guard', async () => {
    app = await buildApp({});
    // reaches the auth stand-in, i.e. FeatureGuard let it through
    await request(app.getHttpServer()).get('/plain').expect(401);
  });

  it('class flag and method flag are merged: BOTH must be on', async () => {
    app = await buildApp({ FEATURE_WORKFLOW: 'true' }); // TEMPLATES still off
    await request(app.getHttpServer()).post('/workflow-things').expect(404);
    await app.close();

    app = await buildApp({
      FEATURE_WORKFLOW: 'true',
      FEATURE_TEMPLATES: 'true',
    });
    await request(app.getHttpServer()).post('/workflow-things').expect(401);
  });

  it('a method-level flag does not switch off sibling routes that only need the class flag', async () => {
    app = await buildApp({ FEATURE_WORKFLOW: 'true' });
    await request(app.getHttpServer()).get('/workflow-things').expect(401);
  });

  it('CONTROL: if the guard were registered AFTER auth, a disabled route would leak as 401', async () => {
    // This is why AppModule registers FeatureGuard first. If someone reorders
    // the providers, the first test in this file fails; this one documents why.
    app = await buildApp({}, { authFirst: true });
    await request(app.getHttpServer()).get('/workflow-things').expect(401);
  });
});
