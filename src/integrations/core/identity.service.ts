import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  IdentityLinkMethod,
  IntegrationConnectionStatus,
  IntegrationProvider,
  Prisma,
} from '@prisma/client';
import { PermissionResolver } from '../../access-control/access-control.service';
import { AuditLogService } from '../../events/audit-log.service';
import { PrismaService } from '../../prisma/prisma.service';
import { IdentityLinkDto } from '../dto/integration.dto';
import { ConnectorRegistry } from './connector.registry';
import { CredentialService } from './credential.service';
import { ExternalUser } from './integration.types';
import { ChatReply, LinkPromptBuilder } from './link-prompt.builder';
import { LinkTokenService } from './link-token.service';
import { PromptThrottleService } from './prompt-throttle.service';

export type NotLinkedReason =
  | 'NO_LINK'
  | 'CONNECTION_INACTIVE'
  | 'NOT_A_PARTICIPANT'
  | 'AMBIGUOUS_EMAIL'
  | 'PROMPT_THROTTLED';

export type ResolvedIdentity =
  | { linked: true; userId: string; method: IdentityLinkMethod; linkId: string }
  | { linked: false; reason: NotLinkedReason; reply: ChatReply };

/** Thrown by requireLinkedUser. A command handler lets it propagate and sends `.reply` back, ephemerally. */
export class UnlinkedCallerError extends Error {
  constructor(
    readonly reason: NotLinkedReason,
    readonly reply: ChatReply,
  ) {
    super(`Caller is not a linked user (${reason})`);
    this.name = 'UnlinkedCallerError';
  }
}

export type OAuthLinkOutcome = 'LINKED' | 'ALREADY_LINKED_ELSEWHERE';

const LINK_SELECT = {
  id: true,
  connectionId: true,
  externalUserId: true,
  externalEmail: true,
  userId: true,
  method: true,
  createdAt: true,
} as const;

/**
 * Who is calling? (ADR-0010). The ONLY way a chat command obtains a userId. A command that cannot get
 * one does not run: `requireLinkedUser` throws. Authority beyond "this is user X" is never granted
 * here - 2.4/2.5 still run every command through PermissionResolver as that user.
 */
@Injectable()
export class IdentityService {
  private readonly logger = new Logger(IdentityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ConnectorRegistry,
    private readonly credentials: CredentialService,
    private readonly resolver: PermissionResolver,
    private readonly audit: AuditLogService,
    private readonly prompts: LinkPromptBuilder,
    private readonly linkTokens: LinkTokenService,
    private readonly promptThrottle: PromptThrottleService,
  ) {}

  // ------------------------------------------------------------------ resolve (chat path)

  async requireLinkedUser(connectionId: string, externalUserId: string): Promise<string> {
    const r = await this.resolve(connectionId, externalUserId);
    if (r.linked === false) throw new UnlinkedCallerError(r.reason, r.reply);
    return r.userId;
  }

  /**
   * 1. only an ACTIVE connection answers;  2. an existing link must still point at someone who is a
   * participant of the account;  3. no link: try the silent verified-email match, else prompt.
   */
  async resolve(connectionId: string, externalUserId: string): Promise<ResolvedIdentity> {
    const conn = await this.prisma.integrationConnection.findUnique({
      where: { id: connectionId },
      select: { id: true, accountId: true, provider: true, status: true, externalAccountId: true, externalAccountName: true },
    });
    if (!conn) throw new NotFoundException('Connection not found');
    if (conn.status !== IntegrationConnectionStatus.ACTIVE) {
      return { linked: false, reason: 'CONNECTION_INACTIVE', reply: this.prompts.disconnected(conn) };
    }
    // Counted at most once per call. Over the limit: no token is issued and no provider lookup is made (ADR-0015 d.6).
    let gate: boolean | undefined;
    const allowed = async () => (gate ??= await this.promptThrottle.allow(conn.id, externalUserId));
    const throttled = (): ResolvedIdentity => ({ linked: false, reason: 'PROMPT_THROTTLED', reply: this.prompts.throttled(conn) });
    const no = async (reason: NotLinkedReason): Promise<ResolvedIdentity> => {
      if (!(await allowed())) return throttled();
      return { linked: false, reason, reply: this.prompts.link(conn, await this.linkTokens.issue(conn.id, externalUserId)) };
    };

    const link = await this.prisma.identityLink.findUnique({
      where: { connectionId_externalUserId: { connectionId, externalUserId } },
    });
    if (link?.userId) {
      if (!(await this.isParticipant(link.userId, conn.accountId))) return no('NOT_A_PARTICIPANT');
      return { linked: true, userId: link.userId, method: link.method, linkId: link.id };
    }

    if (!(await allowed())) return throttled();
    const auto = await this.tryAutoMatch(conn, externalUserId);
    if (auto.kind === 'linked') return { linked: true, userId: auto.userId, method: 'AUTO_EMAIL', linkId: auto.linkId };
    return no(auto.kind === 'ambiguous' ? 'AMBIGUOUS_EMAIL' : 'NO_LINK');
  }

