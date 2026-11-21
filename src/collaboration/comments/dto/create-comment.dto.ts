import {
  ArrayUnique,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { CommentableType } from '@prisma/client';

export class CreateCommentDto {
  @IsEnum(CommentableType)
  targetType: CommentableType;

  @IsString()
  targetId: string;

  @IsString()
  @MinLength(1)
  @MaxLength(10000)
  content: string;

  // DEVIATION: the graph's DTO_FIX says @IsUUID() here, but every id in
  // this schema is generated via Prisma's @default(cuid()), not a UUID
  // (cuids don't match UUID format at all) — @IsUUID() would reject every
  // real parentCommentId and break nested replies entirely. @IsString()
  // instead, consistent with how every other id field is validated
  // throughout this codebase.
  @IsOptional()
  @IsString()
  parentCommentId?: string;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  mentionedUserIds?: string[];
}
