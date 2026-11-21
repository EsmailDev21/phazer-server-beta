/**
 * Step 2.6 - GitHub webhook, key linking, status rules, installation lifecycle and the admin API, against a real DB with
 * HMAC-SIGNED fixtures (ADR-0014). GitHub itself is a fake adapter; the worker half (`github.event`) is driven by feeding the queued
 * work to GithubLinkService exactly as the job does.
 */
import { BadRequestException, ConflictException, ForbiddenException, ValidationPipe } from '@nestjs/common';
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
import { ConnectorRegistry } from '../../src/integrations/core/connector.registry';
import { CredentialService } from '../../src/integrations/core/credential.service';
import { IdentityService } from '../../src/integrations/core/identity.service';
import { ConnectorAdapter, INTEGRATION_ADAPTERS } from '../../src/integrations/core/integration.types';
import { LinkPromptBuilder } from '../../src/integrations/core/link-prompt.builder';
import { LinkTokenService } from '../../src/integrations/core/link-token.service';
import { PromptThrottleService } from '../../src/integrations/core/prompt-throttle.service';
import { RedisLockService } from '../../src/integrations/core/redis-lock.service';
import { LinkRepoDto, UpdateStatusRulesDto } from '../../src/integrations/dto/integration.dto';
import { GithubAdminService } from '../../src/integrations/github/github-admin.service';
import { GithubEventService } from '../../src/integrations/github/github-event.service';
import { GithubLinkService } from '../../src/integrations/github/github-link.service';
import { ChannelAdminService } from '../../src/integrations/notify/channel-admin.service';
import { RichMessageBuilder } from '../../src/integrations/notify/rich-message.builder';
import { GithubRepoInfo } from '../../src/integrations/providers/github.adapter';
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

const SECRET = 'github-webhook-secret-for-tests-0123';
const KEY = randomBytes(32).toString('base64');
const settings: Record<string, string> = { GITHUB_WEBHOOK_SECRET: SECRET, FRONTEND_URL: 'http://fe.test' };
const INST = '777';
const REPO = 4242;
const FULL = 'acme/web';
const GH_SENDER = { id: 9001, login: 'octocat' };

class FakeGithub implements ConnectorAdapter {
  readonly provider = IntegrationProvider.GITHUB;
  readonly capabilities = new Set<never>();
  readonly usesPkce = false;
  visible: GithubRepoInfo[] = [];
  isConfigured() { return true; }
  authorizeUrl() { return 'x'; }
  async exchangeCode(): Promise<never> { throw new Error('unused'); }
  async revoke() { /* noop */ }
  async repositories(_t: string, _p: number) { return { repos: this.visible, hasMore: false }; }
  async repository(_t: string, id: number) { return this.visible.find((r) => r.id === id) ?? null; }
}
const repoInfo = (id: number, fullName: string): GithubRepoInfo => ({ id, fullName, private: false, archived: false, defaultBranch: 'main' });

