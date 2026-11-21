import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { MULTIPART_PART_BYTES, S3StorageProvider } from './s3-storage.provider';
import { StorageObjectTooLargeError } from './storage-provider.interface';

/** A recording fake of the S3 client: the provider's own logic (parts, abort, hash, cap) is what is under test. */
function make(opts: { failPart?: number; failComplete?: boolean } = {}) {
  const sent: Array<{ name: string; input: Record<string, unknown> }> = [];
  const parts = new Map<number, Buffer>();
  const provider = new S3StorageProvider({ get: (k: string) => (k === 'S3_BUCKET' ? 'bkt' : undefined) } as never);
  (provider as unknown as { client: unknown }).client = {
    send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const name = cmd.constructor.name;
      sent.push({ name, input: cmd.input });
      if (name === 'CreateMultipartUploadCommand') return { UploadId: 'up-1' };
      if (name === 'UploadPartCommand') {
        const n = cmd.input.PartNumber as number;
        if (opts.failPart === n) throw new Error('part boom');
        parts.set(n, Buffer.from(cmd.input.Body as Buffer));
        return { ETag: `etag-${n}` };
      }
      if (name === 'CompleteMultipartUploadCommand' && opts.failComplete) throw new Error('complete boom');
      return {};
    },
  };
  return { provider, sent, parts, names: () => sent.map((s) => s.name) };
}
const body = (...chunks: Buffer[]) => Readable.from(chunks);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('S3StorageProvider.putObjectStream (step 4.6)', () => {
  it('a small file is ONE PutObject: no multipart, hash and size reported', async () => {
    const f = make();
    const data = Buffer.from('hello world');
    const r = await f.provider.putObjectStream('k', body(data.subarray(0, 5), data.subarray(5)), { mimeType: 'text/plain', maxBytes: 1000 });
    expect(r).toEqual({ sizeBytes: 11, sha256: sha(data) });
    expect(f.names()).toEqual(['PutObjectCommand']);
    expect(f.sent[0].input).toMatchObject({ Bucket: 'bkt', Key: 'k', ContentType: 'text/plain', ContentLength: 11 });
  });

  it('an empty file is stored (a zero-byte attachment is legal)', async () => {
    const f = make();
    const r = await f.provider.putObjectStream('k', body(), { mimeType: 'text/plain', maxBytes: 10 });
    expect(r).toEqual({ sizeBytes: 0, sha256: sha(Buffer.alloc(0)) });
    expect(f.names()).toEqual(['PutObjectCommand']);
  });

  it('a big file goes up in parts of exactly the part size, in order, then is completed; the hash covers every byte', async () => {
    const f = make();
    const data = Buffer.alloc(MULTIPART_PART_BYTES * 2 + 123, 7);
    for (let i = 0; i < data.length; i += 1_000_003) data[i] = i % 251; // not all one byte
    const chunks: Buffer[] = [];
    for (let i = 0; i < data.length; i += 3_000_000) chunks.push(data.subarray(i, i + 3_000_000)); // awkward chunk size
    const r = await f.provider.putObjectStream('k', body(...chunks), { mimeType: 'application/pdf', maxBytes: data.length });
    expect(r).toEqual({ sizeBytes: data.length, sha256: sha(data) });
    expect(f.names()).toEqual(['CreateMultipartUploadCommand', 'UploadPartCommand', 'UploadPartCommand', 'UploadPartCommand', 'CompleteMultipartUploadCommand']);
    expect([...f.parts.values()].map((p) => p.length)).toEqual([MULTIPART_PART_BYTES, MULTIPART_PART_BYTES, 123]);
    expect(Buffer.concat([...f.parts.values()]).equals(data)).toBe(true);
    const complete = f.sent[f.sent.length - 1].input as { MultipartUpload: { Parts: unknown[] } };
    expect(complete.MultipartUpload.Parts).toEqual([{ ETag: 'etag-1', PartNumber: 1 }, { ETag: 'etag-2', PartNumber: 2 }, { ETag: 'etag-3', PartNumber: 3 }]);
  });

  it('a file of exactly one part size is a one-part multipart upload (the boundary), not a lost tail', async () => {
    const f = make();
    const data = Buffer.alloc(MULTIPART_PART_BYTES, 1);
    const r = await f.provider.putObjectStream('k', body(data), { mimeType: 'x/y', maxBytes: data.length });
    expect(r.sizeBytes).toBe(data.length);
    expect([...f.parts.values()].map((p) => p.length)).toEqual([MULTIPART_PART_BYTES]);
    expect(f.names().at(-1)).toBe('CompleteMultipartUploadCommand');
  });

  it('over the cap: StorageObjectTooLargeError as soon as the limit is crossed, and an open multipart upload is aborted', async () => {
    const f = make();
    const big = Buffer.alloc(MULTIPART_PART_BYTES + 10, 1);
    await expect(f.provider.putObjectStream('k', body(big, big), { mimeType: 'x/y', maxBytes: MULTIPART_PART_BYTES + 20 })).rejects.toBeInstanceOf(StorageObjectTooLargeError);
    expect(f.names()).toContain('AbortMultipartUploadCommand');
    expect(f.names()).not.toContain('CompleteMultipartUploadCommand');
  });

  it('over the cap before any part was sent: nothing at all was written', async () => {
    const f = make();
    await expect(f.provider.putObjectStream('k', body(Buffer.alloc(11)), { mimeType: 'x/y', maxBytes: 10 })).rejects.toBeInstanceOf(StorageObjectTooLargeError);
    expect(f.names()).toEqual([]);
  });

  it('a failing part aborts the upload and rethrows the real error', async () => {
    const f = make({ failPart: 2 });
    const data = Buffer.alloc(MULTIPART_PART_BYTES * 2 + 1, 1);
    await expect(f.provider.putObjectStream('k', body(data), { mimeType: 'x/y', maxBytes: data.length })).rejects.toThrow('part boom');
    expect(f.names().at(-1)).toBe('AbortMultipartUploadCommand');
  });

  it('a failing complete aborts too', async () => {
    const f = make({ failComplete: true });
    await expect(f.provider.putObjectStream('k', body(Buffer.alloc(MULTIPART_PART_BYTES + 1)), { mimeType: 'x/y', maxBytes: MULTIPART_PART_BYTES * 2 })).rejects.toThrow('complete boom');
    expect(f.names().at(-1)).toBe('AbortMultipartUploadCommand');
  });

  it('a source that dies mid-stream aborts and rethrows', async () => {
    const f = make();
    async function* dying() { yield Buffer.alloc(MULTIPART_PART_BYTES + 5); throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }); }
    await expect(f.provider.putObjectStream('k', dying(), { mimeType: 'x/y', maxBytes: MULTIPART_PART_BYTES * 3 })).rejects.toMatchObject({ code: 'ECONNRESET' });
    expect(f.names().at(-1)).toBe('AbortMultipartUploadCommand');
  });

  it('reads the source no faster than parts go out (one part in memory): the source is not drained ahead of the upload', async () => {
    const f = make();
    let produced = 0;
    async function* source() { for (let i = 0; i < 6; i++) { produced += 1; yield Buffer.alloc(MULTIPART_PART_BYTES, 1); } }
    let producedAtFirstPart = -1;
    const orig = (f.provider as unknown as { client: { send: (c: unknown) => Promise<unknown> } }).client.send;
    (f.provider as unknown as { client: { send: (c: { constructor: { name: string } }) => Promise<unknown> } }).client.send = async (c) => {
      if (c.constructor.name === 'UploadPartCommand' && producedAtFirstPart < 0) producedAtFirstPart = produced;
      return orig(c);
    };
    await f.provider.putObjectStream('k', source(), { mimeType: 'x/y', maxBytes: MULTIPART_PART_BYTES * 6 });
    expect(producedAtFirstPart).toBe(1); // the first part left before the second chunk was even pulled
  });
});
