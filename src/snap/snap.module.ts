import { Module } from '@nestjs/common';
import { SnapSessionsController } from './snap-sessions.controller';
import { SnapSessionsService } from './snap-sessions.service';
import { SnapAnalyticsController } from './snap-analytics.controller';
import { SnapAnalyticsService } from './snap-analytics.service';
import { SnapCleanupJob } from './snap-cleanup.job';

@Module({
  controllers: [SnapSessionsController, SnapAnalyticsController],
  providers: [SnapSessionsService, SnapAnalyticsService, SnapCleanupJob],
})
export class SnapModule {}
