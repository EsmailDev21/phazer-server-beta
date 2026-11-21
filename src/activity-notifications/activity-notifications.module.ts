import { Module } from '@nestjs/common';
import { ProjectsTasksModule } from '../projects-tasks/projects-tasks.module';
import { ActivitiesController } from './activity/activities.controller';
import { ActivitiesService } from './activity/activities.service';
import { DueDateReminderService } from './activity/due-date-reminder.service';
import { DueDateReminderJob } from './activity/due-date-reminder.job';
import { NotificationsController } from './notifications/notifications.controller';
import { NotificationsService } from './notifications/notifications.service';
import { WatchesController } from './watches/watches.controller';
import { WatchesService } from './watches/watches.service';
import { FanoutService } from './fanout/fanout.service';
import { NotificationSseRegistry } from './sse/notification-sse-registry.service';
import { NotificationsSseController } from './sse/notifications-sse.controller';

@Module({
  imports: [ProjectsTasksModule],
  controllers: [
    ActivitiesController,
    NotificationsController,
    WatchesController,
    NotificationsSseController,
  ],
  providers: [
    ActivitiesService,
    DueDateReminderService,
    DueDateReminderJob,
    NotificationsService,
    WatchesService,
    FanoutService,
    NotificationSseRegistry,
  ],
  exports: [NotificationsService],
})
export class ActivityNotificationsModule {}
