import { Controller, Get, Query } from '@nestjs/common';
import { ActivitiesService } from './activities.service';
import { QueryActivitiesDto } from './dto/query-activities.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';

@Controller('activities')
export class ActivitiesController {
  constructor(private readonly activitiesService: ActivitiesService) {}

  @Get()
  async list(
    @Query() query: QueryActivitiesDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.activitiesService.list(user.userId, query);
  }
}
