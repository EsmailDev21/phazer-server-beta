import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IntegrationProvider } from '@prisma/client';

/**
 * Provider-neutral reply an adapter renders as an EPHEMERAL message (only the caller sees it).
 * 2.3 defines the full RichMessage; this is the minimal shape 2.2's replies need and maps onto it.
 */
export interface ChatReply {
  ephemeral: true;
  text: string;
  actions: Array<{ label: string; url: string }>;
}

const PROVIDER_NAME: Record<string, string> = {
  DISCORD: 'Discord',
  SLACK: 'Slack',
  GITHUB: 'GitHub',
};

/**
 * "Link your account" reply for a caller we cannot map to a user. The URL carries a ONE-TIME token that
 * exists only in this ephemeral reply (ADR-0010 d.2): whoever completes it while logged in is linked to
 * exactly this chat user. Never send this reply to a channel; the 2.3 renderer must keep it ephemeral.
 * The page may also offer the provider's own identify flow (connectionId + provider are in the URL).
 */
@Injectable()
export class LinkPromptBuilder {
  constructor(private readonly config: ConfigService) {}

  link(
    conn: { id: string; provider: IntegrationProvider; externalAccountName: string },
    token: { token: string; expiresAt: Date },
  ): ChatReply {
    const app = this.config.get<string>('APP_NAME') ?? 'the app';
    const provider = PROVIDER_NAME[conn.provider] ?? conn.provider;
    const base = (this.config.get<string>('FRONTEND_URL') ?? '').replace(/\/$/, '');
    const url = `${base}/settings/integrations/link?token=${encodeURIComponent(token.token)}&connectionId=${encodeURIComponent(conn.id)}&provider=${encodeURIComponent(conn.provider.toLowerCase())}`;
    const minutes = Math.max(1, Math.round((token.expiresAt.getTime() - Date.now()) / 60_000));
    return {
      ephemeral: true,
      text: `I don't know which ${app} user you are yet, so I can't run that for you. Link your ${provider} account (you stay in control; the link works once and expires in ${minutes} minutes) and try again.`,
      actions: [{ label: `Link my ${provider} account`, url }],
    };
  }

  /** Over the prompt limit: tell them where the link is, issue NOTHING (no token, no lookup). */
  throttled(conn: { provider: IntegrationProvider }): ChatReply {
    const provider = PROVIDER_NAME[conn.provider] ?? conn.provider;
    return {
      ephemeral: true,
      text: `I already sent you a link to connect your ${provider} account. Use the most recent private message from me, or wait a few minutes and run the command again.`,
      actions: [],
    };
  }

  disconnected(conn: { provider: IntegrationProvider; externalAccountName: string }): ChatReply {
    const provider = PROVIDER_NAME[conn.provider] ?? conn.provider;
    return {
      ephemeral: true,
      text: `The ${provider} integration for ${conn.externalAccountName} is currently disconnected. Ask an admin to reconnect it.`,
      actions: [],
    };
  }
}
