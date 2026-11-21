import { MetricsService } from '../../metrics/metrics.service';
import { DEFAULT_PROVIDER_PROFILES, ProviderHttpClient, resolveProviderHttpTuning } from './provider-http.client';
import {
  ProviderCircuitOpenError,
  ProviderHttpError,
  ProviderRateLimitedError,
} from './integration.types';

const noRedis = { configured: false, isReady: () => false } as never;
const res = (status: number, body = '{}', headers: Record<string, string> = {}) =>
  new Response(body, { status, headers });

function client(fetchFn: jest.Mock, opts: Record<string, unknown> = {}, metrics?: MetricsService) {
  return new ProviderHttpClient(noRedis, (async (...a: unknown[]) => (await (fetchFn as any)(...a)).clone()) as never, {
    bucketCapacity: 100, refillPerSecond: 1000, maxInlineWaitMs: 200, maxRetries: 2,
    breakerThreshold: 3, breakerOpenMs: 60_000, timeoutMs: 1000, backoffBaseMs: 0, ...opts,
  }, metrics);
}
const req = { rateKey: 'connection:c1', url: 'https://api.example.test/x' };

describe('ProviderHttpClient', () => {
  it('returns a normal response untouched', async () => {
    const f = jest.fn().mockResolvedValue(res(200, '{"a":1}'));
    const r = await client(f).request(req);
    expect(r.ok).toBe(true);
    expect(r.json()).toEqual({ a: 1 });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('429 with a short Retry-After: waits, retries, succeeds', async () => {
    const f = jest.fn().mockResolvedValueOnce(res(429, '', { 'retry-after': '0' })).mockResolvedValueOnce(res(200));
    const r = await client(f).request(req);
    expect(r.status).toBe(200);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('429 with a Retry-After longer than the inline limit: does not block, throws with the delay', async () => {
    const f = jest.fn().mockResolvedValue(res(429, '', { 'retry-after': '30' }));
    await expect(client(f).request(req)).rejects.toMatchObject({ name: 'ProviderRateLimitedError', retryAfterMs: 30_000 });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('429 forever with short waits: gives up after maxRetries', async () => {
    const f = jest.fn().mockResolvedValue(res(429, '', { 'retry-after': '0' }));
    await expect(client(f).request(req)).rejects.toBeInstanceOf(ProviderRateLimitedError);
    expect(f).toHaveBeenCalledTimes(3); // 1 + 2 retries
  });

  it('5xx is retried and the last response is returned', async () => {
    const f = jest.fn().mockResolvedValueOnce(res(503)).mockResolvedValueOnce(res(200));
    expect((await client(f).request(req)).status).toBe(200);
  });

  it('circuit breaker opens after N consecutive failures and rejects without calling the host', async () => {
    const f = jest.fn().mockResolvedValue(res(500));
    const c = client(f, { maxRetries: 0 });
    for (let i = 0; i < 3; i++) await c.request(req);
    await expect(c.request(req)).rejects.toBeInstanceOf(ProviderCircuitOpenError);
    expect(f).toHaveBeenCalledTimes(3);
    // a different host is unaffected
    f.mockResolvedValueOnce(res(200));
    expect((await c.request({ ...req, url: 'https://other.example.test/' })).status).toBe(200);
  });

  it('a success resets the failure count', async () => {
    const f = jest.fn()
      .mockResolvedValueOnce(res(500)).mockResolvedValueOnce(res(500)).mockResolvedValueOnce(res(200))
      .mockResolvedValue(res(500));
    const c = client(f, { maxRetries: 0 });
    for (let i = 0; i < 6; i++) await c.request(req); // 2 fail, ok, 3 fail -> opens only now, not earlier
    await expect(c.request(req)).rejects.toBeInstanceOf(ProviderCircuitOpenError);
    expect(f).toHaveBeenCalledTimes(6);
  });

  it('token bucket: a drained bucket makes the next call wait, an over-long wait throws', async () => {
    const f = jest.fn().mockResolvedValue(res(200));
    const c = client(f, { bucketCapacity: 1, refillPerSecond: 20 }); // 1 token per 50 ms
    const t0 = Date.now();
    await c.request(req);
    await c.request(req);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(40);
    const slow = client(f, { bucketCapacity: 1, refillPerSecond: 0.1, maxInlineWaitMs: 100 }); // 10 s per token
    await slow.request(req);
    await expect(slow.request(req)).rejects.toBeInstanceOf(ProviderRateLimitedError);
  });

  it('buckets are per rateKey', async () => {
    const f = jest.fn().mockResolvedValue(res(200));
    const c = client(f, { bucketCapacity: 1, refillPerSecond: 0.1, maxInlineWaitMs: 100 });
    await c.request({ ...req, rateKey: 'connection:a' });
    await c.request({ ...req, rateKey: 'connection:b' }); // own budget: no throw
  });

  it('requestJson throws ProviderHttpError with a bounded body snippet on 4xx', async () => {
    const f = jest.fn().mockResolvedValue(res(403, 'x'.repeat(1000)));
    const e = await client(f).requestJson(req).catch((x) => x);
    expect(e).toBeInstanceOf(ProviderHttpError);
    expect((e as ProviderHttpError).bodySnippet.length).toBe(300);
  });

  // ---- step 2.7 tuning

  it('GitHub-style limit: a 403 with Retry-After is waited out and retried; a plain 403 is a permission error and is NOT retried', async () => {
    const f = jest.fn().mockResolvedValueOnce(res(403, 'secondary', { 'retry-after': '0' })).mockResolvedValueOnce(res(200));
    expect((await client(f).request(req)).status).toBe(200);
    expect(f).toHaveBeenCalledTimes(2);

    const g = jest.fn().mockResolvedValue(res(403, 'forbidden'));
    expect((await client(g).request(req)).status).toBe(403);
    expect(g).toHaveBeenCalledTimes(1);
  });

  it('a 403 with X-RateLimit-Remaining: 0 and a far reset throws with the real delay instead of blocking', async () => {
    const reset = String(Math.floor(Date.now() / 1000) + 600);
    const f = jest.fn().mockResolvedValue(res(403, '', { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset }));
    const e = await client(f).request(req).catch((x) => x);
    expect(e).toBeInstanceOf(ProviderRateLimitedError);
    expect((e as ProviderRateLimitedError).retryAfterMs).toBeGreaterThan(500_000);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('5xx retries back off (jittered, bounded by the ceiling) instead of hammering the host', async () => {
    const f = jest.fn().mockResolvedValueOnce(res(503)).mockResolvedValueOnce(res(503)).mockResolvedValueOnce(res(200));
    const t0 = Date.now();
    await client(f, { backoffBaseMs: 60, backoffMaxMs: 60 }).request(req);
    const took = Date.now() - t0;
    expect(f).toHaveBeenCalledTimes(3);
    expect(took).toBeLessThan(60 * 2 + 100); // each pause is in [0, 60)
  });

  it('half-open: after the open period exactly ONE call tests the host; a concurrent burst fails fast; success closes the breaker', async () => {
    jest.useFakeTimers({ doNotFake: ['setTimeout', 'nextTick', 'setImmediate', 'queueMicrotask'] });
    try {
      let release!: (r: Response) => void;
      const f = jest.fn()
        .mockResolvedValueOnce(res(500)).mockResolvedValueOnce(res(500)).mockResolvedValueOnce(res(500))
        .mockImplementationOnce(() => new Promise<Response>((r) => { release = r; }))
        .mockResolvedValue(res(200));
      const c = client(f, { maxRetries: 0, breakerOpenMs: 1000 });
      for (let i = 0; i < 3; i++) await c.request(req);
      await expect(c.request(req)).rejects.toBeInstanceOf(ProviderCircuitOpenError);
      jest.setSystemTime(Date.now() + 1500); // open period over: half-open
      const probe = c.request(req); // takes the single probe slot and hangs
      await new Promise((r) => setImmediate(r));
      await expect(c.request(req)).rejects.toBeInstanceOf(ProviderCircuitOpenError); // burst behind it
      release(res(200));
      expect((await probe).status).toBe(200);
      expect((await c.request(req)).status).toBe(200); // closed again
    } finally {
      jest.useRealTimers();
    }
  });

  it('a probe that ends without a verdict (rate limited) releases its slot, so the breaker is not stuck half-open forever', async () => {
    jest.useFakeTimers({ doNotFake: ['setTimeout', 'nextTick', 'setImmediate', 'queueMicrotask'] });
    try {
      const f = jest.fn()
        .mockResolvedValueOnce(res(500)).mockResolvedValueOnce(res(500)).mockResolvedValueOnce(res(500))
        .mockResolvedValueOnce(res(429, '', { 'retry-after': '30' }))
        .mockResolvedValue(res(200));
      const c = client(f, { maxRetries: 0, breakerOpenMs: 1000 });
      for (let i = 0; i < 3; i++) await c.request(req);
      jest.setSystemTime(Date.now() + 1500);
      await expect(c.request(req)).rejects.toBeInstanceOf(ProviderRateLimitedError); // the probe: no verdict
      expect((await c.request(req)).status).toBe(200); // the next call may probe again
    } finally {
      jest.useRealTimers();
    }
  });

  it('per-host profiles: a slow host gets its own, smaller budget while other hosts keep the default', async () => {
    const f = jest.fn().mockResolvedValue(res(200));
    const c = client(f, { bucketCapacity: 100, refillPerSecond: 1000, profiles: { 'slow.example.test': { bucketCapacity: 1, refillPerSecond: 0.1 } } });
    await c.request({ ...req, url: 'https://slow.example.test/a', rateKey: 'connection:s' });
    await expect(c.request({ ...req, url: 'https://slow.example.test/a', rateKey: 'connection:s' })).rejects.toBeInstanceOf(ProviderRateLimitedError);
    for (let i = 0; i < 5; i++) await c.request({ ...req, rateKey: 'connection:fast' }); // default profile: plenty
  });

  it('counts calls by outcome and breaker trips (the series /metrics exposes)', async () => {
    const m = new MetricsService();
    const f = jest.fn().mockResolvedValueOnce(res(200)).mockResolvedValueOnce(res(404)).mockResolvedValue(res(500));
    const c = client(f, { maxRetries: 0 }, m);
    await c.request(req); await c.request(req);
    for (let i = 0; i < 3; i++) await c.request(req);
    await c.request(req).catch(() => undefined); // circuit_open
    const text = await m.render();
    expect(text).toContain('integration_provider_http_requests_total{host="api.example.test",outcome="ok"} 1');
    expect(text).toContain('integration_provider_http_requests_total{host="api.example.test",outcome="client_error"} 1');
    expect(text).toContain('integration_provider_http_requests_total{host="api.example.test",outcome="server_error"} 3');
    expect(text).toContain('integration_provider_http_requests_total{host="api.example.test",outcome="circuit_open"} 1');
    expect(text).toContain('integration_provider_breaker_opened_total{host="api.example.test"} 1');
  });
});

describe('resolveProviderHttpTuning', () => {
  it('no env: the built-in per-provider profiles, no problems', () => {
    const { tuning, problems } = resolveProviderHttpTuning({});
    expect(problems).toEqual([]);
    expect(tuning.profiles).toEqual(DEFAULT_PROVIDER_PROFILES);
    expect(tuning.profiles!['slack.com'].refillPerSecond).toBe(1);
  });

  it('a host key overrides one field of that host\u2019s profile; "*" overrides the defaults', () => {
    const { tuning, problems } = resolveProviderHttpTuning({ PROVIDER_HTTP_TUNING: '{"slack.com":{"refillPerSecond":2},"*":{"timeoutMs":5000},"new.example":{"bucketCapacity":3}}' });
    expect(problems).toEqual([]);
    expect(tuning.profiles!['slack.com']).toEqual({ bucketCapacity: 10, refillPerSecond: 2 });
    expect(tuning.timeoutMs).toBe(5000);
    expect(tuning.profiles!['new.example']).toEqual({ bucketCapacity: 3 });
  });

  it('bad input is ignored and reported, never thrown and never a NaN in the limiter', () => {
    expect(resolveProviderHttpTuning({ PROVIDER_HTTP_TUNING: '{nope' }).problems[0]).toMatch(/not valid JSON/);
    expect(resolveProviderHttpTuning({ PROVIDER_HTTP_TUNING: '[1]' }).problems[0]).toMatch(/must be a JSON object/);
    const r = resolveProviderHttpTuning({ PROVIDER_HTTP_TUNING: '{"slack.com":{"refillPerSecond":0,"bucketCapacity":"9","bogus":1,"maxRetries":-1},"x":5}' });
    expect(r.problems).toHaveLength(5);
    expect(r.tuning.profiles!['slack.com']).toEqual(DEFAULT_PROVIDER_PROFILES['slack.com']); // untouched
  });
});

describe('ProviderHttpClient.openStream (step 4.6)', () => {
  const noRedis = { configured: false, isReady: () => false } as never;
  const make = (f: jest.Mock, o: Record<string, unknown> = {}) => new ProviderHttpClient(noRedis, f as never, { bucketCapacity: 1000, refillPerSecond: 1000, maxRetries: 1, backoffBaseMs: 0, backoffMaxMs: 0, ...o });
  const read = async (s: AsyncIterable<Uint8Array>) => { const p: Buffer[] = []; for await (const c of s) p.push(Buffer.from(c)); return Buffer.concat(p).toString(); };

  it('hands the body over as a stream, unread, with the headers', async () => {
    const f = jest.fn(async () => new Response('file-bytes', { status: 200, headers: { 'content-length': '10' } }));
    const r = await make(f).openStream({ rateKey: 'k', url: 'https://h.test/f' });
    expect(r.headers.get('content-length')).toBe('10');
    expect(await read(r.body)).toBe('file-bytes');
  });

  it('a non-2xx throws ProviderHttpError with a bounded body snippet', async () => {
    const f = jest.fn(async () => new Response('x'.repeat(1000), { status: 404 }));
    await expect(make(f).openStream({ rateKey: 'k', url: 'https://h.test/f' })).rejects.toMatchObject({ status: 404, bodySnippet: 'x'.repeat(300) });
  });

  it('uses the same policy as request(): 5xx is retried, 429 beyond the inline wait is a ProviderRateLimitedError', async () => {
    const f = jest.fn().mockResolvedValueOnce(new Response('', { status: 503 })).mockResolvedValueOnce(new Response('ok', { status: 200 }));
    expect(await read((await make(f).openStream({ rateKey: 'k', url: 'https://h.test/f' })).body)).toBe('ok');
    const g = jest.fn(async () => new Response('', { status: 429, headers: { 'retry-after': '3600' } }));
    await expect(make(g).openStream({ rateKey: 'k', url: 'https://h.test/f' })).rejects.toMatchObject({ retryAfterMs: 3_600_000 });
  });

  it('the transfer timeout is its own (long by default, overridable), not the 15 s of an API call', async () => {
    let signal: AbortSignal | undefined;
    const f = jest.fn(async (_u: unknown, init?: RequestInit) => { signal = init?.signal as AbortSignal; return new Response('x'); });
    await make(f).openStream({ rateKey: 'k', url: 'https://h.test/f' });
    expect(signal!.aborted).toBe(false);
    const g = jest.fn(async (_u: unknown, init?: RequestInit) => { await new Promise((r) => setTimeout(r, 60)); if (init?.signal?.aborted) throw new Error('aborted'); return new Response('x'); });
    await expect(make(g, { maxRetries: 0 }).openStream({ rateKey: 'k', url: 'https://h.test/f', timeoutMs: 10 })).rejects.toThrow('aborted');
  });
});

describe('ProviderHttpClient per-request rate and X-RateLimit-Reset (step 4.7)', () => {
  const noRedis = { configured: false, isReady: () => false } as never;

  it('a request can carry its own bucket: a slow provider is paced, the default bucket is untouched', async () => {
    const f = jest.fn(async () => new Response('{}', { status: 200 }));
    const c = new ProviderHttpClient(noRedis, f as never, { bucketCapacity: 1000, refillPerSecond: 1000, maxRetries: 0, maxInlineWaitMs: 5000 });
    const slow = { rateKey: 'slow', url: 'https://h.test/x', rate: { capacity: 1, refillPerSecond: 20 } };
    const t0 = Date.now();
    await c.request(slow);
    await c.request(slow); // the second waits for a token: 1 / 20 per second = ~50 ms
    expect(Date.now() - t0).toBeGreaterThanOrEqual(40);
    const t1 = Date.now();
    for (let i = 0; i < 20; i++) await c.request({ rateKey: 'fast', url: 'https://h.test/x' });
    expect(Date.now() - t1).toBeLessThan(40);
  });

  it('a wait longer than the inline limit is a ProviderRateLimitedError, not a long sleep', async () => {
    const f = jest.fn(async () => new Response('{}', { status: 200 }));
    const c = new ProviderHttpClient(noRedis, f as never, { bucketCapacity: 1000, refillPerSecond: 1000, maxRetries: 0, maxInlineWaitMs: 100 });
    const slow = { rateKey: 'slow', url: 'https://h.test/x', rate: { capacity: 1, refillPerSecond: 0.1 } };
    await c.request(slow);
    await expect(c.request(slow)).rejects.toMatchObject({ name: 'ProviderRateLimitedError' });
  });

  it('a 429 with only X-RateLimit-Reset (unix seconds) waits until that moment; Retry-After still wins', async () => {
    const reset = Math.floor(Date.now() / 1000) + 3600;
    const f = jest.fn(async () => new Response('', { status: 429, headers: { 'x-ratelimit-reset': String(reset) } }));
    const c = new ProviderHttpClient(noRedis, f as never, { bucketCapacity: 1000, refillPerSecond: 1000, maxRetries: 1, maxInlineWaitMs: 10_000 });
    const e = await c.request({ rateKey: 'k', url: 'https://h.test/x' }).catch((x) => x);
    expect(e.retryAfterMs).toBeGreaterThan(3_500_000);
    expect(e.retryAfterMs).toBeLessThanOrEqual(3_600_000);
    const g = jest.fn(async () => new Response('', { status: 429, headers: { 'retry-after': '7', 'x-ratelimit-reset': String(reset) } }));
    const e2 = await new ProviderHttpClient(noRedis, g as never, { bucketCapacity: 1000, refillPerSecond: 1000, maxRetries: 0, maxInlineWaitMs: 1 }).request({ rateKey: 'k', url: 'https://h.test/x' }).catch((x) => x);
    expect(e2.retryAfterMs).toBe(7000);
  });
});
