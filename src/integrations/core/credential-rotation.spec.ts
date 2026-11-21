import { randomBytes } from 'crypto';
import { TokenVaultService } from '../../crypto/token-vault.service';
import { CredentialRotationService } from './credential-rotation.service';

const K1 = randomBytes(32).toString('base64');
const K2 = randomBytes(32).toString('base64');
const vaultWith = (keys: string, current: string) => new TokenVaultService({ TOKEN_VAULT_KEYS: keys, TOKEN_VAULT_CURRENT_KID: current } as never);

/** An in-memory IntegrationCredential table with the two operations the service uses. */
function fakeDb(rows: Array<{ id: string; connectionId: string; kid: string; ciphertext: string }>, hook?: (row: (typeof rows)[number]) => void) {
  return {
    rows,
    integrationCredential: {
      findMany: jest.fn(async ({ where, take }: { where: { kid: { not: string }; id?: { gt: string } }; take: number }) =>
        rows.filter((r) => r.kid !== where.kid.not && (!where.id || r.id > where.id.gt)).sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, take).map((r) => ({ ...r }))),
      updateMany: jest.fn(async ({ where, data }: { where: { id: string; ciphertext: string }; data: { ciphertext: string; kid: string } }) => {
        const row = rows.find((r) => r.id === where.id);
        if (row) hook?.(row);
        if (!row || row.ciphertext !== where.ciphertext) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
  };
}

describe('CredentialRotationService', () => {
  const oldVault = vaultWith(`k1:${K1}`, 'k1');
  const ring = `k1:${K1},k2:${K2}`;
  const newVault = vaultWith(ring, 'k2');
  const row = (id: string, plain: string) => ({ id, connectionId: `conn-${id}`, kid: 'k1', ciphertext: oldVault.encrypt(plain) });

  it('moves every credential onto the current key; the plaintext survives and is only readable with the new key id', async () => {
    const db = fakeDb([row('a', 'tok-a'), row('b', 'tok-b'), { ...row('c', 'tok-c'), kid: 'k2', ciphertext: newVault.encrypt('tok-c') }]);
    const r = await new CredentialRotationService(db as never, newVault).reencryptAll({ batchSize: 1 }); // several pages
    expect(r).toMatchObject({ dryRun: false, currentKid: 'k2', scanned: 2, rotated: 2, skippedConcurrent: 0, failed: [] });
    expect(db.rows.map((x) => x.kid)).toEqual(['k2', 'k2', 'k2']);
    expect(db.rows.map((x) => newVault.decrypt(x.ciphertext))).toEqual(['tok-a', 'tok-b', 'tok-c']);
    expect(() => oldVault.decrypt(db.rows[0].ciphertext)).toThrow(); // now needs k2: the point of the exercise
  });

  it('is idempotent: a second run finds nothing', async () => {
    const db = fakeDb([row('a', 'tok-a')]);
    const svc = new CredentialRotationService(db as never, newVault);
    await svc.reencryptAll();
    expect(await svc.reencryptAll()).toMatchObject({ scanned: 0, rotated: 0 });
  });

  it('dry run reports what it would do and writes nothing', async () => {
    const db = fakeDb([row('a', 'tok-a'), row('b', 'tok-b')]);
    const before = db.rows.map((x) => x.ciphertext);
    const r = await new CredentialRotationService(db as never, newVault).reencryptAll({ dryRun: true });
    expect(r).toMatchObject({ dryRun: true, scanned: 2, rotated: 0 });
    expect(db.integrationCredential.updateMany).not.toHaveBeenCalled();
    expect(db.rows.map((x) => x.ciphertext)).toEqual(before);
  });

  it('a token refresh that lands between read and write wins: the stale re-encryption is NOT written', async () => {
    const fresh = newVault.encrypt('tok-refreshed');
    const db = fakeDb([row('a', 'tok-a')], (r) => { r.ciphertext = fresh; r.kid = 'k2'; }); // the refresh, just before our CAS
    const r = await new CredentialRotationService(db as never, newVault).reencryptAll();
    expect(r).toMatchObject({ scanned: 1, rotated: 0, skippedConcurrent: 1 });
    expect(newVault.decrypt(db.rows[0].ciphertext)).toBe('tok-refreshed');
  });

  it('a credential whose key already left the ring is reported (by connection id and error NAME) and left alone; the run continues', async () => {
    const lost = { id: 'a', connectionId: 'conn-a', kid: 'k0', ciphertext: vaultWith(`k0:${randomBytes(32).toString('base64')}`, 'k0').encrypt('gone') };
    const db = fakeDb([lost, row('b', 'tok-b')]);
    const before = lost.ciphertext;
    const r = await new CredentialRotationService(db as never, newVault).reencryptAll();
    expect(r.rotated).toBe(1);
    expect(r.failed).toEqual([{ connectionId: 'conn-a', error: 'TokenVaultUnknownKeyError' }]);
    expect(db.rows[0].ciphertext).toBe(before);
    expect(JSON.stringify(r)).not.toContain('gone');
  });

  it('an unconfigured vault refuses to run (nothing to rotate onto)', async () => {
    const svc = new CredentialRotationService(fakeDb([]) as never, new TokenVaultService({} as never));
    await expect(svc.reencryptAll()).rejects.toThrow();
  });
});
