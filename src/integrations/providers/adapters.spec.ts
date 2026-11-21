import { generateKeyPairSync, createVerify } from 'crypto';
import { ProviderHttpClient } from '../core/provider-http.client';
import { ConnectorAdapter, NotifyPermanentError, ProviderAuthRejectedError, RichMessage } from '../core/integration.types';
import { DiscordAdapter, toEmbed } from './discord.adapter';
import { GithubAdapter } from './github.adapter';
import { SlackAdapter } from './slack.adapter';

const noRedis = { configured: false, isReady: () => false } as never;
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });
const cfg = (v: Record<string, string>) => ({ get: (k: string) => v[k] }) as never;
const http = (f: jest.Mock) =>
  new ProviderHttpClient(noRedis, (async (...a: unknown[]) => (await (f as any)(...a)).clone()) as never, { bucketCapacity: 1000, refillPerSecond: 1000, maxRetries: 0 });
const calls = (f: jest.Mock) => f.mock.calls.map(([url, init]) => ({ url: String(url), init: init as RequestInit }));
const form = (init: RequestInit) => Object.fromEntries(new URLSearchParams(String(init.body)));

describe('DiscordAdapter', () => {
  const config = cfg({ DISCORD_CLIENT_ID: 'cid', DISCORD_CLIENT_SECRET: 'sec', DISCORD_BOT_TOKEN: 'bot' });
  const ctx = { redirectUri: 'https://api.test/integrations/discord/callback' };

  it('is configured only with client id and secret', () => {
    expect(new DiscordAdapter(cfg({}), http(jest.fn())).isConfigured()).toBe(false);
    expect(new DiscordAdapter(config, http(jest.fn())).isConfigured()).toBe(true);
  });

  it('authorize URL carries bot + commands scopes, the redirect and the state', () => {
    const u = new URL(new DiscordAdapter(config, http(jest.fn())).authorizeUrl({ state: 'S', ...ctx }));
    expect(u.origin + u.pathname).toBe('https://discord.com/oauth2/authorize');
    expect(u.searchParams.get('scope')).toBe('bot applications.commands identify');
    expect(u.searchParams.get('state')).toBe('S');
    expect(u.searchParams.get('redirect_uri')).toBe(ctx.redirectUri);
    expect(u.searchParams.get('client_id')).toBe('cid');
  });

  it('exchange: guild becomes the external account; tokens parsed', async () => {
    const f = jest.fn().mockResolvedValue(json({
      access_token: 'at', refresh_token: 'rt', expires_in: 604800, scope: 'bot identify', token_type: 'Bearer',
      guild: { id: 'g1', name: 'My Server' },
    }));
    const { tokens, account } = await new DiscordAdapter(config, http(f)).exchangeCode({ code: 'c', guild_id: 'g1' }, ctx);
    expect(account).toEqual({ id: 'g1', name: 'My Server' });
    expect(tokens.refreshToken).toBe('rt');
    expect(tokens.scopes).toEqual(['bot', 'identify']);
    expect(tokens.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 600_000_000);
    expect(form(calls(f)[0].init)).toMatchObject({ grant_type: 'authorization_code', code: 'c', client_secret: 'sec' });
  });

  it('exchange rejects a guild_id that disagrees with the token response, and a missing guild', async () => {
    const f = jest.fn().mockResolvedValue(json({ access_token: 'a', guild: { id: 'g1', name: 'n' } }));
    await expect(new DiscordAdapter(config, http(f)).exchangeCode({ code: 'c', guild_id: 'OTHER' }, ctx)).rejects.toThrow(/mismatch/);
    const g = jest.fn().mockResolvedValue(json({ access_token: 'a' }));
    await expect(new DiscordAdapter(config, http(g)).exchangeCode({ code: 'c' }, ctx)).rejects.toThrow(/guild/);
  });

  it('refresh: dead grant -> ProviderAuthRejectedError; 500 -> plain error (transient)', async () => {
    const dead = jest.fn().mockResolvedValue(json({ error: 'invalid_grant' }, 400));
    await expect(new DiscordAdapter(config, http(dead)).refresh({ accessToken: 'a', refreshToken: 'r', scopes: [] }))
      .rejects.toBeInstanceOf(ProviderAuthRejectedError);
    const flaky = jest.fn().mockResolvedValue(json({}, 500));
    const e = await new DiscordAdapter(config, http(flaky)).refresh({ accessToken: 'a', refreshToken: 'r', scopes: [] }).catch((x) => x);
    expect(e).not.toBeInstanceOf(ProviderAuthRejectedError);
  });

  it('revoke: revokes the token and removes the bot from the guild', async () => {
    const f = jest.fn().mockResolvedValue(new Response(null, { status: 204 }));
    await new DiscordAdapter(config, http(f)).revoke({ accessToken: 'a', scopes: [] }, { id: 'g1', name: 'n' });
    const c = calls(f);
    expect(c[0].url).toMatch(/oauth2\/token\/revoke$/);
    expect(c[1]).toMatchObject({ url: expect.stringMatching(/users\/@me\/guilds\/g1$/) });
    expect((c[1].init.headers as Record<string, string>).authorization).toBe('Bot bot');
  });
});

