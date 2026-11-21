import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { AttachmentsModule } from '../attachments/attachments.module';
import { DomainWriterModule } from '../domain-writer/domain-writer.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { ProjectsTasksModule } from '../projects-tasks/projects-tasks.module';
import { ImportContentWriter } from './executor/import-content-writer';
import { ImportExecutor } from './executor/import-executor.service';
import { ImportFileCopier } from './executor/import-file-copier';
import { ImportTemplateRunner } from './template/import-template.runner';
import { TemplatesModule } from '../templates/templates.module';
import { ImportCopyFilesJob, ImportRunJob, ImportRollbackJob } from './executor/import-jobs';
import { ImportProgressPublisher } from './executor/import-progress';
import { ImportRollback } from './executor/import-rollback.service';
import { ImportWriter } from './executor/import-writer';
import { ImportsModule } from './imports.module';

/**
 * Step 4.4 (ADR-0033). The WORKER half of imports: the executor, the rollback and their queue handlers (run, rollback and, step 4.6, the file copy on its own queue). Imported by the
 * worker app only; the API process keeps ImportsModule (job control) and never runs an import itself.
 */
@Module({
  imports: [DiscoveryModule, ImportsModule, IntegrationsModule, DomainWriterModule, ProjectsTasksModule, AttachmentsModule, TemplatesModule],
  providers: [ImportWriter, ImportTemplateRunner, ImportContentWriter, ImportFileCopier, ImportExecutor, ImportRollback, ImportProgressPublisher, ImportRunJob, ImportRollbackJob, ImportCopyFilesJob],
  exports: [ImportExecutor, ImportRollback, ImportWriter],
})
export class ImportsWorkerModule {}
