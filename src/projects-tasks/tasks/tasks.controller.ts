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
  Query,
} from '@nestjs/common';
import { TasksService } from './tasks.service';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { QueryTasksDto } from './dto/query-tasks.dto';
import { SetAssigneesDto } from './dto/set-assignees.dto';
import { CreateDependencyDto } from './dto/create-dependency.dto';
import { RequireFeature } from '../../feature-flags/require-feature.decorator';
import { TaskKeyService } from './task-key.service';
import { TaskByKeyQueryDto } from './dto/task-by-key-query.dto';
import { DeleteTaskQueryDto } from './dto/delete-task-query.dto';
import { RequireAccess } from '../../access-control/decorators/require-access.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';

@Controller('tasks')
export class TasksController {
  constructor(
    private readonly tasksService: TasksService,
    private readonly taskKeyService: TaskKeyService,
  ) {}

  @RequireAccess('createTask', {
    paramSource: 'body',
    paramName: 'workspaceId',
  })
  @Post()
  async create(
    @Body() dto: CreateTaskDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.tasksService.create(dto, user.userId);
  }

  // LIST_GUARD_FIX: no @RequireAccess — gated entirely by
  // TaskVisibilityService (see tasks.service.ts#list), which is the ONE
  // guard path every task-listing route uses. workspaceId is required in
  // QueryTasksDto so there's always a workspace to resolve visibility for.
  @Get()
  async list(
    @Query() query: QueryTasksDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.tasksService.list(user.userId, query);
  }

  // ADR-0004: `ENG-123` + the account it lives in. Declared BEFORE ':id' so
  // 'by-key' is never read as a task id. No @RequireAccess: authorised in the
  // service exactly like getDetail, and a denial is indistinguishable from
  // "not found".
  @RequireFeature('WORKFLOW')
  @Get('by-key/:key')
  async getByKey(
    @Param('key') key: string,
    @Query() query: TaskByKeyQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.taskKeyService.getByKey(query.accountId, key, user.userId);
  }

  @Get(':id')
  async getDetail(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.tasksService.getDetail(id, user.userId);
  }

  // ADR-0005: the non-archived subtree, flat, with `depth`. Authorised like
  // getDetail (visibility of the root is visibility of the whole tree).
  @Get(':id/subtasks')
  async getSubtasks(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.tasksService.getSubtree(id, user.userId);
  }

  @Get(':id/table-row')
  async getTableRow(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.tasksService.getTableRow(id, user.userId);
  }

  @RequireAccess('editTask')
  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateTaskDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.tasksService.update(id, dto, user.userId);
  }

  @RequireAccess('deleteTask')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':id')
  async delete(@Param('id') id: string, @Query() query: DeleteTaskQueryDto) {
    await this.tasksService.delete(id, query.cascade === true);
  }

  @RequireAccess('archiveTask')
  @Post(':id/archive')
  async archive(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.tasksService.archive(id, user.userId);
  }

  @RequireAccess('archiveTask')
  @Post(':id/restore')
  async restore(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.tasksService.restore(id, user.userId);
  }

  @RequireAccess('editTask')
  @Put(':id/assignees')
  async setAssignees(
    @Param('id') id: string,
    @Body() dto: SetAssigneesDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.tasksService.setAssignees(id, dto, user.userId);
  }

  @RequireAccess('editTask')
  @Post(':id/dependencies')
  async addDependency(
    @Param('id') id: string,
    @Body() dto: CreateDependencyDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.tasksService.addDependency(id, dto, user.userId);
  }

  @RequireAccess('editTask')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':id/dependencies/:dependencyId')
  async removeDependency(
    @Param('id') id: string,
    @Param('dependencyId') dependencyId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.tasksService.removeDependency(id, dependencyId, user.userId);
  }
}
