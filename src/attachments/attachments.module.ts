import { Module } from '@nestjs/common';
import { AttachmentsController } from './attachments.controller';
import { AttachmentsService } from './attachments.service';
import { STORAGE_PROVIDER } from './storage/storage-provider.interface';
import { S3StorageProvider } from './storage/s3-storage.provider';
import { AttachmentCleanupJob } from './attachment-cleanup.job';

@Module({
  controllers: [AttachmentsController],
  providers: [
    AttachmentsService,
    { provide: STORAGE_PROVIDER, useClass: S3StorageProvider },
    AttachmentCleanupJob,
  ],
  exports: [AttachmentsService, STORAGE_PROVIDER],
})
export class AttachmentsModule {}
