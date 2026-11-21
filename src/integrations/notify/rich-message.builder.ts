import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Activity, ActivityAction } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RichMessage } from '../core/integration.types';

/** Actions a channel may subscribe to (ADR-0011 d.2). MENTIONED/REACTED/TAG_* are not events a channel needs. */
export const NOTIFIABLE_ACTIONS: readonly ActivityAction[] = [
  ActivityAction.CREATED,
  ActivityAction.STATUS_CHANGED,
  ActivityAction.PRIORITY_CHANGED,
  ActivityAction.DUE_DATE_CHANGED,
  ActivityAction.ASSIGNED,
  ActivityAction.UNASSIGNED,
  ActivityAction.DESCRIPTION_UPDATED,
  ActivityAction.COMMENTED,
  ActivityAction.ARCHIVED,
  ActivityAction.RESTORED,
  ActivityAction.DUE_DATE_APPROACHING,
  ActivityAction.ATTACHMENT_ADDED,
  ActivityAction.DEPENDENCY_ADDED,
  ActivityAction.DEPENDENCY_REMOVED,
  ActivityAction.ISSUE_TYPE_CHANGED,
  ActivityAction.ITERATION_CHANGED,
  ActivityAction.EXTERNAL_LINKED,
];

/** What a new subscription listens to when the caller does not say. */
export const DEFAULT_EVENTS: readonly ActivityAction[] = [
  ActivityAction.CREATED,
  ActivityAction.STATUS_CHANGED,
  ActivityAction.ASSIGNED,
  ActivityAction.COMMENTED,
  ActivityAction.ARCHIVED,
];

const HEADLINE: Partial<Record<ActivityAction, string>> = {
  CREATED: 'Task created',
  STATUS_CHANGED: 'Status changed',
  PRIORITY_CHANGED: 'Priority changed',
  DUE_DATE_CHANGED: 'Due date changed',
  ASSIGNED: 'Assigned',
  UNASSIGNED: 'Unassigned',
  DESCRIPTION_UPDATED: 'Description updated',
  COMMENTED: 'New comment',
  ARCHIVED: 'Task archived',
  RESTORED: 'Task restored',
  DUE_DATE_APPROACHING: 'Due soon',
  ATTACHMENT_ADDED: 'Attachment added',
  DEPENDENCY_ADDED: 'Dependency added',
  DEPENDENCY_REMOVED: 'Dependency removed',
  ISSUE_TYPE_CHANGED: 'Issue type changed',
  ITERATION_CHANGED: 'Iteration changed',
  EXTERNAL_LINKED: 'Linked to GitHub',
};

const TONE: Partial<Record<ActivityAction, RichMessage['tone']>> = {
  CREATED: 'success',
  RESTORED: 'success',
  ARCHIVED: 'warning',
  DUE_DATE_APPROACHING: 'warning',
  DEPENDENCY_ADDED: 'info',
};

/** Why a message could not be built: the delivery is SKIPPED with this reason, not failed. */
export class TargetGoneError extends Error {}

/**
 * Activity -> RichMessage. Reads only; never trusts metadata beyond the few keys it knows, and cuts every
 * free-text value (a title can be anything a user typed) so one message cannot exceed a provider's limit.
 */
@Injectable()
export class RichMessageBuilder {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async build(activity: Activity): Promise<RichMessage> {
    if (activity.targetType !== 'TASK') throw new TargetGoneError('unsupported target');
    const task = await this.prisma.task.findUnique({
      where: { id: activity.targetId },
      select: {
        id: true, number: true, title: true, priority: true, dueDate: true,
        workspace: { select: { key: true } },
        project: { select: { name: true } },
      },
    });
    if (!task) throw new TargetGoneError('task deleted');
    const actor = activity.actorId
      ? (await this.prisma.user.findUnique({ where: { id: activity.actorId }, select: { name: true } }))?.name
      : undefined;
    const meta = (activity.metadata ?? {}) as Record<string, unknown>;
    const key = `${task.workspace.key}-${task.number}`;

    const fields: RichMessage['fields'] = [];
    if (task.project?.name) fields.push({ label: 'Project', value: cut(task.project.name, 80) });
    let summary = HEADLINE[activity.action] ?? activity.action;

