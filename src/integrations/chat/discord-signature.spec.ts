import { generateKeyPairSync, sign } from 'crypto';
import { MAX_TIMESTAMP_SKEW_SECONDS, verifyDiscordSignature } from './discord-signature';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const pubHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
const NOW = 1_800_000_000;
const body = Buffer.from('{"type":1}');
const signed = (ts: string, b = body) => sign(null, Buffer.concat([Buffer.from(ts), b]), privateKey).toString('hex');
const call = (o: Partial<Parameters<typeof verifyDiscordSignature>[0]> = {}) =>
  verifyDiscordSignature({ publicKeyHex: pubHex, signatureHex: signed(String(NOW)), timestamp: String(NOW), rawBody: body, nowSeconds: NOW, ...o });

describe('verifyDiscordSignature', () => {
  it('accepts a correct signature over timestamp + raw body', () => expect(call()).toBe('ok'));

  it('rejects a body changed by one byte, and a timestamp changed by one second', () => {
    expect(call({ rawBody: Buffer.from('{"type":2}') })).toBe('bad_signature');
    expect(call({ timestamp: String(NOW + 1) })).toBe('bad_signature');
  });

  it('rejects a signature from another key', () => {
    const other = generateKeyPairSync('ed25519');
    const sig = sign(null, Buffer.concat([Buffer.from(String(NOW)), body]), other.privateKey).toString('hex');
    expect(call({ signatureHex: sig })).toBe('bad_signature');
  });

  it('missing headers -> missing; malformed hex / timestamp -> malformed (never throws)', () => {
    expect(call({ signatureHex: undefined })).toBe('missing');
    expect(call({ timestamp: undefined })).toBe('missing');
    expect(call({ signatureHex: 'zz'.repeat(64) })).toBe('malformed');
    expect(call({ signatureHex: 'ab' })).toBe('malformed');
    expect(call({ timestamp: 'yesterday' })).toBe('malformed');
    expect(call({ timestamp: '' })).toBe('missing');
  });

  it('a CORRECTLY signed but stale (or far-future) request is expired: replay protection', () => {
    const old = String(NOW - MAX_TIMESTAMP_SKEW_SECONDS - 1);
    expect(call({ timestamp: old, signatureHex: signed(old) })).toBe('expired');
    const future = String(NOW + MAX_TIMESTAMP_SKEW_SECONDS + 1);
    expect(call({ timestamp: future, signatureHex: signed(future) })).toBe('expired');
    const edge = String(NOW - MAX_TIMESTAMP_SKEW_SECONDS);
    expect(call({ timestamp: edge, signatureHex: signed(edge) })).toBe('ok');
  });

  it('a missing or malformed configured key is bad_key, never ok', () => {
    expect(call({ publicKeyHex: undefined })).toBe('bad_key');
    expect(call({ publicKeyHex: 'abcd' })).toBe('bad_key');
    expect(call({ publicKeyHex: 'zz'.repeat(32) })).toBe('bad_key');
  });

  it('an all-zero signature is rejected', () => {
    expect(call({ signatureHex: '0'.repeat(128) })).toBe('bad_signature');
  });
});
