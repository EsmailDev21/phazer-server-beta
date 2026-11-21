import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ProviderAuthRejectedError, ProviderHttpError } from '../../core/integration.types';
import { ProviderHttpClient, RateShape } from '../../core/provider-http.client';
import { AsEnvelope } from './asana.types';

export const ASANA_API = 'https://app.asana.com/api/1.0';
/** Asana allows 150 requests a minute per token on a Free domain and 1,500 on a paid one. 120 is safe on both and leaves headroom for the person using the same token. */
export const DEFAULT_REQUESTS_PER_MINUTE = 120;
/** Largest page Asana serves. */
export const PAGE_LIMIT = 100;

export interface AsanaCallContext {
  /** Absent before a connection exists (the OAuth callback). */
  connectionId?: string;
  accessToken: string;
}

export type Query = Record<string, string | number | boolean | undefined>;

/**
 * Thin REST layer over ProviderHttpClient: per-token pacing (a bucket sized to the plan's per-minute limit), Authorization, and the
 * translation of failures: 401 -> ProviderAuthRejectedError (the job pauses / the token is refreshed by the caller), any other
 * non-2xx -> ProviderHttpError, 429 -> ProviderRateLimitedError (raised by the HTTP layer from Retry-After, which Asana always sends).
 */
@Injectable()
export class AsanaClient {
  constructor(private readonly http: ProviderHttpClient, private readonly config: ConfigService) {}

  /** Requests per minute this process may spend on one connection. */
  get requestsPerMinute(): number {
    const n = Number(this.config.get('ASANA_REQUESTS_PER_MINUTE'));
    return Number.isFinite(n) && n >= 10 && n <= 10_000 ? Math.floor(n) : DEFAULT_REQUESTS_PER_MINUTE;
  }

  private rate(): RateShape {
    const perSecond = this.requestsPerMinute / 60;
    return { capacity: Math.max(2, Math.ceil(perSecond * 3)), refillPerSecond: perSecond };
  }

  rateKey(ctx: AsanaCallContext): string {
    return ctx.connectionId ? `connection:${ctx.connectionId}` : 'oauth:ASANA';
  }

  /** One request; the whole `{ data, next_page }` envelope. */
  async get<T>(ctx: AsanaCallContext, path: string, query: Query = {}): Promise<AsEnvelope<T>> {
    const url = new URL(`${ASANA_API}${path}`);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v));
    const res = await this.http.request({
      rateKey: this.rateKey(ctx),
      rate: this.rate(),
      url: url.toString(),
      headers: { authorization: `Bearer ${ctx.accessToken}`, accept: 'application/json' },
    });
    if (res.status === 401) throw new ProviderAuthRejectedError('Asana rejected the access token (HTTP 401)');
    if (!res.ok) throw new ProviderHttpError(res.status, url.toString(), res.text.slice(0, 300));
    try {
      const body = res.json<AsEnvelope<T>>();
      if (!body || typeof body !== 'object' || !('data' in body)) throw new Error('no data');
      return body;
    } catch {
      throw new ProviderHttpError(502, url.toString(), 'Asana answered with something that is not the expected JSON');
    }
  }

  /** Every item of a paginated list, up to `max` (limit=100 per request). Returns whether the list was cut at `max`. */
  async all<T>(ctx: AsanaCallContext, path: string, query: Query = {}, max = 2000): Promise<{ items: T[]; capped: boolean }> {
    const items: T[] = [];
    let offset: string | undefined;
    for (let guard = 0; guard < Math.ceil(max / PAGE_LIMIT) + 5; guard++) {
      const r = await this.get<T[]>(ctx, path, { ...query, limit: PAGE_LIMIT, offset });
      const got = Array.isArray(r.data) ? r.data : [];
      items.push(...got);
      offset = r.next_page?.offset ?? undefined;
      if (!offset || got.length === 0) return { items, capped: false };
      if (items.length >= max) return { items: items.slice(0, max), capped: true };
    }
    return { items, capped: true };
  }
}
