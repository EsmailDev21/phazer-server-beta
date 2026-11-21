import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';

// Real e2e: boots the actual AppModule (all real providers, real Prisma) and
// hits the actual public health route. Replaces a leftover Nest scaffold
// test that asserted 'GET /' -> 'Hello World!', a route this app never had.
describe('AppModule (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication({ rawBody: true });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health reports the app and database are reachable', async () => {
    await request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect((res) => {
        if (res.body.status !== 'ok') {
          throw new Error(
            `expected status "ok", got ${JSON.stringify(res.body)}`,
          );
        }
      });
  });
});
