import {
  NotificationChannel,
  NotificationSourceType,
  NotificationType,
} from '@prisma/client';
import { NotificationsService } from './notifications.service';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationSseRegistry } from '../sse/notification-sse-registry.service';

describe('NotificationsService.createNotification — SSE publish (step 0.4)', () => {
  function build(channelPrefs: Partial<Record<NotificationChannel, boolean>>) {
    const createdNotification = {
      id: 'notif_1',
      type: NotificationType.TASK_ASSIGNED,
      sourceType: NotificationSourceType.ACTIVITY,
      sourceId: 'activity_1',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    };
    const prisma = {
      userPreferences: { findUnique: jest.fn().mockResolvedValue(null) },
      notification: {
        create: jest.fn().mockResolvedValue(createdNotification),
      },
      notificationDelivery: { create: jest.fn().mockResolvedValue(undefined) },
    } as unknown as PrismaService;
    const sseRegistry = {
      publish: jest.fn().mockResolvedValue(undefined),
    } as unknown as NotificationSseRegistry;
    const service = new NotificationsService(prisma, sseRegistry);

    // Only relevant when the caller wants to exercise a non-default pref;
    // default (null prefsRow) already gives IN_APP: true per DEFAULT_CHANNELS.
    if (Object.keys(channelPrefs).length > 0) {
      (prisma.userPreferences.findUnique as jest.Mock).mockResolvedValue({
        notificationSettings: {
          [createdNotification.type]: {
            inApp: channelPrefs.IN_APP,
            email: channelPrefs.EMAIL,
            push: channelPrefs.PUSH,
          },
        },
      });
    }

    return { prisma, sseRegistry, createdNotification, service };
  }

  it('IN_APP enabled (the default): publishes to the SSE registry with the persisted row', async () => {
    const { sseRegistry, createdNotification, service } = build({});

    await service.createNotification({
      userId: 'user_1',
      type: NotificationType.TASK_ASSIGNED,
      sourceType: NotificationSourceType.ACTIVITY,
      sourceId: 'activity_1',
    });

    expect(sseRegistry.publish).toHaveBeenCalledWith('user_1', {
      id: createdNotification.id,
      type: createdNotification.type,
      sourceType: createdNotification.sourceType,
      sourceId: createdNotification.sourceId,
      createdAt: createdNotification.createdAt,
    });
  });

  it('IN_APP disabled: never calls the SSE registry at all', async () => {
    const { sseRegistry, service } = build({ IN_APP: false, EMAIL: true });

    await service.createNotification({
      userId: 'user_1',
      type: NotificationType.TASK_ASSIGNED,
      sourceType: NotificationSourceType.ACTIVITY,
      sourceId: 'activity_1',
    });

    expect(sseRegistry.publish).not.toHaveBeenCalled();
  });

  it('createNotification awaits the publish (a slow/rejecting publish cannot resolve before it settles)', async () => {
    const { sseRegistry, service } = build({});
    let publishResolved = false;
    (sseRegistry.publish as jest.Mock).mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => {
            publishResolved = true;
            resolve(undefined);
          }, 20),
        ),
    );

    await service.createNotification({
      userId: 'user_1',
      type: NotificationType.TASK_ASSIGNED,
      sourceType: NotificationSourceType.ACTIVITY,
      sourceId: 'activity_1',
    });

    expect(publishResolved).toBe(true);
  });
});
