import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Account, AccountType, Role } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogService } from '../../events/audit-log.service';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { UpdateAccountDto } from './dto/update-account.dto';
import { DeleteAccountDto } from './dto/delete-account.dto';
import { ChangeMemberRoleDto } from './dto/change-member-role.dto';
import { CreateOrganizationAccountDto } from './dto/create-organization-account.dto';
import { UserEntity } from '../../common/entities/user.entity';

/** Grace period between soft-delete (`deletedAt` set) and hard purge. */
export const ACCOUNT_PURGE_GRACE_DAYS = 30;

@Injectable()
export class AccountsService {
  private readonly logger = new Logger(AccountsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogService: AuditLogService,
  ) {}

  /**
   * MISSING from the original pass: nothing created an ORGANIZATION
   * account anywhere (PERSONAL accounts are now auto-created at
   * registration — see AuthService.register — but that's a 1:1 user
   * relationship via personalOwnerId, not applicable to orgs). Any
   * authenticated user can start a new organization; no permission check
   * against an existing resource since there isn't one yet — the creator
   * becomes its OWNER via AccountMember.
   */
  async createOrganization(
    dto: CreateOrganizationAccountDto,
    creatorId: string,
  ) {
    const account = await this.prisma.account.create({
      data: {
        type: 'ORGANIZATION',
        planType: 'FREE_ORG',
        organization: { create: { name: dto.name, logo: dto.logo } },
        members: { create: { userId: creatorId, role: Role.OWNER } },
      },
      include: { organization: true },
    });

    return account;
  }

  /**
   * GET /me/accounts — every Account the user belongs to: AccountMember
   * rows + the PERSONAL account they own outright (personalOwnerId).
   * Powers the account switcher and the CLIENT-tier restricted-nav
   * detection (a user who is ONLY a ProjectMember/CLIENT somewhere has no
   * entries here at all — by design, since ProjectMember/CLIENT never
   * implies an Account-level relationship).
   */
  async listMyAccounts(userId: string) {
    const [memberships, ownedAccount] = await Promise.all([
      this.prisma.accountMember.findMany({
        where: { userId, account: { deletedAt: null } },
        select: {
          role: true,
          joinedAt: true,
          account: { include: { organization: true } },
        },
      }),
      this.prisma.account.findUnique({
        where: { personalOwnerId: userId, deletedAt: null },
        include: { organization: true },
      }),
    ]);

    const results = memberships.map((m) => ({
      account: m.account,
      role: m.role,
      joinedAt: m.joinedAt,
    }));

    // Owned personal account might not have an AccountMember row at all —
    // include it separately, deduped by id, with an implicit OWNER role.
    if (
      ownedAccount &&
      !results.some((r) => r.account.id === ownedAccount.id)
    ) {
      results.push({
        account: ownedAccount,
        role: Role.OWNER,
        joinedAt: ownedAccount.createdAt,
      });
    }

    return results;
  }

  async findActiveOrThrow(accountId: string): Promise<Account> {
    const account = await this.prisma.account.findUnique({
      where: { id: accountId },
    });
    if (!account || account.deletedAt) {
      throw new NotFoundException('Account not found');
    }
    return account;
  }

  async getById(accountId: string) {
    const account = await this.prisma.account.findUnique({
      where: { id: accountId },
      include: { organization: true },
    });
    if (!account || account.deletedAt) {
      throw new NotFoundException('Account not found');
    }
    return account;
  }

  /**
   * SIMPLIFICATION (no separate OrganizationController): folds into this
   * one PATCH. name/logo only apply when account.type === ORGANIZATION —
   * validated here since Prisma/the DTO can't express that conditional.
   */
  async update(accountId: string, dto: UpdateAccountDto, actorId: string) {
    const account = await this.findActiveOrThrow(accountId);

    if (
      (dto.name !== undefined || dto.logo !== undefined) &&
      account.type !== AccountType.ORGANIZATION
    ) {
      throw new BadRequestException(
        'name/logo can only be set on ORGANIZATION accounts',
      );
    }

    if (
      account.type === AccountType.ORGANIZATION &&
      (dto.name !== undefined || dto.logo !== undefined)
    ) {
      await this.prisma.organization.upsert({
        where: { accountId },
        update: {
          ...(dto.name !== undefined && { name: dto.name }),
          ...(dto.logo !== undefined && { logo: dto.logo }),
        },
        create: {
          accountId,
          name: dto.name ?? 'Untitled Organization',
          logo: dto.logo,
        },
      });
      await this.auditLogService.record({
        actorId,
        action: 'ACCOUNT_SETTINGS_CHANGED',
        accountId,
        metadata: { fields: Object.keys(dto) },
      });
    }

    return this.getById(accountId);
  }

  /**
   * Soft delete: sets deletedAt. `purgeExpiredSoftDeletes` (step 0.3, run
   * as a repeatable `system` queue job — see `account-purge.job.ts`)
   * hard-deletes after the `ACCOUNT_PURGE_GRACE_DAYS`-day grace period.
   * confirmName must match the account's display name (or its raw id, for
   * PERSONAL accounts which have no display name) exactly — no accidental
   * single-click delete.
   */
  async delete(accountId: string, dto: DeleteAccountDto): Promise<void> {
    const account = await this.getById(accountId);

    const expectedName =
      account.type === AccountType.ORGANIZATION
        ? account.organization?.name
        : undefined;
    const validConfirmations = [expectedName, account.id].filter(
      (v): v is string => !!v,
    );

    if (!validConfirmations.includes(dto.confirmName)) {
      throw new BadRequestException('confirmName does not match this account');
    }

    await this.prisma.account.update({
      where: { id: accountId },
      data: { deletedAt: new Date() },
    });
  }

