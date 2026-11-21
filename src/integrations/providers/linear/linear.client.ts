import { Injectable, Logger } from '@nestjs/common';
import { ProviderHttpClient } from '../../core/provider-http.client';
import { ProviderAuthRejectedError, ProviderHttpError, ProviderRateLimitedError } from '../../core/integration.types';
import { Connection, GqlEnvelope, GqlError } from './linear.types';

export const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';

export interface LinearCallContext {
  /** Absent before a connection exists (the OAuth callback): the call then shares the `oauth:LINEAR` bucket. */
  connectionId?: string;
  accessToken: string;
}

/** A page-through that never ends is a bug somewhere (a cursor that does not advance): stop instead of looping forever. */
const MAX_PAGES = 2000;
const DEFAULT_RATE_LIMIT_WAIT_MS = 60_000;
const MAX_RATE_LIMIT_WAIT_MS = 60 * 60_000;

/**
 * Linear speaks GraphQL over one POST endpoint, and reports most failures INSIDE a 200 or 400 body, so the generic HTTP layer
 * (ProviderHttpClient: rate-limit bucket, Retry-After on 429, circuit breaker, retries on 5xx) is not enough on its own. This
 * class adds the translation:
 *   - HTTP 401, or `AUTHENTICATION_ERROR`           -> ProviderAuthRejectedError  (the executor PAUSES the job)
 *   - `RATELIMITED` (Linear answers it with HTTP 400) -> ProviderRateLimitedError  (delayed retry)
 *   - any other error with no `data`                -> ProviderHttpError          (4xx = fail, 5xx = retry)
 * A response with BOTH data and errors is used as is (Linear returns partial data when one field is not visible to the
 * token); a response with errors and no data is never used.
 */
@Injectable()
export class LinearClient {
  private readonly logger = new Logger(LinearClient.name);

  constructor(private readonly http: ProviderHttpClient) {}

  async query<T>(ctx: LinearCallContext, query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const rateKey = ctx.connectionId ? `connection:${ctx.connectionId}` : 'oauth:LINEAR';
    const res = await this.http.request({
      rateKey,
      url: LINEAR_GRAPHQL_URL,
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ctx.accessToken}` },
      body: JSON.stringify({ query, variables }),
    });

    if (res.status === 401) throw new ProviderAuthRejectedError('Linear rejected the access token (HTTP 401)');

    let body: GqlEnvelope<T> | undefined;
    try {
      body = res.json<GqlEnvelope<T>>();
    } catch {
      body = undefined; // an HTML error page from a proxy, say
    }
    const errors = Array.isArray(body?.errors) ? body!.errors! : [];

    const code = (e: GqlError) => (e.extensions?.code ?? e.extensions?.type ?? '').toString().toUpperCase();
    if (errors.some((e) => code(e) === 'RATELIMITED')) {
      throw new ProviderRateLimitedError(this.resetDelayMs(res.headers), rateKey);
    }
    if (errors.some((e) => code(e) === 'AUTHENTICATION_ERROR')) {
      throw new ProviderAuthRejectedError('Linear rejected the access token');
    }

    if (body?.data !== undefined && body.data !== null && res.ok) {
      if (errors.length) this.logger.warn(`Linear returned partial data with ${errors.length} error(s): ${errors[0].message ?? ''}`.slice(0, 300));
      return body.data;
    }

    // No usable data. Report it as an HTTP failure so classifyImportError decides (5xx -> retry, 4xx -> fail).
    const snippet = errors.length ? errors.map((e) => e.message ?? e.extensions?.code ?? 'error').join('; ') : res.text;
    throw new ProviderHttpError(res.ok ? 400 : res.status, LINEAR_GRAPHQL_URL, String(snippet).slice(0, 300));
  }

  /**
   * Walks a Relay connection to its end. `pick` takes the response and returns the connection (or undefined when the parent
   * entity is gone). Stops at `max` nodes (the result says so) so a huge workspace cannot exhaust memory.
   */
  async fetchAll<R, N>(
    ctx: LinearCallContext,
    query: string,
    variables: Record<string, unknown>,
    pick: (r: R) => Connection<N> | undefined | null,
    max = Number.POSITIVE_INFINITY,
  ): Promise<{ nodes: N[]; truncated: boolean }> {
    const nodes: N[] = [];
    let after: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const r: R = await this.query<R>(ctx, query, { ...variables, after });
      const conn = pick(r);
      if (!conn) return { nodes, truncated: false };
      for (const n of conn.nodes ?? []) {
        if (nodes.length >= max) return { nodes, truncated: true };
        nodes.push(n);
      }
      if (!conn.pageInfo?.hasNextPage || !conn.pageInfo.endCursor) return { nodes, truncated: false };
      after = conn.pageInfo.endCursor;
    }
    return { nodes, truncated: true };
  }

  /**
   * How long Linear wants us to wait. Its headers carry the moment the budget resets (UTC epoch; documented in seconds, so a
   * value that is clearly milliseconds is accepted too). Missing or in the past -> a minute; capped at an hour.
   */
  private resetDelayMs(h: Headers): number {
    const raw = h.get('x-ratelimit-requests-reset') ?? h.get('x-ratelimit-complexity-reset');
    const n = raw === null ? NaN : Number(raw);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_RATE_LIMIT_WAIT_MS;
    const atMs = n > 1e12 ? n : n * 1000;
    const wait = atMs - Date.now();
    if (wait <= 0) return DEFAULT_RATE_LIMIT_WAIT_MS;
    return Math.min(wait, MAX_RATE_LIMIT_WAIT_MS);
  }
}
