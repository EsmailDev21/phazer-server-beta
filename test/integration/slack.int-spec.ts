/**
 * Step 2.5 - Slack slash command, interactivity and Events API against a real DB, with HMAC-SIGNED fixtures.
 * The provider is a fake adapter that records what would be sent to Slack.
 */
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { IntegrationProvider, Role } from '@prisma/client';
import { createHmac, randomBytes } from 'crypto';
import { PermissionResolver } from '../../src/access-control/access-control.service';
import { PlanLimitsService } from '../../src/access-control/plan-limits.service';
import { TokenVaultService } from '../../src/crypto/token-vault.service';
import { DomainWriter } from '../../src/domain-writer/domain-writer.service';
import { ActivityService } from '../../src/events/activity.service';
import { AuditLogService } from '../../src/events/audit-log.service';
import { FeatureFlagsService } from '../../src/feature-flags/feature-flags.service';
import { ChatCommandExecutor } from '../../src/integrations/chat/chat-command.executor';
import { ChatCommandJob } from '../../src/integrations/chat/chat-command.job';
import { ChatCommandPayload, ChatResult } from '../../src/integrations/chat/chat.types';
import { ChatUnfurlJob, ChatUnfurlPayload } from '../../src/integrations/chat/slack/chat-unfurl.job';
import { SlackInteractionService } from '../../src/integrations/chat/slack/slack-interaction.service';
import { renderResult } from '../../src/integrations/chat/slack/slack.protocol';
import { ConnectorRegistry } from '../../src/integrations/core/connector.registry';
import { CredentialService } from '../../src/integrations/core/credential.service';
import { ConnectionLifecycleService } from '../../src/integrations/core/connection-lifecycle.service';
import { IdentityService } from '../../src/integrations/core/identity.service';
import { ConnectorAdapter, INTEGRATION_ADAPTERS } from '../../src/integrations/core/integration.types';
import { LinkPromptBuilder } from '../../src/integrations/core/link-prompt.builder';
import { LinkTokenService } from '../../src/integrations/core/link-token.service';
import { PromptThrottleService } from '../../src/integrations/core/prompt-throttle.service';
import { RedisLockService } from '../../src/integrations/core/redis-lock.service';
import { RichMessageBuilder } from '../../src/integrations/notify/rich-message.builder';
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

const SECRET = 'slack-signing-secret-for-tests-0123';
const KEY = randomBytes(32).toString('base64');
const settings: Record<string, string> = { SLACK_SIGNING_SECRET: SECRET, FRONTEND_URL: 'http://fe.test' };

const TEAM = 'T0TEAM001';
const CHAN = 'C0CHAN001';
const CHAN2 = 'C0CHAN002';
const U_OWNER = 'U0OWNER01';
const U_MEMBER = 'U0MEMBER1';
const U_VIEWER = 'U0VIEWER1';
const U_STRANGER = 'U0STRANG1';
const RESP = 'https://hooks.slack.com/commands/T0TEAM001/397700885554/abcDEFghi';
const TS = '1700000000.000100';

class FakeSlack implements ConnectorAdapter {
  readonly provider = IntegrationProvider.SLACK;
  readonly capabilities = new Set<never>();
  readonly usesPkce = false;
  admin = false;
  adminCalls = 0;
  openFails = false;
  opened: Array<{ token: string; trigger: string; view: { callback_id: string; blocks: Array<{ element: { initial_value?: string } }> } }> = [];
  unfurled: Array<{ token: string; channel: string; ts: string; unfurls: Record<string, unknown> }> = [];
  replies: Array<{ target: { applicationId: string; interactionToken: string; reply?: { channelId?: string; threadTs?: string; userId?: string }; accessToken?: string }; result: ChatResult }> = [];
  isConfigured() { return true; }
  authorizeUrl() { return 'x'; }
  async exchangeCode(): Promise<never> { throw new Error('unused'); }
  async revoke() { /* noop */ }
  async isWorkspaceAdmin() { this.adminCalls++; return this.admin; }
  async openView(token: string, trigger: string, view: never) { if (this.openFails) throw new Error('expired_trigger_id'); this.opened.push({ token, trigger, view }); }
  async unfurl(token: string, a: { channel: string; ts: string; unfurls: Record<string, unknown> }) { this.unfurled.push({ token, ...a }); }
  async chatReply(target: never, result: ChatResult) { this.replies.push({ target, result }); }
}

