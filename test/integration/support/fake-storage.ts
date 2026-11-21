import { createHash } from 'node:crypto';
import { AttachmentsService } from '../../../src/attachments/attachments.service';
import { STORAGE_PROVIDER, StorageObjectTooLargeError, StorageProvider } from '../../../src/attachments/storage/storage-provider.interface';
import { TemplateAssetsService } from '../../../src/templates/assets/template-assets.service';
import { TemplateExtractionService } from '../../../src/templates/extract';
import { TemplatesService } from '../../../src/templates/templates.service';
import { ImportTemplateRunner } from '../../../src/imports/template/import-template.runner';
import { ImportContentWriter } from '../../../src/imports/executor/import-content-writer';
import { ImportFileCopier } from '../../../src/imports/executor/import-file-copier';

/** An in-memory object store: what the importer's file copy writes to in the integration specs. Failure knobs for the tests. */
export class FakeStorage implements StorageProvider {
  objects = new Map<string, Buffer>();
  deleted: string[] = [];
  /** Called with the key before the bytes are consumed; may throw (a storage outage) or wait. */
  beforePut: ((key: string) => Promise<void> | void) | null = null;
  async generatePresignedUploadUrl() { return { url: 'https://fake/up', expiresAt: new Date() }; }
  async generatePresignedDownloadUrl() { return { url: 'https://fake/down', expiresAt: new Date() }; }
  async deleteObject(key: string) { this.deleted.push(key); this.objects.delete(key); }
  async putObject(key: string, body: Buffer) { this.objects.set(key, Buffer.from(body)); }
  async getObject(key: string, maxBytes: number) { const o = this.objects.get(key); if (!o) throw new Error('no such object'); if (o.length > maxBytes) throw new Error('too large'); return o; }
  async copyObject(from: string, to: string) { const o = this.objects.get(from); if (!o) throw new Error('no such object'); this.objects.set(to, Buffer.from(o)); }
  async headObject(key: string) { const o = this.objects.get(key); return o ? { sizeBytes: o.length } : null; }
  async putObjectStream(key: string, body: AsyncIterable<Uint8Array>, opts: { mimeType: string; maxBytes: number }) {
    await this.beforePut?.(key);
    const parts: Buffer[] = [];
    let total = 0;
    for await (const c of body) {
      total += c.length;
      if (total > opts.maxBytes) throw new StorageObjectTooLargeError(opts.maxBytes);
      parts.push(Buffer.from(c));
    }
    const data = Buffer.concat(parts);
    this.objects.set(key, data);
    return { sizeBytes: total, sha256: createHash('sha256').update(data).digest('hex') };
  }
}

/** The providers step 4.6 added to the executor's graph. Spread into a testing module's `providers`. */
export const contentProviders = (storage: FakeStorage) => [ImportContentWriter, ImportFileCopier, AttachmentsService, ImportTemplateRunner, TemplatesService, TemplateAssetsService, TemplateExtractionService, { provide: STORAGE_PROVIDER, useValue: storage }];
