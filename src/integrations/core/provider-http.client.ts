import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Readable } from 'node:stream';
import { MetricsService, ProviderCallOutcome } from '../../metrics/metrics.service';
import { RedisService } from '../../redis/redis.service';
import {
  FetchFn,
  PROVIDER_FETCH,
  PROVIDER_HTTP_OPTIONS,
  ProviderCircuitOpenError,
  ProviderHttpError,
  ProviderRateLimitedError,
} from './integration.types';

export interface ProviderHttpOptions {
  /** Bucket size and refill per second, per rateKey. */
  bucketCapacity: number;
  refillPerSecond: number;
  /** Longest Retry-After / bucket wait we will sleep through inside one call. */
  maxInlineWaitMs: number;
  maxRetries: number;
  /** Consecutive 5xx/network failures per host before the breaker opens, and for how long. */
  breakerThreshold: number;
  breakerOpenMs: number;
  timeoutMs: number;
  /** Pause before retrying a 5xx / network failure: base * 2^attempt, capped, with full jitter (0 = retry at once; tests). */
  backoffBaseMs: number;
  backoffMaxMs: number;
}

/** Per-host overrides of the defaults, plus the global ones (all optional). */
export type ProviderHttpTuning = Partial<ProviderHttpOptions> & { profiles?: Record<string, Partial<ProviderHttpOptions>> };

export const DEFAULT_PROVIDER_HTTP_OPTIONS: ProviderHttpOptions = {
  bucketCapacity: 20,
  refillPerSecond: 10,
  maxInlineWaitMs: 10_000,
  maxRetries: 2,
  breakerThreshold: 5,
  breakerOpenMs: 30_000,
  timeoutMs: 15_000,
  backoffBaseMs: 250,
  backoffMaxMs: 3_000,
};

/**
 * Step 2.7 tuning. The budget is per rateKey (one connection), and each provider documents a different ceiling, so one
 * number does not fit all (ADR-0015 d.3). These are deliberately BELOW the documented limits (headroom for the provider's
 * own bursts and for other tools sharing the same app) and are a starting point to tune from /metrics, not a measurement:
 *  - Discord: 50 requests/s global per bot; per-route buckets arrive as 429s and are honoured through Retry-After.
 *  - Slack: Web API tier 3 is ~50/min and chat.postMessage ~1/s per channel: a small burst, then ~1/s.
 *  - GitHub: secondary limits punish bursts (and ~900 REST points/min): a modest burst, ~5/s sustained.
 * Override per deployment with PROVIDER_HTTP_TUNING (JSON, see resolveProviderHttpTuning).
 */
export const DEFAULT_PROVIDER_PROFILES: Record<string, Partial<ProviderHttpOptions>> = {
  'discord.com': { bucketCapacity: 40, refillPerSecond: 25 },
  'slack.com': { bucketCapacity: 10, refillPerSecond: 1 },
  'api.github.com': { bucketCapacity: 20, refillPerSecond: 5 },
};

const NUMERIC_KEYS: ReadonlyArray<keyof ProviderHttpOptions> = [
  'bucketCapacity', 'refillPerSecond', 'maxInlineWaitMs', 'maxRetries', 'breakerThreshold', 'breakerOpenMs', 'timeoutMs', 'backoffBaseMs', 'backoffMaxMs',
];

/**
 * `PROVIDER_HTTP_TUNING='{"slack.com":{"refillPerSecond":2},"*":{"timeoutMs":10000}}'`. Host keys override the built-in profile
 * for that host; `*` overrides the defaults. A bad value is IGNORED and reported (never a boot failure, never a silent NaN).
 */
