import { Injectable, Logger } from '@nestjs/common';
import { ActivityAction, ActivityTargetType, AuditAction, ExternalLinkKind, IntegrationConnectionStatus, TaskStatus } from '@prisma/client';
import { DomainWriter } from '../../domain-writer/domain-writer.service';
import { WriteContext } from '../../domain-writer/write-context';
import { ActivityService } from '../../events/activity.service';
import { AuditLogService } from '../../events/audit-log.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TasksService } from '../../projects-tasks/tasks/tasks.service';
import { WorkspaceKeysService } from '../../tenancy/workspaces/workspace-keys.service';
import { CredentialService } from '../core/credential.service';
import { IdentityService } from '../core/identity.service';
import { GhRepo, GhSender, GithubWork } from './github.protocol';
import { TaskRef, extractTaskRefs } from './key-parser';
import { PrTrigger, decideStatus, rulesFromConfig } from './status-rules';

/** One thing found in a delivery that may deserve a link: a PR, an issue, a commit, a branch. */
interface Item {
  kind: ExternalLinkKind;
  externalId: string;
  url: string;
  title: string;
  state: string | null;
  /** Human reference for the timeline: `#42`, `abc1234`, the branch name. */
  ref: string;
  texts: string[];
  /** SILENT activity (commits, branches): history only, no channel messages. */
  silent: boolean;
  /** Only PRs drive status rules. */
  trigger?: PrTrigger;
  action?: string;
}

type ContentWork = Exclude<GithubWork, { kind: 'installation' | 'installation_repos' }>;

export type ProcessOutcome =
  | { handled: false; reason: 'no-connection' | 'repo-not-linked' | 'nothing-to-do' }
  | { handled: true; linked: number; updated: number; statusChanges: number }
  | { handled: true; lifecycle: string };

const MAX_TASKS_PER_ITEM = 10;
const GITHUB = 'GITHUB' as const;
const SUSPENDED = 'GitHub App suspended';
const NOT_REVOKED = [IntegrationConnectionStatus.ACTIVE, IntegrationConnectionStatus.NEEDS_REAUTH, IntegrationConnectionStatus.ERROR];

/**
 * The part of step 2.6 that touches the database (ADR-0014). Everything arrives here already verified (signature) and
 * deduplicated (delivery id); this class decides WHICH workspace a delivery may touch and what it may do there:
 *
 *  - installation id -> the ONE live GITHUB connection (its account is the tenant);
 *  - (connection, repo id) -> the REPO `ChannelLink` (paused or missing = ignore): its workspace is the ONLY workspace a key may resolve in;
 *  - `ENG-123` -> a task iff ENG is a current key or retired alias OF THAT WORKSPACE and the number exists there. A key of
 *    another workspace of the same account, or of another account, never matches (acceptance criterion of 2.6).
 */
@Injectable()
export class GithubLinkService {
  private readonly logger = new Logger(GithubLinkService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly keys: WorkspaceKeysService,
    private readonly writer: DomainWriter,
    private readonly tasks: TasksService,
    private readonly activities: ActivityService,
    private readonly identities: IdentityService,
    private readonly credentials: CredentialService,
    private readonly audit: AuditLogService,
  ) {}

  async process(work: GithubWork): Promise<ProcessOutcome> {
    switch (work.kind) {
      case 'installation':
        return this.installationEvent(work.installationId, work.action);
      case 'installation_repos':
        return this.repositoriesEvent(work.installationId, work.added, work.removed);
      default:
        return this.contentEvent(work);
    }
  }

  // ------------------------------------------------------------------ PR / issue / push / branch

  private async contentEvent(work: ContentWork): Promise<ProcessOutcome> {
    const conn = await this.prisma.integrationConnection.findFirst({
      where: { provider: GITHUB, externalAccountId: work.installationId, status: IntegrationConnectionStatus.ACTIVE },
      select: { id: true, accountId: true },
    });
    if (!conn) return { handled: false, reason: 'no-connection' };

    const link = await this.prisma.channelLink.findUnique({
      where: { connectionId_kind_externalId: { connectionId: conn.id, kind: 'REPO', externalId: String(work.repo.id) } },
      select: { workspaceId: true, pausedAt: true, config: true, workspace: { select: { accountId: true } } },
    });
    // Paused (installation / repo removed) or never linked: nothing from the payload is used.
    if (!link || link.pausedAt) return { handled: false, reason: 'repo-not-linked' };
    // Defence in depth: the linked workspace must belong to the connection's own account.
    if (link.workspace.accountId !== conn.accountId) return { handled: false, reason: 'repo-not-linked' };

    const items = this.itemsOf(work);
    // Attribution only: a GitHub user who linked their identity is the actor, everyone else is the "GitHub" system actor (null).
    const actorId = work.sender ? await this.identities.lookupLinkedUserId(conn.id, work.sender.id) : null;
    const rules = rulesFromConfig(link.config);
    const keyCache = new Map<string, boolean>();
    let linked = 0, updated = 0, statusChanges = 0, any = false;

    for (const item of items) {
      const refs = extractTaskRefs(item.texts);
      if (refs.length === 0) continue;
      const found = (await this.tasksIn(conn.accountId, link.workspaceId, refs, keyCache)).slice(0, MAX_TASKS_PER_ITEM);
      for (const t of found) {
        any = true;
        const r = await this.upsertLink(t.id, link.workspaceId, actorId, work.sender, item);
        if (r === 'created') linked++; else updated++;
        if (item.trigger) {
          const to = decideStatus(rules, item.trigger, t.status);
          if (to && (await this.applyStatus(t.id, to, actorId, work.repo, item))) statusChanges++;
        }
      }
    }
    return any ? { handled: true, linked, updated, statusChanges } : { handled: false, reason: 'nothing-to-do' };
  }

