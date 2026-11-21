import { Injectable } from '@nestjs/common';
import { IntegrationProvider, OAuthStatePurpose } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { TokenVaultService } from '../../crypto/token-vault.service';
import { PrismaService } from '../../prisma/prisma.service';

export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export type ConsumedState = {
  id: string;
  provider: IntegrationProvider;
  purpose: OAuthStatePurpose;
  user_id: string;
  account_id: string;
  connection_id: string | null;
  pkce_verifier: string | null;
};

/** Single-use OAuth state for both flows (connect, identity). One place owns create + atomic consume. */
@Injectable()
export class OAuthStateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly vault: TokenVaultService,
  ) {}

  async create(args: {
    provider: IntegrationProvider;
    purpose: OAuthStatePurpose;
    userId: string;
    accountId: string;
    connectionId?: string;
    usePkce: boolean;
  }): Promise<{ nonce: string; challenge?: string }> {
    const nonce = randomBytes(32).toString('base64url');
    let verifier: string | undefined;
    let challenge: string | undefined;
    if (args.usePkce) {
      verifier = randomBytes(48).toString('base64url');
      challenge = createHash('sha256').update(verifier).digest('base64url');
    }
    await this.prisma.oAuthState.create({
      data: {
        provider: args.provider,
        purpose: args.purpose,
        nonce,
        pkceVerifier: verifier ? this.vault.encrypt(verifier) : null,
        userId: args.userId,
        accountId: args.accountId,
        connectionId: args.connectionId ?? null,
        expiresAt: new Date(Date.now() + OAUTH_STATE_TTL_MS),
      },
    });
    return { nonce, challenge };
  }

  /** `UPDATE ... RETURNING`: exactly one caller can ever win a given nonce; purpose and provider must match. */
  async consume(
    provider: IntegrationProvider,
    purpose: OAuthStatePurpose,
    nonce: string,
  ): Promise<ConsumedState | null> {
    const rows = await this.prisma.$queryRaw<ConsumedState[]>`
      UPDATE oauth_states SET consumed_at = now()
      WHERE nonce = ${nonce}
        AND provider = ${provider}::integration_provider
        AND purpose = ${purpose}::oauth_state_purpose
        AND consumed_at IS NULL
        AND expires_at > now()
      RETURNING id, provider, purpose, user_id, account_id, connection_id, pkce_verifier`;
    return rows[0] ?? null;
  }

  decryptVerifier(state: ConsumedState): string | undefined {
    return state.pkce_verifier ? this.vault.decrypt(state.pkce_verifier) : undefined;
  }
}