export function resolveProviderHttpTuning(env: NodeJS.ProcessEnv = process.env): { tuning: ProviderHttpTuning; problems: string[] } {
  const problems: string[] = [];
  const raw = (env.PROVIDER_HTTP_TUNING ?? '').trim();
  const profiles: Record<string, Partial<ProviderHttpOptions>> = {};
  for (const [h, p] of Object.entries(DEFAULT_PROVIDER_PROFILES)) profiles[h] = { ...p };
  let global: Partial<ProviderHttpOptions> = {};
  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { tuning: { profiles }, problems: ['PROVIDER_HTTP_TUNING is not valid JSON; using built-in profiles.'] };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { tuning: { profiles }, problems: ['PROVIDER_HTTP_TUNING must be a JSON object; using built-in profiles.'] };
    }
    for (const [host, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        problems.push(`PROVIDER_HTTP_TUNING["${host}"] must be an object; ignored.`);
        continue;
      }
      const clean: Partial<ProviderHttpOptions> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const key = k as keyof ProviderHttpOptions;
        if (!NUMERIC_KEYS.includes(key)) problems.push(`PROVIDER_HTTP_TUNING["${host}"].${k} is not a known option; ignored.`);
        else if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || ((key === 'bucketCapacity' || key === 'refillPerSecond' || key === 'breakerThreshold') && v < 1)) {
          problems.push(`PROVIDER_HTTP_TUNING["${host}"].${k} must be a ${key === 'bucketCapacity' || key === 'refillPerSecond' || key === 'breakerThreshold' ? 'number >= 1' : 'number >= 0'}; ignored.`);
        } else clean[key] = v;
      }
      if (host === '*') global = { ...global, ...clean };
      else profiles[host] = { ...(profiles[host] ?? {}), ...clean };
    }
  }
  return { tuning: { ...global, profiles }, problems };
}

/** Step 4.7: a provider whose limit is far below the default bucket (ClickUp: 100 requests a MINUTE per token) says so per request. */
export interface RateShape {
  capacity: number;
  refillPerSecond: number;
}

export interface ProviderRequest {
  /** What shares one budget: `connection:<id>` once connected, `oauth:<provider>` before. */
  rateKey: string;
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | URLSearchParams;
  /** Overrides the default bucket (size and refill) for this rateKey. Every caller of one rateKey must pass the same shape. */
  rate?: RateShape;
}

/** Step 4.6: a download. Same rate bucket / Retry-After / breaker as request(), but the body is NOT read into memory. */
export interface ProviderStreamRequest extends ProviderRequest {
  /** Whole-transfer limit (headers AND body). Default: STREAM_TIMEOUT_MS. */
  timeoutMs?: number;
}

export interface ProviderStreamResponse {
  status: number;
  headers: Headers;
  /** The body, to be consumed (or destroyed) by the caller. Never buffered here. */
  body: Readable;
}

/** A large file over a slow link: far longer than an API call's 15 s. */
export const STREAM_TIMEOUT_MS = 15 * 60_000;

export interface ProviderResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  text: string;
  json<T = unknown>(): T;
}

// KEYS[1] bucket; ARGV: nowMs, capacity, refillPerMs, cost. Returns 0 if granted, else ms to wait.
const BUCKET = `
local t = redis.call('hmget', KEYS[1], 'tokens', 'ts')
local cap = tonumber(ARGV[2]); local rate = tonumber(ARGV[3]); local now = tonumber(ARGV[1]); local cost = tonumber(ARGV[4])
local tokens = tonumber(t[1]); local ts = tonumber(t[2])
if tokens == nil then tokens = cap; ts = now end
tokens = math.min(cap, tokens + (now - ts) * rate)
local wait = 0
if tokens >= cost then tokens = tokens - cost else wait = math.ceil((cost - tokens) / rate) end
redis.call('hmset', KEYS[1], 'tokens', tokens, 'ts', now)
redis.call('pexpire', KEYS[1], 120000)
return wait`;

/**
 * Every outbound provider call goes through here (diagram 02): a per-key token bucket (Redis, shared by
 * all instances; in-process fallback), `Retry-After` honouring on 429, and a per-host circuit breaker.
 * The breaker is per process on purpose (ADR-0009 d.7): it only needs to stop THIS process hammering a
 * dead host; sharing it would need a Redis round trip on every call for little gain.
 */
@Injectable()
export class ProviderHttpClient {
  private readonly logger = new Logger(ProviderHttpClient.name);
  private readonly opts: ProviderHttpOptions;
  private readonly profiles: Record<string, Partial<ProviderHttpOptions>>;
  private readonly memBuckets = new Map<string, { tokens: number; ts: number }>();
  /** `probing`: the one call allowed through while half-open (after openUntil passed) - the others keep failing fast. */
  private readonly breakers = new Map<string, { failures: number; openUntil: number; probing: boolean }>();

  constructor(
    private readonly redis: RedisService,
    @Inject(PROVIDER_FETCH) private readonly fetchFn: FetchFn,
    @Optional() @Inject(PROVIDER_HTTP_OPTIONS) options?: ProviderHttpTuning,
    @Optional() private readonly metrics?: MetricsService,
  ) {
    const { profiles, ...base } = options ?? {};
    this.opts = { ...DEFAULT_PROVIDER_HTTP_OPTIONS, ...base };
    this.profiles = profiles ?? {};
  }

