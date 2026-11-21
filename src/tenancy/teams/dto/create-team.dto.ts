import {
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { TeamIcon } from '@prisma/client';

export class CreateTeamDto {
  @IsString()
  accountId: string;

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name: string;

  @IsOptional()
  @IsEnum(TeamIcon)
  icon?: TeamIcon;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  type?: string;
}
