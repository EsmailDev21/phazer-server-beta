/**
 * Step 2.4 - Discord interactions + chat commands against a real DB, with SIGNED fixtures (real Ed25519 keypair).
 * The provider is a fake adapter that records follow-ups; the router is wired in for the echo-guard test.
 */
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { Activity, IntegrationProvider, Role } from '@prisma/client';
import { generateKeyPairSync, randomBytes, sign } from 'crypto';
import { PermissionResolver } from '../../src/access-control/access-control.service';
import { PlanLimitsService } from '../../src/access-control/plan-limits.service';
import { TokenVaultService } from '../../src/crypto/token-vault.service';
import { DomainWriter } from '../../src/domain-writer/domain-writer.service';
import { ActivityService } from '../../src/events/activity.service';
import { AuditLogService } from '../../src/events/audit-log.service';
import { FeatureFlagsService } from '../../src/feature-flags/feature-flags.service';
import { ChatCommandExecutor } from '../../src/integrations/chat/chat-command.executor';
import { ChatCommandJob } from '../../src/integrations/chat/chat-command.job';
import { ChatCommandPayload } from '../../src/integrations/chat/chat.types';
import { DiscordInteractionService, FOLLOW_UP_DELAY_MS } from '../../src/integrations/chat/discord-interaction.service';
import { ConnectorRegistry } from '../../src/integrations/core/connector.registry';
import { CredentialService } from '../../src/integrations/core/credential.service';
import { IdentityService } from '../../src/integrations/core/identity.service';
import { ChatResult } from '../../src/integrations/chat/chat.types';
import { ConnectorAdapter, INTEGRATION_ADAPTERS } from '../../src/integrations/core/integration.types';
import { LinkPromptBuilder } from '../../src/integrations/core/link-prompt.builder';
import { LinkTokenService } from '../../src/integrations/core/link-token.service';
import { PromptThrottleService } from '../../src/integrations/core/prompt-throttle.service';
import { RedisLockService } from '../../src/integrations/core/redis-lock.service';
import { NotificationRouter } from '../../src/integrations/notify/notification-router.service';
import { DEFAULT_EVENTS, RichMessageBuilder } from '../../src/integrations/notify/rich-message.builder';
import { WebhookDedupeService } from '../../src/integrations/webhooks/webhook-dedupe.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { CustomFieldsService } from '../../src/projects-tasks/custom-fields/custom-fields.service';
import { IssueTypesService } from '../../src/projects-tasks/issue-types/issue-types.service';
import { IterationsService } from '../../src/projects-tasks/iterations/iterations.service';
import { TaskPlanningService } from '../../src/projects-tasks/planning/task-planning.service';
import { ProjectsService } from '../../src/projects-tasks/projects/projects.service';
import { TaskTreeService } from '../../src/projects-tasks/tasks/task-tree.service';
import { TaskVisibilityService } from '../../src/projects-tasks/tasks/task-visibility.service';
import { TasksService } from '../../src/projects-tasks/tasks/tasks.service';
import { WorkflowService } from '../../src/projects-tasks/workflow/workflow.service';
import { JobHandlerRegistry } from '../../src/queue/job-handler.registry';
import { QueueService } from '../../src/queue/queue.service';
import { RedisService } from '../../src/redis/redis.service';
import { WorkspaceKeysService } from '../../src/tenancy/workspaces/workspace-keys.service';
import { WorkspacesService } from '../../src/tenancy/workspaces/workspaces.service';
import { addAccountMember, createProject, createTask, createUser, createUserWithAccount, createWorkspace } from './factories';
import { disconnectTestPrisma, getTestPrisma } from './support/prisma-test-client';
import { resetDb } from './support/reset-db';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const PUB = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
const KEY = randomBytes(32).toString('base64');
const settings: Record<string, string> = { DISCORD_PUBLIC_KEY: PUB, FRONTEND_URL: 'http://fe.test' };

const APP = '111111111111111111';
const GUILD = '222222222222222222';
const CHAN = '333333333333333333';
const CHAN2 = '333333333333333334';
const U_OWNER = '100000000000000001';
const U_MEMBER = '100000000000000002';
const U_VIEWER = '100000000000000003';
const U_STRANGER = '100000000000000009';
const MANAGE = '32';

class FakeDiscord implements ConnectorAdapter {
  readonly provider = IntegrationProvider.DISCORD;
  readonly capabilities = new Set<never>();
  readonly usesPkce = false;
  replies: Array<{ target: { applicationId: string; interactionToken: string }; result: ChatResult }> = [];
  replyImpl: () => Promise<void> = async () => undefined;
  notified: Array<{ channelId: string; title: string }> = [];
  isConfigured() { return true; }
  authorizeUrl() { return 'x'; }
  async exchangeCode(): Promise<never> { throw new Error('unused'); }
  async revoke() { /* noop */ }
  async chatReply(target: { applicationId: string; interactionToken: string }, result: ChatResult) { this.replies.push({ target, result }); return this.replyImpl(); }
  async notify(c: { channel: { externalId: string }; message: { title: string } }) { this.notified.push({ channelId: c.channel.externalId, title: c.message.title }); }
}

