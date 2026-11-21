import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ProviderAuthRejectedError, ProviderHttpError } from '../../core/integration.types';
import { ProviderHttpClient, RateShape } from '../../core/provider-http.client';

export const CLICKUP_API = 'https://api.clickup.com/api/v2';
/** ClickUp's lowest published limit is 100 requests per minute per token (Free, Unlimited, Business). 90 leaves headroom for a person using the same token. */
export const DEFAULT_REQUESTS_PER_MINUTE = 90;

export interface ClickUpCallContext {
  /** Absent before a connection exists (the OAuth callback). */
  connectionId?: string;
  accessToken: string;
}

/**
 * Thin REST layer over ProviderHttpClient: the per-token pacing (a bucket sized to the plan's per-minute limit, configurable for
 * Business Plus / Enterprise), Authorization, and the translation of failures: 401 -> ProviderAuthRejectedError (the job pauses),
 * any other non-2xx -> ProviderHttpError, 429 -> ProviderRateLimitedError (raised by the HTTP layer, from X-RateLimit-Reset).
 */
@Injectable()
export class ClickUpClient {
  constructor(private readonly http: ProviderHttpClient, private readonly config: ConfigService) {}

  /** Requests per minute this process may spend on one connection. */
  get requestsPerMinute(): number {
    const n = Number(this.config.get('CLICKUP_REQUESTS_PER_MINUTE'));
    return Number.isFinite(n) && n >= 10 && n <= 10_000 ? Math.floor(n) : DEFAULT_REQUESTS_PER_MINUTE;
  }

  private rate(): RateShape {
    const perSecond = this.requestsPerMinute / 60;
    return { capacity: Math.max(2, Math.ceil(perSecond * 3)), refillPerSecond: perSecond };
  }

  rateKey(ctx: ClickUpCallContext): string {
    return ctx.connectionId ? `connection:${ctx.connectionId}` : 'oauth:CLICKUP';
  }

  async get<T>(ctx: ClickUpCallContext, path: string, query: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
    const url = new URL(`${CLICKUP_API}${path}`);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v));
    const res = await this.http.request({
      rateKey: this.rateKey(ctx),
      rate: this.rate(),
      url: url.toString(),
      headers: { authorization: `Bearer ${ctx.accessToken}`, accept: 'application/json' },
    });
    if (res.status === 401) throw new ProviderAuthRejectedError('ClickUp rejected the access token (HTTP 401)');
    if (!res.ok) throw new ProviderHttpError(res.status, url.toString(), res.text.slice(0, 300));
    try {
      return res.json<T>();
    } catch {
      throw new ProviderHttpError(502, url.toString(), 'ClickUp answered with something that is not JSON');
    }
  }
}
