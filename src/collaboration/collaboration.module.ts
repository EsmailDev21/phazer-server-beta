import { Module } from '@nestjs/common';
import { ActivityNotificationsModule } from '../activity-notifications/activity-notifications.module';
import { CommentsController } from './comments/comments.controller';
import { CommentsService } from './comments/comments.service';
import { ReactionsController } from './reactions/reactions.controller';
import { ReactionsService } from './reactions/reactions.service';

@Module({
  // ActivityService/AuditLogService come from the @Global EventsModule
  // (no explicit import needed). NotificationsService (for the terminal
  // ON_ACTIVITY case) comes from ActivityNotificationsModule, which is
  // NOT global — imported explicitly here. One-directional:
  // ActivityNotificationsModule does not depend on CollaborationModule.
  imports: [ActivityNotificationsModule],
  controllers: [CommentsController, ReactionsController],
  providers: [CommentsService, ReactionsService],
  exports: [CommentsService], // step 5.2: the automation runner writes system comments
})
export class CollaborationModule {}
