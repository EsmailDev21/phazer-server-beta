import { IsEnum, IsString } from 'class-validator';
import { AttachmentableType } from '@prisma/client';
import { PaginationDto } from '../../common/dto/pagination.dto';

export class QueryFilesDto extends PaginationDto {
  @IsEnum(AttachmentableType)
  targetType: AttachmentableType;

  @IsString()
  targetId: string;
}
