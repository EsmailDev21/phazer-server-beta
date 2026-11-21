import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  DeliveryStatus,
  NotificationChannel,
  NotificationSourceType,
  NotificationType,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { NotificationSseRegistry } from '../sse/notification-sse-registry.service';

type ChannelPrefs = Partial<Record<NotificationChannel, boolean>>;
type NotificationSettings = Partial<Record<NotificationType, ChannelPrefs>>;

/**
 * Default channel prefs when UserPreferences.notificationSettings is null
 * or doesn't mention this NotificationType — IN_APP on, EMAIL/PUSH off.
 * Validated shape per Foundations-era decision: map of
 * NotificationType -> {inApp, email, push}, stored with lowercase keys in
 * the JSON blob (matches the graph's literal "{inApp,email,push}" spec) —
 * translated to/from the Prisma NotificationChannel enum (IN_APP/EMAIL/PUSH)
 * at the boundary here, since JSON keys and enum values use different casing.
 */
const DEFAULT_CHANNELS: Record<NotificationChannel, boolean> = {
  IN_APP: true,
  EMAIL: false,
  PUSH: false,
};

const CHANNEL_JSON_KEY: Record<
  NotificationChannel,
  'inApp' | 'email' | 'push'
> = {
  IN_APP: 'inApp',
  EMAIL: 'email',
  PUSH: 'push',
};

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sseRegistry: NotificationSseRegistry,
  ) {}

  /**
   * Creates ONE Notification + one NotificationDelivery row per channel
   * the recipient has enabled for this type (AN__DELIVERY__PREFS).
   * IN_APP delivery is marked SENT immediately (the row existing IS the
   * delivery — client polls/subscribes directly); EMAIL/PUSH are PENDING,
   * picked up by a background queue that does not exist in this codebase
   * yet (documented gap, see README) — never a silent swallow on failure,
   * per AN__DELIVERY__CHANNELS.
   */
  async createNotification(params: {
    userId: string;
    type: NotificationType;
    sourceType: NotificationSourceType;
    sourceId: string;
    /** extra fields for the LIVE push only (a rule's message text); the stored row has none */
    extra?: Record<string, unknown>;
  }): Promise<void> {
    const prefs = await this.getChannelPrefs(params.userId, params.type);

    const notification = await this.prisma.notification.create({
      data: {
        userId: params.userId,
        type: params.type,
        sourceType: params.sourceType,
        sourceId: params.sourceId,
      },
    });

    const enabledChannels = (
      Object.keys(prefs) as NotificationChannel[]
    ).filter((c) => prefs[c]);

    await Promise.all(
      enabledChannels.map((channel) =>
        this.prisma.notificationDelivery.create({
          data: {
            notificationId: notification.id,
            channel,
            status:
              channel === NotificationChannel.IN_APP
                ? DeliveryStatus.SENT
                : DeliveryStatus.PENDING,
            sentAt:
              channel === NotificationChannel.IN_APP ? new Date() : undefined,
          },
        }),
      ),
    );

    // IN_APP is ALSO pushed live via SSE, not just polled/fetched - a
    // best-effort push; the REST fetch above already persisted the row
    // (SSE never the source of truth, per AN__DELIVERY__SSE). Step 0.4:
    // always goes through Redis pub/sub (see NotificationSseRegistry /
    // RedisPubSubService class docs) - this is also how a notification
    // created in the WORKER process (no browser connections of its own,
    // ADR-0001) reaches whichever API instance holds the recipient's
    // connection.
    if (enabledChannels.includes(NotificationChannel.IN_APP)) {
      await this.sseRegistry.publish(params.userId, {
        id: notification.id,
        type: notification.type,
        sourceType: notification.sourceType,
        sourceId: notification.sourceId,
        createdAt: notification.createdAt,
        ...params.extra,
      });
    }
  }

  async list(userId: string, unreadOnly: boolean, pagination: PaginationDto) {
    const where = { userId, ...(unreadOnly && { readAt: null }) };
    const [data, total] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        take: pagination.take,
        skip: pagination.skip,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.notification.count({ where }),
    ]);
    return {
      data: await this.withAutomationMessages(data),
      total,
      take: pagination.take,
      skip: pagination.skip,
    };
  }

  /**
   * A rule's notification carries its text in the row it points at: put it on the notification, so the
   * client does not need a second request (other notifications are returned as they were).
   */
  private async withAutomationMessages<
    T extends { sourceType: NotificationSourceType; sourceId: string },
  >(rows: T[]) {
    const ids = rows
      .filter((n) => n.sourceType === NotificationSourceType.AUTOMATION_MESSAGE)
      .map((n) => n.sourceId);
    if (ids.length === 0) return rows;
    const messages = new Map(
      (
        await this.prisma.automationMessage.findMany({
          where: { id: { in: ids } },
          select: { id: true, message: true, taskId: true },
        })
      ).map((m) => [m.id, m]),
    );
    return rows.map((n) => {
      const m =
        n.sourceType === NotificationSourceType.AUTOMATION_MESSAGE
          ? messages.get(n.sourceId)
          : undefined;
      return m ? { ...n, message: m.message, taskId: m.taskId } : n;
    });
  }

  async markRead(notificationId: string, userId: string) {
    const notification = await this.prisma.notification.findUnique({
      where: { id: notificationId },
    });
    if (!notification || notification.userId !== userId) {
      throw new NotFoundException('Notification not found');
    }
    return this.prisma.notification.update({
      where: { id: notificationId },
      data: { readAt: new Date() },
    });
  }

  async markAllRead(userId: string): Promise<{ count: number }> {
    const result = await this.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { count: result.count };
  }

  private async getChannelPrefs(
    userId: string,
    type: NotificationType,
  ): Promise<Record<NotificationChannel, boolean>> {
    const prefsRow = await this.prisma.userPreferences.findUnique({
      where: { userId },
    });
    const settings =
      (prefsRow?.notificationSettings as NotificationSettings | null) ?? null;
    const typeSettings = settings?.[type];

    if (!typeSettings) {
      return { ...DEFAULT_CHANNELS };
    }

    const result = {} as Record<NotificationChannel, boolean>;
    for (const channel of Object.values(NotificationChannel)) {
      const jsonKey = CHANNEL_JSON_KEY[channel];
      result[channel] =
        (typeSettings as Record<string, boolean>)[jsonKey] ??
        DEFAULT_CHANNELS[channel];
    }
    return result;
  }
}
