/**
 * Step 2.1 - integration core against a real DB: OAuth state, callback, credentials, refresh locking,
 * soft revoke, plan limit, and "no secret ever leaves". Uses a FakeAdapter so no network is involved;
 * the real adapters are unit-tested in src/integrations/providers.
 */
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { IntegrationConnectionStatus, IntegrationProvider, Role } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { PermissionResolver } from '../../src/access-control/access-control.service';
import { PlanLimitsService } from '../../src/access-control/plan-limits.service';
import { TokenVaultService } from '../../src/crypto/token-vault.service';
import { AuditLogService } from '../../src/events/audit-log.service';
import { ConnectorRegistry } from '../../src/integrations/core/connector.registry';
import {
  ConnectionNeedsReauthError,
  CredentialService,
} from '../../src/integrations/core/credential.service';
import {
  AuthorizeContext,
  CallbackParams,
  ConnectorAdapter,
  ExchangeContext,
  INTEGRATION_ADAPTERS,
  ProviderAuthRejectedError,
  TokenSet,
} from '../../src/integrations/core/integration.types';
import { IntegrationsService } from '../../src/integrations/core/integrations.service';
import { OAuthService } from '../../src/integrations/core/oauth.service';
import { OAuthStateService } from '../../src/integrations/core/oauth-state.service';
import { OAuthStateSweepJob } from '../../src/integrations/core/oauth-state-sweep.job';
import { RedisLockService } from '../../src/integrations/core/redis-lock.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { RedisService } from '../../src/redis/redis.service';
import { JobHandlerRegistry } from '../../src/queue/job-handler.registry';
import { createUserWithAccount, createWorkspace, createUser, addAccountMember } from './factories';
import { disconnectTestPrisma, getTestPrisma } from './support/prisma-test-client';
import { resetDb } from './support/reset-db';

class FakeAdapter implements ConnectorAdapter {
  readonly provider = IntegrationProvider.DISCORD;
  readonly capabilities = new Set<never>();
  readonly usesPkce = true;
  configured = true;
  refreshCalls = 0;
  refreshImpl: (t: TokenSet) => Promise<TokenSet> = async (t) => ({
    ...t, accessToken: `at-refreshed-${this.refreshCalls}`, expiresAt: new Date(Date.now() + 3600_000),
  });
  revoked: string[] = [];
  seen: { challenge?: string; verifier?: string } = {};
  expiresInMs = 3600_000;

  isConfigured() { return this.configured; }
  authorizeUrl(ctx: AuthorizeContext) {
    this.seen.challenge = ctx.pkceChallenge;
    return `https://fake.test/auth?state=${ctx.state}&cc=${ctx.pkceChallenge}`;
  }
  async exchangeCode(p: CallbackParams, ctx: ExchangeContext) {
    this.seen.verifier = ctx.pkceVerifier;
    if (p.code === 'bad') throw new Error('provider said no');
    return {
      tokens: {
        accessToken: 'SECRET-ACCESS-TOKEN', refreshToken: 'SECRET-REFRESH-TOKEN',
        scopes: ['bot'], expiresAt: new Date(Date.now() + this.expiresInMs),
      },
      account: { id: p.acct ?? 'guild-1', name: 'Guild One' },
    };
  }
  async refresh(t: TokenSet) { this.refreshCalls++; await new Promise((r) => setTimeout(r, 60)); return this.refreshImpl(t); }
  async revoke(t: TokenSet) { this.revoked.push(t.accessToken); }
}

const KEY = randomBytes(32).toString('base64');
const config = { get: (k: string) => ({ FRONTEND_URL: 'http://fe.test', API_PUBLIC_URL: 'http://api.test' } as Record<string, string>)[k] };

