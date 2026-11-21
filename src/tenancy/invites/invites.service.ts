import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AccountType, InviteTargetType, Role } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogService } from '../../events/audit-log.service';
import { PermissionResolver } from '../../access-control/access-control.service';
import { ActionName } from '../../access-control/interfaces/access-control.types';
import { PlanLimitExceededException } from '../../common/exceptions/plan-limit-exceeded.exception';
import { CreateInviteDto } from './dto/create-invite.dto';

@Injectable()
export class InvitesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissionResolver: PermissionResolver,
    private readonly auditLogService: AuditLogService,
  ) {}

  async create(dto: CreateInviteDto, inviterId: string) {
    await this.assertCanManageTarget(inviterId, dto.targetType, dto.targetId);

    if (
      dto.targetType === InviteTargetType.WORKSPACE &&
      !dto.collaboratorRole
    ) {
      throw new BadRequestException(
        'collaboratorRole is required for WORKSPACE-target invites',
      );
    }
    if (dto.targetType !== InviteTargetType.WORKSPACE && !dto.role) {
      throw new BadRequestException('role is required for this targetType');
    }

    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = this.hashToken(rawToken);

    const invite = await this.prisma.invite.create({
      data: {
        tokenHash,
        email: dto.email,
        targetType: dto.targetType,
        targetId: dto.targetId,
        // Placeholder for WORKSPACE targets — Invite.role is a required
        // column but unused when collaboratorRole is the authoritative
        // field (Role/CollaboratorRole are different enums; see schema
        // comment on Invite.collaboratorRole).
        role:
          dto.targetType === InviteTargetType.WORKSPACE
            ? Role.VIEWER
            : (dto.role as Role),
        collaboratorRole:
          dto.targetType === InviteTargetType.WORKSPACE
            ? dto.collaboratorRole
            : null,
        inviterId,
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : undefined,
        maxUses: dto.maxUses,
        isPublic: dto.isPublic ?? false,
      },
    });

    // Raw token is returned ONLY here, at creation time — never again
    // (only tokenHash is persisted, same pattern as RefreshToken).
    return { ...invite, token: rawToken };
  }

  async findPendingForEmail(email: string, requesterEmail: string) {
    if (email !== requesterEmail) {
      throw new ForbiddenException(
        'You can only view invites pending for your own email address',
      );
    }

    return this.prisma.invite.findMany({
      where: {
        email,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Public, pre-accept check — no auth required. Never exposes tokenHash. */
  async validateByToken(token: string) {
    const invite = await this.findActiveByToken(token);
    return {
      targetType: invite.targetType,
      targetId: invite.targetId,
      role:
        invite.targetType === InviteTargetType.WORKSPACE
          ? undefined
          : invite.role,
      collaboratorRole: invite.collaboratorRole ?? undefined,
      expiresAt: invite.expiresAt,
      isPublic: invite.isPublic,
    };
  }

  /**
   * Accept logic branches on targetType:
   *   ACCOUNT   -> creates AccountMember (the ONLY way to become one)
   *   WORKSPACE -> creates WorkspaceCollaborator (personal) or
   *                WorkspaceGuest (org), based on the target account's type
   *   TEAM      -> creates TeamMember (rejects if not already an
   *                AccountMember — same prereq rule as direct add)
   *   PROJECT   -> creates ProjectMember (Project/Task module owns this
   *                table; Invite just triggers the write)
   */
  async accept(token: string, userId: string) {
    const invite = await this.findActiveByToken(token);

    if (invite.email && invite.email !== (await this.getUserEmail(userId))) {
      throw new ForbiddenException(
        'This invite was issued to a different email address',
      );
    }

    switch (invite.targetType) {
      case InviteTargetType.ACCOUNT: {
        const existing = await this.prisma.accountMember.findUnique({
          where: { accountId_userId: { accountId: invite.targetId, userId } },
        });
        if (existing)
          throw new ConflictException(
            'You are already a member of this account',
          );
        await this.prisma.accountMember.create({
          data: { accountId: invite.targetId, userId, role: invite.role },
        });
        await this.auditLogService.record({
          actorId: invite.inviterId,
          action: 'MEMBER_ADDED',
          accountId: invite.targetId,
          metadata: {
            newUserId: userId,
            role: invite.role,
            viaInviteId: invite.id,
          },
        });
        break;
      }

      case InviteTargetType.WORKSPACE: {
        const workspace = await this.prisma.workspace.findUnique({
          where: { id: invite.targetId },
          select: { id: true, account: { select: { type: true } } },
        });
        if (!workspace)
          throw new NotFoundException('Workspace no longer exists');
        if (!invite.collaboratorRole) {
          throw new BadRequestException(
            'This invite is missing a collaboratorRole and cannot be accepted',
          );
        }

        if (workspace.account.type === AccountType.PERSONAL) {
          const existing = await this.prisma.workspaceCollaborator.findUnique({
            where: {
              workspaceId_invitedUserId: {
                workspaceId: invite.targetId,
                invitedUserId: userId,
              },
            },
          });
          if (existing)
            throw new ConflictException(
              'You are already a collaborator on this workspace',
            );
          await this.prisma.workspaceCollaborator.create({
            data: {
              workspaceId: invite.targetId,
              invitedUserId: userId,
              role: invite.collaboratorRole,
              acceptedAt: new Date(),
            },
          });
        } else {
          const existing = await this.prisma.workspaceGuest.findUnique({
            where: {
              workspaceId_invitedUserId: {
                workspaceId: invite.targetId,
                invitedUserId: userId,
              },
            },
          });
          if (existing)
            throw new ConflictException(
              'You are already a guest on this workspace',
            );
          await this.prisma.workspaceGuest.create({
            data: {
              workspaceId: invite.targetId,
              invitedUserId: userId,
              role: invite.collaboratorRole,
              acceptedAt: new Date(),
            },
          });
        }
        break;
      }

      case InviteTargetType.TEAM: {
        const team = await this.prisma.team.findUnique({
          where: { id: invite.targetId },
        });
        if (!team) throw new NotFoundException('Team no longer exists');

        // Same PREREQ_RULE as direct add: target user must already be an
        // AccountMember of the same account.
        const accountMember = await this.prisma.accountMember.findUnique({
          where: { accountId_userId: { accountId: team.accountId, userId } },
        });
        if (!accountMember) {
          throw new BadRequestException(
            'You must already be a member of this account before joining this team',
          );
        }

        const existing = await this.prisma.teamMember.findUnique({
          where: { teamId_userId: { teamId: invite.targetId, userId } },
        });
        if (existing)
          throw new ConflictException('You are already a member of this team');
        await this.prisma.teamMember.create({
          data: { teamId: invite.targetId, userId },
        });
        break;
      }

      case InviteTargetType.PROJECT: {
        const project = await this.prisma.project.findUnique({
          where: { id: invite.targetId },
        });
        if (!project) throw new NotFoundException('Project no longer exists');

        const existing = await this.prisma.projectMember.findUnique({
          where: { projectId_userId: { projectId: invite.targetId, userId } },
        });
        if (existing)
          throw new ConflictException(
            'You are already a member of this project',
          );
        await this.prisma.projectMember.create({
          data: { projectId: invite.targetId, userId, role: invite.role },
        });
        break;
      }
    }

    await this.prisma.invite.update({
      where: { id: invite.id },
      data: { usesCount: { increment: 1 } },
    });

    return {
      accepted: true,
      targetType: invite.targetType,
      targetId: invite.targetId,
    };
  }

  async delete(id: string, requesterId: string): Promise<void> {
    const invite = await this.prisma.invite.findUnique({ where: { id } });
    if (!invite) throw new NotFoundException('Invite not found');

    if (invite.inviterId !== requesterId) {
      // Not the original inviter — still allow if the requester currently
      // holds sufficient permission over the target (e.g. a different
      // admin cleaning up another admin's invite).
      await this.assertCanManageTarget(
        requesterId,
        invite.targetType,
        invite.targetId,
      );
    }

    await this.prisma.invite.delete({ where: { id } });
  }

  async batchDelete(ids: string[], requesterId: string) {
    const results: Record<string, 'deleted' | 'not_found' | 'forbidden'> = {};
    for (const id of ids) {
      try {
        await this.delete(id, requesterId);
        results[id] = 'deleted';
      } catch (error) {
        if (error instanceof NotFoundException) results[id] = 'not_found';
        else if (error instanceof ForbiddenException) results[id] = 'forbidden';
        else throw error;
      }
    }
    return results;
  }

  /**
   * FIXES the confirmed old bug: a literal "// TODO: Add admin permission
   * check" meant any authenticated user could previously trigger this.
   * There's no single account this action targets (it's a global sweep),
   * so it can't route through the normal per-resource PermissionResolver
   * — instead requires the caller to be OWNER/ADMIN of at least one
   * account, or the personal owner of one. Documented deviation from the
   * standard @RequireAccess pattern, since this endpoint has no natural
   * resource target.
   */
  async cleanupExpired(requesterId: string): Promise<{ deletedCount: number }> {
    const isAnyAccountAdmin = await this.prisma.accountMember.findFirst({
      where: { userId: requesterId, role: { in: [Role.OWNER, Role.ADMIN] } },
    });
    const ownsAnAccount = await this.prisma.account.findFirst({
      where: { personalOwnerId: requesterId, deletedAt: null },
    });

    if (!isAnyAccountAdmin && !ownsAnAccount) {
      throw new ForbiddenException(
        'ADMIN-tier minimum required to run invite cleanup',
      );
    }

    const result = await this.prisma.invite.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });

    return { deletedCount: result.count };
  }

  // ---- internals ----

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private async findActiveByToken(token: string) {
    const tokenHash = this.hashToken(token);
    const invite = await this.prisma.invite.findUnique({
      where: { tokenHash },
    });
    if (!invite) throw new NotFoundException('Invite not found');

    if (invite.expiresAt && invite.expiresAt < new Date()) {
      throw new BadRequestException('This invite has expired');
    }
    if (invite.maxUses !== null && invite.usesCount >= invite.maxUses) {
      throw new BadRequestException(
        'This invite has reached its maximum number of uses',
      );
    }

    return invite;
  }

  private async getUserEmail(userId: string): Promise<string> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    if (!user) throw new NotFoundException('User not found');
    return user.email;
  }

  /**
   * Dynamic per-targetType permission check — can't be a static
   * @RequireAccess decorator because the correct action for WORKSPACE
   * targets depends on the target account's type (PERSONAL vs
   * ORGANIZATION), which is only known at request time.
   */
  private async assertCanManageTarget(
    userId: string,
    targetType: InviteTargetType,
    targetId: string,
  ): Promise<void> {
    let action: ActionName;
    const resolvedTargetType: 'ACCOUNT' | 'WORKSPACE' | 'TEAM' | 'PROJECT' =
      targetType;

    switch (targetType) {
      case InviteTargetType.ACCOUNT: {
        const account = await this.prisma.account.findUnique({
          where: { id: targetId },
        });
        if (!account || account.deletedAt)
          throw new NotFoundException('Account not found');
        action = 'inviteToAccount';
        break;
      }
      case InviteTargetType.WORKSPACE: {
        const workspace = await this.prisma.workspace.findUnique({
          where: { id: targetId },
          select: { account: { select: { type: true } } },
        });
        if (!workspace) throw new NotFoundException('Workspace not found');
        action =
          workspace.account.type === AccountType.PERSONAL
            ? 'manageWorkspaceCollaborators'
            : 'manageWorkspaceGuests';
        break;
      }
      case InviteTargetType.TEAM: {
        const team = await this.prisma.team.findUnique({
          where: { id: targetId },
        });
        if (!team) throw new NotFoundException('Team not found');
        action = 'manageTeamMembers';
        break;
      }
      case InviteTargetType.PROJECT: {
        const project = await this.prisma.project.findUnique({
          where: { id: targetId },
        });
        if (!project) throw new NotFoundException('Project not found');
        // PLACEHOLDER: the Project/Task module (not built yet) owns
        // ProjectMember and will likely want its own
        // manageProjectMembers-style action. editProject is reused for now
        // since it's the closest existing action with the right scope —
        // revisit once that module lands.
        action = 'editProject';
        break;
      }
    }

    const result = await this.permissionResolver.resolve(
      userId,
      action,
      resolvedTargetType,
      targetId,
    );
    if (!result.allowed) {
      if (result.planLimitExceeded) {
        throw new PlanLimitExceededException(
          result.reason ?? "This would exceed your plan's member limit",
        );
      }
      throw new ForbiddenException(
        result.reason ?? 'You do not have permission to invite to this target',
      );
    }
  }
}
