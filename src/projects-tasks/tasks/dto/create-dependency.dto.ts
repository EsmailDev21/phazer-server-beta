import { IsEnum, IsOptional, IsString } from 'class-validator';
import { DependencyType } from '@prisma/client';

export class CreateDependencyDto {
  @IsString()
  blockedTaskId: string;

  @IsOptional()
  @IsEnum(DependencyType)
  type?: DependencyType;
}