describe('integration core (step 2.1)', () => {
  let prisma: PrismaService;
  let adapter: FakeAdapter;
  let oauth: OAuthService;
  let creds: CredentialService;
  let integrations: IntegrationsService;
  let sweep: OAuthStateSweepJob;
  let vault: TokenVaultService;
  let locks: RedisLockService;

  beforeAll(async () => {
    prisma = getTestPrisma();
    vault = new TokenVaultService({ TOKEN_VAULT_KEYS: `k1:${KEY}`, TOKEN_VAULT_CURRENT_KID: 'k1' } as never);
    const noRedis = { configured: false, isReady: () => false } as unknown as RedisService;
    adapter = new FakeAdapter();
    const moduleRef = await Test.createTestingModule({
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: new EventEmitter2() },
        { provide: TokenVaultService, useValue: vault },
        { provide: RedisService, useValue: noRedis },
        { provide: ConfigService, useValue: config },
        { provide: INTEGRATION_ADAPTERS, useValue: [adapter] },
        { provide: JobHandlerRegistry, useValue: { register: () => undefined, registerSchedule: () => undefined } },
        AuditLogService, PermissionResolver, PlanLimitsService, ConnectorRegistry, RedisLockService,
        CredentialService, OAuthStateService, OAuthService, IntegrationsService, OAuthStateSweepJob,
      ],
    }).compile();
    await moduleRef.init(); // runs IntegrationsService.onModuleInit -> registers the plan counter
    oauth = moduleRef.get(OAuthService);
    creds = moduleRef.get(CredentialService);
    integrations = moduleRef.get(IntegrationsService);
    sweep = moduleRef.get(OAuthStateSweepJob);
    locks = moduleRef.get(RedisLockService);
  });
  beforeEach(async () => {
    await resetDb(prisma);
    adapter.configured = true; adapter.refreshCalls = 0; adapter.revoked = []; adapter.expiresInMs = 3600_000;
  });
  afterAll(() => disconnectTestPrisma());

  const stateOf = (url: string) => new URL(url).searchParams.get('state')!;
  const dest = (url: string) => new URL(url).searchParams;

  async function connect(userId: string, accountId: string, acct = 'guild-1') {
    const { authUrl } = await oauth.start(IntegrationProvider.DISCORD, accountId, userId);
    const redirect = await oauth.handleCallback(IntegrationProvider.DISCORD, { state: stateOf(authUrl), code: 'ok', acct });
    return { authUrl, redirect };
  }
  const proAccount = async () => {
    const w = await createUserWithAccount(prisma, { role: Role.OWNER });
    await prisma.account.update({ where: { id: w.account.id }, data: { planType: 'ENTERPRISE_ORG' as never } });
    return w;
  };

  describe('connect + callback', () => {
    it('happy path: connection ACTIVE, credential stored ENCRYPTED, audit row, redirect connected', async () => {
      const { user, account } = await createUserWithAccount(prisma, { role: Role.OWNER });
      const { redirect } = await connect(user.id, account.id);
      expect(dest(redirect).get('connected')).toBe('discord');
      expect(redirect.startsWith('http://fe.test/settings/integrations?')).toBe(true);

      const conn = await prisma.integrationConnection.findFirstOrThrow({ where: { accountId: account.id } });
      expect(conn).toMatchObject({ status: 'ACTIVE', externalAccountId: 'guild-1', externalAccountName: 'Guild One', createdById: user.id });
      const row = await prisma.integrationCredential.findUniqueOrThrow({ where: { connectionId: conn.id } });
      expect(row.ciphertext.startsWith('v1:k1:')).toBe(true);
      expect(row.ciphertext).not.toContain('SECRET');
      expect(row.kid).toBe('k1');
      expect(await creds.getAccessToken(conn.id)).toBe('SECRET-ACCESS-TOKEN');
      expect(await prisma.auditLog.count({ where: { action: 'INTEGRATION_CONNECTED', accountId: account.id } })).toBe(1);
    });

    it('PKCE: the verifier reaches the adapter, its SHA-256 is the challenge, and it is stored encrypted', async () => {
      const { user, account } = await createUserWithAccount(prisma, { role: Role.OWNER });
      const { authUrl } = await oauth.start(IntegrationProvider.DISCORD, account.id, user.id);
      const st = await prisma.oAuthState.findUniqueOrThrow({ where: { nonce: stateOf(authUrl) } });
      expect(st.pkceVerifier!.startsWith('v1:k1:')).toBe(true);
      await oauth.handleCallback(IntegrationProvider.DISCORD, { state: stateOf(authUrl), code: 'ok' });
      expect(createHash('sha256').update(adapter.seen.verifier!).digest('base64url')).toBe(adapter.seen.challenge);
    });

    it('replay: the same state works once; the second and a concurrent duplicate fail', async () => {
      const { user, account } = await createUserWithAccount(prisma, { role: Role.OWNER });
      const { authUrl } = await oauth.start(IntegrationProvider.DISCORD, account.id, user.id);
      const q = { state: stateOf(authUrl), code: 'ok' };
      const [a, b] = await Promise.all([
        oauth.handleCallback(IntegrationProvider.DISCORD, q),
        oauth.handleCallback(IntegrationProvider.DISCORD, q),
      ]);
      const outcomes = [dest(a).get('connected') ?? dest(a).get('error'), dest(b).get('connected') ?? dest(b).get('error')].sort();
      expect(outcomes).toEqual(['discord', 'invalid_state']);
      expect(dest(await oauth.handleCallback(IntegrationProvider.DISCORD, q)).get('error')).toBe('invalid_state');
      expect(await prisma.integrationConnection.count()).toBe(1);
    });

    it('expired state, unknown state, missing state, wrong provider: all invalid_state, nothing created', async () => {
      const { user, account } = await createUserWithAccount(prisma, { role: Role.OWNER });
      const { authUrl } = await oauth.start(IntegrationProvider.DISCORD, account.id, user.id);
      const s = stateOf(authUrl);
      await prisma.oAuthState.update({ where: { nonce: s }, data: { expiresAt: new Date(Date.now() - 1000) } });
      for (const q of [{ state: s, code: 'ok' }, { state: 'nope', code: 'ok' }, { code: 'ok' }]) {
        expect(dest(await oauth.handleCallback(IntegrationProvider.DISCORD, q as never)).get('error')).toBe('invalid_state');
      }
      const { authUrl: u2 } = await oauth.start(IntegrationProvider.DISCORD, account.id, user.id);
      expect(dest(await oauth.handleCallback(IntegrationProvider.SLACK, { state: stateOf(u2), code: 'ok' })).get('error')).toBe('invalid_state');
      expect(await prisma.integrationConnection.count()).toBe(0);
    });

    it('provider denial and provider failure redirect with an error code and create nothing', async () => {
      const { user, account } = await createUserWithAccount(prisma, { role: Role.OWNER });
      const a = await oauth.start(IntegrationProvider.DISCORD, account.id, user.id);
      expect(dest(await oauth.handleCallback(IntegrationProvider.DISCORD, { state: stateOf(a.authUrl), error: 'access_denied' })).get('error')).toBe('denied');
      const b = await oauth.start(IntegrationProvider.DISCORD, account.id, user.id);
      expect(dest(await oauth.handleCallback(IntegrationProvider.DISCORD, { state: stateOf(b.authUrl), code: 'bad' })).get('error')).toBe('provider_error');
      expect(await prisma.integrationConnection.count()).toBe(0);
    });

    it('permission is re-checked at callback: demoted between start and callback -> forbidden, nothing created', async () => {
      const { user, account, membership } = await createUserWithAccount(prisma, { role: Role.OWNER });
      const { authUrl } = await oauth.start(IntegrationProvider.DISCORD, account.id, user.id);
      await prisma.accountMember.update({ where: { id: membership.id }, data: { role: Role.MEMBER } });
      const r = await oauth.handleCallback(IntegrationProvider.DISCORD, { state: stateOf(authUrl), code: 'ok' });
      expect(dest(r).get('error')).toBe('forbidden');
      expect(await prisma.integrationConnection.count()).toBe(0);
    });

    it('unconfigured provider: start answers 503 and writes no state', async () => {
      const { user, account } = await createUserWithAccount(prisma, { role: Role.OWNER });
      adapter.configured = false;
      await expect(oauth.start(IntegrationProvider.DISCORD, account.id, user.id)).rejects.toMatchObject({ status: 503 });
      expect(await prisma.oAuthState.count()).toBe(0);
    });
  });

  describe('one live connection per provider tenant (step 2.4, DB-enforced)', () => {
    it('a second account connecting a guild that is live elsewhere is told already_connected and nothing is created; after a disconnect it can', async () => {
      const a = await proAccount(); const b = await proAccount();
      await connect(a.user.id, a.account.id, 'shared-guild');
      const r = await connect(b.user.id, b.account.id, 'shared-guild');
      expect(dest(r.redirect).get('error')).toBe('already_connected');
      expect(await prisma.integrationConnection.count({ where: { accountId: b.account.id } })).toBe(0);
      expect(await prisma.integrationCredential.count()).toBe(1);
      await integrations.revoke((await prisma.integrationConnection.findFirstOrThrow({ where: { accountId: a.account.id } })).id, a.user.id);
      expect(dest((await connect(b.user.id, b.account.id, 'shared-guild')).redirect).get('connected')).toBe('discord');
    });
  });

  describe('plan limit', () => {
    it('FREE tier (1 integration): at the cap, a provider with no live connection is refused at start (402)', async () => {
      const { user, account } = await createUserWithAccount(prisma, { role: Role.OWNER });
      await prisma.integrationConnection.create({ data: { accountId: account.id, provider: 'SLACK', externalAccountId: 'T1', externalAccountName: 't', createdById: user.id } });
      await expect(oauth.start(IntegrationProvider.DISCORD, account.id, user.id)).rejects.toMatchObject({ status: 402 });
      expect(await prisma.oAuthState.count()).toBe(0);
    });

    it('at the cap, same provider may start (could be a repair) but a DIFFERENT guild is refused at the callback', async () => {
      const { user, account } = await createUserWithAccount(prisma, { role: Role.OWNER });
      await connect(user.id, account.id, 'g1');
      const { authUrl } = await oauth.start(IntegrationProvider.DISCORD, account.id, user.id); // allowed
      expect(dest(await oauth.handleCallback(IntegrationProvider.DISCORD, { state: stateOf(authUrl), code: 'ok', acct: 'g2' })).get('error')).toBe('plan_limit');
      expect(await prisma.integrationConnection.count()).toBe(1);
    });

    it('raced: state created while there was room, slot taken before the callback -> plan_limit', async () => {
      const { user, account } = await createUserWithAccount(prisma, { role: Role.OWNER });
      const { authUrl } = await oauth.start(IntegrationProvider.DISCORD, account.id, user.id);
      await prisma.integrationConnection.create({ data: { accountId: account.id, provider: 'SLACK', externalAccountId: 'T1', externalAccountName: 't', createdById: user.id } });
      expect(dest(await oauth.handleCallback(IntegrationProvider.DISCORD, { state: stateOf(authUrl), code: 'ok' })).get('error')).toBe('plan_limit');
    });

    it('REVOKED connections do not occupy a slot', async () => {
      const { user, account } = await createUserWithAccount(prisma, { role: Role.OWNER });
      await connect(user.id, account.id, 'g1');
      const c = await prisma.integrationConnection.findFirstOrThrow();
      await integrations.revoke(c.id, user.id);
      await expect(connect(user.id, account.id, 'g2')).resolves.toBeDefined();
    });
  });

  describe('refresh', () => {
    async function expiredConnection() {
      const w = await proAccount();
      adapter.expiresInMs = 5_000; // inside the 60 s skew -> already "needs refresh"
      await connect(w.user.id, w.account.id);
      return { ...w, conn: await prisma.integrationConnection.findFirstOrThrow() };
    }

    it('5 concurrent callers -> exactly ONE provider refresh; all get the new token', async () => {
      const { conn } = await expiredConnection();
      const tokens = await Promise.all([1, 2, 3, 4, 5].map(() => creds.getAccessToken(conn.id)));
      expect(adapter.refreshCalls).toBe(1);
      expect(new Set(tokens)).toEqual(new Set(['at-refreshed-1']));
      // the refresh token was kept although the provider did not return a new one
      expect((await creds.load(conn.id))!.refreshToken).toBe('SECRET-REFRESH-TOKEN');
    });

    it('two SERVICE INSTANCES (two processes) sharing real Redis also refresh once', async () => {
      const url = process.env.TEST_REDIS_URL;
      if (!url) return; // sandbox always provides it; skip only where Redis genuinely is absent
      const { conn } = await expiredConnection();
      const mk = async () => { const r = new RedisService(url); r.onModuleInit(); await new Promise((res) => setTimeout(res, 150)); return r; };
      const [r1, r2] = [await mk(), await mk()];
      try {
        const mkCreds = (r: RedisService) => new CredentialService(prisma, vault, new ConnectorRegistry([adapter]), new RedisLockService(r), new AuditLogService(prisma, new EventEmitter2()));
        const [c1, c2] = [mkCreds(r1), mkCreds(r2)];
        const out = await Promise.all([c1.getAccessToken(conn.id), c2.getAccessToken(conn.id), c1.getAccessToken(conn.id), c2.getAccessToken(conn.id)]);
        expect(adapter.refreshCalls).toBe(1);
        expect(new Set(out).size).toBe(1);
      } finally {
        await r1.onModuleDestroy(); await r2.onModuleDestroy();
      }
    });

    it('dead grant -> NEEDS_REAUTH, one audit row (not one per caller), ConnectionNeedsReauthError', async () => {
      const { conn, account } = await expiredConnection();
      adapter.refreshImpl = async () => { throw new ProviderAuthRejectedError('invalid_grant'); };
      const results = await Promise.allSettled([creds.getAccessToken(conn.id), creds.getAccessToken(conn.id), creds.getAccessToken(conn.id)]);
      for (const r of results) expect((r as PromiseRejectedResult).reason).toBeInstanceOf(ConnectionNeedsReauthError);
      const after = await prisma.integrationConnection.findUniqueOrThrow({ where: { id: conn.id } });
      expect(after.status).toBe('NEEDS_REAUTH');
      expect(after.lastError).toContain('invalid_grant');
      expect(await prisma.auditLog.count({ where: { action: 'INTEGRATION_NEEDS_REAUTH', accountId: account.id } })).toBe(1);
    });

    it('transient failure (network) leaves the connection ACTIVE and the caller sees the error', async () => {
      const { conn } = await expiredConnection();
      adapter.refreshImpl = async () => { throw new Error('ECONNRESET'); };
      await expect(creds.getAccessToken(conn.id)).rejects.toThrow('ECONNRESET');
      expect((await prisma.integrationConnection.findUniqueOrThrow({ where: { id: conn.id } })).status).toBe('ACTIVE');
      expect(await prisma.auditLog.count({ where: { action: 'INTEGRATION_NEEDS_REAUTH' } })).toBe(0);
    });

    it('a still-valid token is returned without any provider call', async () => {
      const w = await proAccount();
      await connect(w.user.id, w.account.id);
      const conn = await prisma.integrationConnection.findFirstOrThrow();
      expect(await creds.getAccessToken(conn.id)).toBe('SECRET-ACCESS-TOKEN');
      expect(adapter.refreshCalls).toBe(0);
    });

    it('no credential (revoked) -> ConnectionNeedsReauthError', async () => {
      const w = await proAccount();
      await connect(w.user.id, w.account.id);
      const conn = await prisma.integrationConnection.findFirstOrThrow();
      await integrations.revoke(conn.id, w.user.id);
      await expect(creds.getAccessToken(conn.id)).rejects.toBeInstanceOf(ConnectionNeedsReauthError);
    });
  });

  describe('revoke (soft, ADR-0009 d.3)', () => {
    it('deletes tokens, keeps the row REVOKED, pauses channel links, audits, calls the provider; idempotent', async () => {
      const { user, account } = await createUserWithAccount(prisma, { role: Role.OWNER });
      await connect(user.id, account.id);
      const conn = await prisma.integrationConnection.findFirstOrThrow();
      const ws = await createWorkspace(prisma, { accountId: account.id });
      const link = await prisma.channelLink.create({ data: { connectionId: conn.id, kind: 'GUILD', externalId: 'guild-1', workspaceId: ws.id, configuredById: user.id } });

      const out = await integrations.revoke(conn.id, user.id);
      expect(out.status).toBe('REVOKED');
      expect(adapter.revoked).toEqual(['SECRET-ACCESS-TOKEN']);
      expect(await prisma.integrationCredential.count()).toBe(0);
      expect((await prisma.channelLink.findUniqueOrThrow({ where: { id: link.id } })).pausedAt).not.toBeNull();
      expect(await prisma.auditLog.count({ where: { action: 'INTEGRATION_DISCONNECTED' } })).toBe(1);

      await integrations.revoke(conn.id, user.id); // again: no second audit row, no second provider call
      expect(await prisma.auditLog.count({ where: { action: 'INTEGRATION_DISCONNECTED' } })).toBe(1);
      expect(adapter.revoked).toHaveLength(1);
    });

    it('a provider-side failure does not block the local revoke', async () => {
      const { user, account } = await createUserWithAccount(prisma, { role: Role.OWNER });
      await connect(user.id, account.id);
      const conn = await prisma.integrationConnection.findFirstOrThrow();
      adapter.revoke = async () => { throw new Error('provider down'); };
      expect((await integrations.revoke(conn.id, user.id)).status).toBe('REVOKED');
      expect(await prisma.integrationCredential.count()).toBe(0);
      adapter.revoke = FakeAdapter.prototype.revoke.bind(adapter);
    });

    it('reconnecting the same guild REVIVES the row (same id), restores ACTIVE and un-pauses links', async () => {
      const { user, account } = await createUserWithAccount(prisma, { role: Role.OWNER });
      await connect(user.id, account.id);
      const conn = await prisma.integrationConnection.findFirstOrThrow();
      const ws = await createWorkspace(prisma, { accountId: account.id });
      const link = await prisma.channelLink.create({ data: { connectionId: conn.id, kind: 'GUILD', externalId: 'guild-1', workspaceId: ws.id, configuredById: user.id } });
      await integrations.revoke(conn.id, user.id);

      await connect(user.id, account.id);
      const rows = await prisma.integrationConnection.findMany();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: conn.id, status: 'ACTIVE', lastError: null });
      expect((await prisma.channelLink.findUniqueOrThrow({ where: { id: link.id } })).pausedAt).toBeNull();
      expect(await prisma.integrationCredential.count()).toBe(1);
    });

    it('NEEDS_REAUTH is fixed by simply reconnecting (no slot consumed)', async () => {
      const { user, account } = await createUserWithAccount(prisma, { role: Role.OWNER });
      await connect(user.id, account.id);
      const conn = await prisma.integrationConnection.findFirstOrThrow();
      await creds.markNeedsReauth(conn.id, 'x');
      await connect(user.id, account.id); // FREE tier cap is 1: would 402 if it needed a new slot
      expect((await prisma.integrationConnection.findUniqueOrThrow({ where: { id: conn.id } })).status).toBe('ACTIVE');
    });

    it('a plain MEMBER cannot revoke; an unknown id is 404', async () => {
      const { user, account } = await createUserWithAccount(prisma, { role: Role.OWNER });
      await connect(user.id, account.id);
      const conn = await prisma.integrationConnection.findFirstOrThrow();
      const member = await createUser(prisma);
      await addAccountMember(prisma, { accountId: account.id, userId: member.id, role: Role.MEMBER });
      await expect(integrations.revoke(conn.id, member.id)).rejects.toMatchObject({ status: 403 });
      await expect(integrations.revoke('nope', user.id)).rejects.toMatchObject({ status: 404 });
      expect((await prisma.integrationConnection.findUniqueOrThrow({ where: { id: conn.id } })).status).toBe('ACTIVE');
    });
  });

  describe('no secret ever leaves', () => {
    it('list() output (serialised) contains no token, no ciphertext, no kid, no credential key', async () => {
      const { user, account } = await createUserWithAccount(prisma, { role: Role.OWNER });
      await connect(user.id, account.id);
      const list = await integrations.list(account.id);
      expect(list).toHaveLength(1);
      const text = JSON.stringify(list);
      for (const bad of ['SECRET', 'v1:k1', 'ciphertext', 'kid', 'credential', 'refreshToken', 'pkce']) expect(text).not.toContain(bad);
      expect(Object.keys(list[0]).sort()).toEqual(['createdAt', 'externalAccountId', 'externalAccountName', 'id', 'lastError', 'lastUsedAt', 'provider', 'scopes', 'status'].sort());
    });

    it('revoke() output has the same whitelist', async () => {
      const { user, account } = await createUserWithAccount(prisma, { role: Role.OWNER });
      await connect(user.id, account.id);
      const conn = await prisma.integrationConnection.findFirstOrThrow();
      const out = await integrations.revoke(conn.id, user.id);
      expect(JSON.stringify(out)).not.toMatch(/SECRET|v1:k1|ciphertext|accountId/);
    });

    it('list is scoped to the account asked for', async () => {
      const a = await createUserWithAccount(prisma, { role: Role.OWNER });
      const b = await createUserWithAccount(prisma, { role: Role.OWNER });
      await connect(a.user.id, a.account.id);
      expect(await integrations.list(b.account.id)).toEqual([]);
    });
  });

  describe('maintenance', () => {
    it('sweep deletes states expired more than a day ago and keeps newer ones', async () => {
      const { user, account } = await createUserWithAccount(prisma, { role: Role.OWNER });
      const mk = (nonce: string, ageMs: number) => prisma.oAuthState.create({ data: { provider: 'DISCORD', nonce, userId: user.id, accountId: account.id, expiresAt: new Date(Date.now() - ageMs) } });
      await mk('old', 2 * 86400_000); await mk('recent', 3600_000); await mk('live', -600_000);
      expect((await sweep.sweep()).deleted).toBe(1);
      expect((await prisma.oAuthState.findMany({ select: { nonce: true } })).map((r) => r.nonce).sort()).toEqual(['live', 'recent']);
    });
  });

  describe('locks', () => {
    it('local fallback serialises same-key sections and does not block different keys', async () => {
      const order: string[] = [];
      const a = locks.withLock('k', 1000, async () => { order.push('a1'); await new Promise((r) => setTimeout(r, 40)); order.push('a2'); });
      const b = locks.withLock('k', 1000, async () => { order.push('b1'); });
      const c = locks.withLock('other', 1000, async () => { order.push('c'); });
      await Promise.all([a, b, c]);
      expect(order.indexOf('a2')).toBeLessThan(order.indexOf('b1'));
      expect(order.indexOf('c')).toBeLessThan(order.indexOf('a2'));
    });
  });
});

void IntegrationConnectionStatus;
