import { IsEnum, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { IssueTypeLevel } from '@prisma/client';

const HEX = /^#[0-9a-fA-F]{6}$/;

export class CreateIssueTypeDto {
  @IsString()
  @MaxLength(200)
  name: string;

  /** Free text (an emoji or an icon key); the client decides what it means. */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  icon?: string;

  @IsOptional()
  @Matches(HEX, { message: 'color must be a #RRGGBB hex colour' })
  color?: string;

  @IsOptional()
  @IsEnum(IssueTypeLevel)
  level?: IssueTypeLevel;
}

export class UpdateIssueTypeDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  /** null clears it. */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  icon?: string | null;

  @IsOptional()
  @Matches(HEX, { message: 'color must be a #RRGGBB hex colour' })
  color?: string;

  @IsOptional()
  @IsEnum(IssueTypeLevel)
  level?: IssueTypeLevel;
}
