import { Controller, MessageEvent, Sse } from '@nestjs/common';
import { Observable, finalize } from 'rxjs';
import { map } from 'rxjs/operators';
import { NotificationSseRegistry } from './notification-sse-registry.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';

/**
 * GET /notifications/stream (SSE, not WebSocket — server->client push
 * only, no bidirectionality needed). Auth via the same JwtAuthGuard as
 * everything else (global guard, no @Public() here) — the EventSource
 * client sends the same Authorization header/cookie as normal requests.
 */
@Controller('notifications')
export class NotificationsSseController {
  constructor(private readonly registry: NotificationSseRegistry) {}

  @Sse('stream')
  stream(@CurrentUser() user: AuthenticatedUser): Observable<MessageEvent> {
    const subject = this.registry.connect(user.userId);

    return subject.pipe(
      map((payload) => ({ data: payload }) as MessageEvent),
      finalize(() => this.registry.disconnect(user.userId, subject)),
    );
  }
}
