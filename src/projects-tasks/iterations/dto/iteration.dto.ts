import { Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  ValidateIf,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { IterationKind, IterationState } from '@prisma/client';

export class CreateIterationDto {
  @IsEnum(IterationKind)
  kind: IterationKind;

  @IsString()
  @MaxLength(200)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  goal?: string;

  /** 'YYYY-MM-DD'. Both dates are optional (a milestone may only have a target date). */
  @IsOptional()
  @IsString()
  startDate?: string;

  @IsOptional()
  @IsString()
  endDate?: string;

  /** Omitted = the whole workspace. Fixed for the life of the iteration. */
  @IsOptional()
  @IsString()
  projectId?: string;

  /** Settings of this kind (ADR-0043). Checked per kind in iteration-kinds.ts; unknown keys are a 400. */
  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;
}

export class UpdateIterationDto {
  @IsOptional()
  @IsEnum(IterationKind)
  kind?: IterationKind;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  /** null clears. */
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  goal?: string | null;

  @IsOptional()
  @IsString()
  startDate?: string | null;

  @IsOptional()
  @IsString()
  endDate?: string | null;

  /**
   * Replaces the whole config (no merge). null clears it. Omitted = unchanged, except that
   * changing `kind` keeps only the settings that still fit the new kind.
   */
  @IsOptional()
  @IsObject()
  config?: Record<string, unknown> | null;
}

export class SetRetroDto {
  /** The retro note. null or empty clears it. At most 4000 characters (checked with the rest of the config). */
  @ValidateIf((_, v) => v !== null)
  @IsString()
  retro!: string | null;
}

export class CreateCriterionDto {
  /** What must be true. Optional when `taskId` is given: the task's title is used. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  /** Tie the criterion to a task: it is met while that task is done. */
  @IsOptional()
  @IsString()
  taskId?: string;
}

export class UpdateCriterionDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  /** Check or uncheck a plain criterion. A criterion tied to a task follows the task (400). */
  @IsOptional()
  @IsBoolean()
  done?: boolean;
}

export class CloseIterationDto {
  /** Required when any task is not done. Done tasks always stay. */
  @IsOptional()
  @IsIn(['LEAVE', 'MOVE', 'BACKLOG'])
  action?: 'LEAVE' | 'MOVE' | 'BACKLOG';

  @IsOptional()
  @IsString()
  moveToIterationId?: string;
}

export class ListIterationsQueryDto {
  @IsOptional()
  @IsString()
  projectId?: string;

  @IsOptional()
  @IsEnum(IterationState)
  state?: IterationState;

  @IsOptional()
  @IsEnum(IterationKind)
  kind?: IterationKind;
}

export class CurrentIterationsQueryDto {
  /** Narrow to what applies to one project: its own iterations plus workspace-wide ones. */
  @IsOptional()
  @IsString()
  projectId?: string;
}

export const VELOCITY_DEFAULT_LIMIT = 6;
export const VELOCITY_MAX_LIMIT = 50;

export class VelocityQueryDto {
  @IsOptional()
  @IsString()
  projectId?: string;

  /** One kind, or ALL. Default SPRINT. */
  @IsOptional()
  @IsIn(['SPRINT', 'CYCLE', 'MILESTONE', 'ALL'])
  kind?: 'SPRINT' | 'CYCLE' | 'MILESTONE' | 'ALL';

  /** Default CLOSED (a closed iteration's numbers are a snapshot taken when it closed). */
  @IsOptional()
  @IsEnum(IterationState)
  state?: IterationState;

  /** How many most-recent iterations. Default 6, max 50. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(VELOCITY_MAX_LIMIT)
  limit?: number;
}
