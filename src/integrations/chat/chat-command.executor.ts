import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PermissionResolver } from '../../access-control/access-control.service';
import { DomainWriter } from '../../domain-writer/domain-writer.service';
import { PrismaService } from '../../prisma/prisma.service';
import { WorkspaceKeysService } from '../../tenancy/workspaces/workspace-keys.service';
import { TaskVisibilityService } from '../../projects-tasks/tasks/task-visibility.service';
import { ProjectsService } from '../../projects-tasks/projects/projects.service';
import { TasksService } from '../../projects-tasks/tasks/tasks.service';
import { IdentityService } from '../core/identity.service';
import { DEFAULT_EVENTS, RichMessageBuilder } from '../notify/rich-message.builder';
import { ChatActor, ChatIntent, ChatResult, ChatTaskCard, ChatTaskRef, ChatUserError } from './chat.types';

const LIST_LIMIT = 10;

/**
 * Runs a ChatIntent AS the linked user (ADR-0012 d.4). Authority is never the bot's: every branch asks the
 * PermissionResolver (and the visibility service for existing tasks) about `userId`, and a denial is the same
 * wording as "not found" where revealing existence would leak (a task you cannot see).
 * Provider-neutral: Slack (2.5) reuses it unchanged.
 */
@Injectable()
export class ChatCommandExecutor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: PermissionResolver,
    private readonly tasks: TasksService,
    private readonly projects: ProjectsService,
    private readonly writer: DomainWriter,
    private readonly keys: WorkspaceKeysService,
    private readonly visibility: TaskVisibilityService,
    private readonly identities: IdentityService,
    private readonly messages: RichMessageBuilder,
    private readonly config: ConfigService,
  ) {}

  async execute(userId: string, actor: ChatActor, intent: ChatIntent): Promise<ChatResult> {
    switch (intent.kind) {
      case 'create':
        return this.create(userId, actor, intent.title, { projectName: intent.projectName, assigneeExternalId: intent.assigneeExternalId, due: intent.due, priority: intent.priority });
      case 'create_from_message':
        return this.create(userId, actor, intent.title, { projectName: intent.projectName, description: intent.description, source: intent.source });
      case 'update':
        return this.update(userId, actor, intent);
      case 'assign':
        return this.assign(userId, actor, intent.key, intent.assigneeExternalId);
      case 'assign_me':
        return this.assignMe(userId, actor, intent.taskId);
      case 'set_due':
        return this.setDue(userId, actor, intent.taskId, intent.due);
      case 'list':
        return this.list(userId, actor, intent.projectName, intent.mine === true);
      case 'link':
        return this.link(userId, actor, intent.workspaceKey, intent.projectName);
    }
  }

  // ---------------------------------------------------------------- scope: which workspace / project is "here"

  /** Channel link wins over the server link; paused links do not count (a revoked connection pauses them). */
  private async scopeOf(actor: ChatActor): Promise<{ workspaceId: string; projectId: string | null } | null> {
    const links = await this.prisma.channelLink.findMany({
      where: { connectionId: actor.connectionId, pausedAt: null, OR: [{ kind: 'CHANNEL', externalId: actor.channelId }, { kind: 'GUILD', externalId: actor.tenantId }] },
      select: { kind: true, workspaceId: true, projectId: true },
    });
    const channel = links.find((l) => l.kind === 'CHANNEL');
    const guild = links.find((l) => l.kind === 'GUILD');
    const base = channel ?? guild;
    return base ? { workspaceId: base.workspaceId, projectId: channel?.projectId ?? null } : null;
  }

  private async needScope(actor: ChatActor) {
    const s = await this.scopeOf(actor);
    if (!s) throw new ChatUserError('This server is not linked to a workspace yet. An admin can run `/task link workspace:KEY`.');
    return s;
  }

  private async projectIn(workspaceId: string, name: string) {
    const rows = await this.prisma.project.findMany({ where: { workspaceId, name: { equals: name.trim(), mode: 'insensitive' } }, select: { id: true, name: true }, take: 2 });
    if (rows.length === 0) throw new ChatUserError(`There is no project called "${name.slice(0, 60)}" in the linked workspace.`);
    if (rows.length > 1) throw new ChatUserError(`More than one project is called "${name.slice(0, 60)}"; rename one or use the web app.`);
    return rows[0];
  }

  // ---------------------------------------------------------------- create

  /** Everything that can be refused BEFORE a write; shared by `preflight` (sync, pre-ack) and the write itself. */
  private async prepareCreate(userId: string, actor: ChatActor, o: { projectName?: string; assigneeExternalId?: string; source?: { kind: 'MESSAGE' | 'THREAD'; externalId: string } }) {
    const scope = await this.needScope(actor);
    const projectId = o.projectName ? (await this.projectIn(scope.workspaceId, o.projectName)).id : scope.projectId;

    const perm = await this.resolver.resolve(userId, 'createTask', 'WORKSPACE', scope.workspaceId);
    if (!perm.allowed) {
      throw new ChatUserError(perm.planLimitExceeded ? 'This plan has reached its task limit.' : 'You are not allowed to create tasks in this workspace.');
    }
    if (projectId && !(await this.canSeeProject(userId, projectId))) throw new ChatUserError('You do not have access to that project.');

    let assigneeIds: string[] | undefined;
    if (o.assigneeExternalId) {
      const a = await this.identities.lookupLinkedUserId(actor.connectionId, o.assigneeExternalId);
      if (!a) throw new ChatUserError('That person has not linked their account yet, so they cannot be assigned from chat.');
      assigneeIds = [a];
    }
    if (o.source) {
      const dup = await this.prisma.externalLink.findFirst({ where: { provider: actor.provider, kind: o.source.kind, externalId: o.source.externalId }, select: { task: { select: { workspaceId: true } } } });
      if (dup && dup.task.workspaceId === scope.workspaceId) throw new ChatUserError('A task was already created from this message.');
    }
    return { scope, projectId, assigneeIds };
  }

  /**
   * Cheap read-only validation run BEFORE the ack, so a refusal of a PUBLIC command (create) is a private reply
   * instead of an error shown to the whole channel. Nothing is written. Other intents are validated in the job.
   */
  async preflight(userId: string, actor: ChatActor, intent: ChatIntent): Promise<void> {
    if (intent.kind === 'create') await this.prepareCreate(userId, actor, intent);
    else if (intent.kind === 'create_from_message') await this.prepareCreate(userId, actor, intent);
  }

  private async create(
    userId: string, actor: ChatActor, title: string,
    o: { projectName?: string; assigneeExternalId?: string; due?: string; priority?: import('@prisma/client').Priority; description?: string; source?: { kind: 'MESSAGE' | 'THREAD'; externalId: string; url: string } },
  ): Promise<ChatResult> {
    const { scope, projectId, assigneeIds } = await this.prepareCreate(userId, actor, o);
    const ctx = { origin: 'INTEGRATION' as const, actorId: userId, integrationSource: { connectionId: actor.connectionId, channelId: actor.channelId } };
    const task = await this.writer.run(ctx, async (c) => {
      const t = await this.tasks.create(
        { workspaceId: scope.workspaceId, projectId: projectId ?? undefined, title, description: o.description, priority: o.priority, dueDate: o.due } as never,
        userId, c, assigneeIds ? { assigneeIds } : undefined,
      );
      if (o.source) {
        await c.tx!.externalLink.create({
          data: { taskId: t.id, provider: actor.provider, kind: o.source.kind, externalId: o.source.externalId, url: o.source.url, title: o.source.kind === 'THREAD' ? 'Discord thread' : 'Discord message' },
        });
      }
      return t;
    });
    const ref = await this.refOf(task.id);
    return { visibility: 'public', text: `**${ref.key}** created: ${ref.title}${o.due ? ` (due ${o.due})` : ''}`, task: ref };
  }

  // ---------------------------------------------------------------- update / assign

  private async update(userId: string, actor: ChatActor, i: Extract<ChatIntent, { kind: 'update' }>): Promise<ChatResult> {
    const taskId = await this.visibleTask(userId, actor, i.key);
    await this.authorize(userId, 'editTask', taskId);
    await this.tasks.update(taskId, { title: i.title, status: i.status, priority: i.priority, dueDate: i.due } as never, userId);
    const ref = await this.refOf(taskId);
    return { visibility: 'private', text: `Updated **${ref.key}**.`, task: ref };
  }

  private async assign(userId: string, actor: ChatActor, key: string, extUser: string): Promise<ChatResult> {
    const taskId = await this.visibleTask(userId, actor, key);
    await this.authorize(userId, 'assignTask', taskId);
    const assignee = await this.identities.lookupLinkedUserId(actor.connectionId, extUser);
    if (!assignee) throw new ChatUserError('That person has not linked their account yet, so they cannot be assigned from chat.');
    await this.addAssignee(userId, taskId, assignee);
    const ref = await this.refOf(taskId);
    return { visibility: 'private', text: `Assigned **${ref.key}**.`, task: ref };
  }

  private async assignMe(userId: string, actor: ChatActor, taskId: string): Promise<ChatResult> {
    await this.assertTaskInAccount(userId, actor, taskId);
    await this.authorize(userId, 'assignTask', taskId);
    await this.addAssignee(userId, taskId, userId);
    const ref = await this.refOf(taskId);
    return { visibility: 'private', text: `You are now assigned to **${ref.key}**.`, task: ref };
  }

  private async setDue(userId: string, actor: ChatActor, taskId: string, due: string): Promise<ChatResult> {
    await this.assertTaskInAccount(userId, actor, taskId);
    await this.authorize(userId, 'editTask', taskId);
    await this.tasks.update(taskId, { dueDate: due } as never, userId);
    const ref = await this.refOf(taskId);
    return { visibility: 'private', text: `**${ref.key}** is now due ${due}.`, task: ref };
  }

  private async addAssignee(userId: string, taskId: string, assigneeId: string) {
    const current = await this.prisma.task.findUniqueOrThrow({ where: { id: taskId }, select: { assignees: { select: { id: true } } } });
    const ids = [...new Set([...current.assignees.map((u) => u.id), assigneeId])];
    await this.tasks.setAssignees(taskId, { userIds: ids }, userId);
  }

  // ---------------------------------------------------------------- list

  private async list(userId: string, actor: ChatActor, projectName: string | undefined, mine: boolean): Promise<ChatResult> {
    const scope = await this.needScope(actor);
    const projectId = projectName ? (await this.projectIn(scope.workspaceId, projectName)).id : scope.projectId ?? undefined;
    const res = await this.tasks.list(userId, { workspaceId: scope.workspaceId, projectId, assigneeId: mine ? userId : undefined, take: LIST_LIMIT, skip: 0 } as never);
    if (res.data.length === 0) return { visibility: 'private', text: 'No tasks found.' };
    const lines = await Promise.all(res.data.map(async (t) => {
      const key = await this.keyOf(t.id);
      return `\u2022 **${key}** [${t.status}] ${String(t.title).slice(0, 80)}`;
    }));
    return { visibility: 'private', text: `${res.total} task${res.total === 1 ? '' : 's'}${res.total > LIST_LIMIT ? ` (showing ${LIST_LIMIT})` : ''}:`, lines };
  }

  // ---------------------------------------------------------------- link (admin)

  private async link(userId: string, actor: ChatActor, workspaceKey?: string, projectName?: string): Promise<ChatResult> {
    if (!actor.canManageServer) {
      throw new ChatUserError(actor.provider === 'SLACK' ? 'Only Slack workspace admins and owners can link channels.' : 'You need the Manage Server permission to link channels.');
    }

    if (!workspaceKey && !projectName) {
      const scope = await this.scopeOf(actor);
      if (!scope) return { visibility: 'private', text: 'This server is not linked yet. Use `/task link workspace:KEY`.' };
      const ws = await this.prisma.workspace.findUnique({ where: { id: scope.workspaceId }, select: { key: true, name: true } });
      const pr = scope.projectId ? await this.prisma.project.findUnique({ where: { id: scope.projectId }, select: { name: true } }) : null;
      return { visibility: 'private', text: `Linked to workspace **${ws?.key}** (${ws?.name})${pr ? `; this channel posts to project **${pr.name}**` : ''}.` };
    }

    let workspaceId: string;
    if (workspaceKey) {
      const ws = await this.prisma.workspace.findFirst({ where: { accountId: actor.accountId, key: workspaceKey }, select: { id: true } });
      if (!ws) throw new ChatUserError(`This account has no workspace with key ${workspaceKey.slice(0, 20)}.`);
      workspaceId = ws.id;
    } else {
      const guild = await this.prisma.channelLink.findFirst({ where: { connectionId: actor.connectionId, kind: 'GUILD', externalId: actor.tenantId, pausedAt: null }, select: { workspaceId: true } });
      if (!guild) throw new ChatUserError('Link the server to a workspace first: `/task link workspace:KEY`.');
      workspaceId = guild.workspaceId;
    }
    const perm = await this.resolver.resolve(userId, 'linkChannel', 'WORKSPACE', workspaceId);
    if (!perm.allowed) throw new ChatUserError('Only workspace admins can link channels to this workspace.');

    const parts: string[] = [];
    if (workspaceKey) {
      await this.prisma.channelLink.upsert({
        where: { connectionId_kind_externalId: { connectionId: actor.connectionId, kind: 'GUILD', externalId: actor.tenantId } },
        create: { connectionId: actor.connectionId, kind: 'GUILD', externalId: actor.tenantId, workspaceId, configuredById: userId },
        update: { workspaceId, configuredById: userId, pausedAt: null },
      });
      parts.push(`server linked to workspace **${workspaceKey}**`);
    }
    if (projectName) {
      const project = await this.projectIn(workspaceId, projectName);
      const link = await this.prisma.channelLink.upsert({
        where: { connectionId_kind_externalId: { connectionId: actor.connectionId, kind: 'CHANNEL', externalId: actor.channelId } },
        create: { connectionId: actor.connectionId, kind: 'CHANNEL', externalId: actor.channelId, workspaceId, projectId: project.id, configuredById: userId },
        update: { workspaceId, projectId: project.id, configuredById: userId, pausedAt: null },
        select: { id: true },
      });
      // A linked channel should actually hear about its project: give it the default subscription once.
      if ((await this.prisma.channelSubscription.count({ where: { channelLinkId: link.id } })) === 0) {
        await this.prisma.channelSubscription.create({ data: { channelLinkId: link.id, events: [...DEFAULT_EVENTS] } });
      }
      parts.push(`this channel linked to project **${project.name}** (notifications on)`);
    }
    return { visibility: 'private', text: `Done: ${parts.join('; ')}.` };
  }

  // ---------------------------------------------------------------- unfurl

  /** A task as a card for the viewer, or null when it is not in this account or not visible to them (then nothing is unfurled). */
  async describeTask(userId: string, actor: ChatActor, key: string): Promise<ChatTaskCard | null> {
    let taskId: string;
    try {
      taskId = await this.visibleTask(userId, actor, key);
    } catch {
      return null;
    }
    const t = await this.prisma.task.findUniqueOrThrow({
      where: { id: taskId },
      select: { id: true, title: true, status: true, priority: true, dueDate: true, number: true, workspace: { select: { key: true } }, project: { select: { name: true } }, assignees: { select: { name: true } } },
    });
    const k = `${t.workspace.key}-${t.number}`;
    return { key: k, title: t.title.slice(0, 200), url: this.messages.taskUrl(k, t.id), status: t.status ?? 'UNKNOWN', priority: t.priority ?? 'NONE', due: t.dueDate?.toISOString().slice(0, 10), assignees: t.assignees.map((a) => a.name).slice(0, 5), project: t.project?.name };
  }

  // ---------------------------------------------------------------- helpers

  /** Key -> task id, but only a task in THIS connection's account that the caller may see; else the same 404 wording. */
  private async visibleTask(userId: string, actor: ChatActor, key: string): Promise<string> {
    const resolved = await this.keys.resolveTask(this.prisma, actor.accountId, key.trim().toUpperCase());
    if (!resolved || !(await this.visibility.canViewTask(userId, resolved.taskId))) throw new ChatUserError('No task with that key.');
    return resolved.taskId;
  }

  /** Button clicks carry a task id (from a message anyone in the channel can see): it must be in this account AND visible to the clicker. */
  private async assertTaskInAccount(userId: string, actor: ChatActor, taskId: string): Promise<void> {
    const t = await this.prisma.task.findFirst({ where: { id: taskId, workspace: { accountId: actor.accountId } }, select: { id: true } });
    if (!t || !(await this.visibility.canViewTask(userId, taskId))) throw new ChatUserError('No task with that key.');
  }

  private async authorize(userId: string, action: 'editTask' | 'assignTask', taskId: string): Promise<void> {
    const r = await this.resolver.resolve(userId, action, 'TASK', taskId);
    if (!r.allowed) throw new ChatUserError('You are not allowed to change that task.');
  }

  /** Creating into a project needs the project to be visible to the user (a member-restricted project is not). */
  private async canSeeProject(userId: string, projectId: string): Promise<boolean> {
    try {
      await this.projects.assertCanView(userId, projectId);
      return true;
    } catch {
      return false;
    }
  }

  private async keyOf(taskId: string): Promise<string> {
    const t = await this.prisma.task.findUniqueOrThrow({ where: { id: taskId }, select: { number: true, workspace: { select: { key: true } } } });
    return `${t.workspace.key}-${t.number}`;
  }

  private async refOf(taskId: string): Promise<ChatTaskRef> {
    const t = await this.prisma.task.findUniqueOrThrow({ where: { id: taskId }, select: { id: true, title: true, number: true, workspace: { select: { key: true } } } });
    const key = `${t.workspace.key}-${t.number}`;
    return { id: t.id, key, title: t.title.slice(0, 120), url: this.messages.taskUrl(key, t.id) };
  }
}
