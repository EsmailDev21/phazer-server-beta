import {
  IsDateString,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Priority, TaskStatus } from '@prisma/client';

export class UpdateTaskDto {
  @IsOptional()
  @IsString()
  projectId?: string;

  /**
   * Re-parent (a task id) or detach (`null`). `undefined` = leave alone.
   * NOTE: `@IsOptional()` skips validation for null as well as undefined, which
   * is exactly what lets `null` through. TasksService.update pulls this out of
   * the DTO before the generic spread - it must never reach Prisma directly.
   */
  @IsOptional()
  @IsString()
  parentId?: string | null;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10000)
  description?: string;

  @IsOptional()
  @IsEnum(TaskStatus)
  status?: TaskStatus;

  /**
   * ADR-0006: the specific workflow status (must belong to the task's project).
   * `status` stays the CATEGORY; if both are given they must agree (400).
   */
  @IsOptional()
  @IsString()
  workflowStatusId?: string;

  /** ADR-0007: must belong to the task's workspace. null clears it. */
  @IsOptional()
  @IsString()
  issueTypeId?: string | null;

  /**
   * ADR-0007: same workspace; a project-scoped iteration needs a task of that project;
   * a closed iteration takes no new tasks. null = back to the backlog.
   */
  @IsOptional()
  @IsString()
  iterationId?: string | null;

  @IsOptional()
  @IsEnum(Priority)
  priority?: Priority;

  /** ADR-0008: story points, 0..1000. null = not estimated (clears it). */
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(1000)
  estimate?: number | null;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  dueDate?: string;
}
