import { Controller, Headers, Post, UnauthorizedException } from '@nestjs/common';
import { PublicSigned, SignedPayload, SignedRawBody } from '../../../auth/decorators/public-signed.decorator';
import { RequireFeature } from '../../../feature-flags/require-feature.decorator';
import { SlackInteractionService, SlackOutcome } from './slack-interaction.service';

/**
 * Slack's three URLs (set in the app manifest, `docs/slack-app-manifest.json`):
 *   POST /integrations/slack/commands      slash command (form-encoded)
 *   POST /integrations/slack/interactivity shortcut, buttons, modal submissions (form field `payload` = JSON)
 *   POST /integrations/slack/events        Events API (JSON): url_verification, link_shared
 * @PublicSigned: no JWT, the HMAC over the RAW body is the authentication, checked first in the service. A bare 401 for any failure.
 */
@RequireFeature('INTEGRATIONS')
@Controller('integrations/slack')
export class SlackController {
  constructor(private readonly slack: SlackInteractionService) {}

  private done(o: SlackOutcome) {
    if (o.status === 401) throw new UnauthorizedException();
    return o.body;
  }

  @PublicSigned()
  @Post('commands')
  async commands(@SignedRawBody() rawBody: Buffer, @SignedPayload() payload: unknown, @Headers('x-slack-signature') signature?: string, @Headers('x-slack-request-timestamp') timestamp?: string) {
    return this.done(await this.slack.handleCommand({ rawBody, payload, signature, timestamp }));
  }

  @PublicSigned()
  @Post('interactivity')
  async interactivity(@SignedRawBody() rawBody: Buffer, @SignedPayload() payload: unknown, @Headers('x-slack-signature') signature?: string, @Headers('x-slack-request-timestamp') timestamp?: string) {
    return this.done(await this.slack.handleInteractivity({ rawBody, payload, signature, timestamp }));
  }

  @PublicSigned()
  @Post('events')
  async events(@SignedRawBody() rawBody: Buffer, @SignedPayload() payload: unknown, @Headers('x-slack-signature') signature?: string, @Headers('x-slack-request-timestamp') timestamp?: string) {
    return this.done(await this.slack.handleEvent({ rawBody, payload, signature, timestamp }));
  }
}
