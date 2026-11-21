import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ProviderAuthRejectedError, ProviderHttpError, ProviderRateLimitedError } from '../../core/integration.types';
import { ProviderHttpClient, RateShape } from '../../core/provider-http.client';
import { MnComplexity, MnEnvelope, MnError } from './monday.types';

export const MONDAY_API = 'https://api.monday.com/v2';
/**
 * monday versions its API quarterly and a request WITHOUT the header silently floats to whatever is Current, so the version is always
 * sent. 2026-07 was Current for a quarter and is Maintenance since 2026-10 became Current (Oct 26 2026): stable for at least three more
 * months. Override with MONDAY_API_VERSION; move it deliberately (ADR-0041 lists what to re-check).
 */
export const DEFAULT_API_VERSION = '2026-07';
/** Under the lowest minute limit (1,000 queries a minute on the smallest tier). */
export const DEFAULT_REQUESTS_PER_MINUTE = 600;
const MAX_PAGES = 500;
const MAX_PACING_WAIT_MS = 60_000;
/** Below this many complexity points left we wait for the window to reset instead of provoking COMPLEXITY_BUDGET_EXHAUSTED. */
const MIN_COMPLEXITY_LEFT = 150_000;

export interface MondayCallContext {
  connectionId?: string;
  accessToken: string;
}

/** A cursor older than 60 minutes (monday caches them for exactly that long from the FIRST request) is gone: the caller recovers. */
export class MondayCursorExpiredError extends Error {
  constructor() {
    super('The monday.com cursor expired (cursors live 60 minutes)');
    this.name = 'MondayCursorExpiredError';
  }
}

const sleepFor = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const code = (e: MnError): string => (e.extensions?.code ?? '').toString();

/** Milliseconds until the next 00:00 UTC, when the DAILY call limit resets. */
export const msUntilMidnightUtc = (now = Date.now()): number => {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - now;
};

/**
 * monday speaks GraphQL over one POST endpoint. What the generic HTTP layer (bucket, Retry-After on 429, breaker, 5xx retry) does not
 * cover is translated here:
 *   - HTTP 401, or an "not authenticated" error        -> ProviderAuthRejectedError  (the job pauses)
 *   - APPLICATION errors arrive as HTTP **200** with an `errors` array (monday's documented behaviour), so a 200 is NOT success
 *   - COMPLEXITY_BUDGET_EXHAUSTED / concurrency / minute / IP limits (`retry_in_seconds`) -> ProviderRateLimitedError
 *   - DAILY_LIMIT_EXCEEDED                              -> ProviderRateLimitedError until 00:00 UTC (the executor pauses and resumes itself)
 *   - an expired items cursor                           -> MondayCursorExpiredError
 *   - a 403 / 404 about one object                      -> ProviderHttpError 403 / 404 (the caller decides whether that object is skipped)
 * Pacing: every query also asks `complexity {...}` (free) and when the remaining budget is low the next call waits for the reset.
 */
@Injectable()
export class MondayClient {
  private readonly logger = new Logger(MondayClient.name);
  private readonly budget = new Map<string, { after: number; resetAt: number }>();
  /** Replaceable in tests. */
  sleep: (ms: number) => Promise<void> = sleepFor;

  constructor(private readonly http: ProviderHttpClient, private readonly config: ConfigService) {}

  get apiVersion(): string {
    const v = (this.config.get<string>('MONDAY_API_VERSION') ?? '').trim();
    return /^\d{4}-\d{2}$/.test(v) ? v : DEFAULT_API_VERSION;
  }

  get requestsPerMinute(): number {
    const n = Number(this.config.get('MONDAY_REQUESTS_PER_MINUTE'));
    return Number.isFinite(n) && n >= 10 && n <= 5000 ? Math.floor(n) : DEFAULT_REQUESTS_PER_MINUTE;
  }

  private get pacing(): boolean {
    return String(this.config.get('MONDAY_COMPLEXITY_PACING') ?? 'true').toLowerCase() !== 'false';
  }

  private rate(): RateShape {
    const perSecond = this.requestsPerMinute / 60;
    return { capacity: Math.max(2, Math.ceil(perSecond * 3)), refillPerSecond: perSecond };
  }

  rateKey(ctx: MondayCallContext): string {
    return ctx.connectionId ? `connection:${ctx.connectionId}` : 'oauth:MONDAY';
  }

  /** Adds `complexity {...}` as the last selection of the root. The query must be one `query ... { ... }` (every query here is). */
  private withComplexity(query: string): string {
    const i = query.lastIndexOf('}');
    if (i < 0) return query;
    return `${query.slice(0, i)} complexity { query before after reset_in_x_seconds } ${query.slice(i)}`;
  }

  private async waitForBudget(key: string): Promise<void> {
    const b = this.budget.get(key);
    if (!b || b.after >= MIN_COMPLEXITY_LEFT) return;
    const wait = Math.min(b.resetAt - Date.now(), MAX_PACING_WAIT_MS);
    this.budget.delete(key);
    if (wait > 0) {
      this.logger.debug(`monday complexity budget low (${b.after}); waiting ${wait}ms (${key})`);
      await this.sleep(wait);
    }
  }

  private remember(key: string, c: MnComplexity | null | undefined): void {
    if (!c || typeof c.after !== 'number') return;
    const reset = typeof c.reset_in_x_seconds === 'number' && c.reset_in_x_seconds > 0 ? c.reset_in_x_seconds : 60;
    this.budget.set(key, { after: c.after, resetAt: Date.now() + reset * 1000 });
  }

