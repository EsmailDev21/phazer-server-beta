import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CommentsService } from './comments.service';
import { CreateCommentDto } from './dto/create-comment.dto';
import { UpdateCommentDto } from './dto/update-comment.dto';
import { QueryCommentsDto } from './dto/query-comments.dto';
import { RequireAccess } from '../../access-control/decorators/require-access.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';

@Controller('comments')
export class CommentsController {
  constructor(private readonly commentsService: CommentsService) {}

  // No @RequireAccess — targetType (TASK|PROJECT|ACTIVITY) is only known
  // at request time; CommentsService checks permission manually.
  @Post()
  async create(
    @Body() dto: CreateCommentDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.commentsService.create(dto, user.userId);
  }

  @Get()
  async list(
    @Query() query: QueryCommentsDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.commentsService.list(query, user.userId);
  }

  @RequireAccess('editComment')
  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateCommentDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.commentsService.update(id, dto, user.userId);
  }

  @RequireAccess('deleteComment')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':id')
  async delete(@Param('id') id: string) {
    await this.commentsService.delete(id);
  }
}