describe('github webhook, links, status rules, admin (step 2.6)', () => {
  let prisma: PrismaService;
  let events: GithubEventService;
  let links: GithubLinkService;
  let admin: GithubAdminService;
  let channelAdmin: ChannelAdminService;
  let builder: RichMessageBuilder;
  let creds: CredentialService;
  let adapter: FakeGithub;
  const enqueued: Array<{ queue: string; name: string; payload: { deliveryId: string; event: string; work: never }; opts: { jobId?: string } }> = [];
  const emitted: Array<{ id: string; action: string; visibility: string }> = [];
  let enqueueFails = false;
  let seq = 0;

  beforeAll(async () => {
    prisma = getTestPrisma();
    adapter = new FakeGithub();
    const emitter = new EventEmitter2();
    emitter.on('activity.created', (a: { id: string; action: string; visibility: string }) => emitted.push({ id: a.id, action: a.action, visibility: a.visibility }));
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
        ActivityService, AuditLogService, PermissionResolver, PlanLimitsService, ConnectorRegistry, RedisLockService, CredentialService,
        LinkPromptBuilder, LinkTokenService, PromptThrottleService, IdentityService, WebhookDedupeService, RichMessageBuilder,
        TaskVisibilityService, TasksService, TaskTreeService, WorkflowService, TaskPlanningService, IssueTypesService, IterationsService,
        ProjectsService, CustomFieldsService, WorkspaceKeysService, WorkspacesService, DomainWriter,
        GithubEventService, GithubLinkService, GithubAdminService, ChannelAdminService,
      ],
    }).compile();
    await m.init();
    events = m.get(GithubEventService); links = m.get(GithubLinkService); admin = m.get(GithubAdminService);
    channelAdmin = m.get(ChannelAdminService); builder = m.get(RichMessageBuilder); creds = m.get(CredentialService);
  });
  beforeEach(async () => {
    await resetDb(prisma);
    adapter.visible = [];
    enqueued.length = 0; emitted.length = 0; enqueueFails = false;
  });
  afterAll(() => disconnectTestPrisma());

  // ---------------------------------------------------------------- fixtures

  async function world() {
    const { user: owner, account } = await createUserWithAccount(prisma, { role: Role.OWNER });
    await prisma.account.update({ where: { id: account.id }, data: { planType: 'ENTERPRISE_ORG' as never } });
    const member = await createUser(prisma); await addAccountMember(prisma, { accountId: account.id, userId: member.id, role: Role.MEMBER });
    const eng = await createWorkspace(prisma, { accountId: account.id, key: 'ENG' });
    const ops = await createWorkspace(prisma, { accountId: account.id, key: 'OPS' });
    const project = await createProject(prisma, { workspaceId: eng.id, createdById: owner.id, name: 'Web' } as never);
    const opsProject = await createProject(prisma, { workspaceId: ops.id, createdById: owner.id, name: 'Ops' } as never);
    const conn = await prisma.integrationConnection.create({ data: { accountId: account.id, provider: 'GITHUB', externalAccountId: INST, externalAccountName: 'acme', createdById: owner.id } });
    await creds.store(conn.id, { accessToken: 'ghs_test', scopes: [] });
    const link = await prisma.channelLink.create({
      data: { connectionId: conn.id, kind: 'REPO', externalId: String(REPO), workspaceId: eng.id, projectId: project.id, configuredById: owner.id, config: { repoFullName: FULL, statusRules: { prOpened: 'IN_PROGRESS', prMerged: 'DONE', prClosed: null } } },
    });
    const task = (workspaceId: string, projectId: string, over: Record<string, unknown> = {}) => createTask(prisma, { workspaceId, createdById: owner.id, projectId, ...over } as never);
    const t1 = await task(eng.id, project.id);            // ENG-1
    const t2 = await task(eng.id, project.id);            // ENG-2
    const o1 = await task(ops.id, opsProject.id);         // OPS-1
    adapter.visible = [repoInfo(REPO, FULL), repoInfo(5555, 'acme/api')];
    return { owner, member, account, eng, ops, project, opsProject, conn, link, t1, t2, o1, task };
  }
  type W = Awaited<ReturnType<typeof world>>;

  const sig = (raw: Buffer, secret = SECRET) => 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');
  function signed(event: string, body: Record<string, unknown>, o: { delivery?: string; tamper?: boolean; secret?: string } = {}) {
    const raw = Buffer.from(JSON.stringify(body));
    return { rawBody: o.tamper ? Buffer.from(raw.toString() + ' ') : raw, payload: body, signature: sig(raw, o.secret), event, deliveryId: o.delivery ?? `d-${++seq}` };
  }
  const base = { installation: { id: Number(INST) }, repository: { id: REPO, full_name: FULL }, sender: GH_SENDER };
  const prBody = (action: string, over: Record<string, unknown> = {}) => ({ ...base, action, pull_request: { number: 12, title: 'ENG-1 fix login', body: '', head: { ref: 'fix-login' }, draft: false, merged: false, state: 'open', ...over } });

  /** Webhook (API half) then the queued work (worker half), like production. Returns what the worker did. */
  async function deliver(event: string, body: Record<string, unknown>, o: Parameters<typeof signed>[2] = {}) {
    const before = enqueued.length;
    const res = await events.handle(signed(event, body, o));
    if (res.status !== 200 || enqueued.length === before) return { res, outcome: null };
    return { res, outcome: await links.process(enqueued[enqueued.length - 1].payload.work) };
  }
  const pr = (action: string, over: Record<string, unknown> = {}, o?: Parameters<typeof signed>[2]) => deliver('pull_request', prBody(action, over), o);
  const sha = (n: number) => n.toString(16).padStart(40, '0');
  const statusOf = async (id: string) => (await prisma.task.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;
  const extLinks = (taskId: string) => prisma.externalLink.findMany({ where: { taskId }, orderBy: { createdAt: 'asc' } });
  const acts = (taskId: string, action: string) => prisma.activity.findMany({ where: { targetId: taskId, action: action as never }, orderBy: { createdAt: 'asc' } });
  async function setStatus(taskId: string, projectId: string, status: 'TODO' | 'IN_PROGRESS' | 'BLOCKED' | 'DONE') {
    const wf = await prisma.workflowStatus.findFirstOrThrow({ where: { projectId, category: status, isDefault: true } });
    await prisma.task.update({ where: { id: taskId }, data: { status, workflowStatusId: wf.id } });
  }

  // ---------------------------------------------------------------- verification

  describe('request verification', () => {
    it('unsigned, wrong secret, tampered body, malformed header: all 401, and NOTHING is claimed, enqueued or written', async () => {
      const w = await world();
      const good = signed('pull_request', prBody('opened'));
      for (const bad of [
        { ...good, signature: undefined },
        { ...good, signature: 'sha256=' + 'a'.repeat(64) },
        { ...signed('pull_request', prBody('opened'), { secret: 'a-different-secret-entirely' }) },
        { ...signed('pull_request', prBody('opened'), { tamper: true }) },
        { ...good, signature: 'garbage' },
      ]) {
        expect(await events.handle(bad)).toEqual({ status: 401 });
      }
      expect(await prisma.integrationWebhookEvent.count()).toBe(0);
      expect(enqueued).toHaveLength(0);
      expect(await prisma.externalLink.count({ where: { taskId: w.t1.id } })).toBe(0);
    });

    it('no webhook secret configured -> everything is 401 (fail closed)', async () => {
      const saved = settings.GITHUB_WEBHOOK_SECRET; delete settings.GITHUB_WEBHOOK_SECRET;
      try { expect(await events.handle(signed('pull_request', prBody('opened')))).toEqual({ status: 401 }); } finally { settings.GITHUB_WEBHOOK_SECRET = saved; }
    });

    it('ping and unsupported events/actions are acknowledged and dropped BEFORE dedupe (no claim row, no job)', async () => {
      await world();
      expect(await events.handle(signed('ping', { zen: 'x' }))).toEqual({ status: 200, body: { ok: true, ignored: 'ping' } });
      expect((await events.handle(signed('star', { ...base, action: 'created' }))).status).toBe(200);
      expect((await events.handle(signed('pull_request', prBody('labeled')))).status).toBe(200);
      expect((await events.handle(signed('pull_request', { nonsense: true }))).status).toBe(200);
      expect(await prisma.integrationWebhookEvent.count()).toBe(0);
      expect(enqueued).toHaveLength(0);
    });

    it('a redelivered X-GitHub-Delivery is answered 200 but enqueued once; a failed enqueue releases the claim so GitHub can redeliver', async () => {
      await world();
      const first = await events.handle(signed('pull_request', prBody('opened'), { delivery: 'same-id' }));
      expect(first).toEqual({ status: 200, body: { ok: true } });
      expect(await events.handle(signed('pull_request', prBody('opened'), { delivery: 'same-id' }))).toEqual({ status: 200, body: { ok: true, duplicate: true } });
      expect(enqueued).toHaveLength(1);
      expect(enqueued[0].opts.jobId).toBe('gh-same-id');

      enqueueFails = true;
      await expect(events.handle(signed('pull_request', prBody('opened'), { delivery: 'retry-id' }))).rejects.toThrow('redis down');
      expect(await prisma.integrationWebhookEvent.count({ where: { deliveryId: 'retry-id' } })).toBe(0);
      enqueueFails = false;
      expect((await events.handle(signed('pull_request', prBody('opened'), { delivery: 'retry-id' }))).status).toBe(200);
      expect(enqueued).toHaveLength(2);
    });

    it('the queued payload is the REDUCED work, never the raw delivery', async () => {
      await world();
      await events.handle(signed('pull_request', { ...prBody('opened'), junk: 'x'.repeat(10_000) }));
      expect(JSON.stringify(enqueued[0].payload)).not.toContain('junk');
      expect(enqueued[0].queue).toBe('webhooks');
      expect(enqueued[0].name).toBe('github.event');
    });
  });

  // ---------------------------------------------------------------- PR linking and status rules

  describe('pull requests', () => {
    it('opened with ENG-1 in the title: PR link (url built from the repo, not trusted from the payload), TIMELINE activity, task -> In progress with its source', async () => {
      const w = await world();
      const { outcome } = await pr('opened', { html_url: 'https://evil.example/phish' });
      expect(outcome).toEqual({ handled: true, linked: 1, updated: 0, statusChanges: 1 });

      const [l] = await extLinks(w.t1.id);
      expect(l).toMatchObject({ provider: 'GITHUB', kind: 'PR', externalId: `${REPO}#12`, url: 'https://github.com/acme/web/pull/12', state: 'open', title: '#12 ENG-1 fix login' });
      const [linked] = await acts(w.t1.id, 'EXTERNAL_LINKED');
      expect(linked).toMatchObject({ actorId: null, visibility: 'TIMELINE', workspaceId: w.eng.id });
      expect(linked.metadata).toMatchObject({ provider: 'GITHUB', kind: 'PR', ref: '#12', login: 'octocat' });

      expect(await statusOf(w.t1.id)).toBe('IN_PROGRESS');
      const [st] = await acts(w.t1.id, 'STATUS_CHANGED');
      expect(st.actorId).toBeNull();
      expect(st.metadata).toMatchObject({ toCategory: 'IN_PROGRESS', fromCategory: 'TODO', source: { provider: 'GITHUB', kind: 'PR', ref: '#12', repo: FULL }, origin: 'INTEGRATION' });
      expect(await statusOf(w.t2.id)).toBe('TODO'); // untouched
    });

    it('the TIMELINE activity reaches the notification pipeline; commits do not', async () => {
      await world();
      await pr('opened');
      expect(emitted.filter((e) => e.action === 'EXTERNAL_LINKED').map((e) => e.visibility)).toEqual(['TIMELINE']);
    });

    it('replaying the same delivery changes nothing: one link, one linked activity, one status change', async () => {
      const w = await world();
      await pr('opened');
      const again = await links.process(enqueued[0].payload.work);
      expect(again).toEqual({ handled: true, linked: 0, updated: 1, statusChanges: 0 });
      expect(await extLinks(w.t1.id)).toHaveLength(1);
      expect(await acts(w.t1.id, 'EXTERNAL_LINKED')).toHaveLength(1);
      expect(await acts(w.t1.id, 'STATUS_CHANGED')).toHaveLength(1);
    });

    it('merged -> Done and state merged; a LATE out-of-order "opened" cannot bring either back', async () => {
      const w = await world();
      await pr('opened');
      await pr('closed', { merged: true, state: 'closed' });
      expect(await statusOf(w.t1.id)).toBe('DONE');
      expect((await extLinks(w.t1.id))[0].state).toBe('merged');

      await links.process(enqueued[0].payload.work); // the old "opened" arrives again, late
      expect((await extLinks(w.t1.id))[0].state).toBe('merged');
      expect(await statusOf(w.t1.id)).toBe('DONE');
    });

    it('closed WITHOUT merge changes no status (default) and records state closed; reopened -> open', async () => {
      const w = await world();
      await pr('opened');
      await pr('closed', { merged: false, state: 'closed' });
      expect(await statusOf(w.t1.id)).toBe('IN_PROGRESS');
      expect((await extLinks(w.t1.id))[0].state).toBe('closed');
      await pr('reopened');
      expect((await extLinks(w.t1.id))[0].state).toBe('open');
    });

    it('editing the title to add a key links it then (edited has no status rule); a draft PR is state draft', async () => {
      const w = await world();
      await pr('opened', { title: 'work in progress', draft: true });
      expect(await extLinks(w.t2.id)).toHaveLength(0);
      await pr('edited', { title: 'ENG-2 now with a key', draft: true });
      const [l] = await extLinks(w.t2.id);
      expect(l).toMatchObject({ kind: 'PR', state: 'draft' });
      expect(await statusOf(w.t2.id)).toBe('TODO');
    });

    it('keys in the branch (lower case) and in the body both link; one PR links several tasks', async () => {
      const w = await world();
      await pr('opened', { title: 'no key here', head: { ref: 'feature/eng-1-login' }, body: 'also closes ENG-2' });
      expect(await extLinks(w.t1.id)).toHaveLength(1);
      expect(await extLinks(w.t2.id)).toHaveLength(1);
    });

    it('a retired key (alias) of the linked workspace still links', async () => {
      const w = await world();
      await prisma.workspaceKeyAlias.create({ data: { accountId: w.account.id, key: 'OLDENG', workspaceId: w.eng.id } });
      await pr('opened', { title: 'OLDENG-2 uses the old key' });
      expect(await extLinks(w.t2.id)).toHaveLength(1);
    });

    it('CROSS-WORKSPACE: a key of another workspace of the same account never links, nor does a non-existent number', async () => {
      const w = await world();
      const { outcome } = await pr('opened', { title: 'OPS-1 and ENG-999', body: 'ops-1 again' });
      expect(outcome).toEqual({ handled: false, reason: 'nothing-to-do' });
      expect(await prisma.externalLink.count()).toBe(0);
      expect(await statusOf(w.o1.id)).toBe('TODO');
    });

    it('CROSS-ACCOUNT: another account\'s ENG-1 is never touched, even when its workspace uses the same key', async () => {
      const w = await world();
      const { user: otherOwner, account: other } = await createUserWithAccount(prisma, { role: Role.OWNER });
      const otherWs = await createWorkspace(prisma, { accountId: other.id, key: 'ENG' });
      const otherProject = await createProject(prisma, { workspaceId: otherWs.id, createdById: otherOwner.id } as never);
      const foreign = await createTask(prisma, { workspaceId: otherWs.id, createdById: otherOwner.id, projectId: otherProject.id } as never); // their ENG-1
      await pr('opened');
      expect(await extLinks(foreign.id)).toHaveLength(0);
      expect(await statusOf(foreign.id)).toBe('TODO');
      expect(await extLinks(w.t1.id)).toHaveLength(1); // OUR ENG-1 got it
    });

    it('forward only: a Blocked task is linked but NOT unblocked by a new PR, a Done task is not dragged back by a reopened one', async () => {
      const w = await world();
      await setStatus(w.t1.id, w.project.id, 'BLOCKED');
      await setStatus(w.t2.id, w.project.id, 'DONE');
      await pr('opened', { title: 'ENG-1 ENG-2' });
      expect(await statusOf(w.t1.id)).toBe('BLOCKED');
      expect(await statusOf(w.t2.id)).toBe('DONE');
      expect(await extLinks(w.t1.id)).toHaveLength(1);
      expect(await extLinks(w.t2.id)).toHaveLength(1);
    });

    it('custom rules: merged cleared = no change; closed -> TODO moves back but never out of Done', async () => {
      const w = await world();
      await prisma.channelLink.update({ where: { id: w.link.id }, data: { config: { repoFullName: FULL, statusRules: { prOpened: 'IN_PROGRESS', prMerged: null, prClosed: 'TODO' } } } });
      await pr('opened', { title: 'ENG-1 ENG-2' });
      await pr('closed', { merged: true, state: 'closed', title: 'ENG-1 ENG-2' });
      expect(await statusOf(w.t1.id)).toBe('IN_PROGRESS'); // merged rule cleared
      await setStatus(w.t2.id, w.project.id, 'DONE');
      await pr('closed', { merged: false, state: 'closed', title: 'ENG-1 ENG-2' }, { delivery: 'closed-2' });
      expect(await statusOf(w.t1.id)).toBe('TODO');
      expect(await statusOf(w.t2.id)).toBe('DONE');
    });

    it('a link that points at no valid rule config (hand-edited JSON) still links and changes nothing', async () => {
      const w = await world();
      await prisma.channelLink.update({ where: { id: w.link.id }, data: { config: { statusRules: 'garbage' } } });
      await pr('opened');
      expect(await extLinks(w.t1.id)).toHaveLength(1);
      expect(await statusOf(w.t1.id)).toBe('TODO');
    });
  });

  // ---------------------------------------------------------------- actor

  describe('who is the actor', () => {
    it('an unmapped GitHub sender is the system actor (null); a sender who linked their identity is attributed', async () => {
      const w = await world();
      await pr('opened');
      expect((await acts(w.t1.id, 'EXTERNAL_LINKED'))[0].actorId).toBeNull();

      await prisma.identityLink.create({ data: { connectionId: w.conn.id, externalUserId: String(GH_SENDER.id), userId: w.member.id, method: 'MANUAL' } });
      await pr('opened', { title: 'ENG-2 mapped' }, { delivery: 'mapped' });
      expect((await acts(w.t2.id, 'EXTERNAL_LINKED'))[0].actorId).toBe(w.member.id);
      expect((await acts(w.t2.id, 'STATUS_CHANGED'))[0].actorId).toBe(w.member.id);
    });
  });

  // ---------------------------------------------------------------- push / branch / issues

  describe('commits, branches, issues', () => {
    const push = (commits: Array<{ id: string; message: string }>, ref = 'refs/heads/main') => deliver('push', { ...base, ref, commits });

    it('push: a commit link per commit that names a key and the branch name, all SILENT (history only, nothing emitted); no status rule', async () => {
      const w = await world();
      const { outcome } = await push([{ id: sha(1), message: 'ENG-1 first step\n\nlong body' }, { id: sha(2), message: 'unrelated' }], 'refs/heads/eng-1-login');
      expect(outcome).toMatchObject({ handled: true, statusChanges: 0 });
      const ls = await extLinks(w.t1.id);
      expect(ls.map((l) => l.kind).sort()).toEqual(['BRANCH', 'COMMIT']);
      const commit = ls.find((l) => l.kind === 'COMMIT')!;
      expect(commit).toMatchObject({ externalId: `${REPO}@${sha(1)}`, url: `https://github.com/acme/web/commit/${sha(1)}`, state: null, title: `${sha(1).slice(0, 7)} ENG-1 first step` });
      expect(ls.find((l) => l.kind === 'BRANCH')!.url).toBe('https://github.com/acme/web/tree/eng-1-login');
      expect((await acts(w.t1.id, 'EXTERNAL_LINKED')).map((a) => a.visibility)).toEqual(['SILENT', 'SILENT']);
      expect(emitted).toHaveLength(0);
      expect(await statusOf(w.t1.id)).toBe('TODO');
    });

    it('a branch created in the GitHub UI links through the create event, once', async () => {
      const w = await world();
      await deliver('create', { ...base, ref_type: 'branch', ref: 'feature/eng-2-search' });
      await deliver('create', { ...base, ref_type: 'branch', ref: 'feature/eng-2-search' }, { delivery: 'again' });
      expect(await extLinks(w.t2.id)).toHaveLength(1);
      expect(await acts(w.t2.id, 'EXTERNAL_LINKED')).toHaveLength(1);
    });

    it('tags and branch deletions are ignored', async () => {
      await world();
      expect((await deliver('push', { ...base, ref: 'refs/tags/ENG-1', commits: [] })).outcome).toBeNull();
      expect((await deliver('push', { ...base, ref: 'refs/heads/eng-1', deleted: true, commits: [] })).outcome).toBeNull();
    });

    it('issues link as ISSUE (TIMELINE) with their state and drive no status rule; pull requests arriving as issues are ignored', async () => {
      const w = await world();
      const issue = (action: string, over: Record<string, unknown> = {}) => ({ ...base, action, issue: { number: 5, title: 'ENG-1 crash on save', body: '', state: 'open', ...over } });
      await deliver('issues', issue('opened'));
      await deliver('issues', issue('closed', { state: 'closed' }), { delivery: 'close' });
      const [l] = await extLinks(w.t1.id);
      expect(l).toMatchObject({ kind: 'ISSUE', url: 'https://github.com/acme/web/issues/5', state: 'closed' });
      expect(await statusOf(w.t1.id)).toBe('TODO');
      expect((await acts(w.t1.id, 'EXTERNAL_LINKED'))[0].visibility).toBe('TIMELINE');
      expect((await deliver('issues', issue('opened', { pull_request: {} }), { delivery: 'p' })).outcome).toBeNull();
    });
  });

  // ---------------------------------------------------------------- what is ignored

  describe('deliveries that must do nothing', () => {
    it('unknown installation, unlinked repository, paused link, non-ACTIVE connection', async () => {
      const w = await world();
      const other = { ...prBody('opened'), installation: { id: 999999 } };
      expect((await deliver('pull_request', other)).outcome).toEqual({ handled: false, reason: 'no-connection' });
      const unlinked = { ...prBody('opened'), repository: { id: 31337, full_name: 'acme/other' } };
      expect((await deliver('pull_request', unlinked)).outcome).toEqual({ handled: false, reason: 'repo-not-linked' });

      await prisma.channelLink.update({ where: { id: w.link.id }, data: { pausedAt: new Date() } });
      expect((await pr('opened')).outcome).toEqual({ handled: false, reason: 'repo-not-linked' });
      await prisma.channelLink.update({ where: { id: w.link.id }, data: { pausedAt: null } });

      await prisma.integrationConnection.update({ where: { id: w.conn.id }, data: { status: 'NEEDS_REAUTH' } });
      expect((await pr('opened')).outcome).toEqual({ handled: false, reason: 'no-connection' });
      expect(await prisma.externalLink.count()).toBe(0);
    });

    it('a link whose workspace is NOT in the connection\'s account is refused (defence in depth)', async () => {
      const w = await world();
      const { account: other } = await createUserWithAccount(prisma, { role: Role.OWNER });
      const foreignWs = await createWorkspace(prisma, { accountId: other.id, key: 'ENG' });
      await prisma.channelLink.update({ where: { id: w.link.id }, data: { workspaceId: foreignWs.id, projectId: null } });
      expect((await pr('opened')).outcome).toEqual({ handled: false, reason: 'repo-not-linked' });
      expect(await prisma.externalLink.count()).toBe(0);
    });
  });

  // ---------------------------------------------------------------- installation lifecycle

  describe('installation lifecycle', () => {
    const inst = (action: string) => deliver('installation', { installation: { id: Number(INST) }, action });

    it('deleted: connection REVOKED, credential gone, links KEPT but paused, ONE alert-raising audit row; a replay adds nothing; later events are ignored', async () => {
      const w = await world();
      await inst('deleted');
      const conn = await prisma.integrationConnection.findUniqueOrThrow({ where: { id: w.conn.id } });
      expect(conn.status).toBe('REVOKED');
      expect(await prisma.integrationCredential.count({ where: { connectionId: w.conn.id } })).toBe(0);
      const link = await prisma.channelLink.findUniqueOrThrow({ where: { id: w.link.id } });
      expect(link.pausedAt).not.toBeNull();
      expect(link.config).toMatchObject({ repoFullName: FULL }); // kept, so reconnecting revives it

      await inst('deleted'); // GitHub redelivers / second delivery id
      const audits = await prisma.auditLog.findMany({ where: { accountId: w.account.id, action: 'INTEGRATION_DISCONNECTED' } });
      expect(audits).toHaveLength(1);
      expect(audits[0].metadata).toMatchObject({ provider: 'GITHUB', reason: 'installation_deleted', system: true });
      expect((await pr('opened')).outcome).toEqual({ handled: false, reason: 'no-connection' });
    });

    it('suspend / unsuspend toggle ACTIVE <-> ERROR without deleting anything; unsuspend never revives a connection that failed for another reason', async () => {
      const w = await world();
      await inst('suspend');
      expect((await prisma.integrationConnection.findUniqueOrThrow({ where: { id: w.conn.id } })).status).toBe('ERROR');
      expect((await pr('opened')).outcome).toEqual({ handled: false, reason: 'no-connection' });
      await inst('unsuspend');
      expect((await prisma.integrationConnection.findUniqueOrThrow({ where: { id: w.conn.id } })).status).toBe('ACTIVE');
      expect((await pr('opened', {}, { delivery: 'after' })).outcome).toMatchObject({ handled: true });

      await prisma.integrationConnection.update({ where: { id: w.conn.id }, data: { status: 'ERROR', lastError: 'refresh failed' } });
      await inst('unsuspend');
      expect((await prisma.integrationConnection.findUniqueOrThrow({ where: { id: w.conn.id } })).status).toBe('ERROR');
    });

    it('repositories removed from the installation pause their links; added back resumes them (only while ACTIVE)', async () => {
      const w = await world();
      const repos = (added: number[], removed: number[]) => deliver('installation_repositories', { installation: { id: Number(INST) }, repositories_added: added.map((id) => ({ id })), repositories_removed: removed.map((id) => ({ id })) });
      await repos([], [REPO]);
      expect((await prisma.channelLink.findUniqueOrThrow({ where: { id: w.link.id } })).pausedAt).not.toBeNull();
      expect((await pr('opened')).outcome).toEqual({ handled: false, reason: 'repo-not-linked' });
      await repos([REPO], []);
      expect((await prisma.channelLink.findUniqueOrThrow({ where: { id: w.link.id } })).pausedAt).toBeNull();
      expect((await pr('opened', {}, { delivery: 'ok-again' })).outcome).toMatchObject({ handled: true });
    });
  });

  // ---------------------------------------------------------------- admin API

  describe('admin API', () => {
    it('repositories: lists what the installation sees and marks the ones already linked', async () => {
      const w = await world();
      const out = await admin.repositories(w.conn.id, w.owner.id);
      expect(out.repos.map((r) => [r.fullName, r.linkId])).toEqual([[FULL, w.link.id], ['acme/api', null]]);
    });

    it('linkRepo: workspace comes from the PROJECT, rules default explicitly, repo name is stored, then it processes deliveries', async () => {
      const w = await world();
      const dto = { repoId: 5555, projectId: w.opsProject.id } as LinkRepoDto;
      const link = await admin.linkRepo(w.conn.id, w.owner.id, dto);
      expect(link).toMatchObject({ kind: 'REPO', externalId: '5555', workspaceId: w.ops.id, projectId: w.opsProject.id, pausedAt: null });
      expect(link.config).toEqual({ repoFullName: 'acme/api', statusRules: { prOpened: 'IN_PROGRESS', prMerged: 'DONE', prClosed: null } });

      const body = { ...prBody('opened', { title: 'OPS-1 deploy script' }), repository: { id: 5555, full_name: 'acme/api' } };
      expect((await deliver('pull_request', body)).outcome).toMatchObject({ handled: true, linked: 1 });
      expect(await extLinks(w.o1.id)).toHaveLength(1);
    });

    it('linkRepo with explicit rules (null clears a default)', async () => {
      const w = await world();
      const link = await admin.linkRepo(w.conn.id, w.owner.id, { repoId: 5555, projectId: w.project.id, statusRules: { prMerged: null, prClosed: 'TODO' } } as LinkRepoDto);
      expect((link.config as { statusRules: unknown }).statusRules).toEqual({ prOpened: 'IN_PROGRESS', prMerged: null, prClosed: 'TODO' });
    });

    it('linkRepo refuses: a project of another account (same message as a missing one), a repo the installation cannot see, a duplicate', async () => {
      const w = await world();
      const { user: u2, account: a2 } = await createUserWithAccount(prisma, { role: Role.OWNER });
      const ws2 = await createWorkspace(prisma, { accountId: a2.id, key: 'ZZZ' });
      const foreignProject = await createProject(prisma, { workspaceId: ws2.id, createdById: u2.id } as never);
      const e1 = await admin.linkRepo(w.conn.id, w.owner.id, { repoId: 5555, projectId: foreignProject.id } as LinkRepoDto).catch((e) => e);
      const e2 = await admin.linkRepo(w.conn.id, w.owner.id, { repoId: 5555, projectId: 'no-such-project' } as LinkRepoDto).catch((e) => e);
      expect(e1).toBeInstanceOf(BadRequestException);
      expect(e1.message).toBe(e2.message);
      await expect(admin.linkRepo(w.conn.id, w.owner.id, { repoId: 123456, projectId: w.project.id } as LinkRepoDto)).rejects.toThrow(/not accessible/);
      await expect(admin.linkRepo(w.conn.id, w.owner.id, { repoId: REPO, projectId: w.project.id } as LinkRepoDto)).rejects.toBeInstanceOf(ConflictException);
      expect(await prisma.channelLink.count({ where: { kind: 'REPO' } })).toBe(1);
    });

    it('only an account owner/admin: a plain member is forbidden on all three routes, and the rules stay as they were', async () => {
      const w = await world();
      await expect(admin.repositories(w.conn.id, w.member.id)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(admin.linkRepo(w.conn.id, w.member.id, { repoId: 5555, projectId: w.project.id } as LinkRepoDto)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(admin.updateRules(w.link.id, w.member.id, { prMerged: null })).rejects.toBeInstanceOf(ForbiddenException);
      expect((await prisma.channelLink.findUniqueOrThrow({ where: { id: w.link.id } })).config).toMatchObject({ statusRules: { prMerged: 'DONE' } });
    });

    it('updateRules: only the keys sent change, null clears, config keeps the repo name', async () => {
      const w = await world();
      const a = await admin.updateRules(w.link.id, w.owner.id, { prMerged: null });
      expect(a.config).toEqual({ repoFullName: FULL, statusRules: { prOpened: 'IN_PROGRESS', prMerged: null, prClosed: null } });
      const b = await admin.updateRules(w.link.id, w.owner.id, { prClosed: 'TODO' });
      expect(b.config).toEqual({ repoFullName: FULL, statusRules: { prOpened: 'IN_PROGRESS', prMerged: null, prClosed: 'TODO' } });
    });

    it('wrong connection types: a non-GitHub connection, an inactive one, a CHANNEL link, a nonexistent link', async () => {
      const w = await world();
      const slack = await prisma.integrationConnection.create({ data: { accountId: w.account.id, provider: 'SLACK', externalAccountId: 'T1', externalAccountName: 's', createdById: w.owner.id } });
      await expect(admin.repositories(slack.id, w.owner.id)).rejects.toThrow(/Not a GitHub connection/);
      const chan = await prisma.channelLink.create({ data: { connectionId: slack.id, kind: 'CHANNEL', externalId: 'C1', workspaceId: w.eng.id, configuredById: w.owner.id } });
      await expect(admin.updateRules(chan.id, w.owner.id, { prMerged: null })).rejects.toThrow(/Only repository links/);
      await expect(admin.updateRules('nope', w.owner.id, {})).rejects.toThrow(/not found/);
      await prisma.integrationConnection.update({ where: { id: w.conn.id }, data: { status: 'REVOKED' } });
      await expect(admin.repositories(w.conn.id, w.owner.id)).rejects.toThrow(/not active/);
    });

    it('2.3 routes still behave: a CHANNEL link cannot be created on a GitHub connection; the listing shows REPO links with their config', async () => {
      const w = await world();
      await expect(channelAdmin.createLink(w.conn.id, w.owner.id, { externalId: 'C1', workspaceId: w.eng.id } as never)).rejects.toThrow(/repo-links/);
      const list = await channelAdmin.listLinks(w.conn.id, w.owner.id);
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ kind: 'REPO', config: { repoFullName: FULL } });
    });

    it('DTO validation (the real pipe options): status values are categories, null is allowed, unknown keys are rejected', async () => {
      const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
      const meta = (metatype: unknown) => ({ type: 'body' as const, metatype: metatype as never });
      const ok = await pipe.transform({ statusRules: { prOpened: 'IN_PROGRESS', prMerged: null } }, meta(UpdateStatusRulesDto));
      expect(ok.statusRules.prMerged).toBeNull();
      await expect(pipe.transform({ statusRules: { prMerged: 'SHIPPED' } }, meta(UpdateStatusRulesDto))).rejects.toBeInstanceOf(BadRequestException);
      await expect(pipe.transform({ statusRules: { prMerged: 'DONE', hack: 1 } }, meta(UpdateStatusRulesDto))).rejects.toBeInstanceOf(BadRequestException);
      await expect(pipe.transform({}, meta(UpdateStatusRulesDto))).rejects.toBeInstanceOf(BadRequestException);
      await expect(pipe.transform({ repoId: '12', projectId: 'p' }, meta(LinkRepoDto))).rejects.toBeInstanceOf(BadRequestException);
      await expect(pipe.transform({ repoId: 0, projectId: 'p' }, meta(LinkRepoDto))).rejects.toBeInstanceOf(BadRequestException);
      const good = await pipe.transform({ repoId: 12, projectId: 'p', statusRules: { prClosed: 'TODO' } }, meta(LinkRepoDto));
      expect(good.statusRules?.prClosed).toBe('TODO');
    });
  });

  // ---------------------------------------------------------------- channel message

  describe('channel notification text', () => {
    it('EXTERNAL_LINKED renders "Linked PR #12" with the title as a field', async () => {
      const w = await world();
      await pr('opened');
      const [a] = await acts(w.t1.id, 'EXTERNAL_LINKED');
      const msg = await builder.build(a);
      expect(msg.summary).toBe('Linked PR #12');
      expect(msg.fields).toContainEqual({ label: 'GitHub', value: '#12 ENG-1 fix login' });
      expect(msg.title).toContain('ENG-1');
    });
  });
});