describe('discord interactions + chat commands (step 2.4)', () => {
  let prisma: PrismaService;
  let svc: DiscordInteractionService;
  let job: ChatCommandJob;
  let adapter: FakeDiscord;
  let router: NotificationRouter;
  let identities: IdentityService;
  let resolver: PermissionResolver;
  const enqueued: Array<{ queue: string; name: string; payload: ChatCommandPayload & { interactionId: string }; opts: { jobId?: string; delayMs?: number } }> = [];
  let enqueueFails = false;
  let seq = 0;

  beforeAll(async () => {
    prisma = getTestPrisma();
    adapter = new FakeDiscord();
    const emitter = new EventEmitter2();
    const vault = new TokenVaultService({ TOKEN_VAULT_KEYS: `k1:${KEY}`, TOKEN_VAULT_CURRENT_KID: 'k1' } as never);
    const m = await Test.createTestingModule({
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: emitter },
        { provide: TokenVaultService, useValue: vault },
        { provide: RedisService, useValue: { configured: false, isReady: () => false } },
        { provide: ConfigService, useValue: { get: (k: string) => settings[k] } },
        { provide: INTEGRATION_ADAPTERS, useValue: [adapter] },
        { provide: FeatureFlagsService, useValue: { isEnabled: () => true } },
        { provide: JobHandlerRegistry, useValue: { register: () => undefined, registerSchedule: () => undefined } },
        {
          provide: QueueService,
          useValue: { enqueue: async (queue: string, name: string, payload: never, opts: never) => { if (enqueueFails) throw new Error('redis down'); enqueued.push({ queue, name, payload, opts }); return {}; } },
        },
        ActivityService, AuditLogService, PermissionResolver, PlanLimitsService, ConnectorRegistry, RedisLockService, CredentialService,
        LinkPromptBuilder, LinkTokenService, PromptThrottleService, IdentityService, WebhookDedupeService, RichMessageBuilder, NotificationRouter,
        TaskVisibilityService, TasksService, TaskTreeService, WorkflowService, TaskPlanningService, IssueTypesService, IterationsService,
        ProjectsService, CustomFieldsService, WorkspaceKeysService, WorkspacesService, DomainWriter,
        ChatCommandExecutor, ChatCommandJob, DiscordInteractionService,
      ],
    }).compile();
    await m.init();
    svc = m.get(DiscordInteractionService); job = m.get(ChatCommandJob); router = m.get(NotificationRouter); identities = m.get(IdentityService); resolver = m.get(PermissionResolver);
    emitter.on('activity.created', (a: Activity) => router.onActivity(a));
  });
  beforeEach(async () => {
    await resetDb(prisma);
    adapter.replies = []; adapter.replyImpl = async () => undefined; adapter.notified = [];
    enqueued.length = 0; enqueueFails = false;
  });
  afterAll(() => disconnectTestPrisma());

  // ---------------------------------------------------------------- fixtures

  async function world() {
    const { user: owner, account } = await createUserWithAccount(prisma, { role: Role.OWNER });
    await prisma.account.update({ where: { id: account.id }, data: { planType: 'ENTERPRISE_ORG' as never } });
    const member = await createUser(prisma); await addAccountMember(prisma, { accountId: account.id, userId: member.id, role: Role.MEMBER });
    const viewer = await createUser(prisma); await addAccountMember(prisma, { accountId: account.id, userId: viewer.id, role: Role.VIEWER });
    const ws = await createWorkspace(prisma, { accountId: account.id });
    const project = await createProject(prisma, { workspaceId: ws.id, createdById: owner.id, name: 'Website' } as never);
    const conn = await prisma.integrationConnection.create({ data: { accountId: account.id, provider: 'DISCORD', externalAccountId: GUILD, externalAccountName: 'Guild', createdById: owner.id } });
    const link = (userId: string, ext: string) => prisma.identityLink.create({ data: { connectionId: conn.id, externalUserId: ext, userId, method: 'MANUAL' } });
    await link(owner.id, U_OWNER); await link(member.id, U_MEMBER); await link(viewer.id, U_VIEWER);
    await prisma.channelLink.create({ data: { connectionId: conn.id, kind: 'GUILD', externalId: GUILD, workspaceId: ws.id, configuredById: owner.id } });
    const chanLink = await prisma.channelLink.create({ data: { connectionId: conn.id, kind: 'CHANNEL', externalId: CHAN, workspaceId: ws.id, projectId: project.id, configuredById: owner.id } });
    return { owner, member, viewer, account, ws, project, conn, chanLink };
  }
  type W = Awaited<ReturnType<typeof world>>;

  const id = () => String(900000000000000000n + BigInt(++seq));
  const nowSec = () => Math.floor(Date.now() / 1000);

  /** A correctly signed request, exactly as Discord would send it. */
  function signed(payload: unknown, o: { timestamp?: string; tamper?: boolean } = {}) {
    const rawBody = Buffer.from(JSON.stringify(payload));
    const ts = o.timestamp ?? String(nowSec());
    const sig = sign(null, Buffer.concat([Buffer.from(ts), rawBody]), privateKey).toString('hex');
    return { rawBody: o.tamper ? Buffer.from(JSON.stringify({ ...(payload as object), x: 1 })) : rawBody, signature: sig, timestamp: ts, payload };
  }
  const base = (extra: Record<string, unknown> = {}) => ({ id: id(), application_id: APP, token: `tok-${seq}`, guild_id: GUILD, channel_id: CHAN, ...extra });
  const asUser = (ext: string, perms = '0') => ({ member: { user: { id: ext }, permissions: perms } });
  const slash = (ext: string, sub: string, options: Array<{ name: string; type?: number; value: string | number | boolean }>, extra: Record<string, unknown> = {}) =>
    base({ type: 2, ...asUser(ext, (extra.perms as string) ?? '0'), data: { name: 'task', type: 1, options: [{ name: sub, type: 1, options: options.map((o) => ({ type: 3, ...o })) }] }, ...extra });
  const send = (payload: unknown, o?: Parameters<typeof signed>[1]) => svc.handle(signed(payload, o));
  const body = async (payload: unknown) => { const r = await send(payload); if (r.status !== 200) throw new Error('expected 200, got 401'); return r.body; };
  /** Run the worker half for the most recently enqueued command. */
  const runJob = (which = enqueued.length - 1) => {
    const e = enqueued[which];
    return job.handle({ v: 1, traceId: 't', accountId: null, actorId: null, payload: e.payload });
  };
  const lastReply = () => adapter.replies[adapter.replies.length - 1].result;
  const keyOf = async (taskId: string) => { const t = await prisma.task.findUniqueOrThrow({ where: { id: taskId }, select: { number: true, workspace: { select: { key: true } } } }); return `${t.workspace.key}-${t.number}`; };

  // ---------------------------------------------------------------- verification

  describe('request verification (first thing that happens)', () => {
    it('PING signed -> PONG; nothing is written', async () => {
      expect(await body({ id: id(), application_id: APP, type: 1, token: 't' })).toEqual({ type: 1 });
      expect(await prisma.integrationWebhookEvent.count()).toBe(0);
    });

    it('unsigned, wrong signature, tampered body, expired timestamp: all 401, and NOTHING is recorded or enqueued', async () => {
      const w = await world();
      const p = slash(U_OWNER, 'create', [{ name: 'title', value: 'x' }]);
      expect(await svc.handle({ rawBody: Buffer.from('{}'), payload: {}, signature: undefined, timestamp: undefined })).toEqual({ status: 401 });
      expect(await svc.handle({ ...signed(p), signature: 'ab'.repeat(64) })).toEqual({ status: 401 });
      expect(await send(p, { tamper: true })).toEqual({ status: 401 });
      expect(await send(p, { timestamp: String(nowSec() - 3600) })).toEqual({ status: 401 });
      expect(await prisma.integrationWebhookEvent.count()).toBe(0);
      expect(enqueued).toHaveLength(0);
      expect(await prisma.task.count({ where: { workspaceId: w.ws.id } })).toBe(0);
    });

    it('no configured public key -> everything is 401, even a PING (fail closed)', async () => {
      const saved = settings.DISCORD_PUBLIC_KEY; delete settings.DISCORD_PUBLIC_KEY;
      try { expect(await send({ id: id(), application_id: APP, type: 1, token: 't' })).toEqual({ status: 401 }); } finally { settings.DISCORD_PUBLIC_KEY = saved; }
    });

    it('a duplicate interaction id is answered but not processed twice', async () => {
      await world();
      const p = slash(U_OWNER, 'create', [{ name: 'title', value: 'once' }]);
      expect((await body(p)).type).toBe(5);
      const again = await body(p);
      expect(again).toMatchObject({ type: 4, data: { flags: 64 } });
      expect(enqueued).toHaveLength(1);
    });

    it('autocomplete is answered with no choices; a DM (no guild) and an unconnected guild are explained privately', async () => {
      await world();
      expect(await body(base({ type: 4, ...asUser(U_OWNER), data: {} }))).toEqual({ type: 8, data: { choices: [] } });
      expect(await body(slash(U_OWNER, 'list', [], { guild_id: undefined }))).toMatchObject({ type: 4, data: { flags: 64 } });
      const r = await body(slash(U_OWNER, 'list', [], { guild_id: '999999999999999999' }));
      expect((r.data as { content: string }).content).toMatch(/not connected/);
    });
  });

  // ---------------------------------------------------------------- identity gate

  describe('who is calling', () => {
    it('an unlinked caller gets an EPHEMERAL link prompt with a one-time URL; nothing is enqueued or created', async () => {
      const w = await world();
      const r = await body(slash(U_STRANGER, 'create', [{ name: 'title', value: 'sneaky' }]));
      expect(r).toMatchObject({ type: 4, data: { flags: 64 } });
      const url = ((r.data as { components: Array<{ components: Array<{ url: string }> }> }).components[0].components[0]).url;
      expect(url).toMatch(/^http:\/\/fe\.test\/settings\/integrations\/link\?token=[A-Za-z0-9_-]{43}&connectionId=/);
      expect(enqueued).toHaveLength(0);
      expect(await prisma.task.count({ where: { workspaceId: w.ws.id } })).toBe(0);
    });

    it('a MALFORMED command from an unlinked caller is just an error: no link token is issued', async () => {
      await world();
      await body(slash(U_STRANGER, 'create', [{ name: 'title', value: '   ' }]));
      expect(await prisma.identityLinkToken.count()).toBe(0);
    });

    it('a bot caller is refused', async () => {
      await world();
      const r = await body(base({ type: 2, member: { user: { id: U_OWNER, bot: true } }, data: { name: 'task', type: 1, options: [{ name: 'list', type: 1 }] } }));
      expect((r.data as { content: string }).content).toMatch(/Unsupported/);
    });

    it('the link may be removed between the ack and the job: the job then replies with the link prompt and creates nothing', async () => {
      const w = await world();
      await body(slash(U_MEMBER, 'create', [{ name: 'title', value: 'late' }]));
      await prisma.identityLink.deleteMany({ where: { externalUserId: U_MEMBER } });
      await runJob();
      expect(await prisma.task.count({ where: { workspaceId: w.ws.id } })).toBe(0);
      expect(lastReply().text).toMatch(/link/i);
    });
  });

  // ---------------------------------------------------------------- create

  describe('/task create', () => {
    it('acks within the sync path with a PUBLIC deferred response, queues the work with a head-start delay and a deterministic job id, writes NOTHING yet', async () => {
      const w = await world();
      const p = slash(U_MEMBER, 'create', [{ name: 'title', value: 'Fix login' }]);
      expect(await body(p)).toEqual({ type: 5, data: {} });
      expect(enqueued).toHaveLength(1);
      expect(enqueued[0]).toMatchObject({ queue: 'chat', name: 'chat.command', opts: { jobId: `chat-${(p as { id: string }).id}`, delayMs: FOLLOW_UP_DELAY_MS } });
      expect(enqueued[0].payload).toMatchObject({ applicationId: APP, intent: { kind: 'create', title: 'Fix login' }, actor: { connectionId: w.conn.id, externalUserId: U_MEMBER, channelId: CHAN, tenantId: GUILD, canManageServer: false } });
      expect(await prisma.task.count({ where: { workspaceId: w.ws.id } })).toBe(0);
    });

    it('the job creates the task AS THE LINKED USER in the channel\u2019s project, tags the activity with the echo source, and edits the original reply', async () => {
      const w = await world();
      await body(slash(U_MEMBER, 'create', [{ name: 'title', value: 'Fix login' }, { name: 'priority', value: 'HIGH' }, { name: 'due', value: '2026-12-31' }]));
      await runJob();
      const t = await prisma.task.findFirstOrThrow({ where: { workspaceId: w.ws.id } });
      expect(t).toMatchObject({ title: 'Fix login', projectId: w.project.id, createdById: w.member.id, priority: 'HIGH' });
      const act = await prisma.activity.findFirstOrThrow({ where: { targetId: t.id, action: 'CREATED' } });
      expect(act.metadata).toMatchObject({ origin: 'INTEGRATION', integration: { connectionId: w.conn.id, channelId: CHAN } });
      expect(adapter.replies).toHaveLength(1);
      expect(adapter.replies[0].target).toEqual({ applicationId: APP, interactionToken: enqueued[0].payload.interactionToken });
      const key = await keyOf(t.id);
      expect(lastReply()).toMatchObject({ visibility: 'public', text: expect.stringContaining(`**${key}** created: Fix login`), task: { id: t.id, key, url: `http://fe.test/tasks/${key}` } });
      expect(await prisma.chatCommandRun.findFirstOrThrow()).toMatchObject({ status: 'DONE' });
    });

    it('project option: by name (any case); unknown name and ambiguous name are private errors BEFORE the ack', async () => {
      const w = await world();
      const other = await createProject(prisma, { workspaceId: w.ws.id, createdById: w.owner.id, name: 'Mobile' } as never);
      await body(slash(U_OWNER, 'create', [{ name: 'title', value: 'a' }, { name: 'project', value: 'mObIlE' }]));
      await runJob();
      expect((await prisma.task.findFirstOrThrow({ where: { title: 'a' } })).projectId).toBe(other.id);
      const unknown = await body(slash(U_OWNER, 'create', [{ name: 'title', value: 'b' }, { name: 'project', value: 'Nope' }]));
      expect(unknown).toMatchObject({ type: 4, data: { flags: 64 } });
      await createProject(prisma, { workspaceId: w.ws.id, createdById: w.owner.id, name: 'Twin' } as never);
      await createProject(prisma, { workspaceId: w.ws.id, createdById: w.owner.id, name: 'twin' } as never);
      expect(((await body(slash(U_OWNER, 'create', [{ name: 'title', value: 'c' }, { name: 'project', value: 'TWIN' }]))).data as { content: string }).content).toMatch(/More than one/);
      expect(enqueued).toHaveLength(1);
    });

    it('a VIEWER (linked, but may not create tasks) is refused privately before any job exists', async () => {
      const w = await world();
      const r = await body(slash(U_VIEWER, 'create', [{ name: 'title', value: 'nope' }]));
      expect(r).toMatchObject({ type: 4, data: { flags: 64 } });
      expect((r.data as { content: string }).content).toMatch(/not allowed/);
      expect(enqueued).toHaveLength(0);
      expect(await prisma.task.count({ where: { workspaceId: w.ws.id } })).toBe(0);
    });

    it('a server with no workspace link explains how to link it', async () => {
      const w = await world(); await prisma.channelLink.deleteMany({});
      expect(((await body(slash(U_MEMBER, 'create', [{ name: 'title', value: 'x' }]))).data as { content: string }).content).toMatch(/\/task link workspace/);
      void w;
    });

    it('a PAUSED (revoked) link is not used', async () => {
      await world(); await prisma.channelLink.updateMany({ data: { pausedAt: new Date() } });
      expect(((await body(slash(U_MEMBER, 'create', [{ name: 'title', value: 'x' }]))).data as { content: string }).content).toMatch(/not linked/);
    });

    it('assignee: a linked user is assigned; an unlinked one is refused and NO link token is issued for them', async () => {
      const w = await world();
      await body(slash(U_MEMBER, 'create', [{ name: 'title', value: 'a' }, { name: 'assignee', type: 6, value: U_OWNER }]));
      await runJob();
      const t = await prisma.task.findFirstOrThrow({ where: { title: 'a' }, include: { assignees: true } });
      expect(t.assignees.map((u) => u.id)).toEqual([w.owner.id]);
      const r = await body(slash(U_MEMBER, 'create', [{ name: 'title', value: 'b' }, { name: 'assignee', type: 6, value: U_STRANGER }]));
      expect((r.data as { content: string }).content).toMatch(/not linked/);
      expect(await prisma.identityLinkToken.count()).toBe(0);
    });

    it('queue down: a private "busy" reply instead of a hung "thinking..."', async () => {
      await world(); enqueueFails = true;
      const r = await body(slash(U_MEMBER, 'create', [{ name: 'title', value: 'x' }]));
      expect(r).toMatchObject({ type: 4, data: { flags: 64 } });
      expect((r.data as { content: string }).content).toMatch(/busy/);
    });

    it('echo guard end to end: the channel the command came from is not notified again, another subscribed channel is', async () => {
      const w = await world();
      const sub = (linkId: string) => prisma.channelSubscription.create({ data: { channelLinkId: linkId, events: [...DEFAULT_EVENTS] } });
      await sub(w.chanLink.id);
      const l2 = await prisma.channelLink.create({ data: { connectionId: w.conn.id, kind: 'CHANNEL', externalId: CHAN2, workspaceId: w.ws.id, configuredById: w.owner.id } });
      await sub(l2.id);
      await body(slash(U_MEMBER, 'create', [{ name: 'title', value: 'Echo test' }]));
      await runJob();
      await new Promise((r) => setTimeout(r, 250)); // the router runs asynchronously on activity.created
      const deliveries = await prisma.channelDelivery.findMany({ include: { subscription: { include: { channelLink: true } } } });
      const byChannel = Object.fromEntries(deliveries.map((d) => [d.subscription.channelLink.externalId, d.status + (d.error ? `:${d.error}` : '')]));
      expect(byChannel).toEqual({ [CHAN]: 'SKIPPED:echo', [CHAN2]: 'PENDING' });
    });
  });

  // ---------------------------------------------------------------- update / assign / list

  describe('update, assign, buttons, list', () => {
    const makeTask = async (w: W, title = 'Existing') => createTask(prisma, { workspaceId: w.ws.id, createdById: w.owner.id, projectId: w.project.id, title });

    it('update: acked EPHEMERALLY; the job changes the task as the caller and replies privately', async () => {
      const w = await world(); const t = await makeTask(w); const key = await keyOf(t.id);
      expect(await body(slash(U_MEMBER, 'update', [{ name: 'key', value: key }, { name: 'status', value: 'DONE' }, { name: 'title', value: 'Renamed' }]))).toEqual({ type: 5, data: { flags: 64 } });
      await runJob();
      expect(await prisma.task.findUniqueOrThrow({ where: { id: t.id } })).toMatchObject({ status: 'DONE', title: 'Renamed' });
      expect(lastReply()).toMatchObject({ visibility: 'private', text: `Updated **${key}**.` });
    });

    it('key lookups are case-insensitive, and "unknown key", "key of ANOTHER account" and "task you cannot see" say the same thing', async () => {
      const w = await world(); const t = await makeTask(w); const key = (await keyOf(t.id)).toLowerCase();
      await body(slash(U_MEMBER, 'update', [{ name: 'key', value: key }, { name: 'priority', value: 'LOW' }])); await runJob();
      expect((await prisma.task.findUniqueOrThrow({ where: { id: t.id } })).priority).toBe('LOW');
      const o = await createUserWithAccount(prisma, { role: Role.OWNER });
      const ows = await createWorkspace(prisma, { accountId: o.account.id });
      const foreign = await createTask(prisma, { workspaceId: ows.id, createdById: o.user.id, title: 'Foreign' });
      for (const k of ['ZZZ-999', await keyOf(foreign.id)]) {
        await body(slash(U_MEMBER, 'update', [{ name: 'key', value: k }, { name: 'priority', value: 'HIGH' }])); await runJob();
        expect(lastReply().text).toBe('No task with that key.');
      }
      expect((await prisma.task.findUniqueOrThrow({ where: { id: foreign.id } })).priority).not.toBe('HIGH');
    });

    it('a VIEWER cannot edit (private refusal from the job); the task is unchanged', async () => {
      const w = await world(); const t = await makeTask(w); const key = await keyOf(t.id);
      await body(slash(U_VIEWER, 'update', [{ name: 'key', value: key }, { name: 'status', value: 'DONE' }])); await runJob();
      expect(lastReply().text).toMatch(/not allowed/);
      expect((await prisma.task.findUniqueOrThrow({ where: { id: t.id } })).status).not.toBe('DONE');
    });

    it('assign: to a linked user works; an unlinked mention is refused with no token issued; existing assignees are kept', async () => {
      const w = await world(); const t = await makeTask(w); const key = await keyOf(t.id);
      await body(slash(U_OWNER, 'assign', [{ name: 'key', value: key }, { name: 'user', type: 6, value: U_OWNER }])); await runJob();
      await body(slash(U_OWNER, 'assign', [{ name: 'key', value: key }, { name: 'user', type: 6, value: U_MEMBER }])); await runJob();
      const after = await prisma.task.findUniqueOrThrow({ where: { id: t.id }, include: { assignees: true } });
      expect(after.assignees.map((u) => u.id).sort()).toEqual([w.owner.id, w.member.id].sort());
      await body(slash(U_OWNER, 'assign', [{ name: 'key', value: key }, { name: 'user', type: 6, value: U_STRANGER }])); await runJob();
      expect(lastReply().text).toMatch(/not linked|has not linked/);
      expect(await prisma.identityLinkToken.count()).toBe(0);
    });

    it('buttons: "Assign to me" assigns the CLICKER; a task id from another account is refused', async () => {
      const w = await world(); const t = await makeTask(w);
      const click = (ext: string, taskId: string) => base({ type: 3, ...asUser(ext), data: { custom_id: `a:${taskId}` } });
      expect(await body(click(U_MEMBER, t.id))).toEqual({ type: 5, data: { flags: 64 } });
      await runJob();
      expect((await prisma.task.findUniqueOrThrow({ where: { id: t.id }, include: { assignees: true } })).assignees.map((u) => u.id)).toEqual([w.member.id]);
      const o = await createUserWithAccount(prisma, { role: Role.OWNER });
      const foreign = await createTask(prisma, { workspaceId: (await createWorkspace(prisma, { accountId: o.account.id })).id, createdById: o.user.id, title: 'F' });
      await body(click(U_MEMBER, foreign.id)); await runJob();
      expect(lastReply().text).toBe('No task with that key.');
    });

    it('cross-tenant: someone who belongs to BOTH accounts cannot touch the other account\u2019s task through this server\u2019s bot (button or key)', async () => {
      const w = await world();
      const o = await createUserWithAccount(prisma, { role: Role.OWNER });
      await addAccountMember(prisma, { accountId: o.account.id, userId: w.member.id, role: Role.OWNER }); // member is a full owner of account B too
      const bws = await createWorkspace(prisma, { accountId: o.account.id });
      const bTask = await createTask(prisma, { workspaceId: bws.id, createdById: o.user.id, title: 'Other tenant' });
      // sanity: through the normal API rules this person MAY edit that task
      expect((await resolver.resolve(w.member.id, 'editTask', 'TASK', bTask.id)).allowed).toBe(true);
      await body(base({ type: 3, ...asUser(U_MEMBER), data: { custom_id: `a:${bTask.id}` } })); await runJob();
      expect(lastReply().text).toBe('No task with that key.');
      expect((await prisma.task.findUniqueOrThrow({ where: { id: bTask.id }, include: { assignees: true } })).assignees).toHaveLength(0);
      const bKey = await keyOf(bTask.id);
      await body(slash(U_MEMBER, 'update', [{ name: 'key', value: bKey }, { name: 'priority', value: 'URGENT' }])); await runJob();
      expect(lastReply().text).toBe('No task with that key.');
      expect((await prisma.task.findUniqueOrThrow({ where: { id: bTask.id } })).priority).not.toBe('URGENT');
      await body(base({ type: 3, ...asUser(U_MEMBER), data: { custom_id: `d:${bTask.id}` } }));
      await body(base({ type: 5, ...asUser(U_MEMBER), data: { custom_id: `d:${bTask.id}`, components: [{ components: [{ custom_id: 'date', value: '2030-01-01' }] }] } })); await runJob();
      expect(lastReply().text).toBe('No task with that key.');
      expect((await prisma.task.findUniqueOrThrow({ where: { id: bTask.id } })).dueDate).toBeNull();
    });

    it('"Set due": the button opens a date modal; submitting it sets the date; a bad date is refused before the ack', async () => {
      const w = await world(); const t = await makeTask(w);
      const modal = await body(base({ type: 3, ...asUser(U_MEMBER), data: { custom_id: `d:${t.id}` } }));
      expect(modal).toMatchObject({ type: 9, data: { custom_id: `d:${t.id}` } });
      const submit = (date: string) => base({ type: 5, ...asUser(U_MEMBER), data: { custom_id: `d:${t.id}`, components: [{ components: [{ custom_id: 'date', value: date }] }] } });
      expect(((await body(submit('soon'))).data as { content: string }).content).toMatch(/YYYY-MM-DD/);
      expect(await body(submit('2027-03-04'))).toEqual({ type: 5, data: { flags: 64 } });
      await runJob();
      expect((await prisma.task.findUniqueOrThrow({ where: { id: t.id } })).dueDate?.toISOString().slice(0, 10)).toBe('2027-03-04');
    });

    it('list: private, shows keys, honours "mine", scopes to the channel\u2019s project', async () => {
      const w = await world();
      const a = await makeTask(w, 'Alpha'); await makeTask(w, 'Beta');
      const elsewhere = await createProject(prisma, { workspaceId: w.ws.id, createdById: w.owner.id, name: 'Other' } as never);
      await createTask(prisma, { workspaceId: w.ws.id, createdById: w.owner.id, projectId: elsewhere.id, title: 'Gamma' });
      await prisma.task.update({ where: { id: a.id }, data: { assignees: { connect: { id: w.member.id } } } });
      expect(await body(slash(U_MEMBER, 'list', []))).toEqual({ type: 5, data: { flags: 64 } });
      await runJob();
      const all = [lastReply().text, ...(lastReply().lines ?? [])].join('\n');
      expect(all).toContain('2 tasks'); expect(all).toContain('Alpha'); expect(all).toContain('Beta'); expect(all).not.toContain('Gamma');
      await body({ ...slash(U_MEMBER, 'list', []), data: { name: 'task', type: 1, options: [{ name: 'list', type: 1, options: [{ name: 'mine', type: 5, value: true }] }] } }); await runJob();
      const mine = [lastReply().text, ...(lastReply().lines ?? [])].join('\n');
      expect(mine).toContain('Alpha'); expect(mine).not.toContain('Beta');
    });
  });

  // ---------------------------------------------------------------- link

  describe('/task link', () => {
    const linkCmd = (ext: string, perms: string, opts: Array<{ name: string; value: string }>, channel = CHAN2) =>
      slash(ext, 'link', opts, { channel_id: channel, perms, member: { user: { id: ext }, permissions: perms } });

    it('needs Manage Server: without it, refused', async () => {
      await world();
      await body(linkCmd(U_OWNER, '0', [{ name: 'workspace', value: 'ENG' }])); await runJob();
      expect(lastReply().text).toMatch(/Manage Server/);
    });

    it('Manage Server alone is not enough: the caller must also be a workspace admin in the app', async () => {
      const w = await world();
      await body(linkCmd(U_MEMBER, MANAGE, [{ name: 'workspace', value: w.ws.key }])); await runJob();
      expect(lastReply().text).toMatch(/workspace admins/);
    });

    it('server -> workspace, channel -> project, with the default subscription created once (and re-running changes nothing)', async () => {
      const w = await world(); await prisma.channelLink.deleteMany({});
      const other = await createProject(prisma, { workspaceId: w.ws.id, createdById: w.owner.id, name: 'Mobile' } as never);
      await body(linkCmd(U_OWNER, MANAGE, [{ name: 'workspace', value: w.ws.key.toLowerCase() }, { name: 'project', value: 'mobile' }])); await runJob();
      expect(lastReply().text).toContain('Done');
      const guild = await prisma.channelLink.findFirstOrThrow({ where: { kind: 'GUILD' } });
      const chan = await prisma.channelLink.findFirstOrThrow({ where: { kind: 'CHANNEL' }, include: { subscriptions: true } });
      expect(guild).toMatchObject({ externalId: GUILD, workspaceId: w.ws.id, configuredById: w.owner.id });
      expect(chan).toMatchObject({ externalId: CHAN2, projectId: other.id });
      expect(chan.subscriptions).toHaveLength(1);
      expect(chan.subscriptions[0].events.sort()).toEqual([...DEFAULT_EVENTS].sort());
      await body(linkCmd(U_OWNER, MANAGE, [{ name: 'project', value: 'Website' }])); await runJob(); // re-point THIS channel
      expect(await prisma.channelLink.count({ where: { kind: 'CHANNEL' } })).toBe(1);
      expect((await prisma.channelLink.findFirstOrThrow({ where: { kind: 'CHANNEL' } })).projectId).toBe(w.project.id);
      expect(await prisma.channelSubscription.count()).toBe(1);
    });

    it('project-only link needs the server linked first; unknown workspace key and unknown project are explained; no options shows the current link', async () => {
      const w = await world(); await prisma.channelLink.deleteMany({});
      await body(linkCmd(U_OWNER, MANAGE, [{ name: 'project', value: 'Website' }])); await runJob();
      expect(lastReply().text).toMatch(/server to a workspace first/);
      await body(linkCmd(U_OWNER, MANAGE, [{ name: 'workspace', value: 'NOPE' }])); await runJob();
      expect(lastReply().text).toMatch(/no workspace with key/);
      await body(linkCmd(U_OWNER, MANAGE, [{ name: 'workspace', value: w.ws.key }])); await runJob();
      await body(linkCmd(U_OWNER, MANAGE, [{ name: 'project', value: 'Ghost' }])); await runJob();
      expect(lastReply().text).toMatch(/no project called/);
      await body(linkCmd(U_OWNER, MANAGE, [])); await runJob();
      expect(lastReply().text).toContain(`**${w.ws.key}**`);
    });

    it('a workspace key from ANOTHER account cannot be linked', async () => {
      await world();
      const o = await createUserWithAccount(prisma, { role: Role.OWNER });
      const ows = await createWorkspace(prisma, { accountId: o.account.id });
      await body(linkCmd(U_OWNER, MANAGE, [{ name: 'workspace', value: ows.key }])); await runJob();
      expect(lastReply().text).toMatch(/no workspace with key/);
      expect(await prisma.channelLink.count({ where: { workspaceId: ows.id } })).toBe(0);
    });
  });

  // ---------------------------------------------------------------- message -> task

  describe('create task from a message / forum post', () => {
    const msgCmd = (ext: string, o: { messageId?: string; channelId?: string; channelType?: number; content?: string } = {}) => {
      const messageId = o.messageId ?? '666666666666666666';
      return base({ type: 2, ...asUser(ext), channel_id: o.channelId ?? CHAN, channel: { id: o.channelId ?? CHAN, type: o.channelType ?? 0 }, data: { name: 'Create task from message', type: 3, target_id: messageId, resolved: { messages: { [messageId]: { id: messageId, content: o.content ?? 'Login is broken\nsteps follow' } } } } });
    };
    const submit = (ext: string, customId: string, fields: Record<string, string>) =>
      base({ type: 5, ...asUser(ext), data: { custom_id: customId, components: Object.entries(fields).map(([k, v]) => ({ components: [{ custom_id: k, value: v }] })) } });

    it('opens a prefilled modal; submitting creates the task with a MESSAGE ExternalLink back to the message; doing it twice is refused', async () => {
      const w = await world();
      const m = await body(msgCmd(U_MEMBER));
      expect(m).toMatchObject({ type: 9, data: { custom_id: `mt:M:${CHAN}:666666666666666666` } });
      const sub = submit(U_MEMBER, `mt:M:${CHAN}:666666666666666666`, { title: 'Login is broken', description: 'steps follow', project: '' });
      expect(await body(sub)).toEqual({ type: 5, data: {} });
      await runJob();
      const t = await prisma.task.findFirstOrThrow({ where: { workspaceId: w.ws.id }, include: { externalLinks: true } });
      expect(t).toMatchObject({ title: 'Login is broken', description: 'steps follow', projectId: w.project.id });
      expect(t.externalLinks).toEqual([expect.objectContaining({ provider: 'DISCORD', kind: 'MESSAGE', externalId: `${CHAN}/666666666666666666`, url: `https://discord.com/channels/${GUILD}/${CHAN}/666666666666666666` })]);
      const again = await body(submit(U_MEMBER, `mt:M:${CHAN}:666666666666666666`, { title: 'Again' }));
      expect((again.data as { content: string }).content).toMatch(/already created/);
      expect(await prisma.task.count({ where: { workspaceId: w.ws.id } })).toBe(1);
    });

    it('a forum post (thread starter) becomes a THREAD link to the thread', async () => {
      const w = await world();
      const thread = '777777777777777777';
      const m = await body(msgCmd(U_MEMBER, { messageId: thread, channelId: thread, channelType: 11 }));
      expect((m.data as { custom_id: string }).custom_id).toBe(`mt:T:${thread}:${thread}`);
      await body(submit(U_MEMBER, `mt:T:${thread}:${thread}`, { title: 'Forum post' })); await runJob();
      const link = await prisma.externalLink.findFirstOrThrow({ where: { task: { workspaceId: w.ws.id } } });
      expect(link).toMatchObject({ kind: 'THREAD', externalId: thread, url: `https://discord.com/channels/${GUILD}/${thread}` });
    });

    it('an unlinked caller cannot even open the modal; an empty title is refused; a VIEWER is refused before the ack', async () => {
      await world();
      expect(await body(msgCmd(U_STRANGER))).toMatchObject({ type: 4, data: { flags: 64 } });
      expect(((await body(submit(U_MEMBER, `mt:M:${CHAN}:666666666666666666`, { title: '  ' }))).data as { content: string }).content).toMatch(/title/);
      const v = await body(submit(U_VIEWER, `mt:M:${CHAN}:666666666666666666`, { title: 'x' }));
      expect((v.data as { content: string }).content).toMatch(/not allowed/);
      expect(enqueued).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------- job semantics

  describe('chat.command job: writes at-most-once, replies at-least-once', () => {
    it('running the same job twice creates ONE task; the second run re-posts the stored result', async () => {
      const w = await world();
      await body(slash(U_MEMBER, 'create', [{ name: 'title', value: 'Once' }]));
      await runJob(); await runJob();
      expect(await prisma.task.count({ where: { workspaceId: w.ws.id } })).toBe(1);
      expect(adapter.replies).toHaveLength(2);
      expect(adapter.replies[1].result).toEqual(adapter.replies[0].result);
    });

    it('the reply failing (Discord hiccup) throws for a retry, and the retry delivers the SAME result without creating a second task', async () => {
      const w = await world();
      await body(slash(U_MEMBER, 'create', [{ name: 'title', value: 'Hiccup' }]));
      adapter.replyImpl = async () => { throw new Error('Discord follow-up HTTP 404'); };
      await expect(runJob()).rejects.toThrow('404');
      adapter.replyImpl = async () => undefined;
      await runJob();
      expect(await prisma.task.count({ where: { workspaceId: w.ws.id } })).toBe(1);
      expect(adapter.replies.at(-1)!.result.text).toContain('created');
    });

    it('a RUNNING ledger row (previous attempt died mid-write) is NOT re-executed: the user is told the outcome is unknown', async () => {
      const w = await world();
      const p = slash(U_MEMBER, 'create', [{ name: 'title', value: 'Maybe' }]);
      await body(p);
      await prisma.chatCommandRun.create({ data: { provider: 'DISCORD', interactionId: (p as { id: string }).id, status: 'RUNNING' } });
      await runJob();
      expect(await prisma.task.count({ where: { workspaceId: w.ws.id } })).toBe(0);
      expect(lastReply().text).toMatch(/may or may not have completed/);
    });

    it('an unexpected executor failure becomes a generic private message (no internals), recorded as DONE so it is not retried', async () => {
      const w = await world();
      await body(slash(U_MEMBER, 'create', [{ name: 'title', value: 'Boom' }]));
      await prisma.workspace.delete({ where: { id: w.ws.id } }).catch(() => undefined);
      await prisma.channelLink.deleteMany({});
      await runJob();
      expect(lastReply().visibility).toBe('private');
      expect(lastReply().text).not.toMatch(/prisma|stack|Error:|SELECT/i);
      expect((await prisma.chatCommandRun.findFirstOrThrow()).status).toBe('DONE');
    });
  });

  // ---------------------------------------------------------------- one live connection per guild

  describe('one live connection per provider tenant (DB-enforced)', () => {
    it('a second account cannot hold the same guild live; a REVOKED row does not block; reviving the old one then conflicts', async () => {
      const a = await createUserWithAccount(prisma, { role: Role.OWNER });
      const b = await createUserWithAccount(prisma, { role: Role.OWNER });
      const mk = (accountId: string, userId: string, status: 'ACTIVE' | 'REVOKED' | 'NEEDS_REAUTH' = 'ACTIVE') =>
        prisma.integrationConnection.create({ data: { accountId, provider: 'DISCORD', externalAccountId: GUILD, externalAccountName: 'G', createdById: userId, status } });
      const first = await mk(a.account.id, a.user.id);
      await expect(mk(b.account.id, b.user.id)).rejects.toMatchObject({ code: 'P2002' });
      await expect(mk(b.account.id, b.user.id, 'NEEDS_REAUTH')).rejects.toMatchObject({ code: 'P2002' });
      await prisma.integrationConnection.update({ where: { id: first.id }, data: { status: 'REVOKED' } });
      const second = await mk(b.account.id, b.user.id); // allowed now
      await expect(prisma.integrationConnection.update({ where: { id: first.id }, data: { status: 'ACTIVE' } })).rejects.toMatchObject({ code: 'P2002' });
      expect(second.status).toBe('ACTIVE');
    });

    it('the interaction is resolved to the ONE live connection of the guild, not to a revoked one', async () => {
      const w = await world();
      await prisma.integrationConnection.update({ where: { id: w.conn.id }, data: { status: 'REVOKED' } });
      expect(((await body(slash(U_OWNER, 'list', []))).data as { content: string }).content).toMatch(/not connected/);
    });
  });

  it('identity helper used for assignment never issues tokens or asks the provider', async () => {
    const w = await world();
    expect(await identities.lookupLinkedUserId(w.conn.id, U_MEMBER)).toBe(w.member.id);
    expect(await identities.lookupLinkedUserId(w.conn.id, U_STRANGER)).toBeNull();
    await prisma.accountMember.deleteMany({ where: { userId: w.member.id } });
    expect(await identities.lookupLinkedUserId(w.conn.id, U_MEMBER)).toBeNull();
    expect(await prisma.identityLinkToken.count()).toBe(0);
  });
});
