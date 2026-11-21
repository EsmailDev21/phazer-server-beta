import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import {
  CorrectionType,
  SnapActionType,
  SnapRating,
  SnapReviewStatus,
} from '@prisma/client';

export class ReviewClauseDto {
  @IsEnum(SnapReviewStatus)
  reviewStatus: SnapReviewStatus;

  @IsOptional()
  @IsEnum(SnapActionType)
  correctedAction?: SnapActionType;

  @IsOptional()
  correctedEntities?: Record<string, unknown>;

  @IsOptional()
  @IsEnum(CorrectionType)
  correctionType?: CorrectionType;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  rejectionReason?: string;

  /** No dedicated endpoint for this — folded in here since the column exists and a separate endpoint wasn't specified. */
  @IsOptional()
  @IsEnum(SnapRating)
  userRating?: SnapRating;
}
