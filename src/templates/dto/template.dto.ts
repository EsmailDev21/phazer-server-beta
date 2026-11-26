import { TemplateKind, TemplateVisibility } from '@prisma/client';
import { Transform } from 'class-transformer';
import { KeepRaw } from '../../common/dto/keep-raw';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsObject,
  Min,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

// PUBLIC is deliberately NOT here: the API cannot ask for it (step 3.9). The service refuses it as well.
const VISIBILITIES = [
  TemplateVisibility.PRIVATE,
  TemplateVisibility.ACCOUNT,
] as const;
const CATEGORY = /^[a-z][a-z0-9-]{0,39}$/;

/**
 * NOTE (body size): Express's default JSON limit is 100 kb, so `blueprint` uploads are capped at
 * about that until the app-wide limit is raised (a decision recorded in blueprint-v1.md). Routes
 * that BUILD the blueprint on the server (export) are not affected.
 */
export class CreateTemplateDto {
  @IsObject()
  blueprint: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsString()
  @Matches(CATEGORY)
  category?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  tags?: string[];

  @IsOptional()
  @IsIn(VISIBILITIES)
  visibility?: TemplateVisibility;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  changelog?: string;
}

export class UpdateTemplateDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsString()
  @Matches(CATEGORY)
  category?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  tags?: string[];

  @IsOptional()
  @IsIn(VISIBILITIES)
  visibility?: TemplateVisibility;
}

export class NewVersionDto {
  @IsObject()
  blueprint: Record<string, unknown>;

  @IsOptional()
  @IsIn(['major', 'minor', 'patch'])
  bump?: 'major' | 'minor' | 'patch';

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  changelog?: string;
}

export class ForkTemplateDto {
  /** The account that will own the copy. Must be the source template's own account in Phase 3. */
  @IsString()
  accountId: string;

  /** What to call the copy. Default: "<source name> (copy)". */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;
}

export class ExportTemplateDto {
  @IsOptional()
  @IsString()
  projectId?: string;

  @IsOptional() @IsBoolean() includeComments?: boolean;
  @IsOptional() @IsBoolean() includeAttachments?: boolean;
  @IsOptional() @IsBoolean() includeArchived?: boolean;

  /** "YYYY-MM-DD"; default: the earliest date found. */
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  anchorDate?: string;

  /** 'block' (default) refuses an export that contains a credential; 'redact' removes it and continues. */
  @IsOptional()
  @IsIn(['block', 'redact'])
  onSecret?: 'block' | 'redact';

  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsString() @Matches(CATEGORY) category?: string;
  @IsOptional() @IsIn(VISIBILITIES) visibility?: TemplateVisibility;
}

export class ListTemplatesQueryDto {
  @IsOptional()
  @IsEnum(TemplateKind)
  kind?: TemplateKind;

  @IsOptional()
  @IsIn(VISIBILITIES)
  visibility?: TemplateVisibility;

  /** Only the ones I created. */
  // ?mine=false must be false (Boolean('false') would be true)
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  mine?: boolean;
}

/** Step 3.9: the gallery of PUBLIC (first-party) templates. */
export class ListPublicTemplatesQueryDto {
  @IsOptional()
  @IsEnum(TemplateKind)
  kind?: TemplateKind;

  @IsOptional()
  @IsString()
  @Matches(CATEGORY)
  category?: string;
}

// ---- step 3.8: the editor
export class PatchDraftDto {
  /** The revision you loaded. Required: a write without it could silently overwrite someone else's. */
  @IsInt()
  @Min(1)
  ifRevision: number;

  /** Operations (see editor.types.ts). Their shape is checked by the editor itself. */
  @KeepRaw()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  ops: unknown[];
}

export class PublishDraftDto {
  @IsInt()
  @Min(1)
  ifRevision: number;

  @IsOptional()
  @IsIn(['major', 'minor', 'patch'])
  bump?: 'major' | 'minor' | 'patch';

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  changelog?: string;
}

export class DiffQueryDto {
  @IsString() from: string;
  @IsString() to: string;
}

export class DiscardDraftQueryDto {
  @IsOptional()
  @Transform(({ value }) => (value === undefined ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  ifRevision?: number;
}