  /** The effective options for one host: defaults, then the global override, then the host's profile. */
  private optsFor(host: string): ProviderHttpOptions {
    const p = this.profiles[host];
    return p ? { ...this.opts, ...p } : this.opts;
  }

  async request(req: ProviderRequest): Promise<ProviderResponse> {
    const res = await this.fetchWithPolicy(req, undefined);
    const text = await res.text();
    return {
      status: res.status,
      ok: res.ok,
      headers: res.headers,
      text,
      json: <T>() => JSON.parse(text) as T,
    };
  }

  /**
   * Step 4.6. Opens a download and hands back the body as a stream. Any non-2xx throws ProviderHttpError (its first 300
   * characters of body in the message), exactly like requestJson(); the caller decides what a 401 / 404 means for ITS file.
   */
  async openStream(req: ProviderStreamRequest): Promise<ProviderStreamResponse> {
    const res = await this.fetchWithPolicy(req, req.timeoutMs ?? STREAM_TIMEOUT_MS);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ProviderHttpError(res.status, req.url, text.slice(0, 300));
    }
    if (!res.body) throw new ProviderHttpError(502, req.url, 'The provider answered without a body');
    return {
      status: res.status,
      headers: res.headers,
      body: Readable.fromWeb(res.body as unknown as import('node:stream/web').ReadableStream),
    };
  }

  /** The shared policy: breaker, token bucket, 429 / Retry-After, retry of 5xx and network errors. Returns an UNREAD Response. */
  private async fetchWithPolicy(req: ProviderRequest, timeoutMs: number | undefined): Promise<Response> {
    const host = new URL(req.url).host;
    const o = this.optsFor(host);
    for (let attempt = 0; ; attempt++) {
      const probe = this.assertBreakerClosed(host);
      try {
        await this.takeToken(req.rateKey, o, req.rate);

        let res: Response;
        try {
          res = await this.fetchFn(req.url, {
            method: req.method ?? 'GET',
            headers: req.headers,
            body: req.body,
            signal: AbortSignal.timeout(timeoutMs ?? o.timeoutMs),
          });
        } catch (e) {
          this.count(host, 'network_error');
          this.recordFailure(host, o);
          if (attempt < o.maxRetries) {
            await sleep(this.backoffMs(attempt, o));
            continue;
          }
          throw e;
        }

        const limited = this.rateLimitWaitMs(res);
        if (limited !== null) {
          this.count(host, 'rate_limited');
          if (limited > o.maxInlineWaitMs || attempt >= o.maxRetries) {
            throw new ProviderRateLimitedError(limited, req.rateKey);
          }
          this.logger.warn(`Rate limited by ${host}; waiting ${limited}ms (${req.rateKey})`);
          await sleep(limited);
          continue;
        }
        if (res.status >= 500) {
          this.count(host, 'server_error');
          this.recordFailure(host, o);
          if (attempt < o.maxRetries) {
            await sleep(this.backoffMs(attempt, o));
            continue;
          }
        } else {
          this.count(host, res.ok ? 'ok' : 'client_error');
          this.recordSuccess(host);
        }
        return res;
      } finally {
        // A call that ended without a verdict on the host (rate limited, bucket empty, thrown before the fetch) must not leave
        // the half-open breaker believing a probe is still in flight, or it would never close again.
        if (probe) this.releaseProbe(host);
      }
    }
  }

  /** request() that throws ProviderHttpError on any non-2xx. */
  async requestJson<T>(req: ProviderRequest): Promise<T> {
    const res = await this.request(req);
    if (!res.ok) throw new ProviderHttpError(res.status, req.url, res.text.slice(0, 300));
    return res.json<T>();
  }

  // ---- internals

  /**
   * The wait a rate-limit response asks for, or null when this is not one. 429 always is. GitHub signals its primary and secondary
   * limits with 403, so a 403 counts only when it carries `Retry-After` or `X-RateLimit-Remaining: 0` (a plain 403 is a permission
   * problem and must NOT be retried).
   */
  private rateLimitWaitMs(res: Response): number | null {
    const retryAfter = res.headers.get('retry-after');
    if (res.status === 429) return this.retryAfterMs(retryAfter, res);
    if (res.status === 403) {
      if (retryAfter !== null) return this.retryAfterMs(retryAfter);
      if (res.headers.get('x-ratelimit-remaining') === '0') {
        const reset = Number(res.headers.get('x-ratelimit-reset'));
        return Number.isFinite(reset) && reset > 0 ? Math.max(0, reset * 1000 - Date.now()) : 60_000;
      }
    }
    return null;
  }

  private retryAfterMs(raw: string | null, res?: Response): number {
    const seconds = raw === null ? NaN : Number(raw);
    if (Number.isFinite(seconds)) return Math.max(0, Math.ceil(seconds * 1000));
    // Step 4.7: ClickUp sends no Retry-After; X-RateLimit-Reset is the Unix second its window ends.
    const resetRaw = res?.headers.get('x-ratelimit-reset') ?? null;
    const reset = resetRaw === null ? NaN : Number(resetRaw);
    if (Number.isFinite(reset) && reset > 1e9) return Math.min(Math.max(1000, reset * 1000 - Date.now() + 500), 3_600_000);
    return 1000;
  }

  /** Full-jitter exponential backoff: a burst of failing calls must not retry in lockstep. */
  private backoffMs(attempt: number, o: ProviderHttpOptions): number {
    const ceiling = Math.min(o.backoffMaxMs, o.backoffBaseMs * 2 ** attempt);
    return Math.floor(Math.random() * ceiling);
  }

  private count(host: string, outcome: ProviderCallOutcome): void {
    this.metrics?.providerCalls.inc({ host, outcome });
  }

  /** Returns true when THIS call is the half-open probe (and therefore must release the claim when it ends). */
  private assertBreakerClosed(host: string): boolean {
    const b = this.breakers.get(host);
    if (!b) return false;
    if (b.openUntil > Date.now()) {
      this.count(host, 'circuit_open');
      throw new ProviderCircuitOpenError(host);
    }
    if (b.failures < this.optsFor(host).breakerThreshold) return false; // closed, still counting
    // Half-open: openUntil has passed. Exactly ONE call tests the host; a burst behind it fails fast instead of piling on.
    if (b.probing) {
      this.count(host, 'circuit_open');
      throw new ProviderCircuitOpenError(host);
    }
    b.probing = true;
    return true;
  }
  private releaseProbe(host: string): void {
    const b = this.breakers.get(host);
    if (b) b.probing = false;
  }
  private recordFailure(host: string, o: ProviderHttpOptions): void {
    const b = this.breakers.get(host) ?? { failures: 0, openUntil: 0, probing: false };
    b.failures += 1;
    if (b.failures >= o.breakerThreshold) {
      if (b.openUntil <= Date.now()) this.metrics?.breakerOpened.inc({ host });
      b.openUntil = Date.now() + o.breakerOpenMs;
    }
    this.breakers.set(host, b);
  }
  private recordSuccess(host: string): void {
    this.breakers.delete(host);
  }

  private async takeToken(rateKey: string, o: ProviderHttpOptions, shape?: RateShape): Promise<void> {
    for (let i = 0; i < 50; i++) {
      const wait = await this.tryTake(rateKey, o, shape);
      if (wait === 0) return;
      if (wait > o.maxInlineWaitMs) {
        this.metrics?.providerCalls.inc({ host: 'bucket', outcome: 'rate_limited' });
        throw new ProviderRateLimitedError(wait, rateKey);
      }
      await sleep(wait);
    }
    throw new ProviderRateLimitedError(o.maxInlineWaitMs, rateKey);
  }

  private async tryTake(rateKey: string, o: ProviderHttpOptions, shape?: RateShape): Promise<number> {
    const capacity = shape?.capacity ?? o.bucketCapacity;
    const rate = (shape?.refillPerSecond ?? o.refillPerSecond) / 1000;
    if (this.redis.configured && this.redis.isReady()) {
      try {
        const out = await this.redis
          .getClient()
          .eval(BUCKET, 1, `bucket:${rateKey}`, Date.now(), capacity, rate, 1);
        return Number(out);
      } catch (e) {
        this.logger.warn(`Redis bucket failed, using in-process bucket: ${(e as Error).message}`);
      }
    }
    const now = Date.now();
    const b = this.memBuckets.get(rateKey) ?? { tokens: capacity, ts: now };
    b.tokens = Math.min(capacity, b.tokens + (now - b.ts) * rate);
    b.ts = now;
    let wait = 0;
    if (b.tokens >= 1) b.tokens -= 1;
    else wait = Math.ceil((1 - b.tokens) / rate);
    this.memBuckets.set(rateKey, b);
    return wait;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