describe('SlackAdapter', () => {
  const config = cfg({ SLACK_CLIENT_ID: 'cid', SLACK_CLIENT_SECRET: 'sec' });
  const ctx = { redirectUri: 'https://api.test/integrations/slack/callback' };

  it('authorize URL', () => {
    const u = new URL(new SlackAdapter(config, http(jest.fn())).authorizeUrl({ state: 'S', ...ctx }));
    expect(u.origin + u.pathname).toBe('https://slack.com/oauth/v2/authorize');
    expect(u.searchParams.get('scope')).toContain('commands');
    expect(u.searchParams.get('state')).toBe('S');
  });

  it('exchange: team is the account, bot user id kept in extra', async () => {
    const f = jest.fn().mockResolvedValue(json({
      ok: true, access_token: 'xoxb-1', scope: 'commands,chat:write', token_type: 'bot',
      team: { id: 'T1', name: 'Acme' }, bot_user_id: 'U9',
    }));
    const { tokens, account } = await new SlackAdapter(config, http(f)).exchangeCode({ code: 'c' }, ctx);
    expect(account).toEqual({ id: 'T1', name: 'Acme' });
    expect(tokens.scopes).toEqual(['commands', 'chat:write']);
    expect(tokens.extra).toEqual({ botUserId: 'U9' });
    expect(tokens.expiresAt).toBeUndefined(); // no rotation -> never expires
  });

  it('ok:false is an error; a dead refresh token is ProviderAuthRejectedError', async () => {
    const bad = jest.fn().mockResolvedValue(json({ ok: false, error: 'invalid_code' }));
    await expect(new SlackAdapter(config, http(bad)).exchangeCode({ code: 'c' }, ctx)).rejects.toThrow(/invalid_code/);
    const dead = jest.fn().mockResolvedValue(json({ ok: false, error: 'invalid_refresh_token' }));
    await expect(new SlackAdapter(config, http(dead)).refresh({ accessToken: 'a', refreshToken: 'r', scopes: [] }))
      .rejects.toBeInstanceOf(ProviderAuthRejectedError);
  });

  it('refresh keeps the extra fields', async () => {
    const f = jest.fn().mockResolvedValue(json({ ok: true, access_token: 'new', refresh_token: 'r2', expires_in: 43200, scope: 'commands' }));
    const t = await new SlackAdapter(config, http(f)).refresh({ accessToken: 'old', refreshToken: 'r1', scopes: [], extra: { botUserId: 'U9' } });
    expect(t).toMatchObject({ accessToken: 'new', refreshToken: 'r2', extra: { botUserId: 'U9' } });
    expect(t.expiresAt).toBeDefined();
  });
});

