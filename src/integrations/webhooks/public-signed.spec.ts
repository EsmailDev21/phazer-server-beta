/**
 * Step 0.9. Real HTTP (supertest) against a real Nest app wired like
 * production where it matters: the SAME global ValidationPipe options as
 * main.ts, the real ThrottlerGuard and JwtAuthGuard as global guards, and
 * rawBody enabled. These tests exist because the behaviours below are
 * properties of Nest's request pipeline, not of our code, and our first
 * reading of them (a permissive per-route pipe) was wrong.
 */
import {
  Body,
  Controller,
  Injectable,
  Module,
  Post,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { APP_GUARD, DiscoveryModule } from '@nestjs/core';
import { PassportModule, PassportStrategy } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { IsString } from 'class-validator';
import { ExtractJwt, Strategy } from 'passport-jwt';
import request from 'supertest';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { Public } from '../../auth/decorators/public.decorator';
import {
  PublicSigned,
  SignedPayload,
  SignedRawBody,
} from '../../auth/decorators/public-signed.decorator';
import { PublicSignedAuditor } from './public-signed.auditor';

class StrictDto {
  @IsString()
  action: string;
}

@Injectable()
class StubJwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: 'test',
    });
  }
  validate(p: unknown) {
    return p;
  }
}

@Controller('hook')
class WebhookTestController {
  /** What a provider adapter should look like. */
  @PublicSigned()
  @Post('signed')
  signed(@SignedPayload() payload: any, @SignedRawBody() raw: Buffer) {
    return {
      keys: Object.keys(payload).sort(),
      rawLength: raw.length,
      raw: raw.toString('utf8'),
    };
  }

  /** The literal reading of the spec: a permissive pipe on the route, DTO body. */
  @PublicSigned()
  @UsePipes(
    new ValidationPipe({ whitelist: false, forbidNonWhitelisted: false }),
  )
  @Post('dto-with-route-pipe')
  dto(@Body() dto: StrictDto) {
    return { ok: dto.action };
  }

  /** Same limit as the signed route would hit if throttling applied. */
  @Public()
  @Post('plain-public')
  plain() {
    return { ok: true };
  }

  @PublicSigned()
  @Post('status')
  status() {
    return { ok: true };
  }

  @Post('private')
  priv() {
    return { ok: true };
  }
}

@Module({
  imports: [
    PassportModule,
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 3 }]),
  ],
  controllers: [WebhookTestController],
  providers: [
    StubJwtStrategy,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
class TestAppModule {}

async function makeApp(): Promise<NestExpressApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [TestAppModule],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({
    rawBody: true,
  });
  // Identical options to main.ts - the whole point.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  await app.init();
  return app;
}

