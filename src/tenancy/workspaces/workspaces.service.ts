import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AccountType, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateWorkspaceDto } from './dto/create-workspace.dto';
import { UpdateWorkspaceDto } from './dto/update-workspace.dto';
import { AddCollaboratorDto } from './dto/add-collaborator.dto';
import { AddGuestDto } from './dto/add-guest.dto';
import { GrantTeamAccessDto } from './dto/grant-team-access.dto';
import { UserEntity } from '../../common/entities/user.entity';
import { WorkspaceKeysService } from './workspace-keys.service';

@Injectable()
export class WorkspacesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly keys: WorkspaceKeysService,
  ) {}

  async create(dto: CreateWorkspaceDto) {
    const account = await this.prisma.account.findUnique({
      where: { id: dto.accountId },
    });
    if (!account || account.deletedAt) {
      throw new NotFoundException('Account not found');
    }

    // The key is chosen and the row inserted in ONE transaction under the
    // account's key lock, so two simultaneous creates cannot pick the same key.
    try {
      return await this.prisma.$transaction(async (tx) => {
        const key = await this.keys.allocateKey(
          tx,
          dto.accountId,
          dto.name,
          dto.key,
        );
        return tx.workspace.create({
          data: {
            accountId: dto.accountId,
            name: dto.name,
            description: dto.description,
            key,
          },
        });
      });
    } catch (err) {
      // The lock makes this unreachable in practice; the unique index is the
      // backstop, and a clear 409 beats a 500 if it is ever hit.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException(
          'That workspace key is already in use in this account',
        );
      }
      throw err;
    }
  }

  async getById(id: string) {
    const workspace = await this.prisma.workspace.findUnique({ where: { id } });
    if (!workspace) throw new NotFoundException('Workspace not found');
    return workspace;
  }

  async update(id: string, dto: UpdateWorkspaceDto) {
    await this.getById(id);
    return this.prisma.workspace.update({ where: { id }, data: dto });
  }

  async delete(id: string): Promise<void> {
    await this.getById(id);
    // CONFIRMS schema-phase decision: Workspace.accountId is the only
    // ownership path. Cascade delete of projects/tasks/etc. is handled by
    // the Prisma-level onDelete: Cascade chain from Workspace downward.
    await this.prisma.workspace.delete({ where: { id } });
  }

  /**
   * RESOLVED, deduplicated list of every user with ANY access tier to this
   * workspace: AccountMember baseline (Tier3) UNION WorkspaceTeamAccess-
   * granted team members (Tier2/org) UNION WorkspaceCollaborator (Tier2/
   * personal) UNION WorkspaceGuest (Tier2/org). No existing query unions
   * all tiers — built specifically for @-mention autocomplete and any
   * "who can see this workspace" UI need.
   */
  async listMembers(workspaceId: string) {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: {
        id: true,
        accountId: true,
        account: { select: { type: true } },
      },
    });
    if (!workspace) throw new NotFoundException('Workspace not found');

    const [accountMembers, teamAccessRows, collaborators, guests] =
      await Promise.all([
        this.prisma.accountMember.findMany({
          where: { accountId: workspace.accountId },
          select: { user: true, role: true },
        }),
        this.prisma.workspaceTeamAccess.findMany({
          where: { workspaceId },
          select: {
            role: true,
            team: { select: { members: { select: { user: true } } } },
          },
        }),
        this.prisma.workspaceCollaborator.findMany({
          where: { workspaceId },
          select: { invitedUser: true, role: true },
        }),
        this.prisma.workspaceGuest.findMany({
          where: { workspaceId },
          select: { invitedUser: true, role: true },
        }),
      ]);

    const byUserId = new Map<string, { user: UserEntity; sources: string[] }>();

    const add = (
      user: (typeof accountMembers)[number]['user'],
      source: string,
    ) => {
      const existing = byUserId.get(user.id);
      if (existing) {
        existing.sources.push(source);
      } else {
        byUserId.set(user.id, {
          user: new UserEntity(user),
          sources: [source],
        });
      }
    };

    for (const m of accountMembers) add(m.user, `account:${m.role}`);
    for (const t of teamAccessRows) {
      for (const tm of t.team.members) add(tm.user, `team:${t.role}`);
    }
    for (const c of collaborators) add(c.invitedUser, `collaborator:${c.role}`);
    for (const g of guests) add(g.invitedUser, `guest:${g.role}`);

    return Array.from(byUserId.values());
  }

  // ---- Collaborators (PERSONAL accounts only) ----

  async listCollaborators(workspaceId: string) {
    await this.assertAccountType(
      workspaceId,
      AccountType.PERSONAL,
      'collaborators',
    );
    const rows = await this.prisma.workspaceCollaborator.findMany({
      where: { workspaceId },
      include: { invitedUser: true },
    });
    return rows.map((r) => ({
      ...r,
      invitedUser: new UserEntity(r.invitedUser),
    }));
  }

  async addCollaborator(workspaceId: string, dto: AddCollaboratorDto) {
    await this.assertAccountType(
      workspaceId,
      AccountType.PERSONAL,
      'collaborators',
    );

    const existing = await this.prisma.workspaceCollaborator.findUnique({
      where: {
        workspaceId_invitedUserId: {
          workspaceId,
          invitedUserId: dto.invitedUserId,
        },
      },
    });
    if (existing) {
      throw new ConflictException(
        'This user is already a collaborator on this workspace',
      );
    }

    // isFreeSlot / Account.seatsUsed counting is Billing module territory
    // (deferred per the graph) — defaults to true (free slot) here.
    return this.prisma.workspaceCollaborator.create({
      data: {
        workspaceId,
        invitedUserId: dto.invitedUserId,
        role: dto.role,
        acceptedAt: new Date(),
      },
    });
  }

  async removeCollaborator(workspaceId: string, userId: string): Promise<void> {
    await this.assertAccountType(
      workspaceId,
      AccountType.PERSONAL,
      'collaborators',
    );
    await this.prisma.workspaceCollaborator
      .delete({
        where: {
          workspaceId_invitedUserId: { workspaceId, invitedUserId: userId },
        },
      })
      .catch(() => {
        throw new NotFoundException(
          'This user is not a collaborator on this workspace',
        );
      });
  }

  // ---- Guests (ORGANIZATION accounts only) ----

  async listGuests(workspaceId: string) {
    await this.assertAccountType(
      workspaceId,
      AccountType.ORGANIZATION,
      'guests',
    );
    const rows = await this.prisma.workspaceGuest.findMany({
      where: { workspaceId },
      include: { invitedUser: true },
    });
    return rows.map((r) => ({
      ...r,
      invitedUser: new UserEntity(r.invitedUser),
    }));
  }

  async addGuest(workspaceId: string, dto: AddGuestDto) {
    await this.assertAccountType(
      workspaceId,
      AccountType.ORGANIZATION,
      'guests',
    );

    const existing = await this.prisma.workspaceGuest.findUnique({
      where: {
        workspaceId_invitedUserId: {
          workspaceId,
          invitedUserId: dto.invitedUserId,
        },
      },
    });
    if (existing) {
      throw new ConflictException(
        'This user is already a guest on this workspace',
      );
    }

    return this.prisma.workspaceGuest.create({
      data: {
        workspaceId,
        invitedUserId: dto.invitedUserId,
        role: dto.role,
        acceptedAt: new Date(),
      },
    });
  }

  async removeGuest(workspaceId: string, userId: string): Promise<void> {
    await this.assertAccountType(
      workspaceId,
      AccountType.ORGANIZATION,
      'guests',
    );
    await this.prisma.workspaceGuest
      .delete({
        where: {
          workspaceId_invitedUserId: { workspaceId, invitedUserId: userId },
        },
      })
      .catch(() => {
        throw new NotFoundException(
          'This user is not a guest on this workspace',
        );
      });
  }

  // ---- Team access (GitHub-Teams-style: the grant carries its OWN role) ----

  async grantTeamAccess(
    workspaceId: string,
    teamId: string,
    dto: GrantTeamAccessDto,
  ) {
    const workspace = await this.getById(workspaceId);
    const team = await this.prisma.team.findUnique({ where: { id: teamId } });
    if (!team) throw new NotFoundException('Team not found');
    if (team.accountId !== workspace.accountId) {
      throw new BadRequestException(
        'This team does not belong to the same account as the workspace',
      );
    }

    return this.prisma.workspaceTeamAccess.upsert({
      where: { workspaceId_teamId: { workspaceId, teamId } },
      update: { role: dto.role },
      create: { workspaceId, teamId, role: dto.role },
    });
  }

  async revokeTeamAccess(workspaceId: string, teamId: string): Promise<void> {
    await this.prisma.workspaceTeamAccess
      .delete({ where: { workspaceId_teamId: { workspaceId, teamId } } })
      .catch(() => {
        throw new NotFoundException(
          'This team does not have access to this workspace',
        );
      });
  }

  // ---- internals ----

  private async assertAccountType(
    workspaceId: string,
    expected: AccountType,
    feature: string,
  ) {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { account: { select: { type: true } } },
    });
    if (!workspace) throw new NotFoundException('Workspace not found');
    if (workspace.account.type !== expected) {
      throw new BadRequestException(
        `Workspace ${feature} only apply to ${expected} accounts`,
      );
    }
  }
}
