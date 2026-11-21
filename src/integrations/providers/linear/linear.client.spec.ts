import { ProviderHttpClient } from '../../core/provider-http.client';
import { ProviderAuthRejectedError, ProviderHttpError, ProviderRateLimitedError } from '../../core/integration.types';
import { LinearClient } from './linear.client';

const noRedis = { configured: false, isReady: () => false } as never;
const json = (o: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', ...headers } });
const client = (f: jest.Mock) =>
  new LinearClient(new ProviderHttpClient(noRedis, (async (...a: unknown[]) => (await (f as any)(...a)).clone()) as never, { bucketCapacity: 1000, refillPerSecond: 1000, maxRetries: 0 }));
const ctx = { connectionId: 'c1', accessToken: 'tok' };

describe('LinearClient (step 4.5)', () => {
  it('sends a POST with the bearer token and the variables, and returns data', async () => {
    const f = jest.fn().mockResolvedValue(json({ data: { ok: 1 } }));
    expect(await client(f).query(ctx, 'query X { a }', { id: 'v' })).toEqual({ ok: 1 });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('https://api.linear.app/graphql');
    expect((init as RequestInit).method).toBe('POST');
    expect(((init as RequestInit).headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ query: 'query X { a }', variables: { id: 'v' } });
  });

  it('HTTP 401 -> ProviderAuthRejectedError; AUTHENTICATION_ERROR in a 200 body too', async () => {
    await expect(client(jest.fn().mockResolvedValue(json({}, 401))).query(ctx, 'q')).rejects.toBeInstanceOf(ProviderAuthRejectedError);
    const body = { errors: [{ message: 'nope', extensions: { code: 'AUTHENTICATION_ERROR' } }] };
    await expect(client(jest.fn().mockResolvedValue(json(body, 200))).query(ctx, 'q')).rejects.toBeInstanceOf(ProviderAuthRejectedError);
  });

  it('RATELIMITED (Linear answers HTTP 400) -> ProviderRateLimitedError with the delay from the reset header', async () => {
    const resetSec = Math.floor(Date.now() / 1000) + 120;
    const f = jest.fn().mockResolvedValue(json({ errors: [{ message: 'Rate limit exceeded', extensions: { code: 'RATELIMITED' } }] }, 400, { 'x-ratelimit-requests-reset': String(resetSec) }));
    const e = await client(f).query(ctx, 'q').then(() => { throw new Error('expected a rejection'); }, (x: any) => x as any);
    expect(e).toBeInstanceOf(ProviderRateLimitedError);
    expect(e.retryAfterMs).toBeGreaterThan(100_000);
    expect(e.retryAfterMs).toBeLessThanOrEqual(120_000);
    expect(e.rateKey).toBe('connection:c1');
  });

  it('the reset header may be in milliseconds; a missing / past one falls back to a minute; a huge one is capped at an hour', async () => {
    const wait = async (headers: Record<string, string>) => {
      const f = jest.fn().mockResolvedValue(json({ errors: [{ extensions: { code: 'RATELIMITED' } }] }, 400, headers));
      return (await client(f).query(ctx, 'q').then(() => { throw new Error('expected a rejection'); }, (x: any) => x as any)).retryAfterMs as number;
    };
    const ms = await wait({ 'x-ratelimit-requests-reset': String(Date.now() + 30_000) });
    expect(ms).toBeGreaterThan(20_000);
    expect(ms).toBeLessThanOrEqual(30_000);
    expect(await wait({})).toBe(60_000);
    expect(await wait({ 'x-ratelimit-requests-reset': String(Math.floor(Date.now() / 1000) - 50) })).toBe(60_000);
    expect(await wait({ 'x-ratelimit-requests-reset': String(Math.floor(Date.now() / 1000) + 999_999) })).toBe(3_600_000);
  });

  it('an HTTP 429 with a long Retry-After is the shared client\'s ProviderRateLimitedError (passes through unchanged)', async () => {
    const f = jest.fn().mockResolvedValue(json({}, 429, { 'retry-after': '120' }));
    await expect(client(f).query(ctx, 'q')).rejects.toBeInstanceOf(ProviderRateLimitedError);
  });

  it('errors with no data -> ProviderHttpError carrying the messages (a 4xx the executor FAILS on)', async () => {
    const f = jest.fn().mockResolvedValue(json({ errors: [{ message: 'Argument Validation Error' }, { message: 'second' }] }, 400));
    const e = await client(f).query(ctx, 'q').then(() => { throw new Error('expected a rejection'); }, (x: any) => x as any);
    expect(e).toBeInstanceOf(ProviderHttpError);
    expect(e.status).toBe(400);
    expect(e.bodySnippet).toContain('Argument Validation Error; second');
  });

  it('a 200 with errors and null data is a failure, not an empty success', async () => {
    const f = jest.fn().mockResolvedValue(json({ data: null, errors: [{ message: 'Entity not found' }] }));
    const e = await client(f).query(ctx, 'q').then(() => { throw new Error('expected a rejection'); }, (x: any) => x as any);
    expect(e).toBeInstanceOf(ProviderHttpError);
    expect(e.status).toBe(400);
  });

  it('a 5xx keeps its status (the executor retries it); an HTML error page does not crash the parser', async () => {
    const e = await client(jest.fn().mockResolvedValue(new Response('<html>bad gateway</html>', { status: 502 }))).query(ctx, 'q').then(() => { throw new Error('expected a rejection'); }, (x: any) => x as any);
    expect(e).toBeInstanceOf(ProviderHttpError);
    expect(e.status).toBe(502);
    const e2 = await client(jest.fn().mockResolvedValue(new Response('<html>ok?</html>', { status: 200 }))).query(ctx, 'q').then(() => { throw new Error('expected a rejection'); }, (x: any) => x as any);
    expect(e2).toBeInstanceOf(ProviderHttpError);
  });

  it('partial data (data AND errors) is used: one invisible field must not fail the whole import', async () => {
    const f = jest.fn().mockResolvedValue(json({ data: { a: 1 }, errors: [{ message: 'field not visible' }] }));
    expect(await client(f).query(ctx, 'q')).toEqual({ a: 1 });
  });

  it('before a connection exists the call shares the oauth bucket', async () => {
    const f = jest.fn().mockResolvedValue(json({ errors: [{ extensions: { code: 'RATELIMITED' } }] }, 400));
    const e = await client(f).query({ accessToken: 't' }, 'q').then(() => { throw new Error('expected a rejection'); }, (x: any) => x as any);
    expect(e.rateKey).toBe('oauth:LINEAR');
  });

  describe('fetchAll', () => {
    const page = (nodes: number[], next: string | null) => json({ data: { c: { nodes, pageInfo: { hasNextPage: next !== null, endCursor: next } } } });
    const pick = (r: { c: { nodes: number[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }) => r.c;

    it('follows endCursor to the end and passes it as `after`', async () => {
      const f = jest.fn().mockResolvedValueOnce(page([1, 2], 'a')).mockResolvedValueOnce(page([3], null));
      const r = await client(f).fetchAll(ctx, 'q', { id: 'x' }, pick);
      expect(r).toEqual({ nodes: [1, 2, 3], truncated: false });
      expect(f.mock.calls.map(([, i]) => JSON.parse(String((i as RequestInit).body)).variables)).toEqual([{ id: 'x', after: null }, { id: 'x', after: 'a' }]);
    });

    it('stops at `max` and says so', async () => {
      const f = jest.fn().mockResolvedValueOnce(page([1, 2, 3], 'a')).mockResolvedValueOnce(page([4, 5, 6], null));
      expect(await client(f).fetchAll(ctx, 'q', {}, pick, 4)).toEqual({ nodes: [1, 2, 3, 4], truncated: true });
    });

    it('a vanished parent (pick -> undefined) ends the walk with what it has', async () => {
      const f = jest.fn().mockResolvedValue(json({ data: { c: null } }));
      expect(await client(f).fetchAll(ctx, 'q', {}, (r: { c: null }) => r.c)).toEqual({ nodes: [], truncated: false });
    });

    it('hasNextPage without an endCursor ends the walk instead of looping on the same page', async () => {
      const f = jest.fn().mockResolvedValue(json({ data: { c: { nodes: [1], pageInfo: { hasNextPage: true, endCursor: null } } } }));
      expect(await client(f).fetchAll(ctx, 'q', {}, pick)).toEqual({ nodes: [1], truncated: false });
      expect(f).toHaveBeenCalledTimes(1);
    });
  });
});
