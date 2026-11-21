import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AuditAction, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface RecordAuditLogParams {
  actorId: string;
  action: AuditAction;
  accountId: string;
  metadata?: Prisma.InputJsonValue;
}

/**
 * Separate from ActivityService — CONFIRMED separate stream (schema-phase
 * decision): different retention policy, different guard (viewAuditLog,
 * ADMIN-tier minimum), different fan-out recipient rule (OWNER/ADMIN only,
 * see FanoutService). Same async-emit pattern as ActivityService.
 */
@Injectable()
export class AuditLogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async record(params: RecordAuditLogParams) {
    const auditLog = await this.prisma.auditLog.create({
      data: {
        actorId: params.actorId,
        action: params.action,
        accountId: params.accountId,
        metadata: params.metadata,
      },
    });

    this.eventEmitter.emit('auditlog.created', auditLog);
    return auditLog;
  }
}
