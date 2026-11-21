import { randomUUID } from 'crypto';
import { StagedAsset } from '../../../src/templates/assets/template-assets.service';
import { templateAssetKey } from '../../../src/templates/assets/asset.policy';
import { MemoryStorage } from './memory-storage';

/**
 * The golden fixtures declare reference files with made-up sha256 values. A template may only
 * be created with files that are actually stored, so tests store stand-in bytes under those
 * hashes (the apply copies by key; it does not re-hash).
 */
export function stageDeclaredAssets(storage: MemoryStorage, bp: { assets?: Array<{ sha256: string; fileName: string; mimeType: string; sizeBytes: number }> }) {
  const id = randomUUID();
  const assets: StagedAsset[] = (bp.assets ?? []).map((a) => {
    const storageKey = templateAssetKey(id, a.sha256);
    storage.seed(storageKey, Buffer.alloc(a.sizeBytes, 1), a.mimeType);
    return { sha256: a.sha256, fileName: a.fileName, mimeType: a.mimeType, sizeBytes: a.sizeBytes, storageKey };
  });
  return { id, assets };
}
