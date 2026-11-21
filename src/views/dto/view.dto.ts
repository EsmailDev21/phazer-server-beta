import { Transform, Type } from 'class-transformer';
import { SavedViewLayout } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { VIEW_LIMITS } from '../dsl';

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const bool = ({ value }: { value: unknown }) =>
  value === 'true' ? true : value === 'false' ? false : value;

/** `config` is plain JSON on purpose: the view DSL (src/views/dsl) is the one place that knows what it may contain. */
export class CreateViewDto {
  @IsString()
  @MaxLength(400)
  name: string;

  @IsEnum(SavedViewLayout)
  layout: SavedViewLayout;

  /** Omitted = a view of the whole workspace. Fixed for the life of the view. */
  @IsOptional()
  @IsString()
  @Matches(ID)
  projectId?: string;

  /** Shared with the whole workspace: needs an admin. Default: personal. */
  @IsOptional()
  @IsBoolean()
  isShared?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(VIEW_LIMITS.maxPosition)
  position?: number;

  @IsObject()
  config: Record<string, unknown>;
}

export class UpdateViewDto {
  @IsOptional()
  @IsString()
  @MaxLength(400)
  name?: string;

  @IsOptional()
  @IsEnum(SavedViewLayout)
  layout?: SavedViewLayout;

  @IsOptional()
  @IsBoolean()
  isShared?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(VIEW_LIMITS.maxPosition)
  position?: number;

  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;
}

/** Dry run for the view editor: nothing is stored. */
export class ValidateViewDto {
  @IsEnum(SavedViewLayout)
  layout: SavedViewLayout;

  @IsOptional()
  @IsString()
  @Matches(ID)
  projectId?: string;

  @IsObject()
  config: Record<string, unknown>;
}

export class ListViewsQueryDto {
  /** Views for this project: its own AND the workspace-wide ones. */
  @IsOptional()
  @IsString()
  @Matches(ID)
  projectId?: string;

  @IsOptional()
  @IsEnum(SavedViewLayout)
  layout?: SavedViewLayout;

  @IsOptional()
  @Transform(bool)
  @IsBoolean()
  shared?: boolean;
}

/** Paging for running a view: `cursor` is the `nextCursor` of the previous page. */
export class RunViewQueryDto {
  @IsOptional()
  @Transform(({ value }) => (value === undefined ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  limit?: number;

  @IsOptional()
  @IsString()
  @Matches(ID)
  cursor?: string;
}

/** "Run this config" for the view editor: nothing is stored. */
export class RunViewConfigDto extends ValidateViewDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  limit?: number;

  @IsOptional()
  @IsString()
  @Matches(ID)
  cursor?: string;
}
