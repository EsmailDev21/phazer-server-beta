import { ProviderHttpClient } from '../../core/provider-http.client';
import { ProviderAuthRejectedError, ProviderHttpError } from '../../core/integration.types';
import { validateBundle, CanonicalBundle } from '../../../imports/canonical';
import { DEFAULT_IMPORT_OPTIONS } from '../../../imports/imports.types';
import { LinearAdapter, LINEAR_ADAPTER_LIMITS } from './linear.adapter';
import { LinearClient } from './linear.client';
import * as Q from './linear.queries';
import { DATASET, LinearDataset, fakeLinear } from './fixtures/linear-responses';

const noRedis = { configured: false, isReady: () => false } as never;
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });
const cfg = (v: Record<string, string>) => ({ get: (k: string) => v[k] }) as never;
const CONFIG = cfg({ LINEAR_CLIENT_ID: 'cid', LINEAR_CLIENT_SECRET: 'sec' });
const make = (f: jest.Mock, config = CONFIG) => {
  const http = new ProviderHttpClient(noRedis, (async (...a: unknown[]) => (await (f as any)(...a)).clone()) as never, { bucketCapacity: 100000, refillPerSecond: 100000, maxRetries: 0 });
  return new LinearAdapter(config, http, new LinearClient(http));
};
const ctx = { connectionId: 'conn-1', externalAccountId: 'org-1', accessToken: 'tok' };
const sel = (...ids: string[]) => ({ sources: ids.map((id) => ({ id, type: 'team' })) });
const form = (init: RequestInit) => Object.fromEntries(new URLSearchParams(String(init.body)));

/** Runs fetchBundle to the end; returns every page and the cursors used. */
async function runAll(a: LinearAdapter, selection = sel('team-eng', 'team-ops')) {
  const pages: CanonicalBundle[] = [];
  const cursors: unknown[] = [];
  let cursor: unknown = null;
  for (let n = 0; n < 100; n++) {
    cursors.push(cursor);
    const r = await a.fetchBundle({ ctx, selection, options: DEFAULT_IMPORT_OPTIONS, cursor });
    pages.push(r.bundle as CanonicalBundle);
    if (r.next === null) return { pages, cursors };
    cursor = r.next;
  }
  throw new Error('did not terminate');
}