  async listMembers(accountId: string, pagination: PaginationDto) {
    await this.findActiveOrThrow(accountId);

    const [members, total] = await Promise.all([
      this.prisma.accountMember.findMany({
        where: { accountId },
        include: { user: true },
        take: pagination.take,
        skip: pagination.skip,
        orderBy: { joinedAt: 'asc' },
      }),
      this.prisma.accountMember.count({ where: { accountId } }),
    ]);

    return {
      data: members.map((m) => ({
        role: m.role,
        joinedAt: m.joinedAt,
        user: new UserEntity(m.user),
      })),
      total,
      take: pagination.take,
      skip: pagination.skip,
    };
  }

  async changeMemberRole(
    accountId: string,
    targetUserId: string,
    dto: ChangeMemberRoleDto,
    requesterId: string,
  ) {
    await this.findActiveOrThrow(accountId);

    const member = await this.prisma.accountMember.findUnique({
      where: { accountId_userId: { accountId, userId: targetUserId } },
    });
    if (!member) {
      throw new NotFoundException('This user is not a member of the account');
    }

    if (targetUserId === requesterId && dto.role !== Role.OWNER) {
      const account = await this.findActiveOrThrow(accountId);
      if (account.personalOwnerId === requesterId) {
        throw new ForbiddenException(
          'The account owner cannot demote themselves',
        );
      }
    }

    const updated = await this.prisma.accountMember.update({
      where: { accountId_userId: { accountId, userId: targetUserId } },
      data: { role: dto.role },
    });

    await this.auditLogService.record({
      actorId: requesterId,
      action: 'ROLE_CHANGED',
      accountId,
      metadata: { targetUserId, fromRole: member.role, toRole: dto.role },
    });

    return updated;
  }

  async removeMember(
    accountId: string,
    targetUserId: string,
    requesterId: string,
  ) {
    const account = await this.findActiveOrThrow(accountId);

    if (account.personalOwnerId === targetUserId) {
      throw new ForbiddenException('The account owner cannot be removed');
    }

    const member = await this.prisma.accountMember.findUnique({
      where: { accountId_userId: { accountId, userId: targetUserId } },
    });
    if (!member) {
      throw new NotFoundException('This user is not a member of the account');
    }

    await this.prisma.accountMember.delete({
      where: { accountId_userId: { accountId, userId: targetUserId } },
    });

    await this.auditLogService.record({
      actorId: requesterId,
      action: 'MEMBER_REMOVED',
      accountId,
      metadata: { targetUserId },
    });
  }

  async listWorkspaces(accountId: string, pagination: PaginationDto) {
    await this.findActiveOrThrow(accountId);
    const [data, total] = await Promise.all([
      this.prisma.workspace.findMany({
        where: { accountId },
        take: pagination.take,
        skip: pagination.skip,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.workspace.count({ where: { accountId } }),
    ]);
    return { data, total, take: pagination.take, skip: pagination.skip };
  }

  async listTeams(accountId: string, pagination: PaginationDto) {
    const account = await this.findActiveOrThrow(accountId);
    if (account.type !== AccountType.ORGANIZATION) {
      throw new BadRequestException(
        'Teams only exist on ORGANIZATION accounts',
      );
    }
    const [data, total] = await Promise.all([
      this.prisma.team.findMany({
        where: { accountId },
        take: pagination.take,
        skip: pagination.skip,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.team.count({ where: { accountId } }),
    ]);
    return { data, total, take: pagination.take, skip: pagination.skip };
  }

  async listAuditLog(accountId: string, pagination: PaginationDto) {
    await this.findActiveOrThrow(accountId);
    const [data, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where: { accountId },
        take: pagination.take,
        skip: pagination.skip,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.auditLog.count({ where: { accountId } }),
    ]);
    return { data, total, take: pagination.take, skip: pagination.skip };
  }

  /**
   * Accounts past the soft-delete grace period, oldest first. Read-only —
   * `account-purge.job.ts` (step 0.3) orchestrates the actual purge across
   * this, BillingService and AttachmentsService, since those two live in
   * separate modules and this service intentionally stays independent of
   * both (see TenancyModule / avoiding a circular import with
   * BillingModule).
   */
  async listExpiredSoftDeletes(
    graceDays: number = ACCOUNT_PURGE_GRACE_DAYS,
  ): Promise<Pick<Account, 'id'>[]> {
    const cutoff = new Date(Date.now() - graceDays * 24 * 60 * 60 * 1000);
    return this.prisma.account.findMany({
      where: { deletedAt: { not: null, lte: cutoff } },
      select: { id: true },
      orderBy: { deletedAt: 'asc' },
    });
  }

  /**
   * Hard-deletes one account row. Every other account-scoped model has an
   * `onDelete: Cascade` FK to `Account` (directly, or transitively through
   * `Workspace`/`Team`), so this one delete removes workspaces, projects,
   * tasks, members, payments, invoices, usage metrics and audit logs with
   * it — confirmed against `prisma/schema.prisma`, not assumed. The ONE
   * exception is `Attachment.accountId`, which is a deliberately
   * denormalized column with no FK relation (storage objects need an
   * explicit delete, not a silent cascade) — the caller (the purge job)
   * is expected to have purged those first via
   * `AttachmentsService.purgeAllForAccount`.
   *
   * Idempotent: an already-purged (or never-existing) id is a silent
   * no-op, not an error — safe for BullMQ's at-least-once redelivery.
   */
  async hardDelete(accountId: string): Promise<void> {
    try {
      await this.prisma.account.delete({ where: { id: accountId } });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'P2025') return; // already gone — fine, not an error
      throw error;
    }
  }
}
