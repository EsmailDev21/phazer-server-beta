/**
 * Step 2.2 - identity linking against a real DB. FakeAdapter implements the identity capability; the real
 * Discord/Slack identity calls are unit-tested in src/integrations/providers/adapters.spec.ts.
 */
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { IntegrationProvider, Role } from '@prisma/client';
import { randomBytes } from 'crypto';
import { PermissionResolver } from '../../src/access-control/access-control.service';
import { PlanLimitsService } from '../../src/access-control/plan-limits.service';
import { TokenVaultService } from '../../src/crypto/token-vault.service';
import { AuditLogService } from '../../src/events/audit-log.service';
import { ConnectorRegistry } from '../../src/integrations/core/connector.registry';
import { CredentialService } from '../../src/integrations/core/credential.service';
import { IdentityOAuthService } from '../../src/integrations/core/identity-oauth.service';
import { IdentityService, UnlinkedCallerError } from '../../src/integrations/core/identity.service';
import {
  AuthorizeContext, CallbackParams, ConnectorAdapter, ExternalUser, INTEGRATION_ADAPTERS, TokenSet,
} from '../../src/integrations/core/integration.types';
import { IntegrationsService } from '../../src/integrations/core/integrations.service';
import { LinkPromptBuilder } from '../../src/integrations/core/link-prompt.builder';
import { LinkTokenService } from '../../src/integrations/core/link-token.service';
import { PromptThrottleService } from '../../src/integrations/core/prompt-throttle.service';
import { OAuthStateSweepJob } from '../../src/integrations/core/oauth-state-sweep.job';
import { JobHandlerRegistry } from '../../src/queue/job-handler.registry';
import { OAuthStateService } from '../../src/integrations/core/oauth-state.service';
import { OAuthService } from '../../src/integrations/core/oauth.service';
import { RedisLockService } from '../../src/integrations/core/redis-lock.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { RedisService } from '../../src/redis/redis.service';
import { addAccountMember, createUser, createUserWithAccount } from './factories';
import { disconnectTestPrisma, getTestPrisma } from './support/prisma-test-client';
import { resetDb } from './support/reset-db';

class FakeAdapter implements ConnectorAdapter {
  readonly provider = IntegrationProvider.DISCORD;
  readonly capabilities = new Set<never>();
  readonly usesPkce = false;
  hasLookup = true;
  lookupCalls = 0;
  lookupImpl: (id: string) => Promise<ExternalUser | null> = async () => null;
  exchangeImpl: (p: CallbackParams) => Promise<ExternalUser> = async (p) => ({ id: p.ext ?? 'ext-1', name: 'Ext One' });

  isConfigured() { return true; }
  authorizeUrl(ctx: AuthorizeContext) { return `https://fake.test/connect?state=${ctx.state}`; }
  async exchangeCode() { return { tokens: { accessToken: 'a', scopes: [] } as TokenSet, account: { id: 'g1', name: 'G' } }; }
  async revoke() { /* noop */ }

  get identity() {
    const self = this;
    return {
      authorizeUrl: (ctx: AuthorizeContext) => `https://fake.test/identify?state=${ctx.state}&ru=${encodeURIComponent(ctx.redirectUri)}`,
      exchange: (p: CallbackParams) => self.exchangeImpl(p),
      ...(self.hasLookup ? { lookup: async (_t: string, id: string) => { self.lookupCalls++; return self.lookupImpl(id); } } : {}),
    };
  }
}

const KEY = randomBytes(32).toString('base64');
const config = { get: (k: string) => ({ FRONTEND_URL: 'http://fe.test', API_PUBLIC_URL: 'http://api.test', APP_NAME: 'Tasker' } as Record<string, string>)[k] };