describe('identity capability (step 2.2)', () => {
  const idCtx = { redirectUri: 'https://api.test/integrations/x/identity/callback' };

  it('GitHub has none (not in 2.2 scope)', () => {
    expect((new GithubAdapter(cfg({}), http(jest.fn())) as ConnectorAdapter).identity).toBeUndefined();
  });

  it('Discord: identify-only authorize URL on the identity redirect; exchange returns the user, never keeps the token', async () => {
    const config = cfg({ DISCORD_CLIENT_ID: 'cid', DISCORD_CLIENT_SECRET: 'sec' });
    const f = jest.fn(async (url: string) =>
      url.endsWith('/oauth2/token') ? json({ access_token: 'user-tok' }) : json({ id: '42', username: 'neo', global_name: 'Neo' }));
    const a = new DiscordAdapter(config, http(f));
    const u = new URL(a.identity!.authorizeUrl({ state: 'S', ...idCtx }));
    expect(u.searchParams.get('scope')).toBe('identify');
    expect(u.searchParams.get('redirect_uri')).toBe(idCtx.redirectUri);
    expect(u.searchParams.get('permissions')).toBeNull(); // no bot install here
    const ext = await a.identity!.exchange({ code: 'c' }, idCtx);
    expect(ext).toEqual({ id: '42', name: 'Neo', isBot: false });
    expect(form(calls(f)[0].init).redirect_uri).toBe(idCtx.redirectUri);
    expect((calls(f)[1].init.headers as Record<string, string>).authorization).toBe('Bearer user-tok');
    expect(JSON.stringify(ext)).not.toContain('user-tok');
    await expect(a.identity!.exchange({}, idCtx)).rejects.toThrow(/code/);
  });

  it('Slack: OpenID authorize URL; exchange maps sub/email/email_verified/team', async () => {
    const config = cfg({ SLACK_CLIENT_ID: 'cid', SLACK_CLIENT_SECRET: 'sec' });
    const f = jest.fn(async (url: string) =>
      url.includes('openid.connect.token') ? json({ ok: true, access_token: 'xoxp-u' })
        : json({ ok: true, sub: 'U1', name: 'Al', email: 'al@x.test', email_verified: true, 'https://slack.com/team_id': 'T1' }));
    const a = new SlackAdapter(config, http(f));
    const u = new URL(a.identity!.authorizeUrl({ state: 'S', ...idCtx }));
    expect(u.origin + u.pathname).toBe('https://slack.com/openid/connect/authorize');
    expect(u.searchParams.get('scope')).toBe('openid email profile');
    expect(await a.identity!.exchange({ code: 'c' }, idCtx)).toEqual({
      id: 'U1', name: 'Al', email: 'al@x.test', emailConfirmed: true, tenantId: 'T1',
    });
  });

  it('Slack: email_verified absent/false is NOT confirmed; ok:false is an error', async () => {
    const config = cfg({ SLACK_CLIENT_ID: 'cid', SLACK_CLIENT_SECRET: 'sec' });
    const f = jest.fn(async (url: string) =>
      url.includes('token') ? json({ ok: true, access_token: 't' }) : json({ ok: true, sub: 'U1', email: 'a@b.c' }));
    expect((await new SlackAdapter(config, http(f)).identity!.exchange({ code: 'c' }, idCtx)).emailConfirmed).toBe(false);
    const bad = jest.fn().mockResolvedValue(json({ ok: false, error: 'invalid_code' }));
    await expect(new SlackAdapter(config, http(bad)).identity!.exchange({ code: 'c' }, idCtx)).rejects.toThrow(/invalid_code/);
  });

  it('Slack lookup: users.info with the bot token; unconfirmed / deleted / bot flags; user_not_found -> null', async () => {
    const config = cfg({ SLACK_CLIENT_ID: 'cid', SLACK_CLIENT_SECRET: 'sec' });
    const f = jest.fn().mockResolvedValue(json({ ok: true, user: { id: 'U1', team_id: 'T1', real_name: 'Al', is_email_confirmed: true, profile: { email: 'al@x.test' } } }));
    const a = new SlackAdapter(config, http(f));
    expect(await a.identity!.lookup!('bot-tok', 'U1', 'connection:c')).toEqual({
      id: 'U1', name: 'Al', email: 'al@x.test', emailConfirmed: true, isBot: false, tenantId: 'T1',
    });
    expect(calls(f)[0].url).toBe('https://slack.com/api/users.info?user=U1');
    expect((calls(f)[0].init.headers as Record<string, string>).authorization).toBe('Bearer bot-tok');
    const unconfirmed = jest.fn().mockResolvedValue(json({ ok: true, user: { id: 'U1', profile: { email: 'a@b.c' } } }));
    expect((await new SlackAdapter(config, http(unconfirmed)).identity!.lookup!('t', 'U1', 'k'))!.emailConfirmed).toBe(false);
    const deleted = jest.fn().mockResolvedValue(json({ ok: true, user: { id: 'U1', deleted: true, is_email_confirmed: true, profile: { email: 'a@b.c' } } }));
    const d = (await new SlackAdapter(config, http(deleted)).identity!.lookup!('t', 'U1', 'k'))!;
    expect(d.isBot).toBe(true);
    expect(d.emailConfirmed).toBe(false);
    const nf = jest.fn().mockResolvedValue(json({ ok: false, error: 'user_not_found' }));
    expect(await new SlackAdapter(config, http(nf)).identity!.lookup!('t', 'U9', 'k')).toBeNull();
    const err = jest.fn().mockResolvedValue(json({ ok: false, error: 'ratelimited' }));
    await expect(new SlackAdapter(config, http(err)).identity!.lookup!('t', 'U1', 'k')).rejects.toThrow(/ratelimited/);
  });
});

