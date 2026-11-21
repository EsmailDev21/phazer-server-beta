import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { IntegrationConnectionStatus, Prisma } from '@prisma/client';
import { PermissionResolver } from '../../access-control/access-control.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ConnectorRegistry } from '../core/connector.registry';
import { CredentialService } from '../core/credential.service';
import { ChannelLinkDto, GithubRepositoryDto, LinkRepoDto, StatusRulesDto } from '../dto/integration.dto';
import { LINK_SELECT } from '../notify/channel-admin.service';
import { GithubAdapter } from '../providers/github.adapter';
import { DEFAULT_STATUS_RULES, StatusRules, rulesFromConfig } from './status-rules';

/**
 * Admin API for GitHub (ADR-0014 d.5): which repositories the installation can see, link one to a PROJECT, edit its status rules.
 * Same authority as 2.3: `manageIntegrations` (account OWNER/ADMIN) on the connection's account, resolved from the connection
 * itself, never from a client-supplied account id. Listing/deleting links reuses the 2.3 routes (`channel-links`).
 */
@Injectable()
export class GithubAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: PermissionResolver,
    private readonly credentials: CredentialService,
    private readonly adapters: ConnectorRegistry,
  ) {}

  private get github(): GithubAdapter {
    return this.adapters.get('GITHUB') as GithubAdapter;
  }

  async repositories(connectionId: string, actorId: string, page = 1): Promise<{ repos: GithubRepositoryDto[]; hasMore: boolean }> {
    const conn = await this.githubConnection(connectionId, actorId);
    const token = await this.credentials.getAccessToken(conn.id);
    const { repos, hasMore } = await this.github.repositories(token, page, `connection:${conn.id}`);
    const links = await this.prisma.channelLink.findMany({
      where: { connectionId: conn.id, kind: 'REPO', externalId: { in: repos.map((r) => String(r.id)) } },
      select: { id: true, externalId: true },
    });
    const byRepo = new Map(links.map((l) => [l.externalId, l.id]));
    return { repos: repos.map((r) => ({ ...r, linkId: byRepo.get(String(r.id)) ?? null })), hasMore };
  }

  async linkRepo(connectionId: string, actorId: string, dto: LinkRepoDto): Promise<ChannelLinkDto> {
    const conn = await this.githubConnection(connectionId, actorId);
    const project = await this.prisma.project.findUnique({ where: { id: dto.projectId }, select: { id: true, workspaceId: true, workspace: { select: { accountId: true } } } });
    // Same message for "does not exist" and "belongs to another account": no probing of other tenants' ids.
    if (!project || project.workspace.accountId !== conn.accountId) throw new BadRequestException('That project is not in this account');

    const token = await this.credentials.getAccessToken(conn.id);
    const repo = await this.github.repository(token, dto.repoId, `connection:${conn.id}`);
    if (!repo) throw new BadRequestException('That repository is not accessible to this GitHub installation');

    const rules = { ...DEFAULT_STATUS_RULES, ...this.cleanRules(dto.statusRules) };
    try {
      return await this.prisma.channelLink.create({
        data: {
          connectionId: conn.id, kind: 'REPO', externalId: String(repo.id), workspaceId: project.workspaceId, projectId: project.id, configuredById: actorId,
          config: { repoFullName: repo.fullName, statusRules: rules } as unknown as Prisma.InputJsonValue,
        },
        select: LINK_SELECT,
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException('That repository is already linked');
      throw e;
    }
  }

  /** Only the keys sent change; `null` clears a rule. */
  async updateRules(linkId: string, actorId: string, dto: StatusRulesDto): Promise<ChannelLinkDto> {
    const link = await this.prisma.channelLink.findUnique({ where: { id: linkId }, select: { id: true, kind: true, connectionId: true, config: true } });
    if (!link) throw new NotFoundException('Channel link not found');
    await this.adminOf(link.connectionId, actorId);
    if (link.kind !== 'REPO') throw new BadRequestException('Only repository links have status rules');
    const config = { ...((link.config as object | null) ?? {}), statusRules: { ...rulesFromConfig(link.config), ...this.cleanRules(dto) } };
    return this.prisma.channelLink.update({ where: { id: linkId }, data: { config: config as unknown as Prisma.InputJsonValue }, select: LINK_SELECT });
  }

  // ---- internals

  /** Keeps only the three known keys that were actually sent (undefined = untouched, null = cleared). */
  private cleanRules(r: StatusRulesDto | undefined): StatusRules {
    const out: StatusRules = {};
    if (!r) return out;
    for (const k of ['prOpened', 'prMerged', 'prClosed'] as const) if (r[k] !== undefined) out[k] = r[k];
    return out;
  }

  private async adminOf(connectionId: string, actorId: string) {
    const conn = await this.prisma.integrationConnection.findUnique({ where: { id: connectionId }, select: { id: true, accountId: true, provider: true, status: true } });
    if (!conn) throw new NotFoundException('Connection not found');
    const ok = await this.resolver.resolve(actorId, 'manageIntegrations', 'ACCOUNT', conn.accountId);
    if (!ok.allowed) throw new ForbiddenException(ok.reason ?? 'Not allowed');
    return conn;
  }

  private async githubConnection(connectionId: string, actorId: string) {
    const conn = await this.adminOf(connectionId, actorId);
    if (conn.provider !== 'GITHUB') throw new BadRequestException('Not a GitHub connection');
    if (conn.status !== IntegrationConnectionStatus.ACTIVE) throw new BadRequestException('The connection is not active');
    return conn;
  }
}
