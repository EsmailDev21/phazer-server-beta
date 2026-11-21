import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { PublicSignedAuditor } from './public-signed.auditor';
import { IntegrationWebhookSweepJob } from './webhook-sweep.job';
import { WebhookDedupeService } from './webhook-dedupe.service';

/**
 * Step 0.9. Imported once per application graph (API and worker), like
 * DomainWriterModule: the API needs the dedupe service and the boot audit, the
 * worker needs the sweep job's handler. No webhook route exists yet - the first
 * is Phase 2's GitHub adapter (2.6).
 */
@Module({
  imports: [DiscoveryModule],
  providers: [
    WebhookDedupeService,
    PublicSignedAuditor,
    IntegrationWebhookSweepJob,
  ],
  exports: [WebhookDedupeService],
})
export class IntegrationWebhooksModule {}
