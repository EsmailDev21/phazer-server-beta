import { randomBytes } from 'crypto';
import { TokenVaultService } from './token-vault.service';
import {
  TokenVaultFormatError,
  TokenVaultNotConfiguredError,
  TokenVaultTamperError,
  TokenVaultUnknownKeyError,
} from './token-vault.errors';

const key32 = () => randomBytes(32).toString('base64');

/** Flips one byte inside a base64-encoded field of a `v1:kid:iv:tag:ct` payload, re-encodes, leaves the rest untouched - a realistic single-bit-flip style tamper, not just string surgery. */
function corruptField(payload: string, fieldIndex: 2 | 3 | 4): string {
  const parts = payload.split(':');
  const buf = Buffer.from(parts[fieldIndex], 'base64');
  buf[0] = buf[0] ^ 0xff; // flip every bit of the first byte
  parts[fieldIndex] = buf.toString('base64');
  return parts.join(':');
}

describe('TokenVaultService', () => {
  describe('configured', () => {
    it('is false with no env at all', () => {
      const vault = new TokenVaultService({});
      expect(vault.configured).toBe(false);
    });

    it('is true with a valid single-key ring', () => {
      const vault = new TokenVaultService({
        TOKEN_VAULT_KEYS: `k1:${key32()}`,
        TOKEN_VAULT_CURRENT_KID: 'k1',
      });
      expect(vault.configured).toBe(true);
      expect(vault.currentKid).toBe('k1');
    });

    it('encrypt() throws TokenVaultNotConfiguredError, not a generic crash, when unconfigured', () => {
      const vault = new TokenVaultService({});
      expect(() => vault.encrypt('secret')).toThrow(
        TokenVaultNotConfiguredError,
      );
    });

    it('.currentKid getter throws TokenVaultNotConfiguredError when unconfigured', () => {
      const vault = new TokenVaultService({});
      expect(() => vault.currentKid).toThrow(TokenVaultNotConfiguredError);
    });
  });

  describe('encrypt/decrypt round trip', () => {
    const vault = new TokenVaultService({
      TOKEN_VAULT_KEYS: `k1:${key32()}`,
      TOKEN_VAULT_CURRENT_KID: 'k1',
    });

    it('decrypts back to the exact original plaintext', () => {
      const plaintext =
        'a very secret OAuth refresh token, 128 chars xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
      const ciphertext = vault.encrypt(plaintext);
      expect(vault.decrypt(ciphertext)).toBe(plaintext);
    });

    it('round-trips the empty string', () => {
      const ciphertext = vault.encrypt('');
      expect(vault.decrypt(ciphertext)).toBe('');
    });

    it('round-trips unicode (not just ASCII)', () => {
      const plaintext = '🔐 sëcrét tökén 日本語';
      expect(vault.decrypt(vault.encrypt(plaintext))).toBe(plaintext);
    });

    it('the ciphertext is self-describing: v1:{kid}:iv:tag:ct, kid matches the encrypting key', () => {
      const ciphertext = vault.encrypt('x');
      const parts = ciphertext.split(':');
      expect(parts).toHaveLength(5);
      expect(parts[0]).toBe('v1');
      expect(parts[1]).toBe('k1');
    });

    it('two encryptions of the same plaintext produce different ciphertext (fresh IV every call)', () => {
      const a = vault.encrypt('same plaintext');
      const b = vault.encrypt('same plaintext');
      expect(a).not.toBe(b);
      expect(vault.decrypt(a)).toBe('same plaintext');
      expect(vault.decrypt(b)).toBe('same plaintext');
    });

    it('the ciphertext never contains the plaintext as a visible substring', () => {
      const plaintext = 'super-secret-marker-value';
      const ciphertext = vault.encrypt(plaintext);
      expect(ciphertext).not.toContain(plaintext);
    });
  });

  describe('tamper detection', () => {
    const vault = new TokenVaultService({
      TOKEN_VAULT_KEYS: `k1:${key32()}`,
      TOKEN_VAULT_CURRENT_KID: 'k1',
    });

    it('a flipped byte in the ciphertext field is detected, not silently decrypted wrong', () => {
      const original = vault.encrypt('sensitive value');
      const tampered = corruptField(original, 4);
      expect(() => vault.decrypt(tampered)).toThrow(TokenVaultTamperError);
    });

    it('a flipped byte in the auth tag is detected', () => {
      const original = vault.encrypt('sensitive value');
      const tampered = corruptField(original, 3);
      expect(() => vault.decrypt(tampered)).toThrow(TokenVaultTamperError);
    });

    it('a flipped byte in the IV is detected (GCM ties the tag to the IV too)', () => {
      const original = vault.encrypt('sensitive value');
      const tampered = corruptField(original, 2);
      expect(() => vault.decrypt(tampered)).toThrow(TokenVaultTamperError);
    });

    it('swapping the ciphertext of one message onto the tag/iv of another is detected', () => {
      const a = vault.encrypt('message A');
      const b = vault.encrypt('message B');
      const [version, kid, ivA, tagA] = a.split(':');
      const [, , , , ctB] = b.split(':');
      const frankensteined = [version, kid, ivA, tagA, ctB].join(':');
      expect(() => vault.decrypt(frankensteined)).toThrow(
        TokenVaultTamperError,
      );
    });
  });

  describe('wrong-key failure', () => {
    it("decrypting with a vault whose ring does not contain the ciphertext's key id throws TokenVaultUnknownKeyError", () => {
      const vaultA = new TokenVaultService({
        TOKEN_VAULT_KEYS: `kA:${key32()}`,
        TOKEN_VAULT_CURRENT_KID: 'kA',
      });
      const vaultB = new TokenVaultService({
        TOKEN_VAULT_KEYS: `kB:${key32()}`,
        TOKEN_VAULT_CURRENT_KID: 'kB',
      });
      const ciphertext = vaultA.encrypt('secret');

      expect(() => vaultB.decrypt(ciphertext)).toThrow(
        TokenVaultUnknownKeyError,
      );
      try {
        vaultB.decrypt(ciphertext);
        fail('expected a throw');
      } catch (error) {
        expect(
          (error as InstanceType<typeof TokenVaultUnknownKeyError>).kid,
        ).toBe('kA');
      }
    });

    it('two DIFFERENT keys claiming the same kid: decrypting under the wrong bytes fails as a tamper (GCM cannot tell "wrong key" from "tampered")', () => {
      const vaultA = new TokenVaultService({
        TOKEN_VAULT_KEYS: `k1:${key32()}`,
        TOKEN_VAULT_CURRENT_KID: 'k1',
      });
      const vaultAWrongKeyMaterial = new TokenVaultService({
        TOKEN_VAULT_KEYS: `k1:${key32()}`, // same kid "k1", different actual key bytes
        TOKEN_VAULT_CURRENT_KID: 'k1',
      });
      const ciphertext = vaultA.encrypt('secret');

      expect(() => vaultAWrongKeyMaterial.decrypt(ciphertext)).toThrow(
        TokenVaultTamperError,
      );
    });
  });

  describe('rotation (reencrypt)', () => {
    it('reencrypt() moves a ciphertext from the old key onto the current one', () => {
      const oldKey = key32();
      const newKey = key32();
      const vaultBeforeRotation = new TokenVaultService({
        TOKEN_VAULT_KEYS: `old:${oldKey}`,
        TOKEN_VAULT_CURRENT_KID: 'old',
      });
      const ciphertextUnderOldKey = vaultBeforeRotation.encrypt(
        'pre-rotation secret',
      );

      // Rotation: the ring now has BOTH keys (old kept so existing data
      // stays decryptable), current points at the new one.
      const vaultAfterRotation = new TokenVaultService({
        TOKEN_VAULT_KEYS: `old:${oldKey},new:${newKey}`,
        TOKEN_VAULT_CURRENT_KID: 'new',
      });

      // Old ciphertext still decrypts (nothing broke on rotation day).
      expect(vaultAfterRotation.decrypt(ciphertextUnderOldKey)).toBe(
        'pre-rotation secret',
      );

      const reencrypted = vaultAfterRotation.reencrypt(ciphertextUnderOldKey);
      expect(reencrypted.split(':')[1]).toBe('new');
      expect(vaultAfterRotation.decrypt(reencrypted)).toBe(
        'pre-rotation secret',
      );

      // The retired key can now be fully removed - the row no longer
      // depends on it - and the migrated ciphertext is still readable.
      const vaultOldKeyFullyRemoved = new TokenVaultService({
        TOKEN_VAULT_KEYS: `new:${newKey}`,
        TOKEN_VAULT_CURRENT_KID: 'new',
      });
      expect(vaultOldKeyFullyRemoved.decrypt(reencrypted)).toBe(
        'pre-rotation secret',
      );
      expect(() =>
        vaultOldKeyFullyRemoved.decrypt(ciphertextUnderOldKey),
      ).toThrow(TokenVaultUnknownKeyError);
    });

    it('reencrypt() is a no-op (same string) when the ciphertext is already on the current key', () => {
      const vault = new TokenVaultService({
        TOKEN_VAULT_KEYS: `k1:${key32()}`,
        TOKEN_VAULT_CURRENT_KID: 'k1',
      });
      const ciphertext = vault.encrypt('already current');
      expect(vault.reencrypt(ciphertext)).toBe(ciphertext);
    });

    it('reencrypt() still checks authenticity - a tampered old-key ciphertext is rejected, not silently carried forward', () => {
      const oldKey = key32();
      const vault = new TokenVaultService({
        TOKEN_VAULT_KEYS: `old:${oldKey},new:${key32()}`,
        TOKEN_VAULT_CURRENT_KID: 'new',
      });
      const vaultOldOnly = new TokenVaultService({
        TOKEN_VAULT_KEYS: `old:${oldKey}`,
        TOKEN_VAULT_CURRENT_KID: 'old',
      });
      const tampered = corruptField(vaultOldOnly.encrypt('x'), 4);

      expect(() => vault.reencrypt(tampered)).toThrow(TokenVaultTamperError);
    });
  });

  describe('malformed input', () => {
    const vault = new TokenVaultService({
      TOKEN_VAULT_KEYS: `k1:${key32()}`,
      TOKEN_VAULT_CURRENT_KID: 'k1',
    });

    it('garbage input throws TokenVaultFormatError, not an unhandled exception', () => {
      expect(() => vault.decrypt('not-our-format-at-all')).toThrow(
        TokenVaultFormatError,
      );
    });

    it('an unknown format version is rejected', () => {
      const ciphertext = vault.encrypt('x');
      const wrongVersion = ciphertext.replace(/^v1:/, 'v2:');
      expect(() => vault.decrypt(wrongVersion)).toThrow(TokenVaultFormatError);
    });

    it('a too-short IV is rejected before ever touching the cipher', () => {
      const ciphertext = vault.encrypt('x');
      const parts = ciphertext.split(':');
      parts[2] = Buffer.from([1, 2, 3]).toString('base64'); // 3 bytes, not 12
      expect(() => vault.decrypt(parts.join(':'))).toThrow(
        TokenVaultFormatError,
      );
    });
  });
});
