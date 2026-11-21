import { Controller, Headers, Post, UnauthorizedException } from '@nestjs/common';
import { PublicSigned, SignedPayload, SignedRawBody } from '../../auth/decorators/public-signed.decorator';
import { RequireFeature } from '../../feature-flags/require-feature.decorator';
import { DiscordInteractionService } from './discord-interaction.service';

/**
 * Discord's single Interactions Endpoint URL (set in the Developer Portal): `POST /integrations/discord/interactions`.
 * @PublicSigned: no JWT; the Ed25519 signature over the RAW body is the authentication (and is checked first, in the service).
 * Every failure to verify is the same bare 401: the response must not say whether the key, timestamp or signature was wrong.
 */
@RequireFeature('INTEGRATIONS')
@Controller('integrations/discord')
export class DiscordInteractionsController {
  constructor(private readonly interactions: DiscordInteractionService) {}

  @PublicSigned()
  @Post('interactions')
  async handle(
    @SignedRawBody() rawBody: Buffer,
    @SignedPayload() payload: unknown,
    @Headers('x-signature-ed25519') signature: string | undefined,
    @Headers('x-signature-timestamp') timestamp: string | undefined,
  ) {
    const out = await this.interactions.handle({ rawBody, payload, signature, timestamp });
    if (out.status === 401) throw new UnauthorizedException();
    return out.body;
  }
}
