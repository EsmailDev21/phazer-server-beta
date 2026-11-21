import {
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { FieldType } from '@prisma/client';

export class CreateCustomFieldDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name: string;

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  key: string;

  @IsEnum(FieldType)
  dataType: FieldType;

  // Choices — required for SELECT/MULTI_SELECT, validated in the service
  // since it depends on dataType (a cross-field DTO rule).
  @IsOptional()
  @IsArray()
  options?: string[];

  @IsOptional()
  @IsInt()
  order?: number;
}
