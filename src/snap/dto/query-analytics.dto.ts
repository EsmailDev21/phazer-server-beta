import { IsEnum, IsOptional } from 'class-validator';
import { SnapActionType } from '@prisma/client';

export class QuerySnapAccuracyDto {
  @IsOptional()
  @IsEnum(SnapActionType)
  action?: SnapActionType;

  /** 'm1' | 'm2' | 'm3' — which stage's confidence to report against actual correction rate. */
  @IsOptional()
  model?: 'm1' | 'm2' | 'm3';
}
