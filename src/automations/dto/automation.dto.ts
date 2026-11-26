import { Transform, Type } from 'class-transformer';
import { AutomationRunStatus } from '@prisma/client';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { KeepRaw } from '../../common/dto/keep-raw';
import { TRIGGER_TYPES } from '../dsl';

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const bool = ({ value }: { value: unknown }) =>
  value === 'true' ? true : value === 'false' ? false : value;

/**
 * The rule parts are plain JSON on purpose: the DSL validator (src/automations/dsl) is the one place
 * that knows what a rule looks like, and it answers with paths and codes a form can show.
 */
export class CreateAutomationDto {
  @IsString()
  @MaxLength(400)
  name: string;

  /** Omitted = the whole workspace. Fixed for the life of the rule (statuses are per project). */
  @IsOptional()
  @IsString()
  @Matches(ID)
  projectId?: string;

  /** A rule can only be switched on if it is fully valid and uses nothing this build cannot run. */
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsObject()
  trigger: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  conditions?: Record<string, unknown>;

  @KeepRaw()
  @IsArray()
  actions: unknown[];
}

export class UpdateAutomationDto {
  @IsOptional()
  @IsString()
  @MaxLength(400)
  name?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsObject()
  trigger?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  conditions?: Record<string, unknown>;

  @IsOptional()
  @KeepRaw()
  @IsArray()
  actions?: unknown[];
}

/** Dry run for the rule editor: nothing is stored. */
export class ValidateAutomationDto {
  @IsOptional()
  @IsString()
  @Matches(ID)
  projectId?: string;

  @IsObject()
  trigger: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  conditions?: Record<string, unknown>;

  @KeepRaw()
  @IsArray()
  actions: unknown[];
}

export class ListAutomationsQueryDto {
  @IsOptional()
  @IsString()
  @Matches(ID)
  projectId?: string;

  @IsOptional()
  @Transform(bool)
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsIn([...TRIGGER_TYPES, 'RAW'])
  triggerType?: string;
}

export class ListRunsQueryDto {
  @IsOptional()
  @IsEnum(AutomationRunStatus)
  status?: AutomationRunStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
