import { createHash } from 'crypto';

/**
 * Step 3.7. ONE policy for what a template may carry, used by the sanitizer (what an export keeps),
 * by the upload route, and by the asset store (nothing blocked ever reaches storage).
 *
 * Three independent checks, because each one alone is easy to get around:
 *   1. declared MIME type  (deny list of executables / installers)
 *   2. file extension      (same list)
 *   3. the BYTES           (magic numbers of native executables and scripts, whatever the name says)
 */
export const BLOCKED_EXTENSIONS = /\.(exe|dll|bat|cmd|com|scr|msi|ps1|vbs|jar|sh|app|dmg|apk|bin)$/i;
export const BLOCKED_MIME =
  /^application\/(x-msdownload|x-dosexec|x-executable|x-sh|x-shellscript|java-archive|vnd\.microsoft\.portable-executable|x-msi|x-apple-diskimage|vnd\.android\.package-archive|x-bat)$|^text\/x-shellscript$/i;
export const MIME_SHAPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

export type AssetRefusal =
  | 'BLOCKED_TYPE' // executable / installer by MIME or extension
  | 'BLOCKED_CONTENT' // the bytes are an executable / script
  | 'BAD_MIME'
  | 'BAD_NAME'
  | 'TOO_LARGE'
  | 'EMPTY';

/** Leading bytes of things that run. Matched on the content, never on the claimed type. */
export function looksExecutable(head: Buffer): boolean {
  if (head.length >= 2 && head[0] === 0x4d && head[1] === 0x5a) return true; // MZ: PE / DOS
  if (head.length >= 4 && head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46) return true; // ELF
  if (head.length >= 2 && head[0] === 0x23 && head[1] === 0x21) return true; // #! script
  if (head.length >= 4) {
    const m = head.readUInt32BE(0);
    // Mach-O (32/64, both byte orders) and fat binaries
    if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(m)) return true;
  }
  return false;
}

export interface AssetCandidate {
  fileName: string;
  mimeType: string;
  bytes: Buffer;
}

/** The checks that need the bytes. `maxBytes` is the per-file cap. Returns null when allowed. */
export function refuseAsset(a: AssetCandidate, maxBytes: number): AssetRefusal | null {
  const base = a.fileName.split(/[\\/]/).pop() ?? '';
  if (base === '' || base !== a.fileName || /[\u0000-\u001f]/.test(a.fileName)) return 'BAD_NAME';
  if (!MIME_SHAPE.test(a.mimeType.toLowerCase())) return 'BAD_MIME';
  if (BLOCKED_MIME.test(a.mimeType) || BLOCKED_EXTENSIONS.test(a.fileName)) return 'BLOCKED_TYPE';
  if (a.bytes.length === 0) return 'EMPTY';
  if (a.bytes.length > maxBytes) return 'TOO_LARGE';
  if (looksExecutable(a.bytes.subarray(0, 8))) return 'BLOCKED_CONTENT';
  return null;
}

export const sha256Hex = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** Where a template's bytes live. Per TEMPLATE (not content-addressed globally): deleting a template needs no reference counting. */
export const templateAssetKey = (templateId: string, sha256: string): string => `template-assets/${templateId}/${sha256}`;

/** Key of a copy made for a workspace by one install. Opaque; the prefix lets a failed install find everything it made. */
export const installAttachmentPrefix = (accountId: string, installId: string): string =>
  `attachments/${accountId}/TEMPLATE_INSTALL/${installId}/`;

/** Placeholder `targetId` of a reserved (PENDING) attachment until its task exists. */
export const reservationTarget = (installId: string): string => `tpl-reserve:${installId}`;