  /**
   * Silent match, only when EVERY guard holds: the adapter can look the user up; the provider says the email
   * is confirmed and the user is not a bot; the user is in the connection's own tenant; exactly one app user
   * has that email, with a verified email, and is an AccountMember of the account (owner decision, ADR-0010 d.3).
   */
  private async tryAutoMatch(
    conn: { id: string; accountId: string; provider: IntegrationProvider; externalAccountId: string },
    externalUserId: string,
  ): Promise<{ kind: 'linked'; userId: string; linkId: string } | { kind: 'ambiguous' } | { kind: 'none' }> {
    const adapter = this.registry.has(conn.provider) ? this.registry.get(conn.provider) : undefined;
    const lookup = adapter?.identity?.lookup;
    if (!lookup) return { kind: 'none' };

    let ext: ExternalUser | null;
    try {
      const token = await this.credentials.getAccessToken(conn.id);
      ext = await lookup.call(adapter!.identity, token, externalUserId, `connection:${conn.id}`);
    } catch (e) {
      // Provider down / token dead: the safe answer is "not linked", never a guess.
      this.logger.warn(`Identity lookup failed for ${conn.id}: ${(e as Error).message}`);
      return { kind: 'none' };
    }
    if (!ext || ext.isBot || !ext.email || ext.emailConfirmed !== true) return { kind: 'none' };
    if (ext.tenantId && ext.tenantId !== conn.externalAccountId) return { kind: 'none' };

    const candidates = await this.prisma.user.findMany({
      where: { email: { equals: ext.email.trim(), mode: 'insensitive' }, emailVerified: true },
      select: { id: true },
      take: 3,
    });
    const members: string[] = [];
    for (const c of candidates) if (await this.isAccountMember(c.id, conn.accountId)) members.push(c.id);
    if (members.length === 0) return { kind: 'none' };
    if (members.length > 1) return { kind: 'ambiguous' };

    const out = await this.upsertLink(conn.id, externalUserId, members[0], 'AUTO_EMAIL', ext.email, { onlyIfFree: true });
    if (!out) return { kind: 'none' }; // someone linked it meanwhile to a different user
    await this.auditLink(AuditAction.INTEGRATION_IDENTITY_LINKED, members[0], conn, externalUserId, 'AUTO_EMAIL');
    return { kind: 'linked', userId: members[0], linkId: out.id };
  }

  // ------------------------------------------------------------------ OAuth link (user proves both sides)

  async linkViaOAuth(
    conn: { id: string; accountId: string; provider: IntegrationProvider },
    ext: ExternalUser,
    userId: string,
  ): Promise<OAuthLinkOutcome> {
    const existing = await this.prisma.identityLink.findUnique({
      where: { connectionId_externalUserId: { connectionId: conn.id, externalUserId: ext.id } },
    });
    if (existing?.userId && existing.userId !== userId) return 'ALREADY_LINKED_ELSEWHERE'; // never silently steal; an admin can relink
    const row = await this.upsertLink(conn.id, ext.id, userId, 'OAUTH_LINK', ext.email ?? null, { onlyIfFree: true });
    if (!row) return 'ALREADY_LINKED_ELSEWHERE';
    await this.auditLink(AuditAction.INTEGRATION_IDENTITY_LINKED, userId, conn, ext.id, 'OAUTH_LINK');
    return 'LINKED';
  }

  // ------------------------------------------------------------------ one-time link (ADR-0010 d.2)

  /** What the confirmation page shows before the person clicks "link": which integration, never the chat user's identifiers. */
  async inspectLinkToken(token: string, userId: string) {
    const t = await this.linkTokens.inspect(token);
    if (!t) throw new BadRequestException('This link is invalid or has expired. Run the command in chat again for a new one.');
    const conn = await this.prisma.integrationConnection.findUnique({
      where: { id: t.connectionId },
      select: { id: true, accountId: true, provider: true, externalAccountName: true, status: true },
    });
    // 404 for non-participants: do not confirm that the token or the integration exists.
    if (!conn || !(await this.isParticipant(userId, conn.accountId))) throw new NotFoundException('Link not found');
    return { connectionId: conn.id, provider: conn.provider, externalAccountName: conn.externalAccountName, active: conn.status === IntegrationConnectionStatus.ACTIVE };
  }