describe('LinearAdapter OAuth (step 4.5)', () => {
  const rctx = { redirectUri: 'https://api.test/integrations/linear/callback' };

  it('is configured only with client id and secret', () => {
    expect(make(jest.fn(), cfg({})).isConfigured()).toBe(false);
    expect(make(jest.fn(), cfg({ LINEAR_CLIENT_ID: 'x' })).isConfigured()).toBe(false);
    expect(make(jest.fn()).isConfigured()).toBe(true);
  });

  it('declares the IMPORT capability only, no PKCE', () => {
    const a = make(jest.fn());
    expect([...a.capabilities]).toEqual(['IMPORT']);
    expect(a.usesPkce).toBe(false);
    expect(a.provider).toBe('LINEAR');
  });

  it('authorize URL: read scope only, the redirect, the state, code flow', () => {
    const u = new URL(make(jest.fn()).authorizeUrl({ state: 'S', ...rctx }));
    expect(u.origin + u.pathname).toBe('https://linear.app/oauth/authorize');
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ client_id: 'cid', redirect_uri: rctx.redirectUri, response_type: 'code', scope: 'read', state: 'S' });
  });

  it('exchange: code -> token (form), then the organization becomes the external account', async () => {
    const f = jest.fn(async (url: unknown) =>
      String(url).endsWith('/oauth/token')
        ? json({ access_token: 'at', refresh_token: 'rt', expires_in: 86399, scope: ['read'], token_type: 'Bearer' })
        : json({ data: { organization: { id: 'org-9', name: 'Acme', urlKey: 'acme' } } }));
    const { tokens, account } = await make(f as never).exchangeCode({ code: 'c' }, rctx);
    expect(account).toEqual({ id: 'org-9', name: 'Acme' });
    expect(tokens).toMatchObject({ accessToken: 'at', refreshToken: 'rt', scopes: ['read'], tokenType: 'Bearer' });
    expect(tokens.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 80_000_000);
    const [tokenUrl, tokenInit] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(tokenUrl).toBe('https://api.linear.app/oauth/token');
    expect(form(tokenInit)).toEqual({ client_id: 'cid', client_secret: 'sec', grant_type: 'authorization_code', code: 'c', redirect_uri: rctx.redirectUri });
    const [, gqlInit] = f.mock.calls[1] as unknown as [string, RequestInit];
    expect((gqlInit.headers as Record<string, string>).authorization).toBe('Bearer at');
  });

  it('exchange: a space- or comma-separated scope string is split; no expires_in = a token that does not expire', async () => {
    const f = jest.fn(async (url: unknown) =>
      String(url).endsWith('/oauth/token') ? json({ access_token: 'at', scope: 'read write' }) : json({ data: { organization: { id: 'o', name: 'n' } } }));
    const { tokens } = await make(f as never).exchangeCode({ code: 'c' }, rctx);
    expect(tokens.scopes).toEqual(['read', 'write']);
    expect(tokens.expiresAt).toBeUndefined();
    expect(tokens.refreshToken).toBeUndefined();
  });

  it('exchange fails clearly: no code, token HTTP error, no access_token, no organization', async () => {
    await expect(make(jest.fn()).exchangeCode({}, rctx)).rejects.toThrow(/without code/);
    await expect(make(jest.fn().mockResolvedValue(json({ error: 'invalid_request' }, 400))).exchangeCode({ code: 'c' }, rctx)).rejects.toThrow(/HTTP 400 invalid_request/);
    await expect(make(jest.fn().mockResolvedValue(json({}, 200))).exchangeCode({ code: 'c' }, rctx)).rejects.toThrow(/access_token/);
    const f = jest.fn(async (url: unknown) => (String(url).endsWith('/oauth/token') ? json({ access_token: 'at' }) : json({ data: { organization: null } })));
    await expect(make(f as never).exchangeCode({ code: 'c' }, rctx)).rejects.toThrow(/organization/);
  });

  it('exchange: a failing token call is NOT reported as a dead grant (only refresh can say that)', async () => {
    const e = await make(jest.fn().mockResolvedValue(json({ error: 'invalid_grant' }, 400))).exchangeCode({ code: 'c' }, rctx).catch((x) => x);
    expect(e).not.toBeInstanceOf(ProviderAuthRejectedError);
  });

  describe('refresh', () => {
    const old = { accessToken: 'a', refreshToken: 'r1', scopes: ['read'] };
    it('uses the refresh grant and keeps the old refresh token when none comes back', async () => {
      const f = jest.fn().mockResolvedValue(json({ access_token: 'a2', expires_in: 3600, scope: 'read' }));
      const t = await make(f).refresh(old);
      expect(t).toMatchObject({ accessToken: 'a2', refreshToken: 'r1' });
      expect(form(f.mock.calls[0][1] as RequestInit)).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'r1' });
    });
    it('takes a rotated refresh token', async () => {
      const t = await make(jest.fn().mockResolvedValue(json({ access_token: 'a2', refresh_token: 'r2' }))).refresh(old);
      expect(t.refreshToken).toBe('r2');
    });
    it('invalid_grant (400) and 401 -> ProviderAuthRejectedError; no refresh token -> the same; 5xx and other 400s -> a plain error (transient)', async () => {
      await expect(make(jest.fn().mockResolvedValue(json({ error: 'invalid_grant' }, 400))).refresh(old)).rejects.toBeInstanceOf(ProviderAuthRejectedError);
      await expect(make(jest.fn().mockResolvedValue(json({}, 401))).refresh(old)).rejects.toBeInstanceOf(ProviderAuthRejectedError);
      await expect(make(jest.fn()).refresh({ accessToken: 'a', scopes: [] })).rejects.toBeInstanceOf(ProviderAuthRejectedError);
      const flaky = await make(jest.fn().mockResolvedValue(json({}, 500))).refresh(old).catch((x) => x);
      expect(flaky).not.toBeInstanceOf(ProviderAuthRejectedError);
      const odd = await make(jest.fn().mockResolvedValue(json({ error: 'temporarily_unavailable' }, 400))).refresh(old).catch((x) => x);
      expect(odd).not.toBeInstanceOf(ProviderAuthRejectedError);
    });
  });

  it('revoke posts to the revoke endpoint with the bearer token', async () => {
    const f = jest.fn().mockResolvedValue(json({}));
    await make(f).revoke({ accessToken: 'at', scopes: [] });
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.linear.app/oauth/revoke');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer at');
  });
});

