import { IsEnum, IsString } from 'class-validator';
import { WatchableType } from '@prisma/client';

export class CreateWatchDto {
  @IsEnum(WatchableType)
  targetType: WatchableType;

  @IsString()
  targetId: string;
}
