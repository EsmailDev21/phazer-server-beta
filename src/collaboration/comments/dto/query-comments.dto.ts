import { IsEnum, IsString } from 'class-validator';
import { CommentableType } from '@prisma/client';
import { PaginationDto } from '../../../common/dto/pagination.dto';

export class QueryCommentsDto extends PaginationDto {
  @IsEnum(CommentableType)
  targetType: CommentableType;

  @IsString()
  targetId: string;
}
