import { createPublicKey, verify } from 'crypto';

/** Discord's Ed25519 public keys are 32 raw bytes; Node wants SPKI DER, which is this fixed prefix + the key. */
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const HEX = /^[0-9a-fA-F]+$/;

/** Discord documents no tolerance; Slack's is 5 minutes and replay protection wants the same order of magnitude. */
export const MAX_TIMESTAMP_SKEW_SECONDS = 300;

export type SignatureVerdict = 'ok' | 'missing' | 'malformed' | 'expired' | 'bad_signature' | 'bad_key';

/**
 * Verify `X-Signature-Ed25519` over `X-Signature-Timestamp + rawBody` (ADR-0012 d.3). Pure and total: never throws,
 * returns WHY it failed so tests (and logs) can tell an expired request from a forged one. Callers answer 401 for any
 * verdict but 'ok' and must not reveal which.
 */
export function verifyDiscordSignature(input: {
  publicKeyHex: string | undefined;
  signatureHex: string | undefined;
  timestamp: string | undefined;
  rawBody: Buffer;
  nowSeconds?: number;
}): SignatureVerdict {
  const { publicKeyHex, signatureHex, timestamp, rawBody } = input;
  if (!signatureHex || !timestamp) return 'missing';
  if (!publicKeyHex || publicKeyHex.length !== 64 || !HEX.test(publicKeyHex)) return 'bad_key';
  if (signatureHex.length !== 128 || !HEX.test(signatureHex)) return 'malformed';
  if (!/^\d{1,12}$/.test(timestamp)) return 'malformed';
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  // Checked BEFORE the (cheap but pointless) crypto: an old but correctly signed request is a replay.
  if (Math.abs(now - Number(timestamp)) > MAX_TIMESTAMP_SKEW_SECONDS) return 'expired';
  try {
    const key = createPublicKey({
      key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(publicKeyHex, 'hex')]),
      format: 'der',
      type: 'spki',
    });
    const ok = verify(null, Buffer.concat([Buffer.from(timestamp), rawBody]), key, Buffer.from(signatureHex, 'hex'));
    return ok ? 'ok' : 'bad_signature';
  } catch {
    return 'bad_signature';
  }
}
