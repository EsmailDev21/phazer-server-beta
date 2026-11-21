import { BadRequestException, ConflictException, ForbiddenException, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PlanLimitExceededException } from '../../common/exceptions/plan-limit-exceeded.exception';
import { BulkWriteError } from '../../domain-writer/domain-writer.service';
import { ConnectionNeedsReauthError } from '../../integrations/core/credential.service';
import { ProviderAuthRejectedError, ProviderCircuitOpenError, ProviderHttpError, ProviderRateLimitedError } from '../../integrations/core/integration.types';
import { BACKOFF, ImportFailure, backoffMs, classifyImportError, unwrap } from './import-errors';

const prismaErr = (code: string) => new Prisma.PrismaClientKnownRequestError('x', { code, clientVersion: 'test' });

describe('classifyImportError (step 4.4)', () => {
  it.each([
    ['reauth needed', new ConnectionNeedsReauthError('c1'), 'AUTH'],
    ['token rejected', new ProviderAuthRejectedError('nope'), 'AUTH'],
    ['plan limit', new PlanLimitExceededException('Task limit reached'), 'PLAN_LIMIT'],
    ['rate limited', new ProviderRateLimitedError(120_000, 'linear'), 'RATE_LIMIT'],
    ['circuit open', new ProviderCircuitOpenError('api.linear.app'), 'TRANSIENT'],
    ['provider 500', new ProviderHttpError(500, 'u', ''), 'TRANSIENT'],
    ['provider 503', new ProviderHttpError(503, 'u', ''), 'TRANSIENT'],
    ['provider network (0)', new ProviderHttpError(0, 'u', ''), 'TRANSIENT'],
    ['provider 408', new ProviderHttpError(408, 'u', ''), 'TRANSIENT'],
    ['provider 404 (source gone)', new ProviderHttpError(404, 'u', ''), 'FATAL'],
    ['provider 422', new ProviderHttpError(422, 'u', ''), 'FATAL'],
    ['db connection', prismaErr('P1001'), 'TRANSIENT'],
    ['db deadlock', prismaErr('P2034'), 'TRANSIENT'],
    ['db pool timeout', prismaErr('P2024'), 'TRANSIENT'],
    ['unique violation', prismaErr('P2002'), 'ITEM'],
    ['foreign key', prismaErr('P2003'), 'ITEM'],
    ['record missing', prismaErr('P2025'), 'ITEM'],
    ['unknown prisma code', prismaErr('P9999'), 'FATAL'],
    ['our 400', new BadRequestException('depth'), 'ITEM'],
    ['our 404', new NotFoundException('x'), 'ITEM'],
    ['our 409', new ConflictException('x'), 'ITEM'],
    ['our 403', new ForbiddenException('x'), 'ITEM'],
    ['our 500', new InternalServerErrorException('x'), 'FATAL'],
    ['ECONNRESET', Object.assign(new Error('x'), { code: 'ECONNRESET' }), 'TRANSIENT'],
    ['ETIMEDOUT', Object.assign(new Error('x'), { code: 'ETIMEDOUT' }), 'TRANSIENT'],
    ['a plain bug', new TypeError('x is undefined'), 'FATAL'],
    ['a string', 'boom', 'FATAL'],
    ['null', null, 'FATAL'],
  ] as const)('%s -> %s', (_n, err, kind) => {
    expect(classifyImportError(err).kind).toBe(kind);
  });

  it('a deliberate stop carries its own message and is never retried', () => {
    expect(classifyImportError(new ImportFailure('Preview the import again.'))).toEqual({ kind: 'FATAL', message: 'Preview the import again.' });
  });

  it('sees through a bulk write wrapper (the cause decides, not the wrapper)', () => {
    expect(unwrap(new BulkWriteError(2, ['a'], new BadRequestException('x'))) instanceof BadRequestException).toBe(true);
    expect(classifyImportError(new BulkWriteError(0, [], new PlanLimitExceededException('cap'))).kind).toBe('PLAN_LIMIT');
    expect(classifyImportError(new BulkWriteError(0, [], prismaErr('P2034'))).kind).toBe('TRANSIENT');
    expect(classifyImportError(new BulkWriteError(0, [], new ConflictException('dup'))).kind).toBe('ITEM');
  });

  it('a plan limit is NOT mistaken for an ordinary 4xx item error (it is an HttpException too)', () => {
    expect(new PlanLimitExceededException('x')).toBeInstanceOf(Error);
    expect(classifyImportError(new PlanLimitExceededException('Task limit')).kind).toBe('PLAN_LIMIT');
  });

  describe('delays', () => {
    it('a rate limit waits what the provider asked, within [15 s, 30 min]', () => {
      expect(classifyImportError(new ProviderRateLimitedError(120_000, 'k')).delayMs).toBe(120_000);
      expect(classifyImportError(new ProviderRateLimitedError(100, 'k')).delayMs).toBe(BACKOFF.baseMs);
      expect(classifyImportError(new ProviderRateLimitedError(10 * 3600_000, 'k')).delayMs).toBe(BACKOFF.maxRateLimitMs);
    });
    it('transient errors back off exponentially, capped', () => {
      expect([0, 1, 2, 3].map(backoffMs)).toEqual([15_000, 30_000, 60_000, 120_000]);
      expect(backoffMs(50)).toBe(BACKOFF.maxMs);
      expect(backoffMs(-3)).toBe(15_000);
      expect(classifyImportError(new ProviderHttpError(502, 'u', ''), 2).delayMs).toBe(60_000);
      expect(classifyImportError(new ProviderCircuitOpenError('h')).delayMs).toBe(BACKOFF.circuitMs);
    });
    it('only RATE_LIMIT and TRANSIENT carry a delay', () => {
      for (const e of [new ConnectionNeedsReauthError('c'), new PlanLimitExceededException('x'), new BadRequestException('x'), new TypeError('x')]) {
        expect(classifyImportError(e).delayMs).toBeUndefined();
      }
    });
  });

  it('the message a person sees never carries a stack, a URL or the provider\'s body', () => {
    const msgs = [
      classifyImportError(new ProviderHttpError(500, 'https://api.x.com/secret?token=abc', 'SECRET BODY')).message,
      classifyImportError(new ProviderHttpError(404, 'https://api.x.com/secret?token=abc', 'SECRET BODY')).message,
      classifyImportError(new TypeError('Cannot read properties of undefined (reading "token")')).message,
      classifyImportError(prismaErr('P9999')).message,
    ];
    for (const m of msgs) expect(m).not.toMatch(/secret|token|SECRET|https?:|undefined|at /);
  });
});