describe('GithubAdapter', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const config = cfg({
    GITHUB_APP_ID: '123', GITHUB_APP_SLUG: 'my-app', GITHUB_APP_CLIENT_ID: 'cid',
    GITHUB_APP_CLIENT_SECRET: 'sec', GITHUB_APP_PRIVATE_KEY: pem.replace(/\n/g, '\\n'),
  });
  const ctx = { redirectUri: 'https://api.test/integrations/github/callback' };

  it('not configured unless every GitHub App variable is set', () => {
    expect(new GithubAdapter(cfg({ GITHUB_APP_ID: '1' }), http(jest.fn())).isConfigured()).toBe(false);
    expect(new GithubAdapter(config, http(jest.fn())).isConfigured()).toBe(true);
  });

  it('app JWT is RS256, iss = app id, verifies against the public key, lifetime <= 10 min', () => {
    const a = new GithubAdapter(config, http(jest.fn()));
    const jwt = a.appJwt(1_700_000_000);
    const [h, p, s] = jwt.split('.');
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
    expect(claims.iss).toBe('123');
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
    expect(createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(s, 'base64url'))).toBe(true);
  });

  it('authorize URL is the app install page with the state', () => {
    const u = new URL(new GithubAdapter(config, http(jest.fn())).authorizeUrl({ state: 'S', ...ctx }));
    expect(u.toString()).toBe('https://github.com/apps/my-app/installations/new?state=S');
  });

  function happyFetch(installations: number[]) {
    return jest.fn(async (url: string) => {
      if (url.includes('login/oauth/access_token')) return json({ access_token: 'user-tok' });
      if (url.includes('/user/installations')) return json({ installations: installations.map((id) => ({ id })) });
      if (/\/app\/installations\/\d+\/access_tokens/.test(url)) {
        return json({ token: 'ghs_inst', expires_at: new Date(Date.now() + 3600_000).toISOString() }, 201);
      }
      if (/\/app\/installations\/\d+$/.test(url)) return json({ account: { login: 'acme-org' } });
      return json({}, 404);
    });
  }

  it('exchange: verifies the user owns the installation, then mints an installation token', async () => {
    const f = happyFetch([555]);
    const { tokens, account } = await new GithubAdapter(config, http(f)).exchangeCode({ installation_id: '555', code: 'c' }, ctx);
    expect(account).toEqual({ id: '555', name: 'acme-org' });
    expect(tokens).toMatchObject({ accessToken: 'ghs_inst', extra: { installationId: '555' }, tokenType: 'installation' });
    expect(tokens.expiresAt!.getTime()).toBeGreaterThan(Date.now());
    // the user token never reaches the result
    expect(JSON.stringify(tokens)).not.toContain('user-tok');
  });

  it('exchange REFUSES an installation id the authorising user does not have (forged callback)', async () => {
    const f = happyFetch([111]);
    await expect(new GithubAdapter(config, http(f)).exchangeCode({ installation_id: '555', code: 'c' }, ctx))
      .rejects.toThrow(/no access/);
    // and it never even asked GitHub for an installation token
    expect(calls(f).some((c) => c.url.includes('access_tokens'))).toBe(false);
  });

  it('exchange refuses a missing code or a non-numeric installation id', async () => {
    const a = new GithubAdapter(config, http(happyFetch([1])));
    await expect(a.exchangeCode({ installation_id: '1' }, ctx)).rejects.toThrow(/code/);
    await expect(a.exchangeCode({ installation_id: '../x', code: 'c' }, ctx)).rejects.toThrow(/installation_id/);
  });

  it('refresh mints a new token; an uninstalled app is ProviderAuthRejectedError', async () => {
    const a = new GithubAdapter(config, http(happyFetch([1])));
    const t = await a.refresh({ accessToken: 'old', scopes: ['app'], extra: { installationId: '555' } });
    expect(t.accessToken).toBe('ghs_inst');
    const gone = jest.fn().mockResolvedValue(json({ message: 'Not Found' }, 404));
    await expect(new GithubAdapter(config, http(gone)).refresh({ accessToken: 'o', scopes: [], extra: { installationId: '9' } }))
      .rejects.toBeInstanceOf(ProviderAuthRejectedError);
    await expect(a.refresh({ accessToken: 'o', scopes: [] })).rejects.toBeInstanceOf(ProviderAuthRejectedError);
  });

  describe('step 2.6: repositories', () => {
    const repo = (id: number) => ({ id, full_name: `acme/r${id}`, private: id % 2 === 0, archived: false, default_branch: 'trunk' });

    it('lists one page of the installation repositories with the installation token', async () => {
      const f = jest.fn().mockResolvedValue(json({ total_count: 2, repositories: [repo(1), repo(2)] }));
      const out = await new GithubAdapter(config, http(f)).repositories('ghs_inst', 1, 'connection:c1');
      expect(out).toEqual({ hasMore: false, repos: [
        { id: 1, fullName: 'acme/r1', private: false, archived: false, defaultBranch: 'trunk' },
        { id: 2, fullName: 'acme/r2', private: true, archived: false, defaultBranch: 'trunk' },
      ] });
      const [c] = calls(f);
      expect(c.url).toBe('https://api.github.com/installation/repositories?per_page=100&page=1');
      expect((c.init.headers as Record<string, string>).authorization).toBe('Bearer ghs_inst');
    });

    it('hasMore only when a full page came back and the total says there is more; a silly page number becomes 1', async () => {
      const full = Array.from({ length: 100 }, (_, i) => repo(i + 1));
      const f = jest.fn().mockResolvedValue(json({ total_count: 150, repositories: full }));
      expect((await new GithubAdapter(config, http(f)).repositories('t', 1, 'k')).hasMore).toBe(true);
      await new GithubAdapter(config, http(f)).repositories('t', -5, 'k');
      expect(calls(f)[1].url).toContain('page=1');
    });

    it('repository(): found, not visible (404/403 -> null), invalid id (no request), other errors throw', async () => {
      const ok = jest.fn().mockResolvedValue(json(repo(7)));
      expect(await new GithubAdapter(config, http(ok)).repository('t', 7, 'k')).toMatchObject({ id: 7, fullName: 'acme/r7' });
      expect(calls(ok)[0].url).toBe('https://api.github.com/repositories/7');
      for (const status of [404, 403]) {
        expect(await new GithubAdapter(config, http(jest.fn().mockResolvedValue(json({}, status)))).repository('t', 7, 'k')).toBeNull();
      }
      const never = jest.fn();
      expect(await new GithubAdapter(config, http(never)).repository('t', 0, 'k')).toBeNull();
      expect(never).not.toHaveBeenCalled();
      await expect(new GithubAdapter(config, http(jest.fn().mockResolvedValue(json({}, 400)))).repository('t', 7, 'k')).rejects.toThrow(/400/);
    });
  });
});