describe('LinearAdapter import (step 4.5)', () => {
  describe('every query is read-only and cheap enough', () => {
    const docs = Object.entries(Q).filter(([, v]) => typeof v === 'string') as Array<[string, string]>;
    it.each(docs)('%s is a query, never a mutation', (_, doc) => {
      expect(doc.trim().startsWith('query ')).toBe(true);
      expect(doc).not.toMatch(/mutation|subscription/i);
    });
    it('the issue page keeps nested connections at NESTED_FIRST and the page at ISSUE_PAGE_SIZE (complexity stays far under 10,000)', () => {
      const firsts = [...Q.Q_TEAM_ISSUES.matchAll(/\bfirst:\s*(\d+)/g)].map((m) => Number(m[1]));
      expect(firsts.sort((a, b) => a - b)).toEqual([Q.NESTED_FIRST, Q.NESTED_FIRST, Q.ISSUE_PAGE_SIZE]);
      expect(Q.ISSUE_PAGE_SIZE).toBeLessThanOrEqual(50);
    });
  });

  describe('discover', () => {
    it('teams -> selectable "team" nodes, across Relay pages', async () => {
      const fake = fakeLinear();
      const tree = await make(fake.fetch as never).discover(ctx);
      expect(tree.nodes).toEqual([
        { id: 'team-eng', type: 'team', name: 'Engineering (ENG)', parentId: null, selectable: true },
        { id: 'team-ops', type: 'team', name: 'Operations (OPS)', parentId: null, selectable: true },
        { id: 'team-other', type: 'team', name: 'Other (OTH)', parentId: null, selectable: true },
      ]);
      expect(fake.calls.filter((c) => c.op === 'LinearTeams')).toHaveLength(2);
      expect(fake.calls.every((c) => c.auth === 'Bearer tok')).toBe(true);
    });
  });

  describe('estimate', () => {
    it('counts issues per team (archived included), people, and builds the inventory for the Map step', async () => {
      const e = await make(fakeLinear().fetch as never).estimate(ctx, sel('team-eng', 'team-ops'), { ...DEFAULT_IMPORT_OPTIONS, comments: false, attachments: false, history: false });
      expect(e.projects).toEqual([{ sourceId: 'team-eng', name: 'Engineering', tasks: 7 }, { sourceId: 'team-ops', name: 'Operations', tasks: 2 }]);
      expect(e.users).toBe(5);
      expect(e.warnings).toEqual([]);
      expect(e.inventory!.system).toBe('linear');
      expect(e.inventory!.projects.map((p) => [p.externalId, p.statuses.length])).toEqual([['team-eng', 8], ['team-ops', 4]]);
      expect(e.inventory!.projects[1].statuses[0].externalId).toBe('team-ops:s-ops-backlog');
      expect(e.inventory!.users.map((u) => u.externalId)).toEqual(['u-ana', 'u-ben', 'u-cy', 'u-hidden', 'u-bot']);
      expect(e.inventory!.customFields.map((f) => f.name)).toEqual(['Linear project']);
    });

    it('offers Linear\'s fixed priorities even though no issue was read', async () => {
      const e = await make(fakeLinear().fetch as never).estimate(ctx, sel('team-ops'), DEFAULT_IMPORT_OPTIONS);
      expect(e.inventory!.priorities).toEqual(['Urgent', 'High', 'Medium', 'Low']);
    });

    it('says plainly that the content counts are only known while it runs (only when content was asked for)', async () => {
      const asked = await make(fakeLinear().fetch as never).estimate(ctx, sel('team-ops'), DEFAULT_IMPORT_OPTIONS);
      expect(asked.warnings!.map((w) => w.code)).toEqual(['CONTENT_COUNT_UNKNOWN']);
      const one = await make(fakeLinear().fetch as never).estimate(ctx, sel('team-ops'), { ...DEFAULT_IMPORT_OPTIONS, comments: false, attachments: false });
      expect(one.warnings!.map((w) => w.code)).toEqual(['CONTENT_COUNT_UNKNOWN']); // history alone still counts
    });

    it('a team larger than the counting budget reports "at least" with a warning', async () => {
      const big: LinearDataset = { ...DATASET, issues: { 'team-eng': Array.from({ length: LINEAR_ADAPTER_LIMITS.MAX_COUNT_PAGES * 250 + 5 }, (_, i) => ({ id: `x${i}`, title: 't' })) } };
      const e = await make(fakeLinear(big).fetch as never).estimate(ctx, sel('team-eng'), { ...DEFAULT_IMPORT_OPTIONS, comments: false, attachments: false, history: false });
      expect(e.projects[0].tasks).toBe(LINEAR_ADAPTER_LIMITS.MAX_COUNT_PAGES * 250);
      expect(e.warnings!.map((w) => w.code)).toEqual(['COUNT_CAPPED']);
    });

    it('more Linear projects than the option ceiling: the field is left out and the person is told', async () => {
      const many: LinearDataset = { ...DATASET, projects: { ...DATASET.projects, 'team-eng': Array.from({ length: 101 }, (_, i) => ({ id: `p${i}`, name: `Project ${i}` })) } };
      const e = await make(fakeLinear(many).fetch as never).estimate(ctx, sel('team-eng'), { ...DEFAULT_IMPORT_OPTIONS, comments: false, attachments: false, history: false });
      expect(e.inventory!.customFields).toEqual([]);
      expect(e.warnings!.map((w) => w.code)).toEqual(['PROJECT_FIELD_SKIPPED']);
    });

    it('a workspace with more people than a page holds: capped and reported', async () => {
      const crowd: LinearDataset = { ...DATASET, users: Array.from({ length: LINEAR_ADAPTER_LIMITS.MAX_USERS + 7 }, (_, i) => ({ id: `u${i}`, name: `User ${i}` })) };
      const e = await make(fakeLinear(crowd, { pageSize: 100 }).fetch as never).estimate(ctx, sel('team-ops'), { ...DEFAULT_IMPORT_OPTIONS, comments: false, attachments: false, history: false });
      expect(e.users).toBe(LINEAR_ADAPTER_LIMITS.MAX_USERS);
      expect(e.warnings!.map((w) => w.code)).toEqual(['USERS_CAPPED']);
    });

    it('a team that no longer exists is a 404 the executor FAILS on (not an empty import)', async () => {
      const e = await make(fakeLinear().fetch as never).estimate(ctx, sel('team-gone'), DEFAULT_IMPORT_OPTIONS).catch((x) => x);
      expect(e).toBeInstanceOf(ProviderHttpError);
      expect(e.status).toBe(404);
    });
  });

  describe('fetchBundle', () => {
    it('page 0 is the structure: people, labels, a project per team with composed status ids, the project field - and no tasks', async () => {
      const fake = fakeLinear();
      const r = await make(fake.fetch as never).fetchBundle({ ctx, selection: sel('team-eng', 'team-ops'), options: DEFAULT_IMPORT_OPTIONS, cursor: null });
      const p = r.bundle as CanonicalBundle;
      expect(p.source).toEqual({ system: 'linear', displayName: 'Linear' });
      expect(p.users).toHaveLength(5);
      expect(p.users!.find((u) => u.externalId === 'u-bot')!.isBot).toBe(true);
      expect(p.tags!.map((t) => t.name)).toEqual(['Bug', 'Frontend', 'Q3']);
      expect(p.projects!.map((x) => [x.externalId, x.key, x.statuses!.length])).toEqual([['team-eng', 'ENG', 8], ['team-ops', 'OPS', 4]]);
      expect(p.projects![0].statuses!.map((s) => s.externalId)[0]).toBe('team-eng:s-eng-triage');
      expect(p.customFields).toEqual([{ externalId: 'linear-project', name: 'Linear project', dataType: 'SELECT', options: [{ label: 'Web app' }, { label: 'Public API' }] }]);
      expect(p.tasks).toBeUndefined();
      expect(p.iterations).toBeUndefined();
      expect(r.next).toEqual({ v: 1, team: 0, after: null, pf: true });
    });

    it('walks every team to the end: structure page, then issue pages team by team (sorted), then null', async () => {
      const { pages, cursors } = await runAll(make(fakeLinear().fetch as never));
      // ENG: 7 issues in pages of 2 = 4 pages; OPS: 2 issues = 1 page
      expect(pages).toHaveLength(1 + 4 + 1);
      expect(cursors[0]).toBeNull();
      expect((cursors[1] as { team: number }).team).toBe(0);
      expect((cursors[5] as { team: number; after: string | null }).team).toBe(1);
      expect((cursors[5] as { after: string | null }).after).toBeNull();
      const taskIds = pages.flatMap((p) => (p.tasks ?? []).map((t) => t.externalId));
      expect(taskIds).toEqual(['i-eng-1', 'i-eng-2', 'i-eng-3', 'i-eng-4', 'i-eng-5', 'i-eng-6', 'i-eng-7', 'i-ops-1', 'i-ops-2']);
      expect(taskIds).not.toContain('i-other-1'); // not selected
    });

    it('the selection order does not matter (the cursor must not depend on click order)', async () => {
      const a = await runAll(make(fakeLinear().fetch as never), sel('team-eng', 'team-ops'));
      const b = await runAll(make(fakeLinear().fetch as never), sel('team-ops', 'team-eng', 'team-ops'));
      expect(b.pages).toEqual(a.pages);
    });

    it('cycles ride with the FIRST page of their team only', async () => {
      const { pages } = await runAll(make(fakeLinear().fetch as never));
      expect(pages.map((p) => p.iterations?.length ?? 0)).toEqual([0, 2, 0, 0, 0, 0]);
      expect(pages[1].iterations![0]).toMatchObject({ externalId: 'c-1', kind: 'CYCLE', name: 'Spring push', projectExternalId: 'team-eng' });
      expect(pages[1].iterations![1].name).toBe('Cycle 2');
    });

    it('labels beyond the first ten arrive through the follow-up query', async () => {
      const fake = fakeLinear();
      const { pages } = await runAll(make(fake.fetch as never));
      const t = pages.flatMap((p) => p.tasks ?? []).find((x) => x.externalId === 'i-eng-6')!;
      expect(t.tags).toHaveLength(12);
      expect(t.tags![11]).toBe('tag-12');
      expect(fake.calls.filter((c) => c.op === 'LinearIssueLabels').length).toBeGreaterThan(0);
      expect(fake.calls.some((c) => c.op === 'LinearIssueRelations')).toBe(false); // nobody needed it
    });

    it('relations beyond the first ten arrive through the follow-up query too', async () => {
      const data: LinearDataset = {
        ...DATASET,
        issues: { 'team-ops': [{ id: 'i1', title: 'A', relations: { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'x' } } }] },
        extraRelations: { i1: [{ id: 'r-a', type: 'blocks', relatedIssue: { id: 'i2', team: { id: 'team-ops' } } }, { id: 'r-b', type: 'related', relatedIssue: { id: 'i3', team: { id: 'team-ops' } } }, { id: 'r-c', type: 'blocks', relatedIssue: { id: 'i4', team: { id: 'team-ops' } } }] },
      };
      const { pages } = await runAll(make(fakeLinear(data).fetch as never), sel('team-ops'));
      expect(pages.flatMap((p) => p.dependencies ?? []).map((d) => d.externalId)).toEqual(['r-a', 'r-b', 'r-c']);
    });

    it('dependencies: blocks -> BLOCKS, related / duplicate -> RELATES_TO, inside the selection; the other-team one is text, not a link', async () => {
      const { pages } = await runAll(make(fakeLinear().fetch as never));
      expect(pages.flatMap((p) => p.dependencies ?? []).map((d) => [d.externalId, d.fromExternalId, d.toExternalId, d.type])).toEqual([
        ['r-1', 'i-eng-1', 'i-eng-2', 'BLOCKS'],
        ['r-2', 'i-eng-1', 'i-eng-3', 'RELATES_TO'],
        ['r-4', 'i-eng-1', 'i-eng-4', 'RELATES_TO'],
        ['r-5', 'i-ops-2', 'i-ops-1', 'BLOCKS'],
      ]);
      const t1 = pages.flatMap((p) => p.tasks ?? []).find((x) => x.externalId === 'i-eng-1')!;
      expect(t1.description).toContain('- Marked as a duplicate of ENG-4 - Duplicate of login bug');
      expect(t1.description).toContain('- Blocks OTH-9 - Other \\[team\\] thing (not imported)');
      expect(t1.description).not.toContain('Related to'); // that one became a RELATES_TO link
    });

    it('the project field is on the tasks only while the field exists (the flag travels in the cursor)', async () => {
      const { pages } = await runAll(make(fakeLinear().fetch as never));
      const t1 = pages.flatMap((p) => p.tasks ?? []).find((x) => x.externalId === 'i-eng-1')!;
      expect(t1.customValues).toEqual([{ fieldExternalId: 'linear-project', value: 'Web app' }]);
      const many: LinearDataset = { ...DATASET, projects: { ...DATASET.projects, 'team-eng': Array.from({ length: 101 }, (_, i) => ({ id: `p${i}`, name: `Project ${i}` })) } };
      const off = await runAll(make(fakeLinear(many).fetch as never), sel('team-eng'));
      expect(off.pages[0].customFields).toBeUndefined();
      expect(off.pages.flatMap((p) => p.tasks ?? []).some((t) => t.customValues)).toBe(false);
    });

    it('is re-fetchable: the same cursor gives the same page (at-least-once), also from a fresh adapter (a restarted worker)', async () => {
      const first = await runAll(make(fakeLinear().fetch as never));
      for (const i of [1, 2, 4, 5]) {
        const again = await make(fakeLinear().fetch as never).fetchBundle({ ctx, selection: sel('team-eng', 'team-ops'), options: DEFAULT_IMPORT_OPTIONS, cursor: first.cursors[i] });
        expect(again.bundle).toEqual(first.pages[i]);
      }
    });

    it('the cursor is plain JSON (it is stored in the job checkpoint)', async () => {
      const { cursors } = await runAll(make(fakeLinear().fetch as never));
      for (const c of cursors) expect(JSON.parse(JSON.stringify(c))).toEqual(c);
    });

    it('every page passes the executor\'s validator with no fatal and no repair, except the one blank title', async () => {
      const { pages } = await runAll(make(fakeLinear().fetch as never));
      const issues = pages.map((p) => {
        const r = validateBundle(p);
        if ('fatal' in r) throw new Error(`fatal: ${JSON.stringify(r.fatal)}`);
        return r.issues;
      }).flat();
      expect(issues.map((i) => [i.code, i.externalRef])).toEqual([['TITLE_EMPTY', 'task:i-eng-7']]);
    });

    it('an unusable selection or cursor fails loudly instead of importing the wrong thing', async () => {
      const a = make(fakeLinear().fetch as never);
      const go = (selection: unknown, cursor: unknown) => a.fetchBundle({ ctx, selection: selection as never, options: DEFAULT_IMPORT_OPTIONS, cursor });
      await expect(go({ sources: [{ id: 'p-web', type: 'project' }] }, null)).rejects.toThrow(/only import teams/);
      for (const bad of [{ v: 2, team: 0, after: null, pf: true }, { v: 1, team: 5, after: null, pf: true }, { v: 1, team: -1, after: null, pf: true }, { v: 1, team: 0, after: 5, pf: true }, { v: 1, team: 0, after: null }, 'junk', 7, []]) {
        await expect(go(sel('team-eng'), bad)).rejects.toThrow(/cursor is not valid/);
      }
    });

    it('a team deleted between pages is a 404 (FAILED, resumable), not a silently shorter import', async () => {
      const e = await make(fakeLinear().fetch as never).fetchBundle({ ctx, selection: sel('team-gone'), options: DEFAULT_IMPORT_OPTIONS, cursor: { v: 1, team: 0, after: null, pf: false } }).catch((x) => x);
      expect(e).toBeInstanceOf(ProviderHttpError);
      expect(e.status).toBe(404);
    });

    it('a rate-limit answer on page N surfaces as the provider error the executor turns into a delayed retry', async () => {
      const fake = fakeLinear(DATASET, { intercept: (op) => (op === 'LinearTeamIssues' ? json({ errors: [{ extensions: { code: 'RATELIMITED' } }] }, 400) : undefined) });
      const e = await make(fake.fetch as never).fetchBundle({ ctx, selection: sel('team-eng'), options: DEFAULT_IMPORT_OPTIONS, cursor: { v: 1, team: 0, after: null, pf: true } }).catch((x) => x);
      expect(e.name).toBe('ProviderRateLimitedError');
    });

    it('an empty team still yields a valid empty page and moves on', async () => {
      const empty: LinearDataset = { ...DATASET, issues: { 'team-eng': [], 'team-ops': DATASET.issues['team-ops'] } };
      const { pages } = await runAll(make(fakeLinear(empty).fetch as never));
      expect(pages).toHaveLength(1 + 1 + 1);
      expect('fatal' in validateBundle(pages[1])).toBe(false);
    });

    it('never sends a write: every GraphQL operation the run used is one of the known queries', async () => {
      const fake = fakeLinear();
      await runAll(make(fake.fetch as never));
      const known = new Set((Object.values(Q).filter((v) => typeof v === 'string') as string[]).map((d) => /query\s+(\w+)/.exec(d)![1]));
      expect(fake.calls.every((c) => known.has(c.op))).toBe(true);
      expect(fake.fetch.mock.calls.every(([, init]) => (init as RequestInit).method === 'POST')).toBe(true);
    });
  });
});
