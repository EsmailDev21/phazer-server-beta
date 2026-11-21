import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import {
  Activity,
  ActivityVisibility,
  ChannelDeliveryStatus,
  IntegrationConnectionStatus,
  Prisma,
} from '@prisma/client';
import { FeatureFlagsService } from '../../feature-flags/feature-flags.service';
import { PrismaService } from '../../prisma/prisma.service';
import { QUEUES } from '../../queue/queue.definitions';
import { QueueService } from '../../queue/queue.service';
import { NOTIFIABLE_ACTIONS } from './rich-message.builder';

declare module '../../queue/queue.definitions' {
  interface JobPayloads {
    'notify.deliver': { deliveryId: string };
  }
}

export const DEFAULT_MAX_PER_MINUTE = 20;
const NOTIFIABLE = new Set<string>(NOTIFIABLE_ACTIONS);

/**
 * activity.created -> ChannelSubscription match -> one PENDING ChannelDelivery per match -> `notify.deliver` job.
 * (ADR-0011.) Runs in BOTH processes: each emits and handles its own activities in-process, so a due-date
 * reminder raised by the worker is routed by the worker. Never throws into the emitter.
 */
@Injectable()
export class NotificationRouter {
  private readonly logger = new Logger(NotificationRouter.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly flags: FeatureFlagsService,
    private readonly config: ConfigService,
  ) {}

  @OnEvent('activity.created')
  async onActivity(activity: Activity): Promise<void> {
    try {
      await this.route(activity);
    } catch (e) {
      this.logger.error(`Routing failed for activity ${activity.id}: ${(e as Error).message}`, (e as Error).stack);
    }
  }

  /** Public for tests. Returns what it did per subscription. */
  async route(activity: Activity): Promise<Array<{ subscriptionId: string; outcome: 'queued' | 'echo' | 'rate_capped' | 'duplicate' | 'enqueue_failed' }>> {
    if (!this.flags.isEnabled('INTEGRATIONS')) return [];
    if (!NOTIFIABLE.has(activity.action)) return [];
    // Silent/bulk writes never reach here (ActivityService does not emit them); a SILENT-by-default action
    // (DUE_DATE_APPROACHING) only matches subscriptions that opted into SILENT.
    const projectId = await this.projectOf(activity);

    const subs = await this.prisma.channelSubscription.findMany({
      where: {
        enabled: true,
        events: { has: activity.action },
        channelLink: {
          kind: 'CHANNEL',
          workspaceId: activity.workspaceId,
          pausedAt: null,
          OR: projectId ? [{ projectId: null }, { projectId }] : [{ projectId: null }],
          // Defence in depth: the link's tenant must be the workspace's own account.
          connection: {
            status: IntegrationConnectionStatus.ACTIVE,
            account: { workspaces: { some: { id: activity.workspaceId } } },
          },
        },
      },
      select: { id: true, minVisibility: true, channelLink: { select: { connectionId: true, externalId: true } } },
    });

    const echo = (activity.metadata as { integration?: { connectionId?: string; channelId?: string } } | null)?.integration;
    const cap = Number(this.config.get('NOTIFY_MAX_PER_MINUTE') ?? DEFAULT_MAX_PER_MINUTE);
    const out: Array<{ subscriptionId: string; outcome: 'queued' | 'echo' | 'rate_capped' | 'duplicate' | 'enqueue_failed' }> = [];

    for (const sub of subs) {
      // minVisibility = the lowest visibility the subscription accepts: TIMELINE accepts TIMELINE only, SILENT accepts both.
      if (sub.minVisibility === ActivityVisibility.TIMELINE && activity.visibility !== ActivityVisibility.TIMELINE) continue;

      if (echo && echo.connectionId === sub.channelLink.connectionId && echo.channelId === sub.channelLink.externalId) {
        out.push({ subscriptionId: sub.id, outcome: (await this.record(sub.id, activity.id, 'SKIPPED', 'echo')) ? 'echo' : 'duplicate' });
        continue;
      }
      const recent = await this.prisma.channelDelivery.count({
        where: { subscriptionId: sub.id, status: { not: ChannelDeliveryStatus.SKIPPED }, createdAt: { gt: new Date(Date.now() - 60_000) } },
      });
      if (recent >= cap) {
        out.push({ subscriptionId: sub.id, outcome: (await this.record(sub.id, activity.id, 'SKIPPED', 'rate_capped')) ? 'rate_capped' : 'duplicate' });
        continue;
      }
      const id = await this.record(sub.id, activity.id, 'PENDING', null);
      if (!id) { out.push({ subscriptionId: sub.id, outcome: 'duplicate' }); continue; }
      try {
        await this.queue.enqueue(QUEUES.NOTIFY.name, 'notify.deliver', { deliveryId: id }, { jobId: `notify-${id}` });
        out.push({ subscriptionId: sub.id, outcome: 'queued' });
      } catch (e) {
        await this.prisma.channelDelivery.update({ where: { id }, data: { status: 'FAILED', error: 'enqueue_failed' } });
        this.logger.error(`Could not enqueue notify.deliver for ${id}: ${(e as Error).message}`);
        out.push({ subscriptionId: sub.id, outcome: 'enqueue_failed' });
      }
    }
    return out;
  }

  /** Task -> its project; PROJECT target -> itself. Anything else has no project scope. */
  private async projectOf(a: Activity): Promise<string | null> {
    if (a.targetType === 'PROJECT') return a.targetId;
    if (a.targetType !== 'TASK') return null;
    return (await this.prisma.task.findUnique({ where: { id: a.targetId }, select: { projectId: true } }))?.projectId ?? null;
  }

  /** Insert-once: the unique (subscription, activity) key makes routing idempotent. Null = already routed. */
  private async record(subscriptionId: string, activityId: string, status: ChannelDeliveryStatus, error: string | null): Promise<string | null> {
    try {
      return (await this.prisma.channelDelivery.create({ data: { subscriptionId, activityId, status, error }, select: { id: true } })).id;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return null;
      throw e;
    }
  }
}
