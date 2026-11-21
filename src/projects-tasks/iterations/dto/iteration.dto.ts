import { Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
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
