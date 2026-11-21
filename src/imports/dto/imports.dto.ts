import { ImportIssueSeverity } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export class CreateImportDto {
  @IsString()
  @IsNotEmpty()
  connectionId: string;

  @IsString()
  @IsNotEmpty()
  workspaceId: string;

  /** { comments, attachments, history, keepDates } - parsed strictly by parseOptions (unknown keys are a 400). */
  @IsOptional()
  @IsObject()
  options?: Record<string, unknown>;
}

/** Step 4.7b. `spaces` is parsed strictly by parsePerSpace (class-validator cannot express it usefully). */
export class CreatePerSpaceImportDto {
  @IsString()
  @IsNotEmpty()
  connectionId: string;

  @IsArray()
  spaces: unknown[];

  @IsOptional()
  @IsObject()
  options?: Record<string, unknown>;
}

export class ReportDownloadQueryDto {
  @IsOptional()
  @IsIn(['csv', 'json'])
  format?: 'csv' | 'json';
}

export class ListImportsQueryDto {
  @IsString()
  @IsNotEmpty()
  workspaceId: string;
}

/** Structure is checked by parseSelection (class-validator cannot say "array of {id,type} with caps" usefully). */
export class PutSelectionDto {
  @IsArray()
  sources: unknown[];
}

export class IssuesQueryDto {
  @IsOptional()
  @IsEnum(ImportIssueSeverity)
  severity?: ImportIssueSeverity;

  @IsOptional()
  @IsString()
  after?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  take?: number;
}
