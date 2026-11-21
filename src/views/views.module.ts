import { Module } from '@nestjs/common';
import { WorkspaceContextLoader } from '../automations/dsl/workspace-context.loader';
import { ProjectsTasksModule } from '../projects-tasks/projects-tasks.module';
import { TaskQueryService } from './run/task-query.service';
import { ViewsController } from './views.controller';
import { ViewsService } from './views.service';

/** Step 5.4 (run in 5.11). PrismaModule and AccessControlModule are global. */
@Module({
  imports: [ProjectsTasksModule],
  controllers: [ViewsController],
  providers: [WorkspaceContextLoader, TaskQueryService, ViewsService],
  exports: [ViewsService, TaskQueryService],
})
export class ViewsModule {}
