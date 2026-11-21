import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AccountType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogService } from '../../events/audit-log.service';
import { CreateTeamDto } from './dto/create-team.dto';
import { UpdateTeamDto } from './dto/update-team.dto';
import { UserEntity } from '../../common/entities/user.entity';

@Injectable()
export class TeamsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogService: AuditLogService,
  ) {}

  async create(dto: CreateTeamDto, actorId: string) {
    const account = await this.prisma.account.findUnique({
      where: { id: dto.accountId },
    });
    if (!account || account.deletedAt) {
      throw new NotFoundException('Account not found');
    }
    // @RequireAccess enforces the permission side; Prisma can't express
    // "account.type === ORGANIZATION" as a constraint, so it's checked here.
    if (account.type !== AccountType.ORGANIZATION) {
      throw new BadRequestException(
        'Teams can only be created on ORGANIZATION accounts',
      );
    }

    const team = await this.prisma.team.create({
      data: {
        accountId: dto.accountId,
        name: dto.name,
        icon: dto.icon,
        type: dto.type,
      },
    });

    await this.auditLogService.record({
      actorId,
      action: 'TEAM_CREATED',
      accountId: dto.accountId,
      metadata: { teamId: team.id, name: team.name },
    });

    return team;
  }

  async getById(id: string) {
    const team = await this.prisma.team.findUnique({ where: { id } });
    if (!team) throw new NotFoundException('Team not found');
    return team;
  }

  async update(id: string, dto: UpdateTeamDto) {
    await this.getById(id);
    return this.prisma.team.update({ where: { id }, data: dto });
  }

  async delete(id: string): Promise<void> {
    await this.getById(id);
    await this.prisma.team.delete({ where: { id } });
  }

  async listMembers(teamId: string) {
    await this.getById(teamId);
    const rows = await this.prisma.teamMember.findMany({
      where: { teamId },
      include: { user: true },
    });
    return rows.map((r) => new UserEntity(r.user));
  }

  /**
   * VALIDATION RULE: adding a TeamMember requires the target userId to
   * ALREADY be an AccountMember of the SAME account — app-layer check,
   * 400 if not (Prisma can't express this cross-table constraint).
   * TeamMember has no own role because it always inherits from the
   * AccountMember row that must already exist.
   */
  async addMember(teamId: string, userId: string) {
    const team = await this.getById(teamId);

    const accountMember = await this.prisma.accountMember.findUnique({
      where: { accountId_userId: { accountId: team.accountId, userId } },
    });
    if (!accountMember) {
      throw new BadRequestException(
        'This user must already be a member of the account before joining a team',
      );
    }

    const existing = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId } },
    });
    if (existing) {
      throw new ConflictException('This user is already a member of this team');
    }

    return this.prisma.teamMember.create({ data: { teamId, userId } });
  }

  async removeMember(teamId: string, userId: string): Promise<void> {
    await this.prisma.teamMember
      .delete({ where: { teamId_userId: { teamId, userId } } })
      .catch(() => {
        throw new NotFoundException('This user is not a member of this team');
      });
  }
}
