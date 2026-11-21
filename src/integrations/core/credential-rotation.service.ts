import { Injectable, Logger } from '@nestjs/common';
import { TokenVaultService } from '../../crypto/token-vault.service';
import { PrismaService } from '../../prisma/prisma.service';

export interface ReencryptReport {
  dryRun: boolean;
  currentKid: string;
  /** Credentials found on some other key id. */
  scanned: number;
  rotated: number;
  /** A refresh (which always writes the current key) got there first, or the row vanished: nothing to do. */
  skippedConcurrent: number;
  /** Could not be rotated (key already removed from the ring, corrupt ciphertext). Left untouched. Error NAMES only, never contents. */
  failed: Array<{ connectionId: string; error: string }>;
}

/**
 * Step 2.7, the other half of key rotation (the runbook is docs/runbooks/key-rotation.md). Moves every IntegrationCredential onto
 * the vault's CURRENT key. Safe to run any number of times, while the app is serving traffic, and from any instance:
 *  - each row is rewritten with a compare-and-swap on the exact ciphertext it read, so a token refresh that lands in between
 *    wins and is never overwritten with stale tokens;
 *  - a row that cannot be decrypted is reported and left as it is (the run continues, it never aborts half way);
 *  - plaintext exists only inside TokenVaultService; nothing here logs or returns a token or ciphertext.
 */
@Injectable()
export class CredentialRotationService {
  private readonly logger = new Logger(CredentialRotationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly vault: TokenVaultService,
  ) {}

  async reencryptAll(opts: { dryRun?: boolean; batchSize?: number } = {}): Promise<ReencryptReport> {
    const dryRun = opts.dryRun ?? false;
    const batchSize = Math.min(Math.max(opts.batchSize ?? 200, 1), 1000);
    const currentKid = this.vault.currentKid; // throws TokenVaultNotConfiguredError: rotating needs a configured ring
    const report: ReencryptReport = { dryRun, currentKid, scanned: 0, rotated: 0, skippedConcurrent: 0, failed: [] };

    let cursor: string | undefined;
    for (;;) {
      const rows = await this.prisma.integrationCredential.findMany({
        where: { kid: { not: currentKid }, ...(cursor ? { id: { gt: cursor } } : {}) },
        orderBy: { id: 'asc' },
        take: batchSize,
        select: { id: true, connectionId: true, ciphertext: true },
      });
      if (rows.length === 0) break;
      cursor = rows[rows.length - 1].id;
      for (const row of rows) {
        report.scanned++;
        if (dryRun) continue;
        let next: string;
        try {
          next = this.vault.reencrypt(row.ciphertext);
        } catch (e) {
          report.failed.push({ connectionId: row.connectionId, error: (e as Error).name });
          continue;
        }
        const res = await this.prisma.integrationCredential.updateMany({
          where: { id: row.id, ciphertext: row.ciphertext },
          data: { ciphertext: next, kid: currentKid },
        });
        if (res.count === 1) report.rotated++;
        else report.skippedConcurrent++;
      }
    }
    this.logger.log(
      `Credential re-encryption${dryRun ? ' (dry run)' : ''} onto "${currentKid}": ${report.scanned} found, ${report.rotated} rotated, ${report.skippedConcurrent} skipped (concurrent), ${report.failed.length} failed`,
    );
    return report;
  }
}
