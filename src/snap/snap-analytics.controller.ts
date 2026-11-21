import { Controller, Get, Query } from '@nestjs/common';
import { SnapAnalyticsService } from './snap-analytics.service';
import { QuerySnapAccuracyDto } from './dto/query-analytics.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';

@Controller('snap/analytics')
export class SnapAnalyticsController {
  constructor(private readonly snapAnalyticsService: SnapAnalyticsService) {}

  @Get('accuracy')
  async getAccuracy(
    @Query() query: QuerySnapAccuracyDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.snapAnalyticsService.getAccuracy(user.userId, query);
  }

  @Get('corrections')
  async getCorrections(@CurrentUser() user: AuthenticatedUser) {
    return this.snapAnalyticsService.getCorrections(user.userId);
  }
}