  /** One query; the typed `data` (without the `complexity` bookkeeping). */
  async query<T>(ctx: MondayCallContext, query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const key = this.rateKey(ctx);
    if (this.pacing) await this.waitForBudget(key);
    const res = await this.http.request({
      rateKey: key,
      rate: this.rate(),
      url: MONDAY_API,
      method: 'POST',
      // monday's documented form is the bare token in Authorization (no "Bearer"); see ADR-0041 "Unverified".
      headers: { 'content-type': 'application/json', authorization: ctx.accessToken, 'api-version': this.apiVersion },
      body: JSON.stringify({ query: this.pacing ? this.withComplexity(query) : query, variables }),
    });

    if (res.status === 401) throw new ProviderAuthRejectedError('monday.com rejected the access token (HTTP 401)');
    if (!res.ok) throw new ProviderHttpError(res.status, MONDAY_API, res.text.slice(0, 300));

    let body: MnEnvelope<T> | undefined;
    try {
      body = res.json<MnEnvelope<T>>();
    } catch {
      throw new ProviderHttpError(502, MONDAY_API, 'monday.com answered with something that is not JSON');
    }
    const errors = Array.isArray(body?.errors) ? body!.errors! : [];
    if (errors.length) this.raise(errors, key);

    if (!body?.data || typeof body.data !== 'object') throw new ProviderHttpError(502, MONDAY_API, 'monday.com answered without data');
    const { complexity, ...data } = body.data as { complexity?: MnComplexity | null } & Record<string, unknown>;
    this.remember(key, complexity);
    return data as T;
  }

  /** Translates the first meaningful error. Always throws. */
  private raise(errors: MnError[], rateKey: string): never {
    const pick = (f: (e: MnError) => boolean) => errors.find(f);
    const retryMs = (e: MnError, fallbackMs: number) => {
      const s = e.extensions?.retry_in_seconds;
      return typeof s === 'number' && s > 0 ? Math.ceil(s * 1000) : fallbackMs;
    };

    const daily = pick((e) => code(e) === 'DAILY_LIMIT_EXCEEDED' || /daily limit/i.test(e.message ?? ''));
    if (daily) throw new ProviderRateLimitedError(msUntilMidnightUtc(), rateKey);

    const limited = pick((e) => /^(COMPLEXITY_BUDGET_EXHAUSTED|IP_RATE_LIMIT_EXCEEDED|maxConcurrencyExceeded|CONCURRENCY_LIMIT_EXCEEDED|RATE_LIMIT_EXCEEDED|ComplexityException)$/i.test(code(e)) || /(rate limit|complexity budget|concurrency limit)/i.test(e.message ?? ''));
    if (limited) throw new ProviderRateLimitedError(retryMs(limited, 60_000), rateKey);

    if (pick((e) => /cursor/i.test(code(e)) || /(invalid|expired)[^.]{0,20}cursor|cursor[^.]{0,30}(invalid|expired)/i.test(e.message ?? ''))) throw new MondayCursorExpiredError();

    const auth = pick((e) => e.extensions?.status_code === 401 || /not authenticated|invalid (api )?token|token (is )?(invalid|expired|revoked)/i.test(e.message ?? '') || /^(AuthenticationError|NOT_AUTHENTICATED)$/i.test(code(e)));
    if (auth) throw new ProviderAuthRejectedError('monday.com rejected the access token');

    const first = errors[0];
    const status = first.extensions?.status_code;
    const notFound = pick((e) => e.extensions?.status_code === 404 || /(ResourceNotFound|InvalidBoardId|InvalidItemId)/i.test(code(e)) || /not found|does not exist|invalid board id/i.test(e.message ?? ''));
    if (notFound) throw new ProviderHttpError(404, MONDAY_API, (notFound.message ?? 'not found').slice(0, 300));
    const forbidden = pick((e) => e.extensions?.status_code === 403 || /^(USER_UNAUTHORIZED|UserUnauthorizedException|MissingScope|PermissionDenied)/i.test(code(e)) || /(not authorized|permission|missing scope)/i.test(e.message ?? ''));
    if (forbidden) throw new ProviderHttpError(403, MONDAY_API, (forbidden.message ?? 'forbidden').slice(0, 300));
    throw new ProviderHttpError(typeof status === 'number' && status >= 400 && status < 600 ? status : 400, MONDAY_API, errors.map((e) => e.message ?? code(e) ?? 'error').join('; ').slice(0, 300));
  }

  /**
   * A root collection that pages with `limit` / `page` (boards, users, workspaces): until a page comes back short or empty.
   * `build(page)` returns the whole query for that page; `pick` takes the typed data. Returns whether the list was cut at `max`.
   */
  async pages<R, N>(ctx: MondayCallContext, build: (page: number, limit: number) => string, pick: (r: R) => N[] | null | undefined, limit: number, max: number): Promise<{ items: N[]; capped: boolean }> {
    const items: N[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const r = await this.query<R>(ctx, build(page, limit));
      const got = pick(r) ?? [];
      items.push(...got);
      if (items.length >= max) return { items: items.slice(0, max), capped: got.length >= limit || items.length > max };
      if (got.length < limit) return { items, capped: false };
    }
    return { items, capped: true };
  }
}
