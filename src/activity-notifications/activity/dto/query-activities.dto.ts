import { IsBoolean, IsEnum, IsOptional, IsString } from 'class-validator';
import { BooleanQuery } from '../../../common/dto/boolean-query';
import { ActivityTargetType } from '@prisma/client';
import { PaginationDto } from '../../../common/dto/pagination.dto';

export class QueryActivitiesDto extends PaginationDto {
  @IsString()
  workspaceId: string;

  @IsOptional()
  @IsEnum(ActivityTargetType)
  targetType?: ActivityTargetType;

  @IsOptional()
  @IsString()
  targetId?: string;

  // Admin/debug only — default response excludes SILENT rows entirely.
  @IsOptional()
  @BooleanQuery()
  @IsBoolean()
  includeSilent?: boolean;

  // Step 4.6: history copied from another system (visibility IMPORTED). Only valid together with targetType=TASK and a
  // targetId: it is the task's own history tab, never part of the workspace feed.
  @IsOptional()
  @BooleanQuery()
  @IsBoolean()
  includeImported?: boolean;
}

