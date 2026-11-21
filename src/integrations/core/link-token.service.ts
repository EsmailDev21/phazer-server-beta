import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';

export const LINK_TOKEN_TTL_MS = 15 * 60 * 1000;

export interface ConsumedLinkToken {
  id: string;
  connection_id: string;
  external_user_id: string;
}

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * One-time "link your account" tokens (ADR-0010 d.2). The token is delivered ONLY in the ephemeral chat
 * reply to the external user, so holding it proves being that chat user; completing it while logged in
 * proves being the app user. Only the SHA-256 is stored. Consumption is one atomic UPDATE ... RETURNING.
 */
@Injectable()
export class LinkTokenService {
  constructor(private readonly prisma: PrismaService) {}

  /** Replaces any live token for the same chat user: one outstanding link per person, no pile-up from repeated commands. */
  async issue(connectionId: string, externalUserId: string): Promise<{ token: string; expiresAt: Date }> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + LINK_TOKEN_TTL_MS);
    await this.prisma.$transaction([
      this.prisma.identityLinkToken.deleteMany({ where: { connectionId, externalUserId, consumedAt: null } }),
      this.prisma.identityLinkToken.create({
        data: { tokenHash: hash(token), connectionId, externalUserId, expiresAt },
      }),
    ]);
    return { token, expiresAt };
  }

  /** Non-consuming look, for the confirmation page. Null for unknown / used / expired. */
  async inspect(token: string): Promise<{ connectionId: string; externalUserId: string } | null> {
    const row = await this.prisma.identityLinkToken.findUnique({ where: { tokenHash: hash(token) } });
    if (!row || row.consumedAt || row.expiresAt.getTime() <= Date.now()) return null;
    return { connectionId: row.connectionId, externalUserId: row.externalUserId };
  }

  /** Exactly one caller can ever win a token. */
  async consume(token: string): Promise<ConsumedLinkToken | null> {
    const rows = await this.prisma.$queryRaw<ConsumedLinkToken[]>`
      UPDATE identity_link_tokens SET consumed_at = now()
      WHERE token_hash = ${hash(token)} AND consumed_at IS NULL AND expires_at > now()
      RETURNING id, connection_id, external_user_id`;
    return rows[0] ?? null;
  }
}
