import {
  BlueprintV1,
  blueprintChecksum,
  validateBlueprint,
} from '../blueprint';
import { refuseAsset, sha256Hex } from '../assets/asset.policy';
import { BLUEPRINT_LIMITS } from '../blueprint';
import { SeedDefinition } from './seed.types';

export interface PreparedFile {
  key: string;
  fileName: string;
  mimeType: string;
  bytes: Buffer;
  sha256: string;
}

export type PreparedSeed =
  | {
      ok: true;
      seedKey: string;
      blueprint: BlueprintV1;
      checksum: string;
      files: PreparedFile[];
      stats: unknown;
    }
  | { ok: false; seedKey: string; problems: string[] };

const SEED_KEY = /^[a-z][a-z0-9-]{1,63}$/;

/**
 * Pure: turns a definition into what gets stored, or says why it cannot be. No database, no storage.
 *   - the seed key has the shape the database CHECK demands
 *   - every file passes the SAME policy as an upload (MIME, extension, content) and the per-file cap
 *   - the blueprint's `assets` list is built FROM the bytes (hash, size), so it can never disagree with them
 *   - the result validates as a blueprint (the same validator every user-made template goes through)
 */
export function prepareSeed(def: SeedDefinition): PreparedSeed {
  const problems: string[] = [];
  if (!SEED_KEY.test(def.seedKey))
    problems.push(`seedKey "${def.seedKey}" is not a valid key`);
  if ('assets' in def.blueprint)
    problems.push(
      'the blueprint must not declare `assets`; list them as `files`',
    );

  const files: PreparedFile[] = [];
  const seen = new Set<string>();
  for (const f of def.files ?? []) {
    if (seen.has(f.key)) problems.push(`file key "${f.key}" is used twice`);
    seen.add(f.key);
    const bytes = Buffer.from(f.text, 'utf8');
    const refusal = refuseAsset(
      { fileName: f.fileName, mimeType: f.mimeType, bytes },
      BLUEPRINT_LIMITS.maxAssetBytes,
    );
    if (refusal)
      problems.push(
        `file "${f.key}" is refused by the asset policy (${refusal})`,
      );
    files.push({
      key: f.key,
      fileName: f.fileName,
      mimeType: f.mimeType.toLowerCase(),
      bytes,
      sha256: sha256Hex(bytes),
    });
  }
  if (problems.length > 0) return { ok: false, seedKey: def.seedKey, problems };

  const candidate: Record<string, unknown> = JSON.parse(
    JSON.stringify(def.blueprint),
  );
  if (files.length > 0) {
    candidate.assets = files.map((f) => ({
      key: f.key,
      fileName: f.fileName,
      mimeType: f.mimeType,
      sizeBytes: f.bytes.length,
      sha256: f.sha256,
    }));
  }
  const checked = validateBlueprint(candidate);
  if (checked.ok === false) {
    return {
      ok: false,
      seedKey: def.seedKey,
      problems: checked.issues
        .slice(0, 5)
        .map((i) => `${i.code} at ${i.path ?? '?'}`),
    };
  }
  return {
    ok: true,
    seedKey: def.seedKey,
    blueprint: checked.blueprint,
    checksum: blueprintChecksum(checked.blueprint),
    files,
    stats: checked.stats,
  };
}
