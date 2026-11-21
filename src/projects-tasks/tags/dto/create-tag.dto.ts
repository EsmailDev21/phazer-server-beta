import { IsString, MaxLength, MinLength } from 'class-validator';

export class CreateTagDto {
  // Final trimming/collapsing/blank/length rules live in normalizeTagName();
  // this only rejects the grossly wrong early.
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name: string;
}
