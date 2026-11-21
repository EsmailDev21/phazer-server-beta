import { Injectable, Logger } from '@nestjs/common';
import { AuditAction, IntegrationConnectionStatus, Prisma } from '@prisma/client';
import { TokenVaultService } from '../../crypto/token-vault.service';
import { AuditLogService } from '../../events/audit-log.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ConnectorRegistry } from './connector.registry';
import { ProviderAuthRejectedError, TokenSet } from './integration.types';
import { RedisLockService } from './redis-lock.service';

/** Refresh when fewer than this many ms of life remain (clock skew + request time). */
export const REFRESH_SKEW_MS = 60_000;

export class ConnectionNeedsReauthError extends Error {
  constructor(readonly connectionId: string) {
    super(`Integration connection ${connectionId} needs re-authorisation`);
    this.name = 'ConnectionNeedsReauthError';
  }
}

interface StoredPlain {
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  scopes: string[];
  extra?: Record<string, string>;
}

/**
 * The only code that reads or writes IntegrationCredential. Plaintext lives only inside these methods.
 * Refresh runs under a per-connection Redis lock and RE-READS after taking it (ADR-0009 d.6): Jira-style
 * rotating refresh tokens are single use, so two racing refreshes would brick the connection.
 */
@Injectable()
export class CredentialService {
  private readonly logger = new Logger(CredentialService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly vault: TokenVaultService,
    private readonly registry: ConnectorRegistry,
    private readonly locks: RedisLockService,
    private readonly audit: AuditLogService,
  ) {}

  /** Encrypt and upsert. `db` lets the OAuth callback do it in its own transaction. */
  async store(
    connectionId: string,
    tokens: TokenSet,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<void> {
    const plain: StoredPlain = {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      tokenType: tokens.tokenType,
      scopes: tokens.scopes,
      extra: tokens.extra,
    };
    const ciphertext = this.vault.encrypt(JSON.stringify(plain));
    const kid = this.vault.currentKid;
    await db.integrationCredential.upsert({
      where: { connectionId },
      create: { connectionId, kid, ciphertext, expiresAt: tokens.expiresAt ?? null },
      update: { kid, ciphertext, expiresAt: tokens.expiresAt ?? null },
    });
  }

  async remove(
    connectionId: string,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<void> {
    await db.integrationCredential.deleteMany({ where: { connectionId } });
  }

  /** Decrypted tokens as stored (no refresh). Used by revoke. Null if there is no credential. */
  async load(connectionId: string): Promise<TokenSet | null> {
    const row = await this.prisma.integrationCredential.findUnique({ where: { connectionId } });
    return row ? this.toTokenSet(row.ciphertext, row.expiresAt) : null;
  }

  /** A usable access token, refreshing first when it is (nearly) expired. */
  async getAccessToken(connectionId: string): Promise<string> {
    const row = await this.prisma.integrationCredential.findUnique({
      where: { connectionId },
      select: { ciphertext: true, expiresAt: true },
    });
    if (!row) throw new ConnectionNeedsReauthError(connectionId);
    if (!this.needsRefresh(row.expiresAt)) {
      void this.touch(connectionId);
      return this.toTokenSet(row.ciphertext, row.expiresAt).accessToken;
    }
    return this.refreshLocked(connectionId);
  }

  private async refreshLocked(connectionId: string): Promise<string> {
    return this.locks.withLock(`integration-refresh:${connectionId}`, 30_000, async () => {
      // Someone else may have refreshed while we waited for the lock: look again before doing it.
      const row = await this.prisma.integrationCredential.findUnique({
        where: { connectionId },
        include: { connection: { select: { provider: true, accountId: true, createdById: true, status: true } } },
      });
      if (!row) throw new ConnectionNeedsReauthError(connectionId);
      const current = this.toTokenSet(row.ciphertext, row.expiresAt);
      if (!this.needsRefresh(row.expiresAt)) return current.accessToken;

      const adapter = this.registry.get(row.connection.provider);
      if (!adapter.refresh) {
        await this.markNeedsReauth(connectionId, 'Token expired and the provider offers no refresh');
        throw new ConnectionNeedsReauthError(connectionId);
      }
      try {
        const fresh = await adapter.refresh(current);
        // Providers often omit a new refresh token when it did not rotate: keep the old one.
        await this.store(connectionId, {
          ...fresh,
          refreshToken: fresh.refreshToken ?? current.refreshToken,
          extra: fresh.extra ?? current.extra,
        });
        void this.touch(connectionId);
        return fresh.accessToken;
      } catch (e) {
        if (e instanceof ProviderAuthRejectedError) {
          await this.markNeedsReauth(connectionId, e.message);
          throw new ConnectionNeedsReauthError(connectionId);
        }
        // Transient (network, 5xx, rate limit): leave the connection ACTIVE, caller may retry.
        this.logger.warn(`Refresh failed for ${connectionId}: ${(e as Error).message}`);
        throw e;
      }
    });
  }

  /** Status flip + one audit row (fan-out turns it into ACCOUNT_ALERT for the other owners/admins). */
  async markNeedsReauth(connectionId: string, reason: string): Promise<void> {
    const conn = await this.prisma.integrationConnection.findUnique({
      where: { id: connectionId },
      select: { accountId: true, createdById: true, provider: true, status: true },
    });
    if (!conn || conn.status !== IntegrationConnectionStatus.ACTIVE) return; // already flagged / revoked: no repeat alert
    const flipped = await this.prisma.integrationConnection.updateMany({
      where: { id: connectionId, status: IntegrationConnectionStatus.ACTIVE },
      data: { status: IntegrationConnectionStatus.NEEDS_REAUTH, lastError: reason.slice(0, 500) },
    });
    if (flipped.count === 0) return;
    // actorId is required by AuditLog; the connection creator is the closest real user. `system: true`
    // tells the fan-out NOT to exclude that actor, so every owner/admin (incl. the creator) is alerted.
    await this.audit.record({
      actorId: conn.createdById,
      accountId: conn.accountId,
      action: AuditAction.INTEGRATION_NEEDS_REAUTH,
      metadata: { connectionId, provider: conn.provider, system: true },
    });
  }

  private needsRefresh(expiresAt: Date | null): boolean {
    return expiresAt !== null && expiresAt.getTime() - Date.now() <= REFRESH_SKEW_MS;
  }

  private toTokenSet(ciphertext: string, expiresAt: Date | null): TokenSet {
    const plain = JSON.parse(this.vault.decrypt(ciphertext)) as StoredPlain;
    return {
      accessToken: plain.accessToken,
      refreshToken: plain.refreshToken,
      tokenType: plain.tokenType,
      scopes: plain.scopes,
      extra: plain.extra,
      expiresAt: expiresAt ?? undefined,
    };
  }

  private async touch(connectionId: string): Promise<void> {
    await this.prisma.integrationConnection
      .update({ where: { id: connectionId }, data: { lastUsedAt: new Date() }, select: { id: true } })
      .catch(() => undefined);
  }
}
