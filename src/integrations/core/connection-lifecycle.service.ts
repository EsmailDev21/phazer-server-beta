import { Injectable } from '@nestjs/common';
import { AuditAction, IntegrationConnectionStatus, IntegrationProvider } from '@prisma/client';
import { AuditLogService } from '../../events/audit-log.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CredentialService } from './credential.service';

const NOT_REVOKED: IntegrationConnectionStatus[] = [
  IntegrationConnectionStatus.ACTIVE,
  IntegrationConnectionStatus.NEEDS_REAUTH,
  IntegrationConnectionStatus.ERROR,
];

/**
 * Provider-initiated end of a connection (the App was uninstalled, its tokens were revoked). Same soft revoke as a user's
 * disconnect (ADR-0009 d.3): status REVOKED, credential deleted, links paused but KEPT, so reinstalling and reconnecting the
 * same provider account revives everything. Idempotent: only the call that flips the status raises the alert.
 */
@Injectable()
export class ConnectionLifecycleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly credentials: CredentialService,
    private readonly audit: AuditLogService,
  ) {}

  /** Returns how many live connections of this provider tenant were revoked (0 = nothing to do, e.g. an uninstall we already knew about). */
  async revokeByProvider(provider: IntegrationProvider, externalAccountId: string, reason: string): Promise<number> {
    const conns = await this.prisma.integrationConnection.findMany({
      where: { provider, externalAccountId, status: { in: NOT_REVOKED } },
      select: { id: true, accountId: true, createdById: true },
    });
    let revoked = 0;
    for (const conn of conns) {
      const flipped = await this.prisma.$transaction(async (tx) => {
        const r = await tx.integrationConnection.updateMany({
          where: { id: conn.id, status: { in: NOT_REVOKED } },
          data: { status: IntegrationConnectionStatus.REVOKED, lastError: reason.slice(0, 500) },
        });
        if (r.count === 0) return false;
        await this.credentials.remove(conn.id, tx);
        await tx.channelLink.updateMany({ where: { connectionId: conn.id, pausedAt: null }, data: { pausedAt: new Date() } });
        return true;
      });
      if (!flipped) continue;
      revoked++;
      // actorId is required by AuditLog; `system: true` keeps the creator among the people alerted (ADR-0011 fan-out).
      await this.audit.record({
        actorId: conn.createdById,
        accountId: conn.accountId,
        action: AuditAction.INTEGRATION_DISCONNECTED,
        metadata: { connectionId: conn.id, provider, reason, system: true },
      });
    }
    return revoked;
  }
}
