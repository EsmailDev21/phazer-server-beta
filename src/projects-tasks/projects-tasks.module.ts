import { Module } from '@nestjs/common';
import { TenancyModule } from '../tenancy/tenancy.module';
import { ProjectsController } from './projects/projects.controller';
import { ProjectsService } from './projects/projects.service';
import { TasksController } from './tasks/tasks.controller';
import { TasksService } from './tasks/tasks.service';
import { TaskVisibilityService } from './tasks/task-visibility.service';
import { CustomFieldsController } from './custom-fields/custom-fields.controller';
import { TaskCustomValuesController } from './custom-fields/task-custom-values.controller';
import { CustomFieldsService } from './custom-fields/custom-fields.service';
import { TaskKeyService } from './tasks/task-key.service';
import { TaskTreeService } from './tasks/task-tree.service';
import { TagsController } from './tags/tags.controller';
import { TagsService } from './tags/tags.service';
import { IssueTypesController } from './issue-types/issue-types.controller';
import { IssueTypesService } from './issue-types/issue-types.service';
import { IterationsController } from './iterations/iterations.controller';
import { IterationsService } from './iterations/iterations.service';
import { TaskPlanningService } from './planning/task-planning.service';
import { WorkflowController } from './workflow/workflow.controller';
import { WorkflowService } from './workflow/workflow.service';

@Module({
  imports: [TenancyModule],
  controllers: [
    ProjectsController,
    TasksController,
    CustomFieldsController,
    TaskCustomValuesController,
    TagsController,
    WorkflowController,
    IssueTypesController,
    IterationsController,
  ],
  providers: [
    ProjectsService,
    TasksService,
    TaskVisibilityService,
    CustomFieldsService,
    TagsService,
    TaskKeyService,
    TaskTreeService,
    WorkflowService,
    IssueTypesService,
    IterationsService,
    TaskPlanningService,
  ],
  // Consumed by ActivityNotificationsModule (ActivitiesService) and EventsModule,
  // which resolve visibility through the ONE TaskVisibilityService rather than
  // re-implementing it.
  // TasksService/ProjectsService/CustomFieldsService: wrapped by DomainWriter (ADR-0003).
  exports: [
    TaskVisibilityService,
    TasksService,
    ProjectsService,
    CustomFieldsService,
    TagsService, // step 5.2: automation actions attach/detach tags
    WorkflowService,
    IssueTypesService,
    IterationsService,
    TaskPlanningService,
  ],
})
export class ProjectsTasksModule {}
