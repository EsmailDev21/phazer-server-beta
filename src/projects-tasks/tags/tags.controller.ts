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
  Put,
} from '@nestjs/common';
import { TagsService } from './tags.service';
import { CreateTagDto } from './dto/create-tag.dto';
import { UpdateTagDto } from './dto/update-tag.dto';
import { RequireAccess } from '../../access-control/decorators/require-access.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';

@Controller()
export class TagsController {
  constructor(private readonly tagsService: TagsService) {}

  @RequireAccess('manageTags', { targetType: 'WORKSPACE' })
  @Post('workspaces/:id/tags')
  async create(@Param('id') workspaceId: string, @Body() dto: CreateTagDto) {
    return this.tagsService.create(workspaceId, dto);
  }

  // No @RequireAccess: readable by anyone with workspace-level access, which
  // is wider than manageTags. Gated inside the service.
  @Get('workspaces/:id/tags')
  async list(
    @Param('id') workspaceId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.tagsService.listByWorkspace(workspaceId, user.userId);
  }

  // No @RequireAccess on the two routes below: :id is the TAG's id, not a
  // workspace id - permission is resolved from the tag's workspace in the service.
  @Patch('tags/:id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateTagDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.tagsService.update(id, dto, user.userId);
  }

  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete('tags/:id')
  async delete(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.tagsService.delete(id, user.userId);
  }

  @RequireAccess('editTask', { targetType: 'TASK' })
  @Put('tasks/:id/tags/:tagId')
  async attach(
    @Param('id') taskId: string,
    @Param('tagId') tagId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.tagsService.attach(taskId, tagId, user.userId);
  }

  @RequireAccess('editTask', { targetType: 'TASK' })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete('tasks/:id/tags/:tagId')
  async detach(
    @Param('id') taskId: string,
    @Param('tagId') tagId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.tagsService.detach(taskId, tagId, user.userId);
  }
}
