/**
 * Pure functions only - no Nest, no I/O - same reasoning as
 * feature-flags.ts: the rules that decide whether a key ring is valid
 * should be unit-testable on their own and shared by every entrypoint.
 *
 * Format, env-driven (ADR-0002-style "kid:key" pairs, comma-separated):
 *   TOKEN_VAULT_KEYS="k1:base64-32-bytes,k2:base64-32-bytes"
 *   TOKEN_VAULT_CURRENT_KID="k2"
 *
 * `TOKEN_VAULT_KEYS` holds every key still allowed to DECRYPT (so
 * previously-encrypted data stays readable across a rotation);
 * `TOKEN_VAULT_CURRENT_KID` is the ONE key new ENCRYPT calls use. Both
 * unset is normal (nothing in this codebase calls TokenVaultService yet -
 * Phase 2's IntegrationCredential is its first real caller) and reported
 * as `configured: false`, not a problem. Set-but-wrong is a problem.
 */

export const AES_256_GCM_KEY_BYTES = 32;

export interface ParsedKeyRing {
  /** kid -> raw 32-byte key. Empty when TOKEN_VAULT_KEYS is unset. */
  keys: Map<string, Buffer>;
  /** The kid new encrypt() calls should use. Undefined when not configured. */
  currentKid: string | undefined;
  /** Non-empty only when something was SET but is invalid - never for "just unset". */
  problems: string[];
}

/** Exported so token-vault.service.ts validates a kid parsed out of a
 * ciphertext payload against the exact same rule used here - one
 * definition, not two that could drift apart. */
export const KID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function parseKeyRing(
  env: NodeJS.ProcessEnv = process.env,
): ParsedKeyRing {
  const raw = (env.TOKEN_VAULT_KEYS ?? '').trim();
  const currentKidRaw = (env.TOKEN_VAULT_CURRENT_KID ?? '').trim();
  const problems: string[] = [];
  const keys = new Map<string, Buffer>();

  if (raw === '') {
    // Unset is normal. A current-kid with no ring at all is still a real
    // misconfiguration worth surfacing, though - it can never work.
    if (currentKidRaw !== '') {
      problems.push(
        'TOKEN_VAULT_CURRENT_KID is set but TOKEN_VAULT_KEYS is empty.',
      );
    }
    return { keys, currentKid: undefined, problems };
  }

  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (trimmed === '') continue; // tolerate a trailing comma
    const sep = trimmed.indexOf(':');
    if (sep === -1) {
      problems.push(`TOKEN_VAULT_KEYS entry "${trimmed}" is missing ":".`);
      continue;
    }
    const kid = trimmed.slice(0, sep);
    const material = trimmed.slice(sep + 1);

    if (!KID_PATTERN.test(kid)) {
      problems.push(
        `TOKEN_VAULT_KEYS key id "${kid}" is invalid (allowed: letters, digits, "_", "-").`,
      );
      continue;
    }
    if (keys.has(kid)) {
      problems.push(`TOKEN_VAULT_KEYS has a duplicate key id "${kid}".`);
      continue;
    }

    let keyBuf: Buffer;
    try {
      keyBuf = Buffer.from(material, 'base64');
    } catch {
      problems.push(`TOKEN_VAULT_KEYS key id "${kid}" is not valid base64.`);
      continue;
    }
    // Buffer.from(..., 'base64') never throws on garbage - it just drops
    // invalid characters - so the ONLY reliable check is the decoded
    // length. A key that isn't clean base64 will almost never happen to
    // decode to exactly 32 bytes by accident.
    if (keyBuf.length !== AES_256_GCM_KEY_BYTES) {
      problems.push(
        `TOKEN_VAULT_KEYS key id "${kid}" decodes to ${keyBuf.length} byte(s), need exactly ${AES_256_GCM_KEY_BYTES} (aes-256-gcm).`,
      );
      continue;
    }

    keys.set(kid, keyBuf);
  }

  let currentKid: string | undefined;
  if (currentKidRaw === '') {
    if (keys.size > 0) {
      problems.push(
        'TOKEN_VAULT_KEYS is set but TOKEN_VAULT_CURRENT_KID is not - nothing would tell new encrypt() calls which key to use.',
      );
    }
  } else if (!keys.has(currentKidRaw)) {
    problems.push(
      `TOKEN_VAULT_CURRENT_KID "${currentKidRaw}" is not one of the key ids in TOKEN_VAULT_KEYS.`,
    );
  } else {
    currentKid = currentKidRaw;
  }

  return { keys, currentKid, problems };
}
