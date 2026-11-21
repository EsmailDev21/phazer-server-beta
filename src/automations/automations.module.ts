import { Module } from '@nestjs/common';
import { ActivityNotificationsModule } from '../activity-notifications/activity-notifications.module';
import { CollaborationModule } from '../collaboration/collaboration.module';
import { DomainWriterModule } from '../domain-writer/domain-writer.module';
import { ProjectsTasksModule } from '../projects-tasks/projects-tasks.module';
import { ActionExecutor } from './action-executor.service';
import { AutomationNotifier } from './automation-notifier.service';
import { AutomationWaitJob } from './automation-wait.job';
import { AutomationWaitService } from './automation-wait.service';
import { AutomationActorService } from './automation-actor.service';
import { AutomationDueSweepJob } from './automation-due-sweep.job';
import { AutomationRunnerService } from './automation-runner.service';
import { WorkspaceContextLoader } from './dsl/workspace-context.loader';
import { AutomationsController } from './automations.controller';
import { AutomationsService } from './automations.service';
import { DueSweepService } from './due-sweep.service';
import { TaskQueryService } from '../views/run/task-query.service';

/**
 * Step 5.1: the rule store and its API. Step 5.2: the runner that executes them. PrismaModule,
 * AccessControlModule, EventsModule and the queue are global.
 */
@Module({
  imports: [
    ProjectsTasksModule,
    CollaborationModule,
    DomainWriterModule,
    ActivityNotificationsModule,
  ],
  controllers: [AutomationsController],
  providers: [
    WorkspaceContextLoader,
    AutomationsService,
    AutomationActorService,
    TaskQueryService,
    AutomationNotifier,
    AutomationWaitService,
    AutomationWaitJob,
    ActionExecutor,
    AutomationRunnerService,
    DueSweepService,
    AutomationDueSweepJob,
  ],
  exports: [
    AutomationsService,
    AutomationRunnerService,
    DueSweepService,
    WorkspaceContextLoader,
  ],
})
export class AutomationsModule {}
