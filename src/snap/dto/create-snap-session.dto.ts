import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { SnapClauseInputDto } from './snap-clause-input.dto';

export class CreateSnapSessionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(10000)
  rawInput: string;

  @IsOptional()
  @IsString()
  workspaceId?: string;

  /**
   * Transient only — SnapSession has NO accountId column (schema:
   * "orgId DROPPED — derivable via workspace.account"). Used only during
   * this request to scope fuzzy-matching / default account resolution
   * hints; never persisted as its own field.
   */
  @IsOptional()
  @IsString()
  accountId?: string;

  /**
   * Required, explicit, no default — this is a privacy/consent gate
   * (SnapSession.consentGiven), not a formality. 400 if false or absent.
   */
  @IsBoolean()
  consentGiven: boolean;

  @IsOptional()
  @IsInt()
  dataRetentionDays?: number;

  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => SnapClauseInputDto)
  clauses: SnapClauseInputDto[];
}
