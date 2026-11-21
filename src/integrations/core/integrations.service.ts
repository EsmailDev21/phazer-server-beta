import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { AuditAction, IntegrationConnectionStatus } from '@prisma/client';
import { PermissionResolver } from '../../access-control/access-control.service';
import { PlanLimitsService } from '../../access-control/plan-limits.service';
import { AuditLogService } from '../../events/audit-log.service';
import { PrismaService } from '../../prisma/prisma.service';
import { IntegrationConnectionDto } from '../dto/integration.dto';
import { ConnectorRegistry } from './connector.registry';
import { CredentialService } from './credential.service';
import { LIVE_STATUSES } from './oauth.service';

/** Explicit select: the credential relation is not even loadable through this path (ADR-0009 d.5). */
const CONNECTION_SELECT = {
  id: true,
  provider: true,
  externalAccountId: true,
  externalAccountName: true,
  scopes: true,
  status: true,
  lastError: true,
  lastUsedAt: true,
  createdAt: true,
} as const;

@Injectable()
export class IntegrationsService implements OnModuleInit {
  private readonly logger = new Logger(IntegrationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ConnectorRegistry,
    private readonly credentials: CredentialService,
    private readonly resolver: PermissionResolver,
    private readonly planLimits: PlanLimitsService,
    private readonly audit: AuditLogService,
  ) {}

  /** PlanLimitsService throws for a counted limit with no counter; this table is the one behind 'integration'. */
  onModuleInit(): void {
    this.planLimits.registerCounter('integration', (ctx, db) =>
      db.integrationConnection.count({
        where: { accountId: ctx.accountId, status: { in: LIVE_STATUSES } },
      }),
    );
  }

  async list(accountId: string): Promise<IntegrationConnectionDto[]> {
    return this.prisma.integrationConnection.findMany({
      where: { accountId },
      select: CONNECTION_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    });
  }

  /**
   * ADR-0009 d.3 (owner decision): soft revoke. The row stays as REVOKED, tokens are deleted, channel
   * links are paused; reconnecting the same provider account revives it. Idempotent.
   */
  async revoke(connectionId: string, userId: string): Promise<IntegrationConnectionDto> {
    const conn = await this.prisma.integrationConnection.findUnique({
      where: { id: connectionId },
      select: { ...CONNECTION_SELECT, accountId: true },
    });
    if (!conn) throw new NotFoundException('Connection not found');
    const allowed = await this.resolver.resolve(userId, 'manageIntegrations', 'ACCOUNT', conn.accountId);
    if (!allowed.allowed) throw new ForbiddenException(allowed.reason ?? 'Not allowed');
    const { accountId, ...dto } = conn;
    if (conn.status === IntegrationConnectionStatus.REVOKED) return dto;

    // Tell the provider first (best effort): once the token is deleted we cannot.
    try {
      const tokens = await this.credentials.load(connectionId);
      if (tokens && this.registry.has(conn.provider)) {
        await this.registry.get(conn.provider).revoke(tokens, {
          id: conn.externalAccountId,
          name: conn.externalAccountName,
        });
      }
    } catch (e) {
      this.logger.warn(`Provider-side revoke failed for ${connectionId}: ${(e as Error).message}`);
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      await this.credentials.remove(connectionId, tx);
      await tx.channelLink.updateMany({
        where: { connectionId, pausedAt: null },
        data: { pausedAt: new Date() },
      });
      return tx.integrationConnection.update({
        where: { id: connectionId },
        data: { status: IntegrationConnectionStatus.REVOKED, lastError: null },
        select: CONNECTION_SELECT,
      });
    });
    await this.audit.record({
      actorId: userId,
      accountId,
      action: AuditAction.INTEGRATION_DISCONNECTED,
      metadata: { connectionId, provider: conn.provider },
    });
    return updated;
  }
}
