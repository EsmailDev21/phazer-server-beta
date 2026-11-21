import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { JobEnvelope } from '../../queue/job-envelope';
import { JobHandler, JobHandlerRegistry } from '../../queue/job-handler.registry';
import { QUEUES } from '../../queue/queue.definitions';

declare module '../../queue/queue.definitions' {
  interface JobPayloads {
    'system.oauth-states-sweep': Record<string, never>;
  }
}

const RETAIN_MS = 24 * 60 * 60 * 1000;
const BATCH = 5000;

/** Step 2.1: an OAuthState is dead 10 minutes after creation; keep a day for forensics, then delete. */
@Injectable()
export class OAuthStateSweepJob implements JobHandler<'system.oauth-states-sweep'>, OnModuleInit {
  private readonly logger = new Logger(OAuthStateSweepJob.name);
  readonly queue = QUEUES.SYSTEM.name;
  readonly jobName = 'system.oauth-states-sweep' as const;

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
    this.registry.registerSchedule({
      queue: this.queue,
      schedulerId: 'oauth-states-sweep-hourly',
      jobName: this.jobName,
      payload: {},
      everyMs: 60 * 60 * 1000,
    });
  }

  async handle(envelope: JobEnvelope) {
    const deleted = await this.sweep();
    this.logger.log(`OAuth state sweep ${envelope.traceId}: ${deleted.deleted} deleted`);
    return deleted;
  }

  async sweep(now = new Date()): Promise<{ deleted: number; hasMore: boolean; tokensDeleted: number }> {
    const cutoff = new Date(now.getTime() - RETAIN_MS);
    // Step 2.2: one-time identity link tokens follow the same retention.
    const tokensDeleted = (await this.prisma.identityLinkToken.deleteMany({ where: { expiresAt: { lt: cutoff } } })).count;
    // Step 2.4: the chat command run ledger (a retry window is minutes; a day is plenty).
    await this.prisma.chatCommandRun.deleteMany({ where: { createdAt: { lt: cutoff } } });
    const rows = await this.prisma.oAuthState.findMany({
      where: { expiresAt: { lt: cutoff } },
      select: { id: true },
      take: BATCH,
    });
    if (rows.length === 0) return { deleted: 0, hasMore: false, tokensDeleted };
    const res = await this.prisma.oAuthState.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
    return { deleted: res.count, hasMore: rows.length === BATCH, tokensDeleted };
  }
}
