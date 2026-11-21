/** Base for every TokenVault error - lets a caller `catch (e) { if (e instanceof TokenVaultError) ... }` for the whole family at once. */
export abstract class TokenVaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** encrypt() called with no TOKEN_VAULT_CURRENT_KID configured (or key ring entirely unset). */
export class TokenVaultNotConfiguredError extends TokenVaultError {
  constructor() {
    super(
      'TokenVaultService is not configured (TOKEN_VAULT_KEYS/TOKEN_VAULT_CURRENT_KID unset or invalid). Check TokenVaultService.configured before calling encrypt().',
    );
  }
}

/**
 * decrypt()/reencrypt() referenced a key id this vault instance's ring
 * does not contain. Two real causes collapse to the same error on
 * purpose: a key was rotated out and its ciphertext never migrated
 * (`reencrypt()` exists specifically to prevent this), or this process
 * is simply misconfigured for the environment its data came from.
 */
export class TokenVaultUnknownKeyError extends TokenVaultError {
  constructor(public readonly kid: string) {
    super(`No key configured for key id "${kid}".`);
  }
}

/**
 * GCM authentication failed: the ciphertext, IV, or auth tag was
 * modified (or simply wrong), OR the payload was encrypted under a
 * different key's bytes despite claiming this kid. Node's
 * `decipher.final()` throwing is the ONLY signal GCM gives here - by
 * design it never distinguishes "tampered" from "wrong key material for
 * this kid" from "corrupted"; from the caller's side all three mean the
 * same thing: do not trust this plaintext, there isn't one.
 */
export class TokenVaultTamperError extends TokenVaultError {
  constructor(
    public readonly kid: string,
    cause: Error,
  ) {
    super(
      `Ciphertext for key id "${kid}" failed authentication (tampered, corrupted, or wrong key): ${cause.message}`,
    );
  }
}

/** The string handed to decrypt()/reencrypt() isn't shaped like our own ciphertext format at all. */
export class TokenVaultFormatError extends TokenVaultError {
  constructor(reason: string) {
    super(`Malformed TokenVault ciphertext: ${reason}`);
  }
}
