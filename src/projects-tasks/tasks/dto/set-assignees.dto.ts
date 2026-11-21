import { ArrayUnique, IsArray, IsString } from 'class-validator';

export class SetAssigneesDto {
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  userIds: string[];
}
