import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ActivityAction, IntegrationConnectionStatus, Prisma } from '@prisma/client';
import { PermissionResolver } from '../../access-control/access-control.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ChannelDeliveryDto,
  ChannelLinkDto,
  CreateChannelLinkDto,
  CreateSubscriptionDto,
  SubscriptionDto,
  UpdateSubscriptionDto,
} from '../dto/integration.dto';
import { DEFAULT_EVENTS, NOTIFIABLE_ACTIONS } from './rich-message.builder';

const SUB_SELECT = { id: true, channelLinkId: true, events: true, minVisibility: true, enabled: true, failureCount: true, disabledReason: true } as const;
export const LINK_SELECT = {
  id: true, connectionId: true, kind: true, externalId: true, workspaceId: true, projectId: true, pausedAt: true, config: true, createdAt: true,
  subscriptions: { select: SUB_SELECT, orderBy: { createdAt: 'asc' } },
} satisfies Prisma.ChannelLinkSelect;

/**
 * Admin API for "which channel hears what" (ADR-0011 d.5). Every method resolves the connection's account first and
 * requires `manageIntegrations` on it; ids that do not exist are 404. Chat commands (2.4-2.6) will create the same rows.
 */
@Injectable()
export class ChannelAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: PermissionResolver,
  ) {}

  async listLinks(connectionId: string, actorId: string): Promise<ChannelLinkDto[]> {
    await this.adminOfConnection(connectionId, actorId);
    return this.prisma.channelLink.findMany({ where: { connectionId }, select: LINK_SELECT, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  }

  async createLink(connectionId: string, actorId: string, dto: CreateChannelLinkDto): Promise<ChannelLinkDto> {
    const conn = await this.adminOfConnection(connectionId, actorId);
    if (conn.status !== IntegrationConnectionStatus.ACTIVE) throw new BadRequestException('The connection is not active');
    if (conn.provider === 'GITHUB') throw new BadRequestException('GitHub repositories are linked with POST /integrations/connections/:id/github/repo-links');
    const ws = await this.prisma.workspace.findFirst({ where: { id: dto.workspaceId, accountId: conn.accountId }, select: { id: true } });
    if (!ws) throw new BadRequestException('That workspace is not in this account');
    if (dto.projectId) {
      const p = await this.prisma.project.findFirst({ where: { id: dto.projectId, workspaceId: ws.id }, select: { id: true } });
      if (!p) throw new BadRequestException('That project is not in that workspace');
    }
    try {
      return await this.prisma.channelLink.create({
        data: { connectionId, kind: 'CHANNEL', externalId: dto.externalId.trim(), workspaceId: ws.id, projectId: dto.projectId ?? null, configuredById: actorId },
        select: LINK_SELECT,
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException('That channel is already linked');
      throw e;
    }
  }

  async deleteLink(linkId: string, actorId: string): Promise<void> {
    await this.adminOfLink(linkId, actorId);
    await this.prisma.channelLink.delete({ where: { id: linkId } });
  }

  async createSubscription(linkId: string, actorId: string, dto: CreateSubscriptionDto): Promise<SubscriptionDto> {
    const link = await this.adminOfLink(linkId, actorId);
    if (link.kind !== 'CHANNEL') throw new BadRequestException('Only channel links can have subscriptions');
    return this.prisma.channelSubscription.create({
      data: { channelLinkId: linkId, events: this.validEvents(dto.events) ?? [...DEFAULT_EVENTS], minVisibility: dto.minVisibility ?? 'TIMELINE' },
      select: SUB_SELECT,
    });
  }

  async updateSubscription(subId: string, actorId: string, dto: UpdateSubscriptionDto): Promise<SubscriptionDto> {
    await this.adminOfSubscription(subId, actorId);
    const data: Prisma.ChannelSubscriptionUpdateInput = {};
    const events = this.validEvents(dto.events);
    if (events) data.events = events;
    if (dto.minVisibility) data.minVisibility = dto.minVisibility;
    if (dto.enabled === true) { data.enabled = true; data.failureCount = 0; data.disabledReason = null; } // a human decided: fresh start
    if (dto.enabled === false) data.enabled = false;
    return this.prisma.channelSubscription.update({ where: { id: subId }, data, select: SUB_SELECT });
  }

  async deleteSubscription(subId: string, actorId: string): Promise<void> {
    await this.adminOfSubscription(subId, actorId);
    await this.prisma.channelSubscription.delete({ where: { id: subId } });
  }

  /** Newest first; the delivery log is how an admin sees "why did nothing arrive". */
  async deliveries(linkId: string, actorId: string, limit = 50): Promise<ChannelDeliveryDto[]> {
    await this.adminOfLink(linkId, actorId);
    return this.prisma.channelDelivery.findMany({
      where: { subscription: { channelLinkId: linkId } },
      select: { id: true, activityId: true, status: true, attempts: true, error: true, createdAt: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), 100) : 50,
    });
  }

  // ---- internals

  private validEvents(events?: ActivityAction[]): ActivityAction[] | undefined {
    if (!events) return undefined;
    const allowed = new Set<string>(NOTIFIABLE_ACTIONS);
    const bad = events.filter((e) => !allowed.has(e));
    if (bad.length) throw new BadRequestException(`Not subscribable: ${[...new Set(bad)].join(', ')}`);
    return [...new Set(events)];
  }

  private async adminOfConnection(connectionId: string, actorId: string) {
    const conn = await this.prisma.integrationConnection.findUnique({ where: { id: connectionId }, select: { id: true, accountId: true, status: true, provider: true } });
    if (!conn) throw new NotFoundException('Connection not found');
    const ok = await this.resolver.resolve(actorId, 'manageIntegrations', 'ACCOUNT', conn.accountId);
    if (!ok.allowed) throw new ForbiddenException(ok.reason ?? 'Not allowed');
    return conn;
  }

  private async adminOfLink(linkId: string, actorId: string) {
    const link = await this.prisma.channelLink.findUnique({ where: { id: linkId }, select: { id: true, kind: true, connectionId: true } });
    if (!link) throw new NotFoundException('Channel link not found');
    await this.adminOfConnection(link.connectionId, actorId);
    return link;
  }

  private async adminOfSubscription(subId: string, actorId: string) {
    const sub = await this.prisma.channelSubscription.findUnique({ where: { id: subId }, select: { id: true, channelLinkId: true } });
    if (!sub) throw new NotFoundException('Subscription not found');
    await this.adminOfLink(sub.channelLinkId, actorId);
    return sub;
  }
}