describe('DiscordAdapter step 2.4: notify, chatReply, afterConnect', () => {
  const config = cfg({ DISCORD_CLIENT_ID: '111111111111111111', DISCORD_CLIENT_SECRET: 'sec', DISCORD_BOT_TOKEN: 'bot' });
  const msg: RichMessage = { title: 'ENG-1 Fix', url: 'https://app.test/tasks/ENG-1', summary: 'Status: To Do \u2192 Done', fields: [{ label: 'Project', value: 'Web' }], actor: 'Ann', tone: 'success' };
  const ctx = (over: Record<string, unknown> = {}) => ({ accessToken: 'unused', connection: { id: 'c1', externalAccountId: 'g1' }, channel: { kind: 'CHANNEL' as const, externalId: '333333333333333333' }, message: msg, rateKey: 'connection:c1', ...over });

  it('notify posts one embed with the bot token, no mentions', async () => {
    const f = jest.fn().mockResolvedValue(json({ id: 'm' }));
    await new DiscordAdapter(config, http(f)).notify(ctx());
    const [c] = calls(f);
    expect(c.url).toBe('https://discord.com/api/v10/channels/333333333333333333/messages');
    expect((c.init.headers as Record<string, string>).authorization).toBe('Bot bot');
    const body = JSON.parse(String(c.init.body));
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(body.embeds[0]).toMatchObject({ title: 'ENG-1 Fix', url: 'https://app.test/tasks/ENG-1', description: msg.summary, color: 0x57f287, footer: { text: 'Ann' } });
  });

  it.each([400, 401, 403, 404])('HTTP %s -> NotifyPermanentError (retrying cannot help)', async (status) => {
    const f = jest.fn().mockResolvedValue(json({ message: 'x' }, status));
    await expect(new DiscordAdapter(config, http(f)).notify(ctx())).rejects.toMatchObject({ name: 'NotifyPermanentError', code: `discord_${status}` });
  });

  it('5xx is a plain (transient) error', async () => {
    const f = jest.fn().mockResolvedValue(json({}, 502));
    const e = await new DiscordAdapter(config, http(f)).notify(ctx()).catch((x) => x);
    expect(e).toBeInstanceOf(Error); expect(e).not.toBeInstanceOf(NotifyPermanentError);
  });

  it('refuses a non-snowflake channel and a missing bot token without calling Discord', async () => {
    const f = jest.fn();
    await expect(new DiscordAdapter(config, http(f)).notify(ctx({ channel: { kind: 'CHANNEL', externalId: '../x' } }))).rejects.toMatchObject({ code: 'invalid_channel' });
    await expect(new DiscordAdapter(config, http(f)).notify(ctx({ channel: { kind: 'GUILD', externalId: '333333333333333333' } }))).rejects.toMatchObject({ code: 'invalid_channel' });
    await expect(new DiscordAdapter(cfg({ DISCORD_CLIENT_ID: '1' }), http(f)).notify(ctx())).rejects.toMatchObject({ code: 'bot_not_configured' });
    expect(f).not.toHaveBeenCalled();
  });

  it('honours X-RateLimit-Remaining: 0 by waiting for the reset before the next post to that channel', async () => {
    const f = jest.fn().mockImplementation(async () => new Response('{}', { status: 200, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '0.15' } }));
    const a = new DiscordAdapter(config, http(f));
    await a.notify(ctx());
    const t0 = Date.now();
    await a.notify(ctx());
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100);
    // another channel is not delayed
    const t1 = Date.now();
    await a.notify(ctx({ channel: { kind: 'CHANNEL', externalId: '444444444444444444' } }));
    expect(Date.now() - t1).toBeLessThan(80);
  });

  it('a long rate window is transient (the queue retries later), not a block', async () => {
    const f = jest.fn().mockImplementation(async () => new Response('{}', { status: 200, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '30' } }));
    const a = new DiscordAdapter(config, http(f));
    await a.notify(ctx());
    await expect(a.notify(ctx())).rejects.toThrow(/rate window/);
  });

  it('toEmbed respects Discord limits and never emits an empty field value', () => {
    const e = toEmbed({ title: 't'.repeat(999), summary: 's'.repeat(9999), tone: 'danger', fields: Array.from({ length: 40 }, () => ({ label: 'l'.repeat(999), value: '' })) }) as { title: string; description: string; fields: Array<{ name: string; value: string }> };
    expect(e.title).toHaveLength(256); expect(e.description).toHaveLength(4096); expect(e.fields).toHaveLength(25);
    expect(e.fields[0].name).toHaveLength(256); expect(e.fields[0].value).not.toBe('');
  });

  it('chatReply PATCHes @original with the rendered result (no auth header: the token is the credential); non-2xx throws so the job retries', async () => {
    const f = jest.fn().mockResolvedValue(json({}));
    await new DiscordAdapter(config, http(f)).chatReply({ applicationId: '111111111111111111', interactionToken: 'tok/en' }, { visibility: 'public', text: 'hi' });
    const [c] = calls(f);
    expect(c.url).toBe('https://discord.com/api/v10/webhooks/111111111111111111/tok%2Fen/messages/@original');
    expect(c.init.method).toBe('PATCH');
    expect(JSON.parse(String(c.init.body))).toMatchObject({ content: 'hi', allowed_mentions: { parse: [] } });
    const bad = jest.fn().mockResolvedValue(json({}, 404));
    await expect(new DiscordAdapter(config, http(bad)).chatReply({ applicationId: '111111111111111111', interactionToken: 't' }, { visibility: 'public', text: 'x' })).rejects.toThrow(/404/);
    await expect(new DiscordAdapter(config, http(jest.fn())).chatReply({ applicationId: 'x/../y', interactionToken: 't' }, { visibility: 'public', text: 'x' })).rejects.toThrow(/application id/);
  });

  it('afterConnect registers the guild commands (PUT, bot token); without a bot token it silently skips', async () => {
    const f = jest.fn().mockResolvedValue(json([]));
    await new DiscordAdapter(config, http(f)).afterConnect({ id: '222222222222222222', name: 'G' });
    const [c] = calls(f);
    expect(c).toMatchObject({ url: 'https://discord.com/api/v10/applications/111111111111111111/guilds/222222222222222222/commands' });
    expect(c.init.method).toBe('PUT');
    const body = JSON.parse(String(c.init.body));
    expect(body.map((x: { name: string }) => x.name)).toEqual(['task', 'Create task from message']);
    expect(body[0].options.map((o: { name: string }) => o.name)).toEqual(['create', 'update', 'assign', 'list', 'link']);
    const g = jest.fn();
    await new DiscordAdapter(cfg({ DISCORD_CLIENT_ID: '1' }), http(g)).afterConnect({ id: '2', name: 'G' });
    expect(g).not.toHaveBeenCalled();
    await expect(new DiscordAdapter(config, http(jest.fn().mockResolvedValue(json({}, 403)))).afterConnect({ id: '2', name: 'G' })).rejects.toThrow(/403/);
  });
});