  /** The logged-in user completes a token that was delivered to a chat user. One shot, whatever the outcome. */
  async completeLinkToken(token: string, userId: string): Promise<IdentityLinkDto> {
    const t = await this.linkTokens.consume(token);
    if (!t) throw new BadRequestException('This link is invalid or has expired. Run the command in chat again for a new one.');
    const conn = await this.prisma.integrationConnection.findUnique({
      where: { id: t.connection_id },
      select: { id: true, accountId: true, provider: true, status: true },
    });
    if (!conn || conn.status !== IntegrationConnectionStatus.ACTIVE) {
      throw new BadRequestException('This integration is not connected right now');
    }
    if (!(await this.isParticipant(userId, conn.accountId))) {
      throw new ForbiddenException('You are not a member of the account this integration belongs to');
    }
    const existing = await this.prisma.identityLink.findUnique({
      where: { connectionId_externalUserId: { connectionId: conn.id, externalUserId: t.external_user_id } },
    });
    if (existing?.userId && existing.userId !== userId) {
      throw new ConflictException('That chat user is already linked to another account. Ask an admin to relink it.');
    }
    const row = await this.upsertLink(conn.id, t.external_user_id, userId, 'LINK_TOKEN', null, { onlyIfFree: true });
    if (!row) throw new ConflictException('That chat user is already linked to another account. Ask an admin to relink it.');
    await this.auditLink(AuditAction.INTEGRATION_IDENTITY_LINKED, userId, conn, t.external_user_id, 'LINK_TOKEN');
    return this.toDto(row);
  }

  // ------------------------------------------------------------------ admin + self service

  async listForConnection(connectionId: string, actorId: string): Promise<IdentityLinkDto[]> {
    await this.assertAdmin(connectionId, actorId);
    return this.prisma.identityLink.findMany({
      where: { connectionId },
      select: LINK_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    });
  }

  /** Admin override: links (or RELINKS) an external user to an app user. Target must be a participant. */
  async manualLink(
    connectionId: string,
    actorId: string,
    input: { externalUserId: string; userId: string },
  ): Promise<IdentityLinkDto> {
    const conn = await this.assertAdmin(connectionId, actorId);
    if (conn.status === IntegrationConnectionStatus.REVOKED) {
      throw new BadRequestException('The connection is revoked');
    }
    const externalUserId = input.externalUserId.trim();
    if (!externalUserId) throw new BadRequestException('externalUserId is required');
    if (!(await this.isAccountMember(input.userId, conn.accountId))) {
      throw new BadRequestException('That user is not a member of this account');
    }
    const row = await this.upsertLink(connectionId, externalUserId, input.userId, 'MANUAL', null, { onlyIfFree: false });
    await this.auditLink(AuditAction.INTEGRATION_IDENTITY_LINKED, actorId, conn, externalUserId, 'MANUAL', input.userId);
    return this.toDto(row!);
  }

  async unlink(connectionId: string, externalUserId: string, actorId: string): Promise<void> {
    const conn = await this.assertAdmin(connectionId, actorId);
    const res = await this.prisma.identityLink.deleteMany({ where: { connectionId, externalUserId } });
    if (res.count === 0) throw new NotFoundException('No such link');
    await this.auditLink(AuditAction.INTEGRATION_IDENTITY_UNLINKED, actorId, conn, externalUserId, undefined);
  }

  async listMine(userId: string): Promise<IdentityLinkDto[]> {
    return this.prisma.identityLink.findMany({
      where: { userId },
      select: LINK_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    });
  }

  /** A person can always remove their own link. Someone else's id is a 404, not a 403 (no probing). */
  async unlinkMine(linkId: string, userId: string): Promise<void> {
    const link = await this.prisma.identityLink.findFirst({
      where: { id: linkId, userId },
      select: { id: true, externalUserId: true, connection: { select: { id: true, accountId: true, provider: true } } },
    });
    if (!link) throw new NotFoundException('No such link');
    await this.prisma.identityLink.delete({ where: { id: link.id } });
    await this.auditLink(AuditAction.INTEGRATION_IDENTITY_UNLINKED, userId, link.connection, link.externalUserId, undefined);
  }

