import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateWorkspaceDto {
  @IsString()
  accountId: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  /**
   * Optional explicit task-key prefix (ADR-0004), e.g. "ENG". Omitted = one is
   * generated from the name. Format and availability are checked in the service.
   */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  key?: string;
}
