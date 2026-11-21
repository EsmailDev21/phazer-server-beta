import { createHash } from 'node:crypto';
import { PutObjectResult, StorageObjectTooLargeError, StorageProvider } from '../../../src/attachments/storage/storage-provider.interface';

/**
 * In-memory StorageProvider for integration tests (the sandbox has no S3/MinIO). Everything the
 * app does server-side goes through the interface, so this is a faithful stand-in. It can also
 * be told to fail, to prove the compensation / release paths.
 */
export class MemoryStorage implements StorageProvider {
  readonly objects = new Map<string, { body: Buffer; mimeType: string }>();
  readonly log: Array<{ op: 'put' | 'get' | 'copy' | 'delete' | 'head'; key: string; to?: string }> = [];
  failCopyAfter: number | null = null; // fail the (n+1)th copy
  private copies = 0;

  async generatePresignedUploadUrl(): Promise<{ url: string; expiresAt: Date }> {
    return { url: 'memory://upload', expiresAt: new Date(Date.now() + 60_000) };
  }
  async generatePresignedDownloadUrl(): Promise<{ url: string; expiresAt: Date }> {
    return { url: 'memory://download', expiresAt: new Date(Date.now() + 60_000) };
  }
  async deleteObject(key: string): Promise<void> {
    this.log.push({ op: 'delete', key });
    this.objects.delete(key);
  }
  async putObject(key: string, body: Buffer, mimeType: string): Promise<void> {
    this.log.push({ op: 'put', key });
    this.objects.set(key, { body: Buffer.from(body), mimeType });
  }
  /** Step 4.6 streaming upload (the importer's file copy): consumed, counted, capped and hashed like the S3 one. */
  async putObjectStream(key: string, body: AsyncIterable<Uint8Array>, opts: { mimeType: string; maxBytes: number }): Promise<PutObjectResult> {
    const parts: Buffer[] = [];
    let total = 0;
    for await (const c of body) {
      total += c.length;
      if (total > opts.maxBytes) throw new StorageObjectTooLargeError(opts.maxBytes);
      parts.push(Buffer.from(c));
    }
    const data = Buffer.concat(parts);
    this.log.push({ op: 'put', key });
    this.objects.set(key, { body: data, mimeType: opts.mimeType });
    return { sizeBytes: total, sha256: createHash('sha256').update(data).digest('hex') };
  }
  async getObject(key: string, maxBytes: number): Promise<Buffer> {
    this.log.push({ op: 'get', key });
    const o = this.objects.get(key);
    if (!o) throw new Error(`NoSuchKey: ${key}`);
    if (o.body.length > maxBytes) throw new Error(`Object is larger than ${maxBytes} bytes`);
    return Buffer.from(o.body);
  }
  async copyObject(fromKey: string, toKey: string): Promise<void> {
    this.log.push({ op: 'copy', key: fromKey, to: toKey });
    if (this.failCopyAfter !== null && this.copies >= this.failCopyAfter) throw new Error('simulated copy failure');
    this.copies += 1;
    const o = this.objects.get(fromKey);
    if (!o) throw new Error(`NoSuchKey: ${fromKey}`);
    this.objects.set(toKey, { body: Buffer.from(o.body), mimeType: o.mimeType });
  }
  async headObject(key: string): Promise<{ sizeBytes: number } | null> {
    this.log.push({ op: 'head', key });
    const o = this.objects.get(key);
    return o ? { sizeBytes: o.body.length } : null;
  }

  // ---- test helpers
  seed(key: string, body: Buffer | string, mimeType = 'application/octet-stream'): void {
    this.objects.set(key, { body: Buffer.isBuffer(body) ? body : Buffer.from(body), mimeType });
  }
  keys(prefix = ''): string[] {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
  count(op: 'put' | 'get' | 'copy' | 'delete' | 'head'): number {
    return this.log.filter((l) => l.op === op).length;
  }
  reset(): void {
    this.objects.clear();
    this.log.length = 0;
    this.failCopyAfter = null;
    this.copies = 0;
  }
}
