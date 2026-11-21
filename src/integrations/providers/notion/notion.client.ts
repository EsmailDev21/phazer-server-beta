import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ProviderAuthRejectedError, ProviderHttpError } from '../../core/integration.types';
import { ProviderHttpClient, RateShape } from '../../core/provider-http.client';
import { NtError, NtList } from './notion.types';

export const NOTION_API = 'https://api.notion.com';
/**
 * Pinned and ALWAYS sent (a request without the header gets an old default). 2026-03-11 is Current and is the version that has the
 * page-markdown endpoint; its breaking changes (`after` -> `position`, `archived` -> `in_trash`, `transcription` -> `meeting_notes`) only
 * touch writes and the trash flag, which the importer reads under both names. Override with NOTION_API_VERSION.
 */
export const DEFAULT_NOTION_VERSION = '2026-03-11';
/** Notion allows an average of 3 requests a second per token (2,700 per 15 minutes); a little under, so one burst never trips it. */
export const DEFAULT_REQUESTS_PER_SECOND = 2.5;
export const PAGE_SIZE = 100;
const MAX_PAGES = 1000;

export interface NotionCallContext {
  connectionId?: string;
  accessToken: string;
}

export type Query = Record<string, string | number | boolean | string[] | undefined>;

/**
 * Thin REST layer over ProviderHttpClient: per-token pacing at the documented rate, the pinned version header, Bearer auth, and the
 * translation of failures: 401 -> ProviderAuthRejectedError; 429 -> ProviderRateLimitedError (the HTTP layer reads Retry-After, which
 * Notion sends in seconds); any other non-2xx -> ProviderHttpError carrying Notion's own error code. 403 `restricted_resource` and 404
 * `object_not_found` are about ONE object (not shared with the connection): callers decide whether that object is skipped.
 */
@Injectable()
export class NotionClient {
  constructor(private readonly http: ProviderHttpClient, private readonly config: ConfigService) {}

  get apiVersion(): string {
    const v = (this.config.get<string>('NOTION_API_VERSION') ?? '').trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : DEFAULT_NOTION_VERSION;
  }

  get requestsPerSecond(): number {
    const n = Number(this.config.get('NOTION_REQUESTS_PER_SECOND'));
    return Number.isFinite(n) && n >= 0.2 && n <= 3 ? n : DEFAULT_REQUESTS_PER_SECOND;
  }

  private rate(): RateShape {
    return { capacity: 3, refillPerSecond: this.requestsPerSecond };
  }

  rateKey(ctx: NotionCallContext): string {
    return ctx.connectionId ? `connection:${ctx.connectionId}` : 'oauth:NOTION';
  }

  headers(token: string, json = false): Record<string, string> {
    return { authorization: `Bearer ${token}`, 'notion-version': this.apiVersion, accept: 'application/json', ...(json ? { 'content-type': 'application/json' } : {}) };
  }

  private url(path: string, query: Query = {}): string {
    const u = new URL(`${NOTION_API}${path}`);
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      if (Array.isArray(v)) for (const x of v) u.searchParams.append(k, x);
      else u.searchParams.set(k, String(v));
    }
    return u.toString();
  }

  async request<T>(ctx: NotionCallContext, method: 'GET' | 'POST', path: string, opts: { query?: Query; body?: unknown } = {}): Promise<T> {
    const url = this.url(path, opts.query);
    const res = await this.http.request({
      rateKey: this.rateKey(ctx),
      rate: this.rate(),
      url,
      method,
      headers: this.headers(ctx.accessToken, method === 'POST'),
      ...(method === 'POST' ? { body: JSON.stringify(opts.body ?? {}) } : {}),
    });
    if (res.status === 401) throw new ProviderAuthRejectedError('Notion rejected the access token (HTTP 401)');
    if (!res.ok) {
      let err: NtError = {};
      try {
        err = res.json<NtError>();
      } catch {
        /* the status decides */
      }
      throw new ProviderHttpError(res.status, url, `${err.code ? `${err.code}: ` : ''}${(err.message ?? res.text).slice(0, 300)}`);
    }
    try {
      return res.json<T>();
    } catch {
      throw new ProviderHttpError(502, url, 'Notion answered with something that is not JSON');
    }
  }

  get<T>(ctx: NotionCallContext, path: string, query?: Query): Promise<T> {
    return this.request<T>(ctx, 'GET', path, { query });
  }

  post<T>(ctx: NotionCallContext, path: string, body?: unknown, query?: Query): Promise<T> {
    return this.request<T>(ctx, 'POST', path, { body, query });
  }

  /** Every item of a paginated list (GET with `start_cursor`, or POST with it in the body), up to `max`; reports whether it was cut. */
  async all<T>(ctx: NotionCallContext, how: { method: 'GET'; path: string; query?: Query } | { method: 'POST'; path: string; body?: Record<string, unknown>; query?: Query }, max = 2000): Promise<{ items: T[]; capped: boolean }> {
    const items: T[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < MAX_PAGES; i++) {
      const page =
        how.method === 'GET'
          ? await this.get<NtList<T>>(ctx, how.path, { ...how.query, page_size: PAGE_SIZE, start_cursor: cursor })
          : await this.post<NtList<T>>(ctx, how.path, { ...how.body, page_size: PAGE_SIZE, ...(cursor ? { start_cursor: cursor } : {}) }, how.query);
      const got = Array.isArray(page.results) ? page.results : [];
      items.push(...got);
      cursor = page.has_more && page.next_cursor ? page.next_cursor : undefined;
      if (!cursor || got.length === 0) return { items, capped: false };
      if (items.length >= max) return { items: items.slice(0, max), capped: true };
    }
    return { items, capped: true };
  }
}
