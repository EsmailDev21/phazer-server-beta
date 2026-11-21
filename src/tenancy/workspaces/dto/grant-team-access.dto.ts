import { IsEnum } from 'class-validator';
import { Role } from '@prisma/client';

export class GrantTeamAccessDto {
  @IsEnum(Role)
  role: Role;
}
