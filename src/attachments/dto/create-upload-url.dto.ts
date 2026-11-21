import {
  IsEnum,
  IsInt,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { AttachmentableType } from '@prisma/client';

export class CreateUploadUrlDto {
  @IsEnum(AttachmentableType)
  targetType: AttachmentableType;

  @IsString()
  targetId: string;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  filename: string;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  mimeType: string;

  @IsInt()
  @Min(1)
  @Max(10 * 1024 * 1024 * 1024) // 10GB hard ceiling regardless of tier — sanity bound against a malformed/malicious request, real per-tier cap enforced in the service
  sizeBytes: number;
}
