import { Module, OnModuleInit } from '@nestjs/common';
import { AttachmentsModule } from '../attachments/attachments.module';
import { TemplateAssetsService } from './assets/template-assets.service';
import { TemplateEditorService } from './editor/template-editor.service';
import { DomainWriterModule } from '../domain-writer/domain-writer.module';
import { PlanLimitsService } from '../access-control/plan-limits.service';
import { TemplateApplyService } from './apply/apply.service';
import { TemplateExtractionService } from './extract';
import { TemplatesController } from './templates.controller';
import { TemplateSeedService } from './seeds/template-seed.service';
import { TemplatesService } from './templates.service';

/**
 * Step 3.5. PrismaModule and AccessControlModule are global. The module REGISTERS the counter
 * behind the 'template' plan limit (PlanLimitsService throws for a capped tier until someone
 * does): templates owned by the account, account-total. The system account's seeds
 * (step 3.9) are owned by the system account, so they never count against a reader. In Phase 6 PUBLIC
 * ones will stop counting (the limit is for PRIVATE templates).
 */
@Module({
  imports: [DomainWriterModule, AttachmentsModule],
  controllers: [TemplatesController],
  providers: [
    TemplateAssetsService,
    TemplateEditorService,
    TemplatesService,
    TemplateExtractionService,
    TemplateApplyService,
    TemplateSeedService,
  ],
  exports: [
    TemplateAssetsService,
    TemplateEditorService,
    TemplatesService,
    TemplateApplyService,
    TemplateSeedService,
  ],
})
export class TemplatesModule implements OnModuleInit {
  constructor(private readonly limits: PlanLimitsService) {}

  onModuleInit(): void {
    this.limits.registerCounter('template', (ctx, db) =>
      db.template.count({ where: { ownerAccountId: ctx.accountId } }),
    );
  }
}
