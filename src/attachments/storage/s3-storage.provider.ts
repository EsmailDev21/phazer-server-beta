import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { PutObjectResult, StorageObjectTooLargeError, StorageProvider } from './storage-provider.interface';

const UPLOAD_URL_TTL_SECONDS = 15 * 60; // 15 min — forces a prompt upload, distinct from the 24h PENDING-row cleanup window
/** S3's minimum for every part but the last is 5 MiB; 8 MiB keeps a 10,000-part ceiling far above any plan's file cap. */
export const MULTIPART_PART_BYTES = 8 * 1024 * 1024;
const DOWNLOAD_URL_TTL_SECONDS = 15 * 60; // per FILES__READ__DOWNLOAD: "~15min"

/**
 * S3-compatible implementation — works unmodified against AWS S3,
 * Cloudflare R2, or self-hosted MinIO by pointing S3_ENDPOINT at the
 * right host (omit S3_ENDPOINT entirely for real AWS S3). This is the
 * "one real implementation" the graph says is sufficient to start.
 */
@Injectable()
export class S3StorageProvider implements StorageProvider {
  private readonly logger = new Logger(S3StorageProvider.name);
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(private readonly configService: ConfigService) {
    const endpoint = this.configService.get<string>('S3_ENDPOINT'); // unset = real AWS S3
    this.bucket =
      this.configService.get<string>('S3_BUCKET') ?? 'app-attachments';

    this.client = new S3Client({
      region: this.configService.get<string>('S3_REGION') ?? 'us-east-1',
      endpoint,
      forcePathStyle: !!endpoint, // required for MinIO/R2-style path-style addressing; ignored by real AWS S3
      credentials: {
        accessKeyId: this.configService.get<string>('S3_ACCESS_KEY_ID') ?? '',
        secretAccessKey:
          this.configService.get<string>('S3_SECRET_ACCESS_KEY') ?? '',
      },
    });
  }

  async generatePresignedUploadUrl(
    key: string,
    mimeType: string,
    maxSizeBytes: number,
  ): Promise<{ url: string; expiresAt: Date }> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: mimeType,
      ContentLength: maxSizeBytes,
    });
    const url = await getSignedUrl(this.client, command, {
      expiresIn: UPLOAD_URL_TTL_SECONDS,
    });
    return {
      url,
      expiresAt: new Date(Date.now() + UPLOAD_URL_TTL_SECONDS * 1000),
    };
  }

  async generatePresignedDownloadUrl(
    key: string,
  ): Promise<{ url: string; expiresAt: Date }> {
    const command = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    const url = await getSignedUrl(this.client, command, {
      expiresIn: DOWNLOAD_URL_TTL_SECONDS,
    });
    return {
      url,
      expiresAt: new Date(Date.now() + DOWNLOAD_URL_TTL_SECONDS * 1000),
    };
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  async putObject(key: string, body: Buffer, mimeType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: mimeType,
        ContentLength: body.length,
      }),
    );
  }

  async getObject(key: string, maxBytes: number): Promise<Buffer> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    if (res.ContentLength !== undefined && res.ContentLength > maxBytes) {
      // do not pull the body: the cap is a memory bound
      (res.Body as { destroy?: () => void } | undefined)?.destroy?.();
      throw new Error(`Object is larger than ${maxBytes} bytes`);
    }
    if (!res.Body) throw new Error('Object has no body');
    const bytes = Buffer.from(await res.Body.transformToByteArray());
    if (bytes.length > maxBytes) throw new Error(`Object is larger than ${maxBytes} bytes`);
    return bytes;
  }

  async copyObject(fromKey: string, toKey: string): Promise<void> {
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        Key: toKey,
        // CopySource is "bucket/key", URL-encoded per path segment
        CopySource: `${this.bucket}/${fromKey.split('/').map(encodeURIComponent).join('/')}`,
      }),
    );
  }

  async headObject(key: string): Promise<{ sizeBytes: number } | null> {
    try {
      const res = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return { sizeBytes: res.ContentLength ?? 0 };
    } catch (err) {
      const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) return null;
      throw err;
    }
  }

  async putObjectStream(
    key: string,
    body: AsyncIterable<Uint8Array>,
    opts: { mimeType: string; maxBytes: number },
  ): Promise<PutObjectResult> {
    const hash = createHash('sha256');
    let total = 0;
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    let uploadId: string | undefined;
    const parts: Array<{ ETag: string; PartNumber: number }> = [];

    const uploadPart = async (data: Buffer): Promise<void> => {
      if (!uploadId) {
        const created = await this.client.send(
          new CreateMultipartUploadCommand({
            Bucket: this.bucket,
            Key: key,
            ContentType: opts.mimeType,
          }),
        );
        if (!created.UploadId) throw new Error('S3 did not return an upload id');
        uploadId = created.UploadId;
      }
      const PartNumber = parts.length + 1;
      const out = await this.client.send(
        new UploadPartCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          PartNumber,
          Body: data,
          ContentLength: data.length,
        }),
      );
      if (!out.ETag) throw new Error('S3 did not return an ETag for a part');
      parts.push({ ETag: out.ETag, PartNumber });
    };

    try {
      for await (const chunk of body) {
        const b = Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        total += b.length;
        if (total > opts.maxBytes) throw new StorageObjectTooLargeError(opts.maxBytes);
        hash.update(b);
        pending.push(b);
        pendingBytes += b.length;
        // awaiting the part is the back-pressure: the source is not read faster than S3 takes it
        while (pendingBytes >= MULTIPART_PART_BYTES) {
          const all = Buffer.concat(pending, pendingBytes);
          await uploadPart(all.subarray(0, MULTIPART_PART_BYTES));
          const rest = all.subarray(MULTIPART_PART_BYTES);
          pending = rest.length ? [rest] : [];
          pendingBytes = rest.length;
        }
      }
      if (!uploadId) {
        // small file: one request, no multipart bookkeeping
        const data = Buffer.concat(pending, pendingBytes);
        await this.client.send(
          new PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
            Body: data,
            ContentType: opts.mimeType,
            ContentLength: data.length,
          }),
        );
      } else {
        if (pendingBytes > 0) await uploadPart(Buffer.concat(pending, pendingBytes));
        await this.client.send(
          new CompleteMultipartUploadCommand({
            Bucket: this.bucket,
            Key: key,
            UploadId: uploadId,
            MultipartUpload: { Parts: parts },
          }),
        );
      }
    } catch (e) {
      if (uploadId) {
        try {
          await this.client.send(
            new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId }),
          );
        } catch (abortError) {
          this.logger.warn(
            `Could not abort multipart upload of ${key}: ${(abortError as Error).message}`,
          );
        }
      }
      throw e;
    }
    return { sizeBytes: total, sha256: hash.digest('hex') };
  }
}