  private itemsOf(w: ContentWork): Item[] {
    const base = `https://github.com/${w.repo.fullName}`;
    switch (w.kind) {
      case 'pr': {
        const state = w.pr.merged ? 'merged' : w.pr.closed ? 'closed' : w.pr.draft ? 'draft' : 'open';
        const trigger: PrTrigger | undefined =
          w.action === 'opened' || w.action === 'reopened' || w.action === 'ready_for_review' ? 'opened'
            : w.action === 'closed' ? (w.pr.merged ? 'merged' : 'closed') : undefined;
        return [{ kind: 'PR', externalId: `${w.repo.id}#${w.pr.number}`, url: `${base}/pull/${w.pr.number}`, title: `#${w.pr.number} ${w.pr.title}`.slice(0, 300), state, ref: `#${w.pr.number}`, texts: [w.pr.title, w.pr.headRef, w.pr.body], silent: false, trigger, action: w.action }];
      }
      case 'issue':
        return [{ kind: 'ISSUE', externalId: `${w.repo.id}#${w.issue.number}`, url: `${base}/issues/${w.issue.number}`, title: `#${w.issue.number} ${w.issue.title}`.slice(0, 300), state: w.issue.closed ? 'closed' : 'open', ref: `#${w.issue.number}`, texts: [w.issue.title, w.issue.body], silent: false, action: w.action }];
      case 'branch':
        return [this.branchItem(w.repo, w.branch)];
      case 'push':
        return [
          this.branchItem(w.repo, w.branch),
          ...w.commits.map((c): Item => ({ kind: 'COMMIT', externalId: `${w.repo.id}@${c.sha}`, url: `${base}/commit/${c.sha}`, title: `${c.sha.slice(0, 7)} ${c.message.split('\n')[0]}`.slice(0, 300), state: null, ref: c.sha.slice(0, 7), texts: [c.message], silent: true })),
        ];
    }
  }

  private branchItem(repo: GhRepo, branch: string): Item {
    const path = branch.split('/').map(encodeURIComponent).join('/');
    return { kind: 'BRANCH', externalId: `${repo.id}:${branch}`.slice(0, 300), url: `https://github.com/${repo.fullName}/tree/${path}`, title: branch.slice(0, 300), state: null, ref: branch.slice(0, 100), texts: [branch], silent: true };
  }

  /** Candidate keys -> tasks of the LINKED workspace only. `cache` remembers per key whether it belongs to that workspace. */
  private async tasksIn(accountId: string, workspaceId: string, refs: TaskRef[], cache: Map<string, boolean>): Promise<Array<{ id: string; status: TaskStatus }>> {
    const wanted: Array<{ number: number }> = [];
    for (const r of refs) {
      if (!cache.has(r.key)) {
        const ws = await this.keys.resolve(this.prisma, accountId, r.key);
        cache.set(r.key, ws?.workspaceId === workspaceId);
      }
      if (cache.get(r.key)) wanted.push({ number: r.number });
    }
    if (wanted.length === 0) return [];
    return this.prisma.task.findMany({ where: { workspaceId, number: { in: [...new Set(wanted.map((w) => w.number))] } }, select: { id: true, status: true }, orderBy: { number: 'asc' } });
  }

  /**
   * Insert-or-update by the 1.6 key (task, provider, kind, externalId). Re-delivery updates state/title/lastSeenAt and writes
   * NO second activity. A PR that already reached a final state is not moved back by a late, out-of-order delivery (mergeState).
   */
  private async upsertLink(taskId: string, workspaceId: string, actorId: string | null, sender: GhSender | null, item: Item): Promise<'created' | 'updated'> {
    const ctx: WriteContext = { origin: 'INTEGRATION', actorId, silent: item.silent };
    return this.writer.run(ctx, async (c) => {
      const tx = c.tx!;
      const where = { taskId_provider_kind_externalId: { taskId, provider: GITHUB, kind: item.kind, externalId: item.externalId } } as const;
      const existing = await tx.externalLink.findUnique({ where });
      if (existing) {
        await tx.externalLink.update({ where: { id: existing.id }, data: { state: mergeState(existing.state, item.state, item.action), title: item.title, url: item.url, lastSeenAt: new Date() } });
        return 'updated' as const;
      }
      await tx.externalLink.create({ data: { taskId, provider: GITHUB, kind: item.kind, externalId: item.externalId, url: item.url, title: item.title, state: item.state } });
      await this.activities.record(
        {
          actorId, action: ActivityAction.EXTERNAL_LINKED, targetType: ActivityTargetType.TASK, targetId: taskId, workspaceId,
          metadata: { provider: GITHUB, kind: item.kind, ref: item.ref, title: item.title.slice(0, 200), ...(sender?.login ? { login: sender.login } : {}) },
        },
        c,
      );
      return 'created' as const;
    });
  }

