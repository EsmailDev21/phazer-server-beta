import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateOrganizationAccountDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  logo?: string;
}
