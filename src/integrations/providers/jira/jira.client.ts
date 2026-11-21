import { Injectable } from '@nestjs/common';
import { ProviderAuthRejectedError, ProviderHttpError } from '../../core/integration.types';
import { ProviderHttpClient } from '../../core/provider-http.client';

export const ATLASSIAN_API = 'https://api.atlassian.com';

export interface JiraCallContext {
  /** The site (cloudId). */
  cloudId: string;
  accessToken: string;
  connectionId?: string;
}

/**
 * REST layer over ProviderHttpClient for ONE Jira Cloud site: `https://api.atlassian.com/ex/jira/{cloudId}/...`, Bearer auth, the
 * shared token bucket / Retry-After handling, 401 -> ProviderAuthRejectedError, any other non-2xx -> ProviderHttpError.
 */
@Injectable()
export class JiraClient {
  constructor(private readonly http: ProviderHttpClient) {}

  base(cloudId: string): string {
    return `${ATLASSIAN_API}/ex/jira/${encodeURIComponent(cloudId)}`;
  }

  /** The address of an attachment's bytes. Built from ids (never taken from a response), so it can only ever point at Atlassian's gateway. */
  attachmentContentUrl(cloudId: string, attachmentId: string): string {
    return `${this.base(cloudId)}/rest/api/3/attachment/content/${encodeURIComponent(attachmentId)}`;
  }

  private rateKey(c: JiraCallContext): string {
    return c.connectionId ? `connection:${c.connectionId}` : 'oauth:JIRA';
  }

  async get<T>(c: JiraCallContext, path: string, query: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
    const url = new URL(`${this.base(c.cloudId)}${path}`);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v));
    return this.send<T>(c, url.toString(), 'GET');
  }

  async post<T>(c: JiraCallContext, path: string, body: unknown): Promise<T> {
    return this.send<T>(c, `${this.base(c.cloudId)}${path}`, 'POST', JSON.stringify(body));
  }

  private async send<T>(c: JiraCallContext, url: string, method: 'GET' | 'POST', body?: string): Promise<T> {
    const res = await this.http.request({
      rateKey: this.rateKey(c),
      url,
      method,
      headers: { authorization: `Bearer ${c.accessToken}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: body as never } : {}),
    });
    if (res.status === 401) throw new ProviderAuthRejectedError('Jira rejected the access token (HTTP 401)');
    if (!res.ok) throw new ProviderHttpError(res.status, url, res.text.slice(0, 300));
    try {
      return res.json<T>();
    } catch {
      throw new ProviderHttpError(502, url, 'Jira answered with something that is not JSON');
    }
  }

  /** Jira's classic list pages: `{ values, isLast, startAt }`. Follows them up to `max` items. */
  async paged<T>(c: JiraCallContext, path: string, query: Record<string, string | number | boolean | undefined>, key: string, max: number): Promise<T[]> {
    const out: T[] = [];
    let startAt = 0;
    for (let guard = 0; guard < 500 && out.length < max; guard++) {
      const r = await this.get<Record<string, unknown>>(c, path, { ...query, startAt, maxResults: 50 });
      const items = (Array.isArray(r[key]) ? r[key] : Array.isArray(r) ? r : []) as T[];
      out.push(...items);
      if (r.isLast === true || items.length === 0) break;
      startAt += items.length;
    }
    return out.slice(0, max);
  }
}