  /** The rule fired: change the status through the normal service (workflow resolution, activity, fan-out). A refusal (e.g. an enforced transition) is logged and skipped, never fails the delivery. */
  private async applyStatus(taskId: string, to: TaskStatus, actorId: string | null, repo: GhRepo, item: Item): Promise<boolean> {
    try {
      await this.tasks.update(taskId, { status: to } as never, actorId, {
        ctx: { origin: 'INTEGRATION', actorId },
        metadata: { source: { provider: GITHUB, kind: item.kind, ref: item.ref, repo: repo.fullName } },
      });
      return true;
    } catch (e) {
      this.logger.warn(`GitHub status rule not applied to task ${taskId} (${to}): ${(e as Error).message}`);
      return false;
    }
  }

  // ------------------------------------------------------------------ installation lifecycle

  private async liveConnection(installationId: string) {
    return this.prisma.integrationConnection.findFirst({
      where: { provider: GITHUB, externalAccountId: installationId, status: { in: NOT_REVOKED } },
      select: { id: true, accountId: true, createdById: true, status: true },
    });
  }

  /**
   * deleted: the App was uninstalled on GitHub. Links are KEPT (paused), the connection goes REVOKED and the credential is
   * deleted, so reinstalling and reconnecting revives everything (ADR-0009 d.3). One audit row alerts the account's owners/admins.
   * suspend / unsuspend: reversible, so the connection only toggles ACTIVE <-> ERROR('suspended'); nothing is deleted.
   */
  private async installationEvent(installationId: string, action: 'deleted' | 'suspend' | 'unsuspend'): Promise<ProcessOutcome> {
    const conn = await this.liveConnection(installationId);
    if (!conn) return { handled: false, reason: 'no-connection' };

    if (action === 'suspend') {
      await this.prisma.integrationConnection.updateMany({ where: { id: conn.id, status: IntegrationConnectionStatus.ACTIVE }, data: { status: IntegrationConnectionStatus.ERROR, lastError: SUSPENDED } });
      return { handled: true, lifecycle: 'suspended' };
    }
    if (action === 'unsuspend') {
      await this.prisma.integrationConnection.updateMany({ where: { id: conn.id, status: IntegrationConnectionStatus.ERROR, lastError: SUSPENDED }, data: { status: IntegrationConnectionStatus.ACTIVE, lastError: null } });
      return { handled: true, lifecycle: 'unsuspended' };
    }

    const flipped = await this.prisma.$transaction(async (tx) => {
      const r = await tx.integrationConnection.updateMany({ where: { id: conn.id, status: { in: NOT_REVOKED } }, data: { status: IntegrationConnectionStatus.REVOKED, lastError: 'GitHub App uninstalled' } });
      if (r.count === 0) return false;
      await this.credentials.remove(conn.id, tx);
      await tx.channelLink.updateMany({ where: { connectionId: conn.id, pausedAt: null }, data: { pausedAt: new Date() } });
      return true;
    });
    if (flipped) {
      // actorId is required by AuditLog; `system: true` keeps the connection's creator among the people alerted.
      await this.audit.record({ actorId: conn.createdById, accountId: conn.accountId, action: AuditAction.INTEGRATION_DISCONNECTED, metadata: { connectionId: conn.id, provider: GITHUB, reason: 'installation_deleted', system: true } });
    }
    return { handled: true, lifecycle: 'deleted' };
  }

  /** Repos removed from the installation: their links pause (kept). Added back: paused links resume, but only while the connection is ACTIVE. */
  private async repositoriesEvent(installationId: string, added: number[], removed: number[]): Promise<ProcessOutcome> {
    const conn = await this.liveConnection(installationId);
    if (!conn) return { handled: false, reason: 'no-connection' };
    if (removed.length) {
      await this.prisma.channelLink.updateMany({ where: { connectionId: conn.id, kind: 'REPO', externalId: { in: removed.map(String) }, pausedAt: null }, data: { pausedAt: new Date() } });
    }
    if (added.length && conn.status === IntegrationConnectionStatus.ACTIVE) {
      await this.prisma.channelLink.updateMany({ where: { connectionId: conn.id, kind: 'REPO', externalId: { in: added.map(String) }, pausedAt: { not: null } }, data: { pausedAt: null } });
    }
    return { handled: true, lifecycle: 'repositories' };
  }
}

/** ExternalLink.state is the provider's word. merged is final (a PR cannot be un-merged); closed only becomes open again through `reopened`. */
export function mergeState(existing: string | null, incoming: string | null, action?: string): string | null {
  if (incoming === null) return existing;
  if (existing === 'merged') return 'merged';
  if (existing === 'closed' && incoming !== 'merged' && incoming !== 'closed' && action !== 'reopened') return 'closed';
  return incoming;
}
