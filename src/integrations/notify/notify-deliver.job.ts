import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AuditAction, ChannelDeliveryStatus, IntegrationConnectionStatus } from '@prisma/client';
import { Job } from 'bullmq';
import { AuditLogService } from '../../events/audit-log.service';
import { PrismaService } from '../../prisma/prisma.service';
import { JobEnvelope } from '../../queue/job-envelope';
import { JobHandler, JobHandlerRegistry } from '../../queue/job-handler.registry';
import { QUEUES } from '../../queue/queue.definitions';
import { ConnectorRegistry } from '../core/connector.registry';
import { ConnectionNeedsReauthError, CredentialService } from '../core/credential.service';
import { NotifyPermanentError } from '../core/integration.types';
import { RichMessageBuilder, TargetGoneError } from './rich-message.builder';

/** Consecutive failed deliveries after which a subscription is disabled (diagram 08). */
export const DISABLE_AFTER_FAILURES = 3;

/**
 * `notify.deliver`: send one PENDING ChannelDelivery. Idempotent (only PENDING rows are processed), re-checks
 * everything the router checked (the world may have changed while the job waited), and classifies the result:
 * SENT; SKIPPED (nothing to blame); FAILED (counts toward disabling the subscription).
 */
@Injectable()
export class NotifyDeliverJob implements JobHandler<'notify.deliver'>, OnModuleInit {
  private readonly logger = new Logger(NotifyDeliverJob.name);
  readonly queue = QUEUES.NOTIFY.name;
  readonly jobName = 'notify.deliver' as const;

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly adapters: ConnectorRegistry,
    private readonly credentials: CredentialService,
    private readonly messages: RichMessageBuilder,
    private readonly audit: AuditLogService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(envelope: JobEnvelope, job?: Job): Promise<unknown> {
    const { deliveryId } = envelope.payload as { deliveryId: string };
    const d = await this.prisma.channelDelivery.findUnique({
      where: { id: deliveryId },
      include: {
        activity: true,
        subscription: { include: { channelLink: { include: { connection: true } } } },
      },
    });
    if (!d || d.status !== ChannelDeliveryStatus.PENDING) return { skipped: 'not_pending' };

    const sub = d.subscription;
    const link = sub.channelLink;
    const conn = link.connection;
    if (!sub.enabled) return this.finish(d.id, 'SKIPPED', 'subscription_disabled');
    if (link.pausedAt) return this.finish(d.id, 'SKIPPED', 'link_paused');
    if (conn.status !== IntegrationConnectionStatus.ACTIVE) return this.finish(d.id, 'SKIPPED', 'connection_inactive');
    if (!this.adapters.has(conn.provider)) return this.finish(d.id, 'SKIPPED', 'no_adapter');
    const adapter = this.adapters.get(conn.provider);
    if (!adapter.notify) return this.finish(d.id, 'SKIPPED', 'adapter_cannot_notify');

    let message;
    try {
      message = await this.messages.build(d.activity);
    } catch (e) {
      if (e instanceof TargetGoneError) return this.finish(d.id, 'SKIPPED', 'target_gone');
      throw e;
    }

    let accessToken: string;
    try {
      accessToken = await this.credentials.getAccessToken(conn.id);
    } catch (e) {
      if (e instanceof ConnectionNeedsReauthError) return this.finish(d.id, 'SKIPPED', 'connection_needs_reauth');
      return this.transient(d.id, sub.id, job, e);
    }

    try {
      await adapter.notify({
        accessToken,
        connection: { id: conn.id, externalAccountId: conn.externalAccountId },
        channel: { kind: link.kind, externalId: link.externalId },
        message,
        rateKey: `connection:${conn.id}`,
      });
    } catch (e) {
      if (e instanceof NotifyPermanentError) return this.fail(d.id, sub.id, e.code);
      return this.transient(d.id, sub.id, job, e);
    }
    await this.prisma.channelDelivery.update({ where: { id: d.id }, data: { status: 'SENT', attempts: { increment: 1 }, error: null } });
    // Success ends a failure streak: only CONSECUTIVE failures disable.
    await this.prisma.channelSubscription.updateMany({ where: { id: sub.id, failureCount: { gt: 0 } }, data: { failureCount: 0 } });
    return { sent: true };
  }

  private async finish(id: string, status: ChannelDeliveryStatus, reason: string) {
    await this.prisma.channelDelivery.update({ where: { id }, data: { status, error: reason } });
    return { [status.toLowerCase()]: reason };
  }

  /** Retry with the queue's backoff until the last attempt; then it is a real failure. */
  private async transient(deliveryId: string, subscriptionId: string, job: Job | undefined, e: unknown): Promise<unknown> {
    const attempts = job?.opts?.attempts ?? 1;
    const made = (job?.attemptsMade ?? 0) + 1;
    await this.prisma.channelDelivery.update({ where: { id: deliveryId }, data: { attempts: { increment: 1 }, error: `transient: ${(e as Error).message}`.slice(0, 300) } });
    if (made < attempts) throw e; // BullMQ retries
    return this.fail(deliveryId, subscriptionId, 'retries_exhausted');
  }

  private async fail(deliveryId: string, subscriptionId: string, code: string): Promise<unknown> {
    await this.prisma.channelDelivery.update({ where: { id: deliveryId }, data: { status: 'FAILED', error: code } });
    const { failureCount } = await this.prisma.channelSubscription.update({
      where: { id: subscriptionId }, data: { failureCount: { increment: 1 } }, select: { failureCount: true },
    });
    if (failureCount >= DISABLE_AFTER_FAILURES) await this.disable(subscriptionId, code);
    return { failed: code };
  }

  /** Atomic: only the call that flips enabled -> false raises the alert, however many jobs fail together. */
  private async disable(subscriptionId: string, code: string): Promise<void> {
    const flipped = await this.prisma.channelSubscription.updateMany({
      where: { id: subscriptionId, enabled: true },
      data: { enabled: false, disabledReason: `${DISABLE_AFTER_FAILURES} consecutive failures: ${code}` },
    });
    if (flipped.count === 0) return;
    const sub = await this.prisma.channelSubscription.findUnique({
      where: { id: subscriptionId },
      select: { channelLink: { select: { id: true, kind: true, externalId: true, configuredById: true, connection: { select: { accountId: true, provider: true } } } } },
    });
    if (!sub) return;
    const link = sub.channelLink;
    this.logger.warn(`Subscription ${subscriptionId} disabled after ${DISABLE_AFTER_FAILURES} failures (${code})`);
    await this.audit.record({
      actorId: link.configuredById,
      accountId: link.connection.accountId,
      action: AuditAction.INTEGRATION_SUBSCRIPTION_DISABLED,
      metadata: { subscriptionId, channelLinkId: link.id, provider: link.connection.provider, reason: code, system: true },
    });
  }
}
