import { Injectable, Logger } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { KID_PATTERN, parseKeyRing } from './key-ring';
import {
  TokenVaultFormatError,
  TokenVaultNotConfiguredError,
  TokenVaultTamperError,
  TokenVaultUnknownKeyError,
} from './token-vault.errors';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96 bits - the size GCM is designed and recommended for
const AUTH_TAG_BYTES = 16;
const FORMAT_VERSION = 'v1';

interface ParsedCiphertext {
  kid: string;
  iv: Buffer;
  tag: Buffer;
  ciphertext: Buffer;
}

/**
 * ADR-driven (PLAN.md "No secret encryption utility -> TokenVault"),
 * step 0.5. AES-256-GCM: authenticated encryption, so tampering with any
 * byte of the ciphertext, IV, or tag is DETECTED (decrypt() throws)
 * rather than silently returning garbage - there is no way to get
 * "decryption succeeds with the wrong output" out of GCM done correctly.
 *
 * Ciphertext format (self-describing, one string, fits a single DB
 * column): `v1:{kid}:{ivBase64}:{tagBase64}:{ciphertextBase64}`. The kid
 * travels WITH the ciphertext specifically so a key can rotate - old
 * data keeps naming the key it was actually encrypted under, and stays
 * decryptable for as long as that key id stays in the ring, regardless
 * of which key id is "current" for new writes.
 *
 * No caller exists yet in this codebase - Phase 2's `IntegrationCredential`
 * (PLAN.md "Tokens: AES-256-GCM with key ids... excluded from every
 * `select`") is the first real one. `configured` lets a future caller
 * check before calling `encrypt()` the same way `RedisService.configured`
 * and `FeatureFlagsService` are checked elsewhere, rather than
 * try/catching `TokenVaultNotConfiguredError` as control flow.
 */
@Injectable()
export class TokenVaultService {
  private readonly logger = new Logger(TokenVaultService.name);
  private readonly keys: Map<string, Buffer>;
  private readonly currentKidValue: string | undefined;

  /** True only when TOKEN_VAULT_KEYS + TOKEN_VAULT_CURRENT_KID are both set and valid. */
  readonly configured: boolean;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const { keys, currentKid, problems } = parseKeyRing(env);
    this.keys = keys;
    this.currentKidValue = currentKid;
    this.configured = currentKid !== undefined;

    // Same "set but wrong deserves a warning, unset is normal" split as
    // RedisService: only warn when TOKEN_VAULT_KEYS was actually set.
    if (problems.length > 0 && (env.TOKEN_VAULT_KEYS ?? '').trim() !== '') {
      for (const problem of problems) this.logger.warn(problem);
    }
  }

  /** The key id new encrypt() calls use. Throws TokenVaultNotConfiguredError if unconfigured - check `.configured` first to avoid the throw. */
  get currentKid(): string {
    if (!this.currentKidValue) throw new TokenVaultNotConfiguredError();
    return this.currentKidValue;
  }

  /** Is this key id still in the ring (i.e. can ciphertext naming it still be decrypted)? */
  hasKey(kid: string): boolean {
    return this.keys.has(kid);
  }

  encrypt(plaintext: string): string {
    if (!this.currentKidValue) throw new TokenVaultNotConfiguredError();
    const kid = this.currentKidValue;
    const key = this.keys.get(kid)!; // invariant: parseKeyRing only sets currentKid to a kid present in keys

    // A fresh, unpredictable IV every call - GCM's security guarantee
    // depends entirely on never reusing an (key, IV) pair, so this is
    // never derived from anything, never reused, never cached.
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    return [
      FORMAT_VERSION,
      kid,
      iv.toString('base64'),
      tag.toString('base64'),
      ciphertext.toString('base64'),
    ].join(':');
  }

  decrypt(payload: string): string {
    const parsed = this.parse(payload);
    const key = this.keys.get(parsed.kid);
    if (!key) throw new TokenVaultUnknownKeyError(parsed.kid);

    const decipher = createDecipheriv(ALGORITHM, key, parsed.iv);
    decipher.setAuthTag(parsed.tag);
    try {
      const plaintext = Buffer.concat([
        decipher.update(parsed.ciphertext),
        decipher.final(), // throws here on any tamper/wrong-key/corruption - see TokenVaultTamperError's doc
      ]);
      return plaintext.toString('utf8');
    } catch (error) {
      throw new TokenVaultTamperError(parsed.kid, error as Error);
    }
  }

  /**
   * Moves a ciphertext onto the current key. A no-op (same string
   * returned, nothing re-encrypted) when it's already there - this is
   * the fast path a bulk "migrate everything off a retiring key" job
   * (Phase 2+) is expected to call over every row unconditionally,
   * without checking first itself.
   */
  reencrypt(payload: string): string {
    const parsed = this.parse(payload);
    if (parsed.kid === this.currentKidValue) return payload;
    const plaintext = this.decrypt(payload);
    return this.encrypt(plaintext);
  }

  private parse(payload: string): ParsedCiphertext {
    const parts = payload.split(':');
    if (parts.length !== 5) {
      throw new TokenVaultFormatError(
        `expected 5 ":"-separated fields, got ${parts.length}.`,
      );
    }
    const [version, kid, ivB64, tagB64, ctB64] = parts;

    if (version !== FORMAT_VERSION) {
      throw new TokenVaultFormatError(
        `unknown format version "${version}" (expected "${FORMAT_VERSION}").`,
      );
    }
    if (!KID_PATTERN.test(kid)) {
      throw new TokenVaultFormatError(`invalid key id "${kid}".`);
    }

    const iv = Buffer.from(ivB64, 'base64');
    if (iv.length !== IV_BYTES) {
      throw new TokenVaultFormatError(
        `IV decodes to ${iv.length} byte(s), expected ${IV_BYTES}.`,
      );
    }
    const tag = Buffer.from(tagB64, 'base64');
    if (tag.length !== AUTH_TAG_BYTES) {
      throw new TokenVaultFormatError(
        `auth tag decodes to ${tag.length} byte(s), expected ${AUTH_TAG_BYTES}.`,
      );
    }
    const ciphertext = Buffer.from(ctB64, 'base64');

    return { kid, iv, tag, ciphertext };
  }
}
