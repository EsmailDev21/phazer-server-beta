import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
} from 'class-validator';
import { SnapActionType } from '@prisma/client';

/**
 * Shape of ONE clause as submitted by the frontend, which already ran
 * the real M1(segment)/M2(classify)/M3(extract) pipeline in a separate,
 * real-time-facing project — this backend does not compute any of these
 * fields itself, only validates and persists them, then does the parts
 * that genuinely need live app-database access (fuzzy-matching entity
 * references against real tasks/members — see SnapSessionsService).
 */
export class SnapClauseInputDto {
  @IsString()
  @MinLength(1)
  text: string;

  @IsInt()
  @Min(0)
  charStart: number;

  @IsInt()
  @Min(0)
  charEnd: number;

  @IsOptional()
  @Min(0)
  @Max(1)
  m1Confidence?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  m1TimeMs?: number;

  @IsOptional()
  @IsEnum(SnapActionType)
  predictedAction?: SnapActionType;

  @IsOptional()
  @Min(0)
  @Max(1)
  actionConfidence?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  m2TimeMs?: number;

  /**
   * Shape depends on predictedAction — validated LENIENTLY at write time
   * (logged, not rejected, on a mismatch) since this arrives from an
   * external pipeline of unpredictable quality and HITL review is the
   * real correction mechanism, not strict server-side rejection.
   */
  @IsOptional()
  extractedEntities?: Record<string, unknown>;

  @IsOptional()
  @Min(0)
  @Max(1)
  entityConfidence?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  m3TimeMs?: number;
}
