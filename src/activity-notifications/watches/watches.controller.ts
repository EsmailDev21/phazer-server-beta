import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
} from '@nestjs/common';
import { WatchesService } from './watches.service';
import { CreateWatchDto } from './dto/create-watch.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';
import { WatchableType } from '@prisma/client';

@Controller('watches')
export class WatchesController {
  constructor(private readonly watchesService: WatchesService) {}

  @Post()
  async create(
    @Body() dto: CreateWatchDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.watchesService.create(
      user.userId,
      dto.targetType,
      dto.targetId,
    );
  }

  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete()
  async remove(
    @Query('targetType') targetType: WatchableType,
    @Query('targetId') targetId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.watchesService.remove(user.userId, targetType, targetId);
  }

  @Get()
  async listMine(@CurrentUser() user: AuthenticatedUser) {
    return this.watchesService.listMine(user.userId);
  }
}
