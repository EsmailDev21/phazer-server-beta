/**
 * StorageProvider interface — per FILES__PROVIDER__INTERFACE. Unlike
 * PaymentProvider, this isn't solving an active blocking constraint; it's
 * kept behind an interface for vendor-lock-in avoidance and consistency
 * with the rest of this codebase's architecture. One real implementation
 * (S3-compatible) is sufficient to start.
 */
export interface StorageProvider {
  /**
   * Presigned PUT URL the client uploads directly to — bytes never touch
   * the app server. `maxSizeBytes` is enforced by the storage provider
   * itself via a signed content-length condition where supported; the
   * application ALSO checks size before ever issuing the URL (see
   * AttachmentsService) — belt and suspenders, not redundant, since a
   * malicious client could otherwise attempt to upload past the declared
   * sizeBytes.
   */
  generatePresignedUploadUrl(
    key: string,
    mimeType: string,
    maxSizeBytes: number,
  ): Promise<{ url: string; expiresAt: Date }>;

  /** Presigned GET URL, time-limited (~15min), re-derived fresh per request — never a permanent public link. */
  generatePresignedDownloadUrl(
    key: string,
  ): Promise<{ url: string; expiresAt: Date }>;

  deleteObject(key: string): Promise<void>;

  // ---- server-side access (step 3.7: template assets are read, hashed and copied BY the app) ----

  /** Stores `body` under `key`. Overwrites. */
  putObject(key: string, body: Buffer, mimeType: string): Promise<void>;

  /**
   * Reads an object fully. Refuses (rejects) when the object is larger than `maxBytes`, WITHOUT
   * reading it all - the caller's cap is a memory bound, not just a policy.
   */
  getObject(key: string, maxBytes: number): Promise<Buffer>;

  /** Server-side copy inside the same store; the bytes never pass through the app. */
  copyObject(fromKey: string, toKey: string): Promise<void>;

  /** Size of the stored object, or null when there is none. */
  headObject(key: string): Promise<{ sizeBytes: number } | null>;

  /**
   * Step 4.6 (renamed in the merge: `putObject` is the whole-buffer write above). SERVER-SIDE STREAMING upload, for the one caller
   * whose bytes come from another system rather than from a browser (the importer's attachment copy). The body is consumed as it
   * arrives and written in parts: memory use is one part (a few MiB), never the file. Counts the bytes and hashes them on the way.
   *
   * Throws StorageObjectTooLargeError the moment more than `maxBytes` have arrived (nothing is left behind: a half-written
   * multipart upload is aborted). On any other failure the partial object is aborted too and the error is rethrown.
   */
  putObjectStream(
    key: string,
    body: AsyncIterable<Uint8Array>,
    opts: { mimeType: string; maxBytes: number },
  ): Promise<PutObjectResult>;
}

export interface PutObjectResult {
  sizeBytes: number;
  /** Lower-case hex SHA-256 of the stored bytes. */
  sha256: string;
}

export class StorageObjectTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`The file is larger than the ${maxBytes} byte limit`);
    this.name = 'StorageObjectTooLargeError';
  }
}


export const STORAGE_PROVIDER = Symbol('STORAGE_PROVIDER');
