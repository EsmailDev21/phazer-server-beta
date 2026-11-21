import { Inject, Injectable, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { STORAGE_PROVIDER, StorageProvider } from '../../attachments/storage/storage-provider.interface';
import { PrismaService } from '../../prisma/prisma.service';
import { BLUEPRINT_LIMITS, BlueprintV1 } from '../blueprint';
import { RawBlueprint } from '../extract';
import { AssetRefusal, refuseAsset, sha256Hex, templateAssetKey } from './asset.policy';

type Db = Prisma.TransactionClient | PrismaService;

export interface StagedAsset {
  sha256: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  storageKey: string;
}

export interface StageResult {
  /** sha256 per source attachment id, for `sanitize({assetHashes})`. Only files that passed every check. */
  hashes: Map<string, string>;
  /** the size the BYTES had (the attachment row's declared size is not trusted) */
  actualSizes: Map<string, number>;
  staged: StagedAsset[];
  /** why a file was left out; never contains file content */
  refused: Array<{ sourceAttachmentId: string; reason: AssetRefusal | 'UNREADABLE' | 'OVER_TEMPLATE_CAP' }>;
}

/**
 * Step 3.7. The template asset store: reads, checks, hashes and stores the files a template
 * carries. Everything that reaches storage passes `refuseAsset` first, on the BYTES.
 *
 * Objects are written BEFORE the database row that points at them. A crash in between leaves an
 * unreferenced object (cheap, invisible); the reverse order would leave a row pointing at nothing.
 */
@Injectable()
export class TemplateAssetsService {
  private readonly logger = new Logger(TemplateAssetsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  // ================================================================ export ===============

  /**
   * For an export: read each source attachment's bytes (one at a time - memory stays bounded by
   * the per-file cap), apply the policy, hash, and store under `templateId`. Files that fail are
   * simply not hashed; the sanitizer then drops them from the blueprint and says so in its report.
   */
  async stageFromAttachments(templateId: string, raw: RawBlueprint): Promise<StageResult> {
    const L = BLUEPRINT_LIMITS;
    const out: StageResult = { hashes: new Map(), actualSizes: new Map(), staged: [], refused: [] };
    const ids = raw.assets.map((a) => a.sourceAttachmentId);
    if (ids.length === 0) return out;
    const rows = await this.prisma.attachment.findMany({
      where: { id: { in: ids } },
      select: { id: true, storageKey: true },
    });
    const keyById = new Map(rows.map((r) => [r.id, r.storageKey]));
    const seen = new Map<string, StagedAsset>(); // sha -> staged (same bytes attached twice: one object)
    let total = 0;

    for (const a of raw.assets) {
      const srcKey = keyById.get(a.sourceAttachmentId);
      if (!srcKey) { out.refused.push({ sourceAttachmentId: a.sourceAttachmentId, reason: 'UNREADABLE' }); continue; }
      // cheap refusals first: nothing is read for a file that cannot be kept
      if (seen.size >= L.maxAssets || total >= L.maxTotalAssetBytes) {
        out.refused.push({ sourceAttachmentId: a.sourceAttachmentId, reason: 'OVER_TEMPLATE_CAP' });
        continue;
      }
      let bytes: Buffer;
      try {
        bytes = await this.storage.getObject(srcKey, L.maxAssetBytes);
      } catch (err) {
        out.refused.push({ sourceAttachmentId: a.sourceAttachmentId, reason: /larger than/.test(String((err as Error).message)) ? 'TOO_LARGE' : 'UNREADABLE' });
        continue;
      }
      const refusal = refuseAsset({ fileName: a.fileName, mimeType: a.mimeType, bytes }, L.maxAssetBytes);
      if (refusal) { out.refused.push({ sourceAttachmentId: a.sourceAttachmentId, reason: refusal }); continue; }
      const sha = sha256Hex(bytes);
      let entry = seen.get(sha);
      if (!entry) {
        if (total + bytes.length > L.maxTotalAssetBytes) {
          out.refused.push({ sourceAttachmentId: a.sourceAttachmentId, reason: 'OVER_TEMPLATE_CAP' });
          continue;
        }
        entry = { sha256: sha, fileName: a.fileName, mimeType: a.mimeType.toLowerCase(), sizeBytes: bytes.length, storageKey: templateAssetKey(templateId, sha) };
        await this.storage.putObject(entry.storageKey, bytes, entry.mimeType);
        seen.set(sha, entry);
        out.staged.push(entry);
        total += bytes.length;
      }
      out.hashes.set(a.sourceAttachmentId, sha);
      out.actualSizes.set(a.sourceAttachmentId, bytes.length);
    }
    return out;
  }

  // ================================================================ upload ===============

  /** API upload of one file to an existing template. Counts toward the template's caps. */
  async upload(templateId: string, userId: string, file: { fileName: string; mimeType: string; bytes: Buffer }) {
    const L = BLUEPRINT_LIMITS;
    const refusal = refuseAsset(file, L.maxAssetBytes);
    if (refusal) {
      throw new UnprocessableEntityException({ code: 'ASSET_REFUSED', reason: refusal, message: 'This file cannot be added to a template' });
    }
    const sha = sha256Hex(file.bytes);
    const key = templateAssetKey(templateId, sha);
    const mimeType = file.mimeType.toLowerCase();

    // caps are checked under a per-template lock so two uploads cannot both take the last slot
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`template-assets:${templateId}`}, 0))`;
      const existing = await tx.templateAsset.findUnique({ where: { templateId_sha256: { templateId, sha256: sha } } });
      if (existing) return existing; // same bytes again: nothing to do
      const agg = await tx.templateAsset.aggregate({ where: { templateId }, _count: true, _sum: { sizeBytes: true } });
      if (agg._count >= L.maxAssets || (agg._sum.sizeBytes ?? 0) + file.bytes.length > L.maxTotalAssetBytes) {
        throw new UnprocessableEntityException({ code: 'ASSET_CAP', message: `A template carries at most ${L.maxAssets} files / ${L.maxTotalAssetBytes} bytes` });
      }
      await this.storage.putObject(key, file.bytes, mimeType);
      try {
        return await tx.templateAsset.create({
          data: { templateId, sha256: sha, fileName: file.fileName, mimeType, sizeBytes: file.bytes.length, storageKey: key, createdById: userId },
        });
      } catch (err) {
        await this.storage.deleteObject(key).catch(() => undefined);
        throw err;
      }
    });
  }

  list(templateId: string) {
    return this.prisma.templateAsset.findMany({
      where: { templateId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, sha256: true, fileName: true, mimeType: true, sizeBytes: true, createdAt: true },
    });
  }

  // ================================================================ integrity ============

  /**
   * Every asset a blueprint declares must exist (same sha256 AND size) either among the template's
   * stored assets or among `staged`. Otherwise a version could point at bytes that are not there.
   */
  async assertBlueprintAssets(db: Db, templateId: string | null, bp: BlueprintV1, staged: StagedAsset[] = []): Promise<void> {
    const declared = bp.assets ?? [];
    if (declared.length === 0) return;
    const have = new Map<string, number>(staged.map((s) => [s.sha256, s.sizeBytes]));
    if (templateId) {
      const rows = await db.templateAsset.findMany({ where: { templateId, sha256: { in: declared.map((a) => a.sha256) } }, select: { sha256: true, sizeBytes: true } });
      rows.forEach((r) => have.set(r.sha256, r.sizeBytes));
    }
    const bad = declared.filter((a) => have.get(a.sha256) !== a.sizeBytes).map((a) => ({ key: a.key, fileName: a.fileName }));
    if (bad.length > 0) {
      throw new UnprocessableEntityException({
        code: 'ASSET_MISSING',
        message: 'The blueprint lists files that are not stored with this template. Upload them first.',
        assets: bad,
      });
    }
  }

  // ================================================================ fork / delete ========

  /** Copies every asset of `fromTemplateId` under `toTemplateId` (server-side copy). Returns what to insert. */
  async copyAll(fromTemplateId: string, toTemplateId: string): Promise<StagedAsset[]> {
    const rows = await this.prisma.templateAsset.findMany({ where: { templateId: fromTemplateId } });
    const out: StagedAsset[] = [];
    try {
      for (const r of rows) {
        const key = templateAssetKey(toTemplateId, r.sha256);
        await this.storage.copyObject(r.storageKey, key);
        out.push({ sha256: r.sha256, fileName: r.fileName, mimeType: r.mimeType, sizeBytes: r.sizeBytes, storageKey: key });
      }
    } catch (err) {
      await this.deleteObjects(out.map((s) => s.storageKey));
      throw err;
    }
    return out;
  }

  async keysOf(templateId: string): Promise<string[]> {
    return (await this.prisma.templateAsset.findMany({ where: { templateId }, select: { storageKey: true } })).map((r) => r.storageKey);
  }

  /** Best effort: a missing object is fine, a failing store must not undo a delete that already committed. */
  async deleteObjects(keys: string[]): Promise<void> {
    for (const k of keys) {
      try { await this.storage.deleteObject(k); } catch (err) { this.logger.warn(`could not delete ${k}: ${(err as Error).message}`); }
    }
  }

  async requireRow(templateId: string, sha256: string) {
    const r = await this.prisma.templateAsset.findUnique({ where: { templateId_sha256: { templateId, sha256 } } });
    if (!r) throw new NotFoundException('Asset not found');
    return r;
  }
}
