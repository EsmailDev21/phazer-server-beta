import { Module } from '@nestjs/common';
import { IntegrationsModule } from '../integrations/integrations.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { ExternalRefService } from './external-ref.service';
import { ImportIssueService } from './import-issue.service';
import { ImportUsageService } from './import-usage.service';
import { ImportsController } from './imports.controller';
import { ImportsService } from './imports.service';
import { MappingService } from './mapping/mapping.service';

/**
 * Step 4.1 (ADR-0030). API process: the controller and the job-control service. The executor and rollback handlers
 * (step 4.4) live in the worker graph and reuse ExternalRefService / ImportIssueService / ImportUsageService, which
 * is why those are exported. Prisma, Queue, Events and AccessControl are @Global.
 */
@Module({
  imports: [IntegrationsModule, TenancyModule],
  controllers: [ImportsController],
  providers: [ImportsService, ExternalRefService, ImportIssueService, ImportUsageService, MappingService],
  exports: [ExternalRefService, ImportIssueService, ImportUsageService, MappingService],
})
export class ImportsModule {}