    switch (activity.action) {
      case ActivityAction.STATUS_CHANGED: {
        const [from, to] = await this.statusNames(meta);
        if (from && to) summary = `Status: ${from} \u2192 ${to}`;
        break;
      }
      case ActivityAction.PRIORITY_CHANGED:
        summary = `Priority is now ${task.priority}`;
        break;
      case ActivityAction.DUE_DATE_CHANGED:
      case ActivityAction.DUE_DATE_APPROACHING:
        if (task.dueDate) fields.push({ label: 'Due', value: task.dueDate.toISOString().slice(0, 10) });
        break;
      case ActivityAction.ASSIGNED:
      case ActivityAction.UNASSIGNED: {
        const id = typeof meta.assigneeId === 'string' ? meta.assigneeId : null;
        const who = id ? (await this.prisma.user.findUnique({ where: { id }, select: { name: true } }))?.name : null;
        if (who) summary = `${HEADLINE[activity.action]}: ${cut(who, 60)}`;
        break;
      }
      case ActivityAction.EXTERNAL_LINKED: {
        const label = { PR: 'PR', ISSUE: 'Issue', COMMIT: 'Commit', BRANCH: 'Branch' }[String(meta.kind)];
        if (label && typeof meta.ref === 'string') summary = `Linked ${label} ${cut(meta.ref, 60)}`;
        if (typeof meta.title === 'string') fields.push({ label: 'GitHub', value: cut(meta.title, 200) });
        break;
      }
      default:
        break;
    }
    return {
      title: cut(`${key} ${task.title}`, 200),
      url: this.taskUrl(key, task.id),
      summary: cut(summary, 300),
      fields,
      actor: actor ? cut(actor, 60) : undefined,
      tone: TONE[activity.action] ?? 'info',
    };
  }

  /** TASK_URL_TEMPLATE may use {key} and {id}; default is {FRONTEND_URL}/tasks/{key}. Undefined when no base is configured. */
  taskUrl(key: string, id: string): string | undefined {
    const tpl = this.config.get<string>('TASK_URL_TEMPLATE');
    if (tpl) return tpl.replace('{key}', encodeURIComponent(key)).replace('{id}', encodeURIComponent(id));
    const base = (this.config.get<string>('FRONTEND_URL') ?? '').replace(/\/$/, '');
    return base ? `${base}/tasks/${encodeURIComponent(key)}` : undefined;
  }

  /**
   * The inverse of taskUrl(): which task key does this URL point at? Null for anything that is not one of OUR task links
   * (the Slack unfurl handler must ignore every other URL posted in a channel). Same rules as taskUrl: TASK_URL_TEMPLATE
   * (`{key}`, `{id}`) wins, else `{FRONTEND_URL}/tasks/{KEY-N}`. Matches the whole URL, no query-string tricks.
   */
  parseTaskKey(url: string): string | null {
    const KEY = '([A-Za-z][A-Za-z0-9]{0,19}-[0-9]{1,9})';
    const tpl = this.config.get<string>('TASK_URL_TEMPLATE');
    let pattern: string;
    if (tpl) {
      if (!tpl.includes('{key}')) return null; // an {id}-only template cannot be mapped back to a key
      pattern = tpl.split(/(\{key\}|\{id\})/).map((part) => (part === '{key}' ? KEY : part === '{id}' ? '[^/?#]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('');
    } else {
      const base = (this.config.get<string>('FRONTEND_URL') ?? '').replace(/\/$/, '');
      if (!base) return null;
      pattern = `${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/tasks/${KEY}`;
    }
    const m = new RegExp(`^${pattern}/?$`).exec(url);
    return m ? m[1].toUpperCase() : null;
  }

  private async statusNames(meta: Record<string, unknown>): Promise<[string | null, string | null]> {
    const ids = [meta.fromStatusId, meta.toStatusId].filter((x): x is string => typeof x === 'string');
    const rows = ids.length
      ? await this.prisma.workflowStatus.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
      : [];
    const name = (id: unknown, category: unknown) =>
      rows.find((r) => r.id === id)?.name ?? (typeof category === 'string' ? category : null);
    return [name(meta.fromStatusId, meta.fromCategory), name(meta.toStatusId, meta.toCategory)];
  }
}

const cut = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}\u2026`);
