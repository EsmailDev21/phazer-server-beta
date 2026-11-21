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

export class CreateTaskDto {
  @IsString()
  workspaceId: string;

  @IsOptional()
  @IsString()
  projectId?: string;

  /**
   * Makes this a subtask (ADR-0005). Must be in the same workspace and project;
   * when `projectId` is omitted the parent's is used.
   */
  @IsOptional()
  @IsString()
  parentId?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(300)
  title: string;

  @IsOptional()
  @IsString()
  @MaxLength(10000)
  description?: string;

  // FIX: was bare @IsString() before, letting garbage values pass DTO
  // validation and fail downstream as raw Prisma errors.
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

  /** ADR-0007: must belong to the task's workspace. */
  @IsOptional()
  @IsString()
  issueTypeId?: string;

  /**
   * ADR-0007: same workspace; a project-scoped iteration needs a task of that project;
   * a closed iteration takes no new tasks.
   */
  @IsOptional()
  @IsString()
  iterationId?: string;

  @IsOptional()
  @IsEnum(Priority)
  priority?: Priority;

  /** ADR-0008: story points, 0..1000. null = not estimated. */
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