describe('@PublicSigned over real HTTP', () => {
  let app: NestExpressApplication;
  beforeAll(async () => {
    app = await makeApp();
  });
  afterAll(() => app.close());

  it('WHY there is no permissive route pipe: a global strict pipe still rejects a DTO body even with a lenient @UsePipes on the route', async () => {
    const res = await request(app.getHttpServer())
      .post('/hook/dto-with-route-pipe')
      .send({
        action: 'opened',
        installation: { id: 1 },
        sender: { login: 'x' },
      });
    expect(res.status).toBe(400); // forbidNonWhitelisted from the GLOBAL pipe won
  });

  it('@SignedPayload accepts a payload full of undeclared fields', async () => {
    const res = await request(app.getHttpServer())
      .post('/hook/signed')
      .send({
        action: 'opened',
        installation: { id: 1 },
        sender: { login: 'x' },
        zen: 'Keep it logically awesome.',
      });
    expect(res.status).toBe(200);
    expect(res.body.keys).toEqual(['action', 'installation', 'sender', 'zen']);
  });

  it('@SignedRawBody is the exact bytes sent, not a re-serialisation', async () => {
    const exact = '{ "b":2,   "a" : 1 }\n'; // odd whitespace + key order
    const res = await request(app.getHttpServer())
      .post('/hook/signed')
      .set('Content-Type', 'application/json')
      .send(exact);
    expect(res.status).toBe(200);
    expect(res.body.raw).toBe(exact);
    expect(res.body.rawLength).toBe(Buffer.byteLength(exact));
  });

  it('raw body is also captured for form-encoded posts (Slack interactions)', async () => {
    const res = await request(app.getHttpServer())
      .post('/hook/signed')
      .type('form')
      .send('payload=%7B%22type%22%3A%22block_actions%22%7D&team_id=T1');
    expect(res.status).toBe(200);
    expect(res.body.raw).toBe(
      'payload=%7B%22type%22%3A%22block_actions%22%7D&team_id=T1',
    );
    expect(res.body.keys).toEqual(['payload', 'team_id']);
  });

  it('no body at all -> 400 from SignedRawBody, never a silent empty buffer', async () => {
    const res = await request(app.getHttpServer()).post('/hook/signed');
    expect(res.status).toBe(400);
  });

  it('answers 200, not the POST default 201', async () => {
    const res = await request(app.getHttpServer())
      .post('/hook/status')
      .send({});
    expect(res.status).toBe(200);
  });

  it('is reachable without a JWT, while an undecorated route is 401', async () => {
    expect(
      (await request(app.getHttpServer()).post('/hook/status').send({})).status,
    ).toBe(200);
    expect(
      (await request(app.getHttpServer()).post('/hook/private').send({}))
        .status,
    ).toBe(401);
  });

  it('skips the default throttle: well past the limit of 3 every call is 200, while a plain @Public route is cut off', async () => {
    const signed: number[] = [];
    for (let i = 0; i < 12; i++) {
      signed.push(
        (await request(app.getHttpServer()).post('/hook/status').send({}))
          .status,
      );
    }
    expect(signed.every((s) => s === 200)).toBe(true);

    const plain: number[] = [];
    for (let i = 0; i < 6; i++) {
      plain.push(
        (await request(app.getHttpServer()).post('/hook/plain-public').send({}))
          .status,
      );
    }
    expect(plain).toContain(429);
  });
});

describe('PublicSignedAuditor', () => {
  async function auditorFor(controllers: any[]) {
    @Module({
      imports: [DiscoveryModule],
      controllers,
      providers: [PublicSignedAuditor],
    })
    class M {}
    const moduleRef = await Test.createTestingModule({
      imports: [M],
    }).compile();
    return moduleRef.get(PublicSignedAuditor);
  }

  it('passes the shapes an adapter is supposed to use', async () => {
    @Controller('clean')
    class Clean {
      @PublicSigned() @Post('a') a(
        @SignedPayload() _p: unknown,
        @SignedRawBody() _r: Buffer,
      ) {
        return 1;
      }
      @PublicSigned() @Post('b') b(@Body() _p: Record<string, unknown>) {
        return 1;
      }
      @PublicSigned() @Post('c') c(@Body() _p: unknown) {
        return 1;
      }
      @PublicSigned() @Post('d') d() {
        return 1;
      }
    }
    expect((await auditorFor([Clean])).findProblems()).toEqual([]);
  });

  it('flags a DTO-typed @Body() on a @PublicSigned route, by name, and fails the boot', async () => {
    const a = await auditorFor([WebhookTestController]);
    const problems = a.findProblems();
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/WebhookTestController\.dto\(\).*StrictDto/);
    expect(() => a.onApplicationBootstrap()).toThrow(
      /ValidationPipe.*SignedPayload/s,
    );
  });

  it('ignores DTO bodies on routes that are NOT @PublicSigned', async () => {
    @Controller('normal')
    class Normal {
      @Post('x') x(@Body() _d: StrictDto) {
        return 1;
      }
      @Public() @Post('y') y(@Body() _d: StrictDto) {
        return 1;
      }
    }
    expect((await auditorFor([Normal])).findProblems()).toEqual([]);
  });
});
