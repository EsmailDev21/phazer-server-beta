import {
  IsBoolean,
  IsDateString,
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Min,
  ValidateIf,
} from 'class-validator';
import { CollaboratorRole, InviteTargetType, Role } from '@prisma/client';

export class CreateInviteDto {
  @IsEnum(InviteTargetType)
  targetType: InviteTargetType;

  @IsString()
  targetId: string;

  // Required for ACCOUNT/TEAM/PROJECT targets. For WORKSPACE targets this
  // is ignored by the service (Role and CollaboratorRole are different
  // enums — see collaboratorRole below) but still validated as a real Role
  // if provided, since forbidNonWhitelisted only strips undeclared fields,
  // not conditionally-unused declared ones.
  @ValidateIf(
    (dto: CreateInviteDto) => dto.targetType !== InviteTargetType.WORKSPACE,
  )
  @IsEnum(Role)
  role?: Role;

  // Required ONLY for WORKSPACE targets — the authoritative role for the
  // WorkspaceCollaborator/WorkspaceGuest row created on accept. Role and
  // CollaboratorRole are genuinely different enums (only VIEWER overlaps
  // by name), so WORKSPACE invites use this field instead of `role`.
  @ValidateIf(
    (dto: CreateInviteDto) => dto.targetType === InviteTargetType.WORKSPACE,
  )
  @IsEnum(CollaboratorRole)
  collaboratorRole?: CollaboratorRole;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxUses?: number;

  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}
