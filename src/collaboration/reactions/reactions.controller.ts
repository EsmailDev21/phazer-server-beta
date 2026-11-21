import { Body, Controller, Post } from '@nestjs/common';
import { ReactionsService } from './reactions.service';
import { CreateReactionDto } from './dto/create-reaction.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';

@Controller('reactions')
export class ReactionsController {
  constructor(private readonly reactionsService: ReactionsService) {}

  @Post()
  async toggle(
    @Body() dto: CreateReactionDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.reactionsService.toggle(dto, user.userId);
  }
}
