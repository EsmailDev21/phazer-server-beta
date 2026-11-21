import { IsEnum, IsString } from 'class-validator';
import { ReactableType, ReactionType } from '@prisma/client';

export class CreateReactionDto {
  @IsEnum(ReactableType)
  targetType: ReactableType;

  @IsString()
  targetId: string;

  @IsEnum(ReactionType)
  reaction: ReactionType;
}