describe('SlackAdapter step 2.5: notify, chatReply, openView, isWorkspaceAdmin, unfurl', () => {
  const config = cfg({ SLACK_CLIENT_ID: 'cid', SLACK_CLIENT_SECRET: 'sec' });
  const msg: RichMessage = { title: 'ENG-1 Fix', url: 'https://app.test/tasks/ENG-1', summary: 'Status: To Do \u2192 Done', fields: [{ label: 'Project', value: 'Web' }], actor: 'Ann', tone: 'success' };
  const ctx = (over: Record<string, unknown> = {}) => ({ accessToken: 'xoxb-tok', connection: { id: 'c1', externalAccountId: 'T0TEAM01' }, channel: { kind: 'CHANNEL' as const, externalId: 'C0CHAN001' }, message: msg, rateKey: 'connection:c1', ...over });
  const RESP = 'https://hooks.slack.com/commands/T0TEAM01/397/abcDEF';

  it('notify posts chat.postMessage with the bearer token, a colour attachment and nothing unfurled', async () => {
    const f = jest.fn().mockResolvedValue(json({ ok: true }));
    await new SlackAdapter(config, http(f)).notify(ctx());
    const [c] = calls(f);
    expect(c.url).toBe('https://slack.com/api/chat.postMessage');
    expect((c.init.headers as Record<string, string>).authorization).toBe('Bearer xoxb-tok');
    const body = JSON.parse(String(c.init.body));
    expect(body).toMatchObject({ channel: 'C0CHAN001', unfurl_links: false });
    expect(body.attachments[0].color).toBe('#2EB67D');
  });

  it.each(['channel_not_found', 'not_in_channel', 'is_archived', 'token_revoked', 'invalid_auth', 'missing_scope', 'account_inactive'])('ok:false %s -> NotifyPermanentError', async (error) => {
    const f = jest.fn().mockResolvedValue(json({ ok: false, error }));
    await expect(new SlackAdapter(config, http(f)).notify(ctx())).rejects.toMatchObject({ name: 'NotifyPermanentError', code: `slack_${error}` });
  });

  it('other ok:false and HTTP 5xx are transient; a bad channel id never reaches Slack', async () => {
    for (const f of [jest.fn().mockResolvedValue(json({ ok: false, error: 'internal_error' })), jest.fn().mockResolvedValue(json({}, 503))]) {
      const e = await new SlackAdapter(config, http(f)).notify(ctx()).catch((x) => x);
      expect(e).toBeInstanceOf(Error); expect(e).not.toBeInstanceOf(NotifyPermanentError);
    }
    const g = jest.fn();
    await expect(new SlackAdapter(config, http(g)).notify(ctx({ channel: { kind: 'CHANNEL', externalId: 'DM../x' } }))).rejects.toMatchObject({ code: 'invalid_channel' });
    await expect(new SlackAdapter(config, http(g)).notify(ctx({ channel: { kind: 'GUILD', externalId: 'C0CHAN001' } }))).rejects.toMatchObject({ code: 'invalid_channel' });
    expect(g).not.toHaveBeenCalled();
  });

  it('chatReply via response_url: POSTs the rendered result with the right response_type, never replaces the original', async () => {
    const f = jest.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    await new SlackAdapter(config, http(f)).chatReply({ applicationId: 'T0TEAM01', interactionToken: RESP }, { visibility: 'public', text: '**K-1** created' });
    const [c] = calls(f);
    expect(c.url).toBe(RESP);
    expect(JSON.parse(String(c.init.body))).toMatchObject({ response_type: 'in_channel', replace_original: false });
    expect((c.init.headers as Record<string, string>).authorization).toBeUndefined();
    await new SlackAdapter(config, http(f)).chatReply({ applicationId: 'T0TEAM01', interactionToken: RESP }, { visibility: 'private', text: 'x' });
    expect(JSON.parse(String(calls(f)[1].init.body)).response_type).toBe('ephemeral');
  });

  it('chatReply REFUSES a response_url that is not Slack\u2019s (SSRF) and throws on a non-2xx', async () => {
    const f = jest.fn();
    for (const bad of ['https://evil.test/x', 'http://hooks.slack.com/commands/T/1/a', 'https://169.254.169.254/latest', '']) {
      await expect(new SlackAdapter(config, http(f)).chatReply({ applicationId: 'T0TEAM01', interactionToken: bad }, { visibility: 'private', text: 'x' })).rejects.toThrow(/response_url/);
    }
    expect(f).not.toHaveBeenCalled();
    await expect(new SlackAdapter(config, http(jest.fn().mockResolvedValue(json({}, 404)))).chatReply({ applicationId: 'T', interactionToken: RESP }, { visibility: 'private', text: 'x' })).rejects.toThrow(/404/);
  });

  it('chatReply without a response_url posts: public -> chat.postMessage in the thread, private -> chat.postEphemeral to the user; needs the token', async () => {
    const f = jest.fn().mockResolvedValue(json({ ok: true }));
    const a = new SlackAdapter(config, http(f));
    const target = { applicationId: 'T0TEAM01', interactionToken: '', reply: { channelId: 'C0CHAN001', threadTs: '1700000000.000100', userId: 'U0ALEX01' }, accessToken: 'xoxb-tok' };
    await a.chatReply(target, { visibility: 'public', text: 'created' });
    await a.chatReply(target, { visibility: 'private', text: 'only you' });
    const [pub, priv] = calls(f);
    expect(pub.url).toBe('https://slack.com/api/chat.postMessage');
    expect(JSON.parse(String(pub.init.body))).toMatchObject({ channel: 'C0CHAN001', thread_ts: '1700000000.000100' });
    expect(priv.url).toBe('https://slack.com/api/chat.postEphemeral');
    expect(JSON.parse(String(priv.init.body))).toMatchObject({ channel: 'C0CHAN001', user: 'U0ALEX01' });
    await expect(a.chatReply({ ...target, accessToken: undefined }, { visibility: 'public', text: 'x' })).rejects.toThrow(/token/);
    await expect(new SlackAdapter(config, http(jest.fn().mockResolvedValue(json({ ok: false, error: 'channel_not_found' })))).chatReply(target, { visibility: 'public', text: 'x' })).rejects.toThrow(/channel_not_found/);
  });

  it('openView passes the trigger id and view, and surfaces expired_trigger_id; isWorkspaceAdmin reads is_admin/is_owner and is false on any failure; unfurl sends the map', async () => {
    const ok = jest.fn().mockResolvedValue(json({ ok: true }));
    await new SlackAdapter(config, http(ok)).openView('tok', 'trig.1', { type: 'modal' }, 'rk');
    expect(JSON.parse(String(calls(ok)[0].init.body))).toEqual({ trigger_id: 'trig.1', view: { type: 'modal' } });
    await expect(new SlackAdapter(config, http(jest.fn().mockResolvedValue(json({ ok: false, error: 'expired_trigger_id' })))).openView('tok', 't', {}, 'rk')).rejects.toThrow(/expired_trigger_id/);

    const admin = (u: Record<string, boolean>) => new SlackAdapter(config, http(jest.fn().mockResolvedValue(json({ ok: true, user: u })))).isWorkspaceAdmin('tok', 'U1', 'rk');
    expect(await admin({ is_admin: true })).toBe(true);
    expect(await admin({ is_owner: true })).toBe(true);
    expect(await admin({ is_primary_owner: true })).toBe(true);
    expect(await admin({})).toBe(false);
    expect(await new SlackAdapter(config, http(jest.fn().mockResolvedValue(json({ ok: false, error: 'user_not_found' })))).isWorkspaceAdmin('tok', 'U1', 'rk')).toBe(false);
    expect(await new SlackAdapter(config, http(jest.fn().mockRejectedValue(new Error('network')))).isWorkspaceAdmin('tok', 'U1', 'rk')).toBe(false);

    const u = jest.fn().mockResolvedValue(json({ ok: true }));
    await new SlackAdapter(config, http(u)).unfurl('tok', { channel: 'C0CHAN001', ts: '1.1', unfurls: { 'https://app.test/tasks/K-1': { blocks: [] } } }, 'rk');
    expect(JSON.parse(String(calls(u)[0].init.body))).toMatchObject({ channel: 'C0CHAN001', unfurls: { 'https://app.test/tasks/K-1': { blocks: [] } } });
    await expect(new SlackAdapter(config, http(jest.fn().mockResolvedValue(json({ ok: false, error: 'cannot_unfurl_url' })))).unfurl('tok', { channel: 'C', ts: '1', unfurls: {} }, 'rk')).rejects.toThrow(/cannot_unfurl_url/);
  });
});