  // ------------------------------------------------------------------ shared

  /**
   * "Belongs to this account": an AccountMember, an invited workspace collaborator, or a project member of a
   * project in the account. Whether they may do a given thing is PermissionResolver's job at command time.
   */
  /**
   * "Which app user is this OTHER chat person?" - for assigning a task to a mentioned user. Read-only by design:
   * it never asks the provider, never issues a link token (a token returned to the CALLER would let them claim
   * someone else's identity) and never auto-links. Null = not linked (or no longer a participant).
   */
  async lookupLinkedUserId(connectionId: string, externalUserId: string): Promise<string | null> {
    const row = await this.prisma.identityLink.findUnique({
      where: { connectionId_externalUserId: { connectionId, externalUserId } },
      select: { userId: true, connection: { select: { accountId: true, status: true } } },
    });
    if (!row?.userId || row.connection.status !== IntegrationConnectionStatus.ACTIVE) return null;
    return (await this.isParticipant(row.userId, row.connection.accountId)) ? row.userId : null;
  }

  /** Strict: an AccountMember row. Used where the app trusts the link without the person proving anything (auto-match, admin mapping). */
  async isAccountMember(userId: string, accountId: string): Promise<boolean> {
    return (await this.prisma.accountMember.count({ where: { accountId, userId } })) > 0;
  }

  async isParticipant(userId: string, accountId: string): Promise<boolean> {
    const [m, c, p] = await Promise.all([
      this.prisma.accountMember.count({ where: { accountId, userId } }),
      this.prisma.workspaceCollaborator.count({ where: { invitedUserId: userId, workspace: { accountId } } }),
      this.prisma.projectMember.count({ where: { userId, project: { workspace: { accountId } } } }),
    ]);
    return m + c + p > 0;
  }

  private async assertAdmin(connectionId: string, actorId: string) {
    const conn = await this.prisma.integrationConnection.findUnique({
      where: { id: connectionId },
      select: { id: true, accountId: true, provider: true, status: true },
    });
    if (!conn) throw new NotFoundException('Connection not found');
    const ok = await this.resolver.resolve(actorId, 'manageIntegrations', 'ACCOUNT', conn.accountId);
    if (!ok.allowed) throw new ForbiddenException(ok.reason ?? 'Not allowed');
    return conn;
  }

  /**
   * `onlyIfFree`: never overwrite a link that already belongs to a DIFFERENT user (null when it does).
   * Race-safe: a concurrent create hits the unique key, we re-read and decide on the winner.
   */
  private async upsertLink(
    connectionId: string,
    externalUserId: string,
    userId: string,
    method: IdentityLinkMethod,
    externalEmail: string | null,
    opts: { onlyIfFree: boolean },
  ) {
    const key = { connectionId_externalUserId: { connectionId, externalUserId } };
    for (let attempt = 0; attempt < 2; attempt++) {
      const cur = await this.prisma.identityLink.findUnique({ where: key });
      if (!cur) {
        try {
          return await this.prisma.identityLink.create({
            data: { connectionId, externalUserId, userId, method, externalEmail },
          });
        } catch (e) {
          if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') continue;
          throw e;
        }
      }
      if (cur.userId && cur.userId !== userId && opts.onlyIfFree) return null;
      // Same user re-linking keeps the stronger method (never downgrade OAUTH_LINK / MANUAL to AUTO_EMAIL).
      const keep = cur.userId === userId && method === 'AUTO_EMAIL' ? cur.method : method;
      return this.prisma.identityLink.update({
        where: key,
        data: { userId, method: keep, externalEmail: externalEmail ?? cur.externalEmail },
      });
    }
    return null;
  }

  private async auditLink(
    action: AuditAction,
    actorId: string,
    conn: { id: string; accountId: string; provider: IntegrationProvider },
    externalUserId: string,
    method: IdentityLinkMethod | undefined,
    linkedUserId?: string,
  ) {
    await this.audit.record({
      actorId,
      accountId: conn.accountId,
      action,
      metadata: { connectionId: conn.id, provider: conn.provider, externalUserId, method, linkedUserId },
    });
  }

  private toDto(r: IdentityLinkDto): IdentityLinkDto {
    const { id, connectionId, externalUserId, externalEmail, userId, method, createdAt } = r;
    return { id, connectionId, externalUserId, externalEmail, userId, method, createdAt };
  }
}
