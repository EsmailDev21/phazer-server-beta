import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * Foundations Validation Policy — RULE 3:
 * Shared PaginationDto on EVERY list endpoint, not opt-in.
 * take: @IsInt() @Min(1) @Max(100), default 25 if omitted
 * skip: @IsInt() @Min(0), default 0
 *
 * Fixes: 38 of 45 findMany calls with no limit mechanism, and the
 * "take:undefined returns every row" default behavior.
 */
export class PaginationDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  take?: number = 25;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip?: number = 0;
}