describe('slack commands, interactivity, events (step 2.5)', () => {
  let prisma: PrismaService;
  let svc: SlackInteractionService;
  let chatJob: ChatCommandJob;
  let unfurlJob: ChatUnfurlJob;
  let adapter: FakeSlack;
  let creds: CredentialService;
  let resolver: PermissionResolver;
  const enqueued: Array<{ queue: string; name: string; payload: never; opts: { jobId?: string; delayMs?: number } }> = [];
  let enqueueFails = false;
  let seq = 0;

  beforeAll(async () => {
    prisma = getTestPrisma();
    adapter = new FakeSlack();
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
        { provide: QueueService, useValue: { enqueue: async (queue: string, name: string, payload: never, opts: never) => { if (enqueueFails) throw new Error('redis down'); enqueued.push({ queue, name, payload, opts }); return {}; } } },
        ActivityService, AuditLogService, PermissionResolver, PlanLimitsService, ConnectorRegistry, RedisLockService, CredentialService, ConnectionLifecycleService,
        LinkPromptBuilder, LinkTokenService, PromptThrottleService, IdentityService, WebhookDedupeService, RichMessageBuilder,
        TaskVisibilityService, TasksService, TaskTreeService, WorkflowService, TaskPlanningService, IssueTypesService, IterationsService,
        ProjectsService, CustomFieldsService, WorkspaceKeysService, WorkspacesService, DomainWriter,
        ChatCommandExecutor, ChatCommandJob, ChatUnfurlJob, SlackInteractionService,
      ],
    }).compile();
    await m.init();
    svc = m.get(SlackInteractionService); chatJob = m.get(ChatCommandJob); unfurlJob = m.get(ChatUnfurlJob); creds = m.get(CredentialService); resolver = m.get(PermissionResolver);
  });
  beforeEach(async () => {
    await resetDb(prisma);
    Object.assign(adapter, { admin: false, adminCalls: 0, openFails: false, opened: [], unfurled: [], replies: [] });
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
    const conn = await prisma.integrationConnection.create({ data: { accountId: account.id, provider: 'SLACK', externalAccountId: TEAM, externalAccountName: 'Acme', createdById: owner.id } });
    await creds.store(conn.id, { accessToken: 'xoxb-test', scopes: [] });
    const link = (userId: string, ext: string) => prisma.identityLink.create({ data: { connectionId: conn.id, externalUserId: ext, userId, method: 'MANUAL' } });
    await link(owner.id, U_OWNER); await link(member.id, U_MEMBER); await link(viewer.id, U_VIEWER);
    await prisma.channelLink.create({ data: { connectionId: conn.id, kind: 'GUILD', externalId: TEAM, workspaceId: ws.id, configuredById: owner.id } });
    const chanLink = await prisma.channelLink.create({ data: { connectionId: conn.id, kind: 'CHANNEL', externalId: CHAN, workspaceId: ws.id, projectId: project.id, configuredById: owner.id } });
    return { owner, member, viewer, account, ws, project, conn, chanLink };
  }
  type W = Awaited<ReturnType<typeof world>>;

  const nowSec = () => Math.floor(Date.now() / 1000);
  const sigOf = (ts: string, raw: Buffer, secret = SECRET) => 'v0=' + createHmac('sha256', secret).update(`v0:${ts}:`).update(raw).digest('hex');
  const trig = () => `${++seq}.${900000 + seq}.abcdef${seq}`;

  /** A correctly signed request as Slack sends it: form-encoded (commands, interactivity) or JSON (events). */
  function signed(kind: 'form' | 'json', fields: Record<string, unknown>, o: { ts?: string; tamper?: boolean; secret?: string } = {}) {
    const rawStr = kind === 'form' ? new URLSearchParams(Object.entries(fields).map(([k, v]) => [k, String(v)])).toString() : JSON.stringify(fields);
    const raw = Buffer.from(rawStr);
    const ts = o.ts ?? String(nowSec());
    const payload = kind === 'form' ? Object.fromEntries(new URLSearchParams(rawStr)) : fields;
    return { rawBody: o.tamper ? Buffer.from(rawStr + 'x') : raw, signature: sigOf(ts, raw, o.secret), timestamp: ts, payload };
  }
  const cmdFields = (ext: string, text: string, over: Record<string, unknown> = {}) => ({ team_id: TEAM, user_id: ext, channel_id: CHAN, command: '/task', text, response_url: RESP, trigger_id: trig(), ...over });
  const command = (ext: string, text: string, over: Record<string, unknown> = {}) => svc.handleCommand(signed('form', cmdFields(ext, text, over)));
  const okBody = async (p: Promise<{ status: number; body?: unknown }>) => { const r = await p; if (r.status !== 200) throw new Error('expected 200, got ' + r.status); return r.body as Record<string, unknown> | string; };
  const interact = (payload: Record<string, unknown>) => svc.handleInteractivity(signed('form', { payload: JSON.stringify({ trigger_id: trig(), team: { id: TEAM }, ...payload }) }));
  const event = (e: Record<string, unknown>, o?: Parameters<typeof signed>[2]) => svc.handleEvent(signed('json', e, o));

  const runChat = (which = enqueued.length - 1) => chatJob.handle({ v: 1, traceId: 't', accountId: null, actorId: null, payload: enqueued[which].payload as ChatCommandPayload & { interactionId: string } });
  const runUnfurl = (which = enqueued.length - 1) => unfurlJob.handle({ v: 1, traceId: 't', accountId: null, actorId: null, payload: enqueued[which].payload as ChatUnfurlPayload });
  const lastReply = () => adapter.replies[adapter.replies.length - 1];
  const keyOf = async (taskId: string) => { const t = await prisma.task.findUniqueOrThrow({ where: { id: taskId }, select: { number: true, workspace: { select: { key: true } } } }); return `${t.workspace.key}-${t.number}`; };
  const txt = (b: unknown) => JSON.stringify(b);

  // ---------------------------------------------------------------- verification

  describe('request verification', () => {
    it('unsigned, wrong secret, tampered body, expired timestamp: all 401 on every route, and NOTHING is written or enqueued', async () => {
      const w = await world();
      const f = cmdFields(U_OWNER, 'create x');
      for (const handler of [(s: ReturnType<typeof signed>) => svc.handleCommand(s), (s: ReturnType<typeof signed>) => svc.handleInteractivity(s), (s: ReturnType<typeof signed>) => svc.handleEvent(s)]) {
        expect(await handler({ ...signed('form', f), signature: undefined as never })).toEqual({ status: 401 });
        expect(await handler(signed('form', f, { secret: 'a-different-secret-entirely' }))).toEqual({ status: 401 });
        expect(await handler(signed('form', f, { tamper: true }))).toEqual({ status: 401 });
        expect(await handler(signed('form', f, { ts: String(nowSec() - 3600) }))).toEqual({ status: 401 });
      }
      expect(await prisma.integrationWebhookEvent.count()).toBe(0);
      expect(enqueued).toHaveLength(0);
      expect(await prisma.task.count({ where: { workspaceId: w.ws.id } })).toBe(0);
    });

    it('no signing secret configured -> everything is 401 (fail closed)', async () => {
      const saved = settings.SLACK_SIGNING_SECRET; delete settings.SLACK_SIGNING_SECRET;
      try { expect(await svc.handleCommand(signed('form', cmdFields(U_OWNER, 'list')))).toEqual({ status: 401 }); } finally { settings.SLACK_SIGNING_SECRET = saved; }
    });

    it('url_verification answers the challenge ONLY when signed (an unsigned one learns nothing)', async () => {
      expect(await event({ type: 'url_verification', challenge: 'abc123' })).toEqual({ status: 200, body: { challenge: 'abc123' } });
      expect(await event({ type: 'url_verification', challenge: 'abc123' }, { tamper: true })).toEqual({ status: 401 });
      expect(await event({ type: 'url_verification', challenge: 'abc123' }, { secret: 'nope-nope-nope' })).toEqual({ status: 401 });
    });

    it('a repeated trigger_id (Slack retry) is answered but not processed twice', async () => {
      await world();
      const f = cmdFields(U_MEMBER, 'create once');
      expect(await okBody(svc.handleCommand(signed('form', f)))).toBe('');
      const again = await okBody(svc.handleCommand(signed('form', f)));
      expect((again as { text: string }).text).toMatch(/already received/);
      expect(enqueued).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------- slash command

  describe('/task', () => {
    it('create: empty 200 ack, work queued with the response_url, nothing written yet; the job creates the task AS the linked user with the echo source and replies via response_url', async () => {
      const w = await world();
      expect(await okBody(command(U_MEMBER, 'create Fix login page priority:high due:2026-12-31'))).toBe('');
      expect(enqueued).toHaveLength(1);
      expect(enqueued[0]).toMatchObject({ queue: 'chat', name: 'chat.command' });
      expect(enqueued[0].payload).toMatchObject({ provider: 'SLACK', applicationId: TEAM, interactionToken: RESP, visibility: 'public', intent: { kind: 'create', title: 'Fix login page', priority: 'HIGH', due: '2026-12-31' }, actor: { connectionId: w.conn.id, externalUserId: U_MEMBER, channelId: CHAN, tenantId: TEAM } });
      expect(await prisma.task.count({ where: { workspaceId: w.ws.id } })).toBe(0);
      await runChat();
      const t = await prisma.task.findFirstOrThrow({ where: { workspaceId: w.ws.id } });
      expect(t).toMatchObject({ title: 'Fix login page', projectId: w.project.id, createdById: w.member.id, priority: 'HIGH' });
      const act = await prisma.activity.findFirstOrThrow({ where: { targetId: t.id, action: 'CREATED' } });
      expect(act.metadata).toMatchObject({ origin: 'INTEGRATION', integration: { connectionId: w.conn.id, channelId: CHAN } });
      expect(lastReply().target).toEqual({ applicationId: TEAM, interactionToken: RESP, reply: undefined, accessToken: undefined });
      const key = await keyOf(t.id);
      expect(lastReply().result).toMatchObject({ visibility: 'public', task: { id: t.id, key, url: `http://fe.test/tasks/${key}` } });
    });

    it('an unlinked caller gets an EPHEMERAL prompt with a one-time link button; nothing is queued or created', async () => {
      const w = await world();
      const r = await okBody(command(U_STRANGER, 'create sneaky')) as { response_type: string; blocks: Array<{ elements?: Array<{ url: string }> }> };
      expect(r.response_type).toBe('ephemeral');
      expect(r.blocks[1].elements![0].url).toMatch(/^http:\/\/fe\.test\/settings\/integrations\/link\?token=[A-Za-z0-9_-]{43}&connectionId=/);
      expect(enqueued).toHaveLength(0);
      expect(await prisma.task.count({ where: { workspaceId: w.ws.id } })).toBe(0);
    });

    it('help and malformed commands are private text; a MALFORMED command from an unlinked caller issues no link token', async () => {
      await world();
      expect(((await okBody(command(U_MEMBER, 'help'))) as { response_type: string; text: string }).text).toContain('/task');
      expect(((await okBody(command(U_STRANGER, 'create'))) as { text: string }).text).toMatch(/title/);
      expect(((await okBody(command(U_MEMBER, 'update ENG-1'))) as { text: string }).text).toMatch(/Nothing to change/);
      expect(await prisma.identityLinkToken.count()).toBe(0);
      expect(enqueued).toHaveLength(0);
    });

    it('SSRF: a response_url that is not Slack\u2019s is refused before anything is queued', async () => {
      await world();
      for (const bad of ['https://evil.test/hook', 'http://hooks.slack.com/commands/T/1/a', 'https://hooks.slack.com.evil.test/commands/T/1/a', 'https://169.254.169.254/latest/meta-data']) {
        expect(((await okBody(command(U_MEMBER, 'create x', { response_url: bad }))) as { text: string }).text).toMatch(/Unsupported/);
      }
      expect(enqueued).toHaveLength(0);
    });

    it('malformed ids (user, channel, team) are refused', async () => {
      await world();
      for (const over of [{ user_id: '../x' }, { channel_id: 'general' }, { team_id: 'oops' }]) expect(((await okBody(command(U_MEMBER, 'list', over))) as { text: string }).text).toMatch(/Unsupported/);
      expect(enqueued).toHaveLength(0);
    });

    it('a VIEWER is refused privately before any job; an unconnected or REVOKED workspace is explained', async () => {
      const w = await world();
      expect(((await okBody(command(U_VIEWER, 'create nope'))) as { text: string }).text).toMatch(/not allowed/);
      expect(enqueued).toHaveLength(0);
      expect(((await okBody(command(U_MEMBER, 'list', { team_id: 'T0OTHER99' }))) as { text: string }).text).toMatch(/not connected/);
      await prisma.integrationConnection.update({ where: { id: w.conn.id }, data: { status: 'REVOKED' } });
      expect(((await okBody(command(U_MEMBER, 'list'))) as { text: string }).text).toMatch(/not connected/);
    });

    it('queue down -> a private "busy" message, not silence', async () => {
      await world(); enqueueFails = true;
      expect(((await okBody(command(U_MEMBER, 'create x'))) as { text: string }).text).toMatch(/busy/);
    });

    it('update / assign / list run through the job as the caller and answer privately', async () => {
      const w = await world();
      const t = await createTask(prisma, { workspaceId: w.ws.id, createdById: w.owner.id, projectId: w.project.id, title: 'Existing' });
      const key = await keyOf(t.id);
      await command(U_MEMBER, `update ${key.toLowerCase()} status:done title:"Renamed it"`); await runChat();
      expect(await prisma.task.findUniqueOrThrow({ where: { id: t.id } })).toMatchObject({ status: 'DONE', title: 'Renamed it' });
      expect(lastReply().result).toMatchObject({ visibility: 'private', text: `Updated **${key}**.` });
      await command(U_OWNER, `assign ${key} <@${U_MEMBER}|mia>`); await runChat();
      expect((await prisma.task.findUniqueOrThrow({ where: { id: t.id }, include: { assignees: true } })).assignees.map((u) => u.id)).toEqual([w.member.id]);
      await command(U_OWNER, `assign ${key} <@${U_STRANGER}>`); await runChat();
      expect(lastReply().result.text).toMatch(/not linked|has not linked/);
      expect(await prisma.identityLinkToken.count()).toBe(0);
      await command(U_MEMBER, 'list mine'); await runChat();
      expect([lastReply().result.text, ...(lastReply().result.lines ?? [])].join('\n')).toContain('Renamed it');
    });

    it('a VIEWER cannot edit; a key from another account answers exactly like an unknown key', async () => {
      const w = await world();
      const t = await createTask(prisma, { workspaceId: w.ws.id, createdById: w.owner.id, projectId: w.project.id, title: 'Existing' });
      await command(U_VIEWER, `update ${await keyOf(t.id)} status:DONE`); await runChat();
      expect(lastReply().result.text).toMatch(/not allowed/);
      const o = await createUserWithAccount(prisma, { role: Role.OWNER });
      const foreign = await createTask(prisma, { workspaceId: (await createWorkspace(prisma, { accountId: o.account.id })).id, createdById: o.user.id, title: 'F' });
      for (const k of ['ZZZ-999', await keyOf(foreign.id)]) { await command(U_MEMBER, `update ${k} priority:HIGH`); await runChat(); expect(lastReply().result.text).toBe('No task with that key.'); }
    });

    it('MARKUP INJECTION: a title full of <!channel> and <https://evil|links> is stored verbatim but RENDERED escaped, so it cannot ping or forge links', async () => {
      const w = await world();
      await command(U_MEMBER, 'create <!channel> <!here> look <https://evil.test|click> <@U0OWNER01>'); await runChat();
      const t = await prisma.task.findFirstOrThrow({ where: { workspaceId: w.ws.id } });
      expect(t.title).toContain('<!channel>');
      const rendered = JSON.stringify(renderResult(lastReply().result));
      expect(rendered).not.toContain('<!channel>'); expect(rendered).not.toContain('<!here>'); expect(rendered).not.toContain('<https://evil.test');
      expect(rendered).toContain('&lt;!channel&gt;');
    });

    it('/task link: only a Slack workspace admin who is also a workspace admin in the app; the admin lookup happens ONLY for link', async () => {
      const w = await world(); await prisma.channelLink.deleteMany({});
      await command(U_OWNER, 'list'); expect(adapter.adminCalls).toBe(0);
      adapter.admin = false;
      await command(U_OWNER, `link workspace:${w.ws.key}`); await runChat();
      expect(lastReply().result.text).toMatch(/Slack workspace admins/);
      adapter.admin = true;
      await command(U_MEMBER, `link workspace:${w.ws.key}`); await runChat();
      expect(lastReply().result.text).toMatch(/workspace admins/); // Slack admin but only a MEMBER in the app
      await command(U_OWNER, `link workspace:${w.ws.key.toLowerCase()} project:website`); await runChat();
      expect(lastReply().result.text).toContain('Done');
      expect(await prisma.channelLink.findFirstOrThrow({ where: { kind: 'GUILD' } })).toMatchObject({ externalId: TEAM, workspaceId: w.ws.id });
      expect(await prisma.channelLink.findFirstOrThrow({ where: { kind: 'CHANNEL' }, include: { subscriptions: true } })).toMatchObject({ externalId: CHAN, projectId: w.project.id, subscriptions: [expect.objectContaining({ enabled: true })] });
      expect(adapter.adminCalls).toBeGreaterThanOrEqual(3);
    });

    it('the job is idempotent (same trigger replayed): one task, the stored result is re-posted', async () => {
      const w = await world();
      await command(U_MEMBER, 'create Once'); await runChat(); await runChat();
      expect(await prisma.task.count({ where: { workspaceId: w.ws.id } })).toBe(1);
      expect(adapter.replies).toHaveLength(2);
    });
  });

  // ---------------------------------------------------------------- interactivity

  describe('message shortcut, buttons, modals', () => {
    const shortcut = (ext: string, over: Record<string, unknown> = {}) => ({ type: 'message_action', callback_id: 'create_task', user: { id: ext }, channel: { id: CHAN }, message: { ts: TS, text: 'Login is broken\nsteps follow' }, ...over });
    const submit = (ext: string, callback: string, meta: unknown, values: Record<string, Record<string, { value: string }>>) =>
      ({ type: 'view_submission', user: { id: ext }, view: { callback_id: callback, private_metadata: JSON.stringify(meta), state: { values } } });
    const mtMeta = { c: CHAN, ts: TS, k: 'M' };

    it('shortcut opens the modal synchronously with the trigger id and a prefilled title; the HTTP answer is an empty 200', async () => {
      await world();
      const r = await interact(shortcut(U_MEMBER));
      expect(r).toEqual({ status: 200, body: '' });
      expect(adapter.opened).toHaveLength(1);
      expect(adapter.opened[0]).toMatchObject({ token: 'xoxb-test', view: { callback_id: 'mt' } });
      expect(adapter.opened[0].view.blocks[0].element.initial_value).toBe('Login is broken');
    });

    it('shortcut: an unlinked caller gets a PRIVATE prompt (no form); a VIEWER gets a private refusal (no form); a failing views.open is explained', async () => {
      await world();
      await interact(shortcut(U_STRANGER));
      expect(adapter.opened).toHaveLength(0);
      expect(lastReply().target.reply).toEqual({ channelId: CHAN, userId: U_STRANGER });
      expect(lastReply().result.visibility).toBe('private');
      expect(lastReply().result.lines![0]).toMatch(/\/settings\/integrations\/link\?token=/);
      await interact(shortcut(U_VIEWER));
      expect(adapter.opened).toHaveLength(0);
      expect(lastReply().result.text).toMatch(/not allowed/);
      adapter.openFails = true;
      await interact(shortcut(U_MEMBER));
      expect(lastReply().result.text).toMatch(/Could not open the form/);
    });

    it('submit -> queued (public, posted in the message thread), the job creates the task + a MESSAGE ExternalLink; the same message again is refused INSIDE the modal', async () => {
      const w = await world();
      const sub = submit(U_MEMBER, 'mt', mtMeta, { title_b: { title: { value: 'Login is broken' } }, desc_b: { desc: { value: 'steps follow' } }, project_b: { project: { value: '' } } });
      expect(await interact(sub)).toEqual({ status: 200, body: '' });
      expect(enqueued[0].payload).toMatchObject({ visibility: 'public', interactionToken: '', reply: { channelId: CHAN, threadTs: TS, userId: U_MEMBER } });
      await runChat();
      const t = await prisma.task.findFirstOrThrow({ where: { workspaceId: w.ws.id }, include: { externalLinks: true } });
      expect(t).toMatchObject({ title: 'Login is broken', description: 'steps follow', projectId: w.project.id });
      expect(t.externalLinks).toEqual([expect.objectContaining({ provider: 'SLACK', kind: 'MESSAGE', externalId: `${CHAN}/${TS}`, url: `https://slack.com/app_redirect?team=${TEAM}&channel=${CHAN}&message_ts=${TS}` })]);
      expect(lastReply().target).toMatchObject({ reply: { channelId: CHAN, threadTs: TS }, accessToken: 'xoxb-test' });
      expect(lastReply().result.visibility).toBe('public');
      const again = (await okBody(interact(sub))) as unknown as { response_action: string; errors: Record<string, string> };
      expect(again.response_action).toBe('errors');
      expect(again.errors.title_b).toMatch(/already created/);
      expect(await prisma.task.count({ where: { workspaceId: w.ws.id } })).toBe(1);
    });

    it('submit validation errors appear in the modal: empty title, VIEWER, unlinked, forged metadata', async () => {
      await world();
      const errs = async (s: Record<string, unknown>) => ((await okBody(interact(s))) as unknown as { response_action: string; errors: Record<string, string> });
      expect((await errs(submit(U_MEMBER, 'mt', mtMeta, { title_b: { title: { value: '  ' } } }))).errors.title_b).toMatch(/title/);
      expect((await errs(submit(U_VIEWER, 'mt', mtMeta, { title_b: { title: { value: 'x' } } }))).errors.title_b).toMatch(/not allowed/);
      expect((await errs(submit(U_STRANGER, 'mt', mtMeta, { title_b: { title: { value: 'x' } } }))).errors.title_b).toMatch(/not linked/);
      expect((await errs(submit(U_MEMBER, 'mt', { c: '../x', ts: TS, k: 'M' }, { title_b: { title: { value: 'x' } } }))).errors.title_b).toMatch(/no longer valid/);
      expect(enqueued).toHaveLength(0);
      expect(await prisma.identityLinkToken.count()).toBe(0); // a modal never issues a token
    });

    it('buttons: "Assign to me" answers through the payload\u2019s response_url and assigns the CLICKER', async () => {
      const w = await world();
      const t = await createTask(prisma, { workspaceId: w.ws.id, createdById: w.owner.id, projectId: w.project.id, title: 'T' });
      await interact({ type: 'block_actions', user: { id: U_MEMBER }, channel: { id: CHAN }, response_url: RESP, actions: [{ action_id: 'a', value: t.id }] });
      expect(enqueued[0].payload).toMatchObject({ interactionToken: RESP, visibility: 'private' });
      await runChat();
      expect((await prisma.task.findUniqueOrThrow({ where: { id: t.id }, include: { assignees: true } })).assignees.map((u) => u.id)).toEqual([w.member.id]);
      expect(lastReply().target.interactionToken).toBe(RESP);
    });

    it('buttons: a response_url that is not Slack\u2019s is never used (falls back to posting to the channel)', async () => {
      const w = await world();
      const t = await createTask(prisma, { workspaceId: w.ws.id, createdById: w.owner.id, projectId: w.project.id, title: 'T' });
      await interact({ type: 'block_actions', user: { id: U_MEMBER }, channel: { id: CHAN }, response_url: 'https://evil.test/x', actions: [{ action_id: 'a', value: t.id }] });
      expect(enqueued[0].payload).toMatchObject({ interactionToken: '', reply: { channelId: CHAN, userId: U_MEMBER } });
    });

    it('"Set due": button opens the date modal; a bad date is a modal error; a good one is queued and answered only to the user', async () => {
      const w = await world();
      const t = await createTask(prisma, { workspaceId: w.ws.id, createdById: w.owner.id, projectId: w.project.id, title: 'T' });
      await interact({ type: 'block_actions', user: { id: U_MEMBER }, channel: { id: CHAN }, actions: [{ action_id: 'd', value: t.id }] });
      expect(adapter.opened[0].view.callback_id).toBe(`d:${t.id}`);
      const due = (v: string) => submit(U_MEMBER, `d:${t.id}`, { c: CHAN }, { date_b: { date: { value: v } } });
      expect(((await okBody(interact(due('soon')))) as unknown as { errors: Record<string, string> }).errors.date_b).toMatch(/YYYY-MM-DD/);
      expect(await interact(due('2027-03-04'))).toEqual({ status: 200, body: '' });
      await runChat();
      expect((await prisma.task.findUniqueOrThrow({ where: { id: t.id } })).dueDate?.toISOString().slice(0, 10)).toBe('2027-03-04');
      expect(lastReply().target.reply).toEqual({ channelId: CHAN, userId: U_MEMBER });
      expect(lastReply().result.visibility).toBe('private');
    });

    it('cross-tenant: someone in BOTH accounts cannot reach the other account\u2019s task through this workspace\u2019s button', async () => {
      const w = await world();
      const o = await createUserWithAccount(prisma, { role: Role.OWNER });
      await addAccountMember(prisma, { accountId: o.account.id, userId: w.member.id, role: Role.OWNER });
      const bTask = await createTask(prisma, { workspaceId: (await createWorkspace(prisma, { accountId: o.account.id })).id, createdById: o.user.id, title: 'Other tenant' });
      expect((await resolver.resolve(w.member.id, 'editTask', 'TASK', bTask.id)).allowed).toBe(true); // sanity: the normal API would allow it
      await interact({ type: 'block_actions', user: { id: U_MEMBER }, channel: { id: CHAN }, response_url: RESP, actions: [{ action_id: 'a', value: bTask.id }] });
      await runChat();
      expect(lastReply().result.text).toBe('No task with that key.');
      expect((await prisma.task.findUniqueOrThrow({ where: { id: bTask.id }, include: { assignees: true } })).assignees).toHaveLength(0);
    });

    it('garbage payload JSON, view_closed and the URL "Open" button are acknowledged and ignored', async () => {
      await world();
      expect(await svc.handleInteractivity(signed('form', { payload: '{not json' }))).toEqual({ status: 200, body: '' });
      expect(await interact({ type: 'view_closed', user: { id: U_MEMBER } })).toEqual({ status: 200, body: '' });
      expect(await interact({ type: 'block_actions', user: { id: U_MEMBER }, channel: { id: CHAN }, actions: [{ action_id: 'open', value: '' }] })).toEqual({ status: 200, body: '' });
      expect(enqueued).toHaveLength(0); expect(adapter.opened).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------- events + unfurl

  describe('Events API: uninstall and token revocation (step 2.7)', () => {
    const uninstall = (type: 'app_uninstalled' | 'tokens_revoked', over: Record<string, unknown> = {}, tokens?: unknown) =>
      ({ type: 'event_callback', team_id: TEAM, event_id: `Ev${++seq}`, event: { type, ...(tokens ? { tokens } : {}) }, ...over });

    it('app_uninstalled: connection REVOKED, credential deleted, links paused but KEPT, ONE alert-raising audit row; a replay and a second event add nothing', async () => {
      const w = await world();
      const ev = uninstall('app_uninstalled');
      expect(await event(ev)).toEqual({ status: 200, body: '' });
      const conn = await prisma.integrationConnection.findUniqueOrThrow({ where: { id: w.conn.id } });
      expect(conn.status).toBe('REVOKED');
      expect(conn.lastError).toBe('Slack app uninstalled');
      expect(await prisma.integrationCredential.count({ where: { connectionId: w.conn.id } })).toBe(0);
      const links = await prisma.channelLink.findMany({ where: { connectionId: w.conn.id } });
      expect(links).toHaveLength(2);
      expect(links.every((l) => l.pausedAt !== null)).toBe(true);
      const audits = () => prisma.auditLog.findMany({ where: { accountId: w.account.id, action: 'INTEGRATION_DISCONNECTED' } });
      expect(await audits()).toHaveLength(1);
      expect((await audits())[0].metadata).toMatchObject({ connectionId: w.conn.id, provider: 'SLACK', reason: 'Slack app uninstalled', system: true });
      await event(ev); // exact replay: deduped by event id
      await event(uninstall('app_uninstalled')); // a NEW event id for the same fact: no live connection left, nothing to do
      expect(await audits()).toHaveLength(1);
    });

    it('then the workspace is not answered any more (commands get the not-connected reply)', async () => {
      const w = await world();
      await event(uninstall('app_uninstalled'));
      const body = await okBody(command(U_MEMBER, 'list')) as { text: string };
      expect(body.text).toMatch(/not connected/);
      expect(enqueued).toHaveLength(0);
      void w;
    });

    it('tokens_revoked: a revoked BOT token ends the connection; revoked USER tokens only (we hold none) change nothing', async () => {
      const w = await world();
      await event(uninstall('tokens_revoked', {}, { oauth: ['U0SOMEONE1'] }));
      await event(uninstall('tokens_revoked', {}, { oauth: [], bot: [] }));
      await event(uninstall('tokens_revoked', {}, { bot: 'not-an-array' }));
      expect((await prisma.integrationConnection.findUniqueOrThrow({ where: { id: w.conn.id } })).status).toBe('ACTIVE');
      await event(uninstall('tokens_revoked', {}, { oauth: [], bot: ['U0BOTUSER1'] }));
      const conn = await prisma.integrationConnection.findUniqueOrThrow({ where: { id: w.conn.id } });
      expect(conn.status).toBe('REVOKED');
      expect(conn.lastError).toBe('Slack bot token revoked');
    });

    it('a NEEDS_REAUTH connection is also ended; an unknown team, a malformed team id, and a REVOKED connection are left alone', async () => {
      const w = await world();
      await prisma.integrationConnection.update({ where: { id: w.conn.id }, data: { status: 'NEEDS_REAUTH' } });
      await event(uninstall('app_uninstalled', { team_id: 'T0NOBODY9' }));
      await event(uninstall('app_uninstalled', { team_id: 'not a team' }));
      await event(uninstall('app_uninstalled', { team_id: undefined }));
      expect((await prisma.integrationConnection.findUniqueOrThrow({ where: { id: w.conn.id } })).status).toBe('NEEDS_REAUTH');
      await event(uninstall('app_uninstalled'));
      expect((await prisma.integrationConnection.findUniqueOrThrow({ where: { id: w.conn.id } })).status).toBe('REVOKED');
    });

    it('an UNSIGNED, wrong-secret or stale uninstall event is 401 and changes nothing (nobody can disconnect a workspace by forging one)', async () => {
      const w = await world();
      const ev = uninstall('app_uninstalled');
      expect(await event(ev, { secret: 'a-different-secret-entirely' })).toEqual({ status: 401 });
      expect(await event(ev, { tamper: true })).toEqual({ status: 401 });
      expect(await event(ev, { ts: String(nowSec() - 3600) })).toEqual({ status: 401 }); // captured earlier, replayed late
      expect((await prisma.integrationConnection.findUniqueOrThrow({ where: { id: w.conn.id } })).status).toBe('ACTIVE');
      expect(await prisma.integrationWebhookEvent.count()).toBe(0);
    });

    it('reconnecting the same workspace revives the soft-revoked connection with its links still there', async () => {
      const w = await world();
      await event(uninstall('app_uninstalled'));
      await prisma.integrationConnection.update({ where: { id: w.conn.id }, data: { status: 'ACTIVE', lastError: null } }); // what OAuthService does on reconnect
      expect(await prisma.channelLink.count({ where: { connectionId: w.conn.id } })).toBe(2);
    });
  });

  describe('signing-secret rotation and replay (step 2.7)', () => {
    const NEW_SECRET = 'the-NEW-slack-signing-secret-0123456';
    afterEach(() => { settings.SLACK_SIGNING_SECRET = SECRET; delete settings.SLACK_SIGNING_SECRET_PREVIOUS; });

    it('during the overlap requests signed with EITHER secret are accepted; after the previous one is removed only the new one is', async () => {
      await world();
      settings.SLACK_SIGNING_SECRET = NEW_SECRET; settings.SLACK_SIGNING_SECRET_PREVIOUS = SECRET;
      const f = () => cmdFields(U_OWNER, 'list');
      expect((await svc.handleCommand(signed('form', f(), { secret: NEW_SECRET }))).status).toBe(200);
      expect((await svc.handleCommand(signed('form', f(), { secret: SECRET }))).status).toBe(200);
      expect(await svc.handleCommand(signed('form', f(), { secret: 'some-third-secret-of-length-xx' }))).toEqual({ status: 401 });
      delete settings.SLACK_SIGNING_SECRET_PREVIOUS;
      expect(await svc.handleCommand(signed('form', f(), { secret: SECRET }))).toEqual({ status: 401 });
      expect((await svc.handleCommand(signed('form', f(), { secret: NEW_SECRET }))).status).toBe(200);
    });

    it('a captured valid request replayed immediately is processed once (same trigger id); replayed after the window it is rejected although its signature is valid', async () => {
      const w = await world();
      const fields = cmdFields(U_OWNER, 'list');
      const first = signed('form', fields);
      expect((await svc.handleCommand(first)).status).toBe(200);
      expect(enqueued).toHaveLength(1);
      const again = await svc.handleCommand(first); // byte-identical replay
      expect((again as { body: { text: string } }).body.text).toMatch(/already received/);
      expect(enqueued).toHaveLength(1);
      const stale = signed('form', cmdFields(U_OWNER, 'list'), { ts: String(nowSec() - 301) });
      expect(await svc.handleCommand(stale)).toEqual({ status: 401 });
      expect(enqueued).toHaveLength(1);
      void w;
    });
  });

  describe('Events API: link_shared unfurl', () => {
    const linkShared = (user: string, urls: string[], over: Record<string, unknown> = {}) =>
      ({ type: 'event_callback', team_id: TEAM, event_id: `Ev${++seq}`, event: { type: 'link_shared', user, channel: CHAN, message_ts: TS, links: urls.map((url) => ({ url, domain: new URL(url).host })) }, ...over });

    it('enqueues ONE unfurl job with only OUR task links; others are ignored; a duplicate event id is processed once', async () => {
      const w = await world();
      const t = await createTask(prisma, { workspaceId: w.ws.id, createdById: w.owner.id, projectId: w.project.id, title: 'Unfurl me' });
      const key = await keyOf(t.id);
      const ev = linkShared(U_MEMBER, [`http://fe.test/tasks/${key}`, 'https://evil.test/x', `http://fe.test/tasks/${key}?x=1`, 'https://github.com/o/r/pull/1']);
      expect(await event(ev)).toEqual({ status: 200, body: '' });
      expect(enqueued).toHaveLength(1);
      expect(enqueued[0]).toMatchObject({ queue: 'chat', name: 'chat.unfurl', payload: { teamId: TEAM, channel: CHAN, messageTs: TS, userExternalId: U_MEMBER, urls: [`http://fe.test/tasks/${key}`] } });
      await event(ev);
      expect(enqueued).toHaveLength(1);
    });

    it('no links of ours, or an unknown team: nothing is enqueued', async () => {
      await world();
      await event(linkShared(U_MEMBER, ['https://example.com/a']));
      await event(linkShared(U_MEMBER, ['http://fe.test/tasks/ENG-1'], { team_id: 'T0NOBODY9' }));
      expect(enqueued).toHaveLength(0);
    });

    it('the job unfurls a task the POSTER may see, as a card with escaped text', async () => {
      const w = await world();
      const t = await createTask(prisma, { workspaceId: w.ws.id, createdById: w.owner.id, projectId: w.project.id, title: '<!channel> Visible' });
      const url = `http://fe.test/tasks/${await keyOf(t.id)}`;
      await event(linkShared(U_MEMBER, [url])); await runUnfurl();
      expect(adapter.unfurled).toHaveLength(1);
      expect(adapter.unfurled[0]).toMatchObject({ token: 'xoxb-test', channel: CHAN, ts: TS });
      const card = txt(adapter.unfurled[0].unfurls[url]);
      expect(card).toContain('Visible'); expect(card).not.toContain('<!channel>');
    });

    it('SAME account but not visible to the poster (project-only member): the channel must NOT see that task\u2019s card, nor can they edit it by key; their own project\u2019s task works', async () => {
      const w = await world();
      const restricted = await createUser(prisma); // no AccountMember row: scoped to the projects they were added to
      const P1 = await createProject(prisma, { workspaceId: w.ws.id, createdById: w.owner.id, name: 'Visible to them' } as never);
      const P2 = await createProject(prisma, { workspaceId: w.ws.id, createdById: w.owner.id, name: 'Hidden from them' } as never);
      await prisma.projectMember.create({ data: { projectId: P1.id, userId: restricted.id, role: 'MEMBER' } });
      await prisma.identityLink.create({ data: { connectionId: w.conn.id, externalUserId: 'U0RESTRI1', userId: restricted.id, method: 'LINK_TOKEN' } });
      const mine = await createTask(prisma, { workspaceId: w.ws.id, createdById: w.owner.id, projectId: P1.id, title: 'Mine to see' });
      const hidden = await createTask(prisma, { workspaceId: w.ws.id, createdById: w.owner.id, projectId: P2.id, title: 'Board only' });
      const hiddenUrl = `http://fe.test/tasks/${await keyOf(hidden.id)}`;
      const mineUrl = `http://fe.test/tasks/${await keyOf(mine.id)}`;
      await event(linkShared('U0RESTRI1', [hiddenUrl])); expect(await runUnfurl()).toEqual({ skipped: 'nothing_visible' });
      expect(adapter.unfurled).toHaveLength(0);
      await event(linkShared('U0RESTRI1', [mineUrl, hiddenUrl])); await runUnfurl();
      expect(adapter.unfurled).toHaveLength(1);
      expect(Object.keys(adapter.unfurled[0].unfurls)).toEqual([mineUrl]); // the hidden one is silently left out
      expect(txt(adapter.unfurled)).not.toContain('Board only');
      // and by key from the slash command: same answer as "no such task"
      await command('U0RESTRI1', `update ${await keyOf(hidden.id)} priority:HIGH`); await runChat();
      expect(lastReply().result.text).toBe('No task with that key.');
      expect((await prisma.task.findUniqueOrThrow({ where: { id: hidden.id } })).priority).not.toBe('HIGH');
    });

    it('an UNLINKED poster, or a task of another account, unfurls nothing - and no link prompt is ever produced for a pasted link', async () => {
      const w = await world();
      const t = await createTask(prisma, { workspaceId: w.ws.id, createdById: w.owner.id, projectId: w.project.id, title: 'Secret' });
      await event(linkShared(U_STRANGER, [`http://fe.test/tasks/${await keyOf(t.id)}`])); expect(await runUnfurl()).toEqual({ skipped: 'unlinked' });
      const o = await createUserWithAccount(prisma, { role: Role.OWNER });
      const foreign = await createTask(prisma, { workspaceId: (await createWorkspace(prisma, { accountId: o.account.id })).id, createdById: o.user.id, title: 'Foreign' });
      await event(linkShared(U_MEMBER, [`http://fe.test/tasks/${await keyOf(foreign.id)}`])); expect(await runUnfurl()).toEqual({ skipped: 'nothing_visible' });
      expect(adapter.unfurled).toHaveLength(0);
      expect(adapter.replies).toHaveLength(0);
      expect(await prisma.identityLinkToken.count()).toBe(0);
    });
  });
});
