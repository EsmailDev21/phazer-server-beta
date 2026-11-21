import { IsEnum, IsString } from 'class-validator';
import { CollaboratorRole } from '@prisma/client';

export class AddGuestDto {
  @IsString()
  invitedUserId: string;

  @IsEnum(CollaboratorRole)
  role: CollaboratorRole;
}
