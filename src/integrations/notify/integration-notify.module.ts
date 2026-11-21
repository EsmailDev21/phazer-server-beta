import { Module } from '@nestjs/common';
import { IntegrationCoreModule } from '../integration-core.module';
import { NotificationRouter } from './notification-router.service';
import { NotifyDeliverJob } from './notify-deliver.job';
import { RichMessageBuilder } from './rich-message.builder';

/**
 * Imported by BOTH the API and the worker graph: each process routes the activities it emits itself, and the
 * worker consumes `notify.deliver` (queue `notify`, off with FEATURE_INTEGRATIONS).
 */
@Module({
  imports: [IntegrationCoreModule],
  providers: [RichMessageBuilder, NotificationRouter, NotifyDeliverJob],
  exports: [RichMessageBuilder],
})
export class IntegrationNotifyModule {}