describe('identity linking (step 2.2)', () => {
  let prisma: PrismaService;
  let adapter: FakeAdapter;
  let identities: IdentityService;
  let idOauth: IdentityOAuthService;
  let connectOauth: OAuthService;
  let integrations: IntegrationsService;
  let creds: CredentialService;
  let sweepJob: OAuthStateSweepJob;

  beforeAll(async () => {
    prisma = getTestPrisma();
    adapter = new FakeAdapter();
    const vault = new TokenVaultService({ TOKEN_VAULT_KEYS: `k1:${KEY}`, TOKEN_VAULT_CURRENT_KID: 'k1' } as never);
    const m = await Test.createTestingModule({
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: new EventEmitter2() },
        { provide: TokenVaultService, useValue: vault },
        { provide: RedisService, useValue: { configured: false, isReady: () => false } },
        { provide: ConfigService, useValue: config },
        { provide: INTEGRATION_ADAPTERS, useValue: [adapter] },
        AuditLogService, PermissionResolver, PlanLimitsService, ConnectorRegistry, RedisLockService, CredentialService,
        OAuthStateService, OAuthService, IntegrationsService, LinkPromptBuilder, LinkTokenService, PromptThrottleService, IdentityService, IdentityOAuthService, OAuthStateSweepJob,
        { provide: JobHandlerRegistry, useValue: { register: () => undefined, registerSchedule: () => undefined } },
      ],
    }).compile();
    await m.init();
    identities = m.get(IdentityService); idOauth = m.get(IdentityOAuthService); connectOauth = m.get(OAuthService);
    integrations = m.get(IntegrationsService); creds = m.get(CredentialService); sweepJob = m.get(OAuthStateSweepJob);
  });
  beforeEach(async () => {
    await resetDb(prisma);
    adapter.hasLookup = true; adapter.lookupCalls = 0; adapter.lookupImpl = async () => null;
    adapter.exchangeImpl = async (p) => ({ id: p.ext ?? 'ext-1', name: 'Ext One' });
  });
  afterAll(() => disconnectTestPrisma());

  /** Org account with an OWNER, a MEMBER (verified email) and an ACTIVE connection with a stored token. */
  async function world() {
    const { user: owner, account } = await createUserWithAccount(prisma, { role: Role.OWNER });
    await prisma.account.update({ where: { id: account.id }, data: { planType: 'ENTERPRISE_ORG' as never } });
    const member = await createUser(prisma, { email: 'alice@corp.test' });
    await addAccountMember(prisma, { accountId: account.id, userId: member.id, role: Role.MEMBER });
    const conn = await prisma.integrationConnection.create({
      data: { accountId: account.id, provider: 'DISCORD', externalAccountId: 'g1', externalAccountName: 'Guild', createdById: owner.id },
    });
    await creds.store(conn.id, { accessToken: 'bot-token', scopes: [] });
    return { owner, member, account, conn };
  }
  const stateOf = (url: string) => new URL(url).searchParams.get('state')!;
  const qp = (url: string) => new URL(url).searchParams;
  const confirmed = (email: string, extra: Partial<ExternalUser> = {}): ExternalUser => ({ id: 'ext-1', name: 'E', email, emailConfirmed: true, ...extra });

  describe('resolve: an unlinked caller never executes', () => {
    it('handler guarded by requireLinkedUser: unlinked -> the command body never runs, caller gets an ephemeral link prompt', async () => {
      const { conn } = await world();
      const body = jest.fn();
      const command = async () => { const userId = await identities.requireLinkedUser(conn.id, 'ext-1'); body(userId); };
      const err = await command().catch((e) => e);
      expect(err).toBeInstanceOf(UnlinkedCallerError);
      expect(body).not.toHaveBeenCalled();
      expect((err as UnlinkedCallerError).reason).toBe('NO_LINK');
      const reply = (err as UnlinkedCallerError).reply;
      expect(reply.ephemeral).toBe(true);
      expect(reply.actions).toHaveLength(1);
      expect(reply.actions[0].url).toMatch(new RegExp(`^http://fe\\.test/settings/integrations/link\\?token=[A-Za-z0-9_-]{43}&connectionId=${conn.id}&provider=discord$`));
      expect(JSON.stringify(reply)).not.toMatch(/secret|bot-token|state=/i); // the one-time token is the only credential in it
    });

    it('prompt throttle (step 2.7): the 4th prompt inside the window issues NO token and makes NO provider lookup; a link completed meanwhile still works; others are unaffected', async () => {
      const { conn, owner, member } = await world();
      for (let i = 0; i < 3; i++) expect(await identities.resolve(conn.id, 'ext-spam')).toMatchObject({ linked: false, reason: 'NO_LINK' });
      expect(await prisma.identityLinkToken.count()).toBe(1); // one live token per chat user (replaced, not piled up)
      const lookupsBefore = adapter.lookupCalls;
      const r = await identities.resolve(conn.id, 'ext-spam');
      expect(r).toMatchObject({ linked: false, reason: 'PROMPT_THROTTLED' });
      expect((r as { reply: { actions: unknown[]; text: string } }).reply.actions).toEqual([]);
      expect(JSON.stringify(r)).not.toMatch(/token=/);
      expect(adapter.lookupCalls).toBe(lookupsBefore);
      expect(await prisma.identityLinkToken.count()).toBe(1);
      // someone else in the same workspace still gets a prompt
      expect(await identities.resolve(conn.id, 'ext-other')).toMatchObject({ reason: 'NO_LINK' });
      // being linked ends the problem regardless of the counter
      await identities.manualLink(conn.id, owner.id, { externalUserId: 'ext-spam', userId: member.id });
      expect(await identities.resolve(conn.id, 'ext-spam')).toMatchObject({ linked: true, userId: member.id });
    });

    it('linked -> returns exactly the linked user id', async () => {
      const { conn, owner, member } = await world();
      await identities.manualLink(conn.id, owner.id, { externalUserId: 'ext-1', userId: member.id });
      expect(await identities.requireLinkedUser(conn.id, 'ext-1')).toBe(member.id);
      const r = await identities.resolve(conn.id, 'ext-1');
      expect(r).toMatchObject({ linked: true, userId: member.id, method: 'MANUAL' });
    });

    it('a link to someone who has since left the account no longer executes (row kept)', async () => {
      const { conn, owner, member, account } = await world();
      await identities.manualLink(conn.id, owner.id, { externalUserId: 'ext-1', userId: member.id });
      await prisma.accountMember.deleteMany({ where: { accountId: account.id, userId: member.id } });
      const r = await identities.resolve(conn.id, 'ext-1');
      expect(r).toMatchObject({ linked: false, reason: 'NOT_A_PARTICIPANT' });
      expect(await prisma.identityLink.count()).toBe(1);
    });

    it.each(['REVOKED', 'NEEDS_REAUTH', 'ERROR'] as const)('connection %s: nobody executes, even when linked; reply is the "disconnected" notice', async (status) => {
      const { conn, owner, member } = await world();
      await identities.manualLink(conn.id, owner.id, { externalUserId: 'ext-1', userId: member.id });
      await prisma.integrationConnection.update({ where: { id: conn.id }, data: { status } });
      const r = await identities.resolve(conn.id, 'ext-1');
      expect(r).toMatchObject({ linked: false, reason: 'CONNECTION_INACTIVE' });
      expect((r as { reply: { text: string; actions: unknown[] } }).reply.text).toContain('disconnected');
      expect((r as { reply: { actions: unknown[] } }).reply.actions).toHaveLength(0);
    });

    it('unknown connection -> 404 (not an "unlinked" answer)', async () => {
      await expect(identities.resolve('nope', 'x')).rejects.toMatchObject({ status: 404 });
    });

    it('a workspace collaborator (no AccountMember) can link THEMSELVES with the one-time link and then resolves; an admin cannot map them', async () => {
      const { conn, owner, account } = await world();
      const { createWorkspace } = await import('./factories');
      const ws = await createWorkspace(prisma, { accountId: account.id });
      const guest = await createUser(prisma);
      await prisma.workspaceCollaborator.create({ data: { workspaceId: ws.id, invitedUserId: guest.id } });
      await expect(identities.manualLink(conn.id, owner.id, { externalUserId: 'ext-g', userId: guest.id })).rejects.toMatchObject({ status: 400 });
      const { token } = await issue(conn.id, 'ext-g');
      await identities.completeLinkToken(token, guest.id);
      expect(await identities.requireLinkedUser(conn.id, 'ext-g')).toBe(guest.id);
    });
  });

  /** What the chat path does for an unlinked caller: resolve() issues the token inside the reply URL. */
  async function issue(connectionId: string, externalUserId: string) {
    const r = await identities.resolve(connectionId, externalUserId);
    if (r.linked !== false) throw new Error('expected an unlinked caller');
    return { token: qp(r.reply.actions[0].url).get('token')!, reply: r.reply };
  }

  describe('one-time link (ADR-0010 d.2)', () => {
    it('chat -> prompt with token -> logged-in member completes -> LINK_TOKEN link, audit, and the caller now resolves', async () => {
      const { conn, member, account } = await world();
      const { token } = await issue(conn.id, 'ext-1');
      const dto = await identities.completeLinkToken(token, member.id);
      expect(dto).toMatchObject({ connectionId: conn.id, externalUserId: 'ext-1', userId: member.id, method: 'LINK_TOKEN' });
      expect(await identities.requireLinkedUser(conn.id, 'ext-1')).toBe(member.id);
      expect(await prisma.auditLog.count({ where: { action: 'INTEGRATION_IDENTITY_LINKED', accountId: account.id, actorId: member.id } })).toBe(1);
    });

    it('only the SHA-256 is stored, never the token', async () => {
      const { conn } = await world();
      const { token } = await issue(conn.id, 'ext-1');
      const rows = await prisma.identityLinkToken.findMany();
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows)).not.toContain(token);
      expect(rows[0].tokenHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('single use: a replay fails, and so does a concurrent duplicate (exactly one winner)', async () => {
      const { conn, member, owner } = await world();
      const { token } = await issue(conn.id, 'ext-1');
      const res = await Promise.allSettled([identities.completeLinkToken(token, member.id), identities.completeLinkToken(token, owner.id)]);
      expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      await expect(identities.completeLinkToken(token, member.id)).rejects.toMatchObject({ status: 400 });
      expect(await prisma.identityLink.count()).toBe(1);
    });

    it('expired and unknown tokens: 400, nothing linked', async () => {
      const { conn, member } = await world();
      const { token } = await issue(conn.id, 'ext-1');
      await prisma.identityLinkToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
      await expect(identities.completeLinkToken(token, member.id)).rejects.toMatchObject({ status: 400 });
      await expect(identities.completeLinkToken('nope', member.id)).rejects.toMatchObject({ status: 400 });
      expect(await prisma.identityLink.count()).toBe(0);
    });

    it('a new command from the same chat user replaces the old token (old dies, one row)', async () => {
      const { conn, member } = await world();
      const a = await issue(conn.id, 'ext-1');
      const b = await issue(conn.id, 'ext-1');
      expect(await prisma.identityLinkToken.count()).toBe(1);
      await expect(identities.completeLinkToken(a.token, member.id)).rejects.toMatchObject({ status: 400 });
      await expect(identities.completeLinkToken(b.token, member.id)).resolves.toBeDefined();
    });

    it('a different chat user gets an independent token', async () => {
      const { conn } = await world();
      await issue(conn.id, 'ext-1'); await issue(conn.id, 'ext-2');
      expect(await prisma.identityLinkToken.count()).toBe(2);
    });

    it('someone outside the account cannot complete it (403) - and the token is burned, so a leak costs a re-run, not an account', async () => {
      const { conn, member } = await world();
      const { token } = await issue(conn.id, 'ext-1');
      const outsider = await createUser(prisma);
      await expect(identities.completeLinkToken(token, outsider.id)).rejects.toMatchObject({ status: 403 });
      expect(await prisma.identityLink.count()).toBe(0);
      await expect(identities.completeLinkToken(token, member.id)).rejects.toMatchObject({ status: 400 });
    });

    /** A token as a stale prompt would hold it: issued earlier, the chat user got linked meanwhile. */
    async function rawToken(connectionId: string, externalUserId: string, token: string) {
      const { createHash } = await import('crypto');
      await prisma.identityLinkToken.create({
        data: { tokenHash: createHash('sha256').update(token).digest('hex'), connectionId, externalUserId, expiresAt: new Date(Date.now() + 60_000) },
      });
    }

    it('chat user already linked to ANOTHER person: 409 and the link is unchanged (only an admin relinks)', async () => {
      const { conn, member, owner } = await world();
      await identities.manualLink(conn.id, owner.id, { externalUserId: 'ext-1', userId: owner.id });
      await rawToken(conn.id, 'ext-1', 'stale-token');
      await expect(identities.completeLinkToken('stale-token', member.id)).rejects.toMatchObject({ status: 409 });
      expect((await prisma.identityLink.findFirstOrThrow()).userId).toBe(owner.id);
    });

    it('the same person completing again is idempotent: still one row, still theirs', async () => {
      const { conn, member } = await world();
      await identities.completeLinkToken((await issue(conn.id, 'ext-1')).token, member.id);
      await rawToken(conn.id, 'ext-1', 'second-token');
      await expect(identities.completeLinkToken('second-token', member.id)).resolves.toMatchObject({ userId: member.id });
      expect(await prisma.identityLink.count()).toBe(1);
    });

    it('a revoked / inactive connection cannot be linked (400)', async () => {
      const { conn, member } = await world();
      const { token } = await issue(conn.id, 'ext-1');
      await prisma.integrationConnection.update({ where: { id: conn.id }, data: { status: 'REVOKED' } });
      await expect(identities.completeLinkToken(token, member.id)).rejects.toMatchObject({ status: 400 });
    });

    it('inspect: a member sees provider + integration name (no chat identifiers) and the token stays usable; an outsider gets 404; junk 400', async () => {
      const { conn, member } = await world();
      const { token } = await issue(conn.id, 'ext-secret-id');
      const seen = await identities.inspectLinkToken(token, member.id);
      expect(seen).toEqual({ connectionId: conn.id, provider: 'DISCORD', externalAccountName: 'Guild', active: true });
      expect(JSON.stringify(seen)).not.toContain('ext-secret-id');
      const outsider = await createUser(prisma);
      await expect(identities.inspectLinkToken(token, outsider.id)).rejects.toMatchObject({ status: 404 });
      await expect(identities.inspectLinkToken('junk', member.id)).rejects.toMatchObject({ status: 400 });
      await expect(identities.completeLinkToken(token, member.id)).resolves.toBeDefined();
    });

    it('no token is issued for an inactive connection (the reply is the "disconnected" notice)', async () => {
      const { conn } = await world();
      await prisma.integrationConnection.update({ where: { id: conn.id }, data: { status: 'REVOKED' } });
      await identities.resolve(conn.id, 'ext-1');
      expect(await prisma.identityLinkToken.count()).toBe(0);
    });

    it('the maintenance sweep deletes tokens expired more than a day ago and keeps newer ones', async () => {
      const { conn } = await world();
      const mk = (h: string, ext: string, ageMs: number) => prisma.identityLinkToken.create({ data: { tokenHash: h, connectionId: conn.id, externalUserId: ext, expiresAt: new Date(Date.now() - ageMs) } });
      await mk('old', 'a', 2 * 86400_000); await mk('recent', 'b', 3600_000);
      expect((await sweepJob.sweep()).tokensDeleted).toBe(1);
      expect((await prisma.identityLinkToken.findMany()).map((t) => t.tokenHash)).toEqual(['recent']);
    });
  });

  describe('verified-email auto-match', () => {
    it('all guards hold -> AUTO_EMAIL link, audit row, and the 2nd resolve does not call the provider again', async () => {
      const { conn, member, account } = await world();
      adapter.lookupImpl = async () => confirmed('Alice@Corp.test'); // case-insensitive
      const r = await identities.resolve(conn.id, 'ext-1');
      expect(r).toMatchObject({ linked: true, userId: member.id, method: 'AUTO_EMAIL' });
      expect(await prisma.auditLog.count({ where: { action: 'INTEGRATION_IDENTITY_LINKED', accountId: account.id } })).toBe(1);
      await identities.resolve(conn.id, 'ext-1');
      expect(adapter.lookupCalls).toBe(1);
    });

    const noLink = async (conn: { id: string }, reason = 'NO_LINK') => {
      expect(await identities.resolve(conn.id, 'ext-1')).toMatchObject({ linked: false, reason });
      expect(await prisma.identityLink.count()).toBe(0);
    };

    it('provider does not vouch for the email -> no link', async () => {
      const { conn } = await world();
      adapter.lookupImpl = async () => confirmed('alice@corp.test', { emailConfirmed: false });
      await noLink(conn);
    });
    it('bot / deleted user -> no link', async () => {
      const { conn } = await world();
      adapter.lookupImpl = async () => confirmed('alice@corp.test', { isBot: true });
      await noLink(conn);
    });
    it('user from another provider tenant -> no link', async () => {
      const { conn } = await world();
      adapter.lookupImpl = async () => confirmed('alice@corp.test', { tenantId: 'OTHER' });
      await noLink(conn);
    });
    it('app user email NOT verified -> no link', async () => {
      const { conn, member } = await world();
      await prisma.user.update({ where: { id: member.id }, data: { emailVerified: false } });
      adapter.lookupImpl = async () => confirmed('alice@corp.test');
      await noLink(conn);
    });
    it('same email but the app user is not in THIS account -> no link', async () => {
      const { conn } = await world();
      await createUser(prisma, { email: 'stranger@other.test' });
      adapter.lookupImpl = async () => confirmed('stranger@other.test');
      await noLink(conn);
    });
    it('verified matching email but only a workspace COLLABORATOR (not an AccountMember) -> no silent link (owner decision)', async () => {
      const { conn, account } = await world();
      const { createWorkspace } = await import('./factories');
      const ws = await createWorkspace(prisma, { accountId: account.id });
      const guest = await createUser(prisma, { email: 'guest@client.test' });
      await prisma.workspaceCollaborator.create({ data: { workspaceId: ws.id, invitedUserId: guest.id } });
      adapter.lookupImpl = async () => confirmed('guest@client.test');
      await noLink(conn);
      expect(adapter.lookupCalls).toBeGreaterThan(0);
    });
    it('no matching app user -> no link', async () => {
      const { conn } = await world();
      adapter.lookupImpl = async () => confirmed('nobody@corp.test');
      await noLink(conn);
    });
    it('provider has no lookup capability -> no link, no call', async () => {
      const { conn } = await world();
      adapter.hasLookup = false;
      await noLink(conn);
      expect(adapter.lookupCalls).toBe(0);
    });
    it('provider lookup throws -> no link (never a guess), no crash', async () => {
      const { conn } = await world();
      adapter.lookupImpl = async () => { throw new Error('slack 500'); };
      await noLink(conn);
    });
    it('two verified account members whose emails differ only by case -> AMBIGUOUS_EMAIL, nobody linked', async () => {
      const { conn, account } = await world();
      const twin = await createUser(prisma, { email: 'ALICE@corp.test' });
      await addAccountMember(prisma, { accountId: account.id, userId: twin.id, role: Role.MEMBER });
      adapter.lookupImpl = async () => confirmed('alice@corp.test');
      await noLink(conn, 'AMBIGUOUS_EMAIL');
    });
    it('concurrent first messages from the same person -> one link row, same user for both', async () => {
      const { conn, member } = await world();
      adapter.lookupImpl = async () => confirmed('alice@corp.test');
      const [a, b] = await Promise.all([identities.resolve(conn.id, 'ext-1'), identities.resolve(conn.id, 'ext-1')]);
      expect(a).toMatchObject({ linked: true, userId: member.id });
      expect(b).toMatchObject({ linked: true, userId: member.id });
      expect(await prisma.identityLink.count()).toBe(1);
    });
    it('an auto-match never overwrites a link that already belongs to someone else', async () => {
      const { conn, owner, member } = await world();
      await identities.manualLink(conn.id, owner.id, { externalUserId: 'ext-1', userId: owner.id });
      adapter.lookupImpl = async () => confirmed('alice@corp.test');
      expect(await identities.requireLinkedUser(conn.id, 'ext-1')).toBe(owner.id);
      void member;
    });
  });

  describe('OAuth identity link', () => {
    async function start(userId: string, connId: string) {
      const { authUrl } = await idOauth.start(IntegrationProvider.DISCORD, connId, userId);
      return stateOf(authUrl);
    }

    it('start: state row is purpose IDENTITY bound to user + connection; redirect URI is the identity callback', async () => {
      const { conn, member } = await world();
      const { authUrl } = await idOauth.start(IntegrationProvider.DISCORD, conn.id, member.id);
      expect(decodeURIComponent(qp(authUrl).get('ru')!)).toBe('http://api.test/integrations/discord/identity/callback');
      expect(await prisma.oAuthState.findUniqueOrThrow({ where: { nonce: stateOf(authUrl) } }))
        .toMatchObject({ purpose: 'IDENTITY', connectionId: conn.id, userId: member.id });
    });

    it('start: outsider, wrong provider, unknown id -> 404; revoked -> 400; no identity support -> 404; none writes state', async () => {
      const { conn, member } = await world();
      const outsider = await createUser(prisma);
      await expect(idOauth.start(IntegrationProvider.DISCORD, conn.id, outsider.id)).rejects.toMatchObject({ status: 404 });
      await expect(idOauth.start(IntegrationProvider.SLACK, conn.id, member.id)).rejects.toMatchObject({ status: 404 });
      await expect(idOauth.start(IntegrationProvider.DISCORD, 'nope', member.id)).rejects.toMatchObject({ status: 404 });
      Object.defineProperty(adapter, 'identity', { value: undefined, configurable: true });
      await expect(idOauth.start(IntegrationProvider.DISCORD, conn.id, member.id)).rejects.toMatchObject({ status: 404 });
      delete (adapter as never as Record<string, unknown>).identity; // restore the prototype getter
      await prisma.integrationConnection.update({ where: { id: conn.id }, data: { status: 'REVOKED' } });
      await expect(idOauth.start(IntegrationProvider.DISCORD, conn.id, member.id)).rejects.toMatchObject({ status: 400 });
      expect(await prisma.oAuthState.count()).toBe(0);
    });

    it('callback: links OAUTH_LINK, audits, redirects identity_linked; the link then resolves', async () => {
      const { conn, member, account } = await world();
      const s = await start(member.id, conn.id);
      const r = await idOauth.handleCallback(IntegrationProvider.DISCORD, { state: s, code: 'c', ext: 'ext-77' });
      expect(qp(r).get('identity_linked')).toBe('discord');
      expect(r.startsWith('http://fe.test/settings/integrations?')).toBe(true);
      expect(await prisma.identityLink.findFirstOrThrow()).toMatchObject({ externalUserId: 'ext-77', userId: member.id, method: 'OAUTH_LINK' });
      expect(await prisma.auditLog.count({ where: { action: 'INTEGRATION_IDENTITY_LINKED', accountId: account.id } })).toBe(1);
      expect(await identities.requireLinkedUser(conn.id, 'ext-77')).toBe(member.id);
    });

    it('replay and concurrent duplicate: exactly one wins', async () => {
      const { conn, member } = await world();
      const s = await start(member.id, conn.id);
      const q = { state: s, code: 'c', ext: 'ext-1' };
      const [a, b] = await Promise.all([idOauth.handleCallback(IntegrationProvider.DISCORD, q), idOauth.handleCallback(IntegrationProvider.DISCORD, q)]);
      expect([qp(a).get('identity_linked') ?? qp(a).get('identity_error'), qp(b).get('identity_linked') ?? qp(b).get('identity_error')].sort()).toEqual(['discord', 'invalid_state']);
    });

    it('purpose isolation: an IDENTITY state is dead on the CONNECT callback (and is NOT consumed by it); a CONNECT state is dead here', async () => {
      const { conn, member, owner, account } = await world();
      const idState = await start(member.id, conn.id);
      const viaConnect = await connectOauth.handleCallback(IntegrationProvider.DISCORD, { state: idState, code: 'c' });
      expect(qp(viaConnect).get('error')).toBe('invalid_state');
      expect(await prisma.oAuthState.findUniqueOrThrow({ where: { nonce: idState } }).then((r) => r.consumedAt)).toBeNull();
      expect(qp(await idOauth.handleCallback(IntegrationProvider.DISCORD, { state: idState, code: 'c', ext: 'e' })).get('identity_linked')).toBe('discord');

      const { authUrl } = await connectOauth.start(IntegrationProvider.DISCORD, account.id, owner.id);
      const viaIdentity = await idOauth.handleCallback(IntegrationProvider.DISCORD, { state: stateOf(authUrl), code: 'c', ext: 'x' });
      expect(qp(viaIdentity).get('identity_error')).toBe('invalid_state');
    });

    it('already linked to ANOTHER user -> already_linked, nothing changed', async () => {
      const { conn, owner, member } = await world();
      await identities.manualLink(conn.id, owner.id, { externalUserId: 'ext-1', userId: owner.id });
      const s = await start(member.id, conn.id);
      expect(qp(await idOauth.handleCallback(IntegrationProvider.DISCORD, { state: s, code: 'c', ext: 'ext-1' })).get('identity_error')).toBe('already_linked');
      expect((await prisma.identityLink.findFirstOrThrow()).userId).toBe(owner.id);
    });

    it('same user again -> idempotent, still one row', async () => {
      const { conn, member } = await world();
      for (let i = 0; i < 2; i++) {
        const s = await start(member.id, conn.id);
        expect(qp(await idOauth.handleCallback(IntegrationProvider.DISCORD, { state: s, code: 'c', ext: 'ext-1' })).get('identity_linked')).toBe('discord');
      }
      expect(await prisma.identityLink.count()).toBe(1);
    });

    it('a stronger method survives a later auto-match style upsert (OAUTH_LINK is not downgraded)', async () => {
      const { conn, member } = await world();
      const s = await start(member.id, conn.id);
      await idOauth.handleCallback(IntegrationProvider.DISCORD, { state: s, code: 'c', ext: 'ext-1' });
      adapter.lookupImpl = async () => confirmed('alice@corp.test');
      expect(await identities.resolve(conn.id, 'ext-1')).toMatchObject({ linked: true, method: 'OAUTH_LINK' });
    });

    it.each([
      ['wrong workspace', { tenantId: 'OTHER' }, 'wrong_workspace'],
      ['a bot', { isBot: true }, 'not_a_person'],
    ])('provider says %s -> %s, no link', async (_n, patch, code) => {
      const { conn, member } = await world();
      adapter.exchangeImpl = async () => ({ id: 'ext-1', name: 'x', ...patch });
      const s = await start(member.id, conn.id);
      expect(qp(await idOauth.handleCallback(IntegrationProvider.DISCORD, { state: s, code: 'c' })).get('identity_error')).toBe(code);
      expect(await prisma.identityLink.count()).toBe(0);
    });

    it('denied, provider failure, left-the-account, connection-revoked-meanwhile: coded redirects, no link', async () => {
      const { conn, member, account } = await world();
      expect(qp(await idOauth.handleCallback(IntegrationProvider.DISCORD, { state: await start(member.id, conn.id), error: 'access_denied' })).get('identity_error')).toBe('denied');
      adapter.exchangeImpl = async () => { throw new Error('boom'); };
      expect(qp(await idOauth.handleCallback(IntegrationProvider.DISCORD, { state: await start(member.id, conn.id), code: 'c' })).get('identity_error')).toBe('provider_error');
      adapter.exchangeImpl = async () => ({ id: 'ext-1', name: 'x' });
      const s1 = await start(member.id, conn.id);
      await prisma.accountMember.deleteMany({ where: { accountId: account.id, userId: member.id } });
      expect(qp(await idOauth.handleCallback(IntegrationProvider.DISCORD, { state: s1, code: 'c' })).get('identity_error')).toBe('forbidden');
      await addAccountMember(prisma, { accountId: account.id, userId: member.id, role: Role.MEMBER });
      const s2 = await start(member.id, conn.id);
      await prisma.integrationConnection.update({ where: { id: conn.id }, data: { status: 'REVOKED' } });
      expect(qp(await idOauth.handleCallback(IntegrationProvider.DISCORD, { state: s2, code: 'c' })).get('identity_error')).toBe('connection_inactive');
      expect(await prisma.identityLink.count()).toBe(0);
    });

    it('missing / unknown state -> invalid_state', async () => {
      await world();
      expect(qp(await idOauth.handleCallback(IntegrationProvider.DISCORD, { code: 'c' })).get('identity_error')).toBe('invalid_state');
      expect(qp(await idOauth.handleCallback(IntegrationProvider.DISCORD, { state: 'zzz', code: 'c' })).get('identity_error')).toBe('invalid_state');
    });
  });

  describe('admin + self service', () => {
    it('manual link: admin ok; MEMBER 403; non-participant target 400; revoked 400; blank id 400', async () => {
      const { conn, owner, member } = await world();
      const dto = await identities.manualLink(conn.id, owner.id, { externalUserId: ' ext-1 ', userId: member.id });
      expect(dto).toMatchObject({ externalUserId: 'ext-1', userId: member.id, method: 'MANUAL' });
      await expect(identities.manualLink(conn.id, member.id, { externalUserId: 'e', userId: member.id })).rejects.toMatchObject({ status: 403 });
      const outsider = await createUser(prisma);
      await expect(identities.manualLink(conn.id, owner.id, { externalUserId: 'e2', userId: outsider.id })).rejects.toMatchObject({ status: 400 });
      await expect(identities.manualLink(conn.id, owner.id, { externalUserId: '  ', userId: member.id })).rejects.toMatchObject({ status: 400 });
      await prisma.integrationConnection.update({ where: { id: conn.id }, data: { status: 'REVOKED' } });
      await expect(identities.manualLink(conn.id, owner.id, { externalUserId: 'e3', userId: member.id })).rejects.toMatchObject({ status: 400 });
    });

    it('admin relink overrides another user (explicit admin act) and is audited with the target user', async () => {
      const { conn, owner, member, account } = await world();
      await identities.manualLink(conn.id, owner.id, { externalUserId: 'ext-1', userId: owner.id });
      await identities.manualLink(conn.id, owner.id, { externalUserId: 'ext-1', userId: member.id });
      expect((await prisma.identityLink.findFirstOrThrow()).userId).toBe(member.id);
      const audits = await prisma.auditLog.findMany({ where: { action: 'INTEGRATION_IDENTITY_LINKED', accountId: account.id } });
      expect(audits).toHaveLength(2);
    });

    it('admin unlink: removes, audits, 404 when absent, 403 for MEMBER; the person is then unlinked again', async () => {
      const { conn, owner, member } = await world();
      await identities.manualLink(conn.id, owner.id, { externalUserId: 'ext-1', userId: member.id });
      await expect(identities.unlink(conn.id, 'ext-1', member.id)).rejects.toMatchObject({ status: 403 });
      await identities.unlink(conn.id, 'ext-1', owner.id);
      expect(await prisma.auditLog.count({ where: { action: 'INTEGRATION_IDENTITY_UNLINKED' } })).toBe(1);
      await expect(identities.unlink(conn.id, 'ext-1', owner.id)).rejects.toMatchObject({ status: 404 });
      expect(await identities.resolve(conn.id, 'ext-1')).toMatchObject({ linked: false });
    });

    it('admin list: MEMBER 403; DTO has only whitelisted keys', async () => {
      const { conn, owner, member } = await world();
      await identities.manualLink(conn.id, owner.id, { externalUserId: 'ext-1', userId: member.id });
      await expect(identities.listForConnection(conn.id, member.id)).rejects.toMatchObject({ status: 403 });
      const list = await identities.listForConnection(conn.id, owner.id);
      expect(Object.keys(list[0]).sort()).toEqual(['connectionId', 'createdAt', 'externalEmail', 'externalUserId', 'id', 'method', 'userId'].sort());
    });

    it('self service: list shows only mine; I can remove mine; someone else\'s id is a 404 and untouched', async () => {
      const { conn, owner, member } = await world();
      await identities.manualLink(conn.id, owner.id, { externalUserId: 'e-mine', userId: member.id });
      await identities.manualLink(conn.id, owner.id, { externalUserId: 'e-owner', userId: owner.id });
      const mine = await identities.listMine(member.id);
      expect(mine.map((l) => l.externalUserId)).toEqual(['e-mine']);
      const ownerLink = await prisma.identityLink.findFirstOrThrow({ where: { externalUserId: 'e-owner' } });
      await expect(identities.unlinkMine(ownerLink.id, member.id)).rejects.toMatchObject({ status: 404 });
      expect(await prisma.identityLink.count()).toBe(2);
      await identities.unlinkMine(mine[0].id, member.id);
      expect(await prisma.identityLink.count()).toBe(1);
      expect(await prisma.auditLog.count({ where: { action: 'INTEGRATION_IDENTITY_UNLINKED' } })).toBe(1);
    });
  });

  it('revoking a connection does not delete identity links (revive restores them)', async () => {
    const { conn, owner, member } = await world();
    await identities.manualLink(conn.id, owner.id, { externalUserId: 'ext-1', userId: member.id });
    await integrations.revoke(conn.id, owner.id);
    expect(await prisma.identityLink.count()).toBe(1);
    expect(await identities.resolve(conn.id, 'ext-1')).toMatchObject({ linked: false, reason: 'CONNECTION_INACTIVE' });
  });
});
