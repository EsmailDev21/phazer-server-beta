import { Module } from '@nestjs/common';
import { ProjectsTasksModule } from '../projects-tasks/projects-tasks.module';
import { DomainEraser } from './domain-eraser.service';
import { DomainWriter } from './domain-writer.service';

/**
 * ADR-0003. Imported ONCE per application graph (API and worker) so later
 * modules (chat, imports, templates, automations) just inject DomainWriter.
 * PlanLimitsService / PrismaService / AuditLogService come from the @Global
 * modules each root already imports.
 */
@Module({
  imports: [ProjectsTasksModule],
  providers: [DomainWriter, DomainEraser],
  exports: [DomainWriter, DomainEraser],
})
export class DomainWriterModule {}
