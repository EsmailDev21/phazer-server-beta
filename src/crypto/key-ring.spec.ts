import { randomBytes } from 'crypto';
import { parseKeyRing } from './key-ring';

const key32 = () => randomBytes(32).toString('base64');

describe('parseKeyRing', () => {
  it('unset entirely: empty ring, no current kid, no problems', () => {
    const result = parseKeyRing({});
    expect(result.keys.size).toBe(0);
    expect(result.currentKid).toBeUndefined();
    expect(result.problems).toEqual([]);
  });

  it('a valid single-key ring parses cleanly', () => {
    const k1 = key32();
    const result = parseKeyRing({
      TOKEN_VAULT_KEYS: `k1:${k1}`,
      TOKEN_VAULT_CURRENT_KID: 'k1',
    });
    expect(result.problems).toEqual([]);
    expect(result.currentKid).toBe('k1');
    expect(result.keys.get('k1')?.toString('base64')).toBe(k1);
  });

  it('a valid multi-key ring (rotation in progress) parses every key, current points at the new one', () => {
    const kOld = key32();
    const kNew = key32();
    const result = parseKeyRing({
      TOKEN_VAULT_KEYS: `old:${kOld},new:${kNew}`,
      TOKEN_VAULT_CURRENT_KID: 'new',
    });
    expect(result.problems).toEqual([]);
    expect(result.keys.size).toBe(2);
    expect(result.currentKid).toBe('new');
  });

  it('tolerates whitespace around entries and a trailing comma', () => {
    const k1 = key32();
    const k2 = key32();
    const result = parseKeyRing({
      TOKEN_VAULT_KEYS: ` k1 : ${k1} , k2:${k2}, `,
      TOKEN_VAULT_CURRENT_KID: ' k2 ',
    });
    // NOTE: only the ENTRY is trimmed, not internal whitespace around the
    // colon - "k1 " / " k1" would fail KID_PATTERN, which is intentional
    // (a kid with embedded whitespace is almost certainly a typo, not a
    // real key id).
    expect(result.problems.some((p) => p.includes('k1'))).toBe(true);
    expect(result.keys.get('k2')?.toString('base64')).toBe(k2);
  });

  it('missing ":" in an entry is a problem, does not crash the rest of the ring', () => {
    const k1 = key32();
    const result = parseKeyRing({
      TOKEN_VAULT_KEYS: `not-a-pair,k1:${k1}`,
      TOKEN_VAULT_CURRENT_KID: 'k1',
    });
    expect(result.problems).toEqual([expect.stringContaining('missing ":"')]);
    expect(result.currentKid).toBe('k1');
  });

  it('an invalid key id (bad characters) is rejected', () => {
    const result = parseKeyRing({
      TOKEN_VAULT_KEYS: `bad kid!:${key32()}`,
      TOKEN_VAULT_CURRENT_KID: 'bad kid!',
    });
    expect(result.problems.some((p) => p.includes('invalid'))).toBe(true);
    expect(result.keys.size).toBe(0);
  });

  it('a duplicate key id is rejected (first one wins, duplicate dropped)', () => {
    const first = key32();
    const second = key32();
    const result = parseKeyRing({
      TOKEN_VAULT_KEYS: `k1:${first},k1:${second}`,
      TOKEN_VAULT_CURRENT_KID: 'k1',
    });
    expect(result.problems.some((p) => p.includes('duplicate'))).toBe(true);
    expect(result.keys.get('k1')?.toString('base64')).toBe(first);
  });

  it('a key that decodes to the wrong length is rejected (not 32 bytes)', () => {
    const tooShort = randomBytes(16).toString('base64');
    const result = parseKeyRing({
      TOKEN_VAULT_KEYS: `k1:${tooShort}`,
      TOKEN_VAULT_CURRENT_KID: 'k1',
    });
    expect(
      result.problems.some((p) => p.includes('16 byte') && p.includes('32')),
    ).toBe(true);
    expect(result.keys.size).toBe(0);
  });

  it('TOKEN_VAULT_CURRENT_KID pointing at a kid not in the ring is a problem', () => {
    const result = parseKeyRing({
      TOKEN_VAULT_KEYS: `k1:${key32()}`,
      TOKEN_VAULT_CURRENT_KID: 'does-not-exist',
    });
    expect(result.problems.some((p) => p.includes('does-not-exist'))).toBe(
      true,
    );
    expect(result.currentKid).toBeUndefined();
  });

  it('keys set but TOKEN_VAULT_CURRENT_KID unset is a problem', () => {
    const result = parseKeyRing({ TOKEN_VAULT_KEYS: `k1:${key32()}` });
    expect(
      result.problems.some((p) => p.includes('TOKEN_VAULT_CURRENT_KID')),
    ).toBe(true);
    expect(result.currentKid).toBeUndefined();
  });

  it('TOKEN_VAULT_CURRENT_KID set with TOKEN_VAULT_KEYS unset is a problem, not silently ignored', () => {
    const result = parseKeyRing({ TOKEN_VAULT_CURRENT_KID: 'k1' });
    expect(result.problems).toEqual([
      expect.stringContaining('TOKEN_VAULT_KEYS is empty'),
    ]);
  });
});
