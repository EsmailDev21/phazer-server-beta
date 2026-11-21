import { IsBoolean, IsEnum, IsOptional, IsString } from 'class-validator';
import { BooleanQuery } from '../../../common/dto/boolean-query';
import { TaskStatus } from '@prisma/client';
import { PaginationDto } from '../../../common/dto/pagination.dto';

export class QueryTasksDto extends PaginationDto {
  @IsString()
  workspaceId: string;

  @IsOptional()
  @IsString()
  projectId?: string;

  @IsOptional()
  @IsEnum(TaskStatus)
  status?: TaskStatus;

  /** ADR-0007 */
  @IsOptional()
  @IsString()
  issueTypeId?: string;

  /** ADR-0007 */
  @IsOptional()
  @IsString()
  iterationId?: string;

  /** One specific workflow status. `status` keeps filtering by category. */
  @IsOptional()
  @IsString()
  workflowStatusId?: string;

  @IsOptional()
  @IsString()
  assigneeId?: string;

  /** Only the direct subtasks of this task. Wins over `rootsOnly`. */
  @IsOptional()
  @IsString()
  parentId?: string;

  /**
   * Only top-level tasks. Default (omitted/false) returns ALL tasks, subtasks
   * included - the pre-subtask behaviour, unchanged (ADR-0005 decision 11).
   */
  @IsOptional()
  @BooleanQuery()
  @IsBoolean()
  rootsOnly?: boolean;
}
