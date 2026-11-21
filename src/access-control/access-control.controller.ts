import { Body, Controller, Post } from '@nestjs/common';
import { PermissionResolver } from './access-control.service';
import { CheckAccessDto } from './dto/check-access.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';

/**
 * /access-control/check — lets ANY authenticated caller ask "can I do X to
 * Y" without attempting the action, using the exact same PermissionResolver
 * the route guards use. Useful for the frontend to conditionally render
 * UI (e.g. hide a delete button) without guessing at role logic client-side.
 */
@Controller('access-control')
export class AccessControlController {
  constructor(private readonly permissionResolver: PermissionResolver) {}

  @Post('check')
  async check(
    @Body() dto: CheckAccessDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.permissionResolver.resolve(
      user.userId,
      dto.action,
      dto.targetType,
      dto.targetId,
    );
  }
}
