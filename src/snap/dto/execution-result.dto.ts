import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Min,
  MaxLength,
} from 'class-validator';

/**
 * THIN — only records what the frontend already did by calling the real
 * POST /tasks, POST /projects, or POST /workspaces endpoint directly.
 * This endpoint performs no privileged action itself.
 */
export class ExecutionResultDto {
  @IsBoolean()
  success: boolean;

  @IsOptional()
  @IsString()
  createdEntityId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  error?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  executionTimeMs?: number;
}
