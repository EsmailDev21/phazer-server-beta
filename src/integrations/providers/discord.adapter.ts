import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IntegrationProvider } from '@prisma/client';
import { ProviderHttpClient } from '../core/provider-http.client';
import { DISCORD_COMMANDS, renderResult } from '../chat/discord.protocol';
import { ChatResult } from '../chat/chat.types';
import {
  AuthorizeContext,
  CallbackParams,
  Capability,
  ConnectorAdapter,
  ExchangeContext,
  ExternalAccount,
  IdentityCapability,
  NotifyContext,
  NotifyPermanentError,
  ProviderAuthRejectedError,
  RichMessage,
  TokenSet,
} from '../core/integration.types';

const API = 'https://discord.com/api/v10';
/** VIEW_CHANNEL | SEND_MESSAGES | EMBED_LINKS */
const BOT_PERMISSIONS = 1024 + 2048 + 16384;
const SCOPES = ['bot', 'applications.commands', 'identify'];

interface DiscordTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  guild?: { id: string; name: string };
}

/**
 * Discord: bot install + OAuth2 code grant (step 2.1: connect / refresh / revoke only; commands,
 * interactions and notify arrive in 2.4). The connection is the GUILD the bot was added to.
 * PKCE: not enabled - Discord's documentation does not promise it for confidential clients, and an
 * ignored `code_challenge` would silently weaken nothing but also prove nothing. The single-use,
 * user-bound state is the CSRF defence (ADR-0009 d.4).
 */
@Injectable()
export class DiscordAdapter implements ConnectorAdapter {
  readonly provider = IntegrationProvider.DISCORD;
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>(['NOTIFY', 'COMMANDS', 'LINKS']);
  readonly usesPkce = false;

  constructor(
    private readonly config: ConfigService,
    private readonly http: ProviderHttpClient,
  ) {}

  isConfigured(): boolean {
    return !!this.config.get('DISCORD_CLIENT_ID') && !!this.config.get('DISCORD_CLIENT_SECRET');
  }

  authorizeUrl(ctx: AuthorizeContext): string {
    const u = new URL('https://discord.com/oauth2/authorize');
    u.searchParams.set('client_id', this.config.get<string>('DISCORD_CLIENT_ID')!);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', SCOPES.join(' '));
    u.searchParams.set('permissions', String(BOT_PERMISSIONS));
    u.searchParams.set('redirect_uri', ctx.redirectUri);
    u.searchParams.set('state', ctx.state);
    return u.toString();
  }

  /** Step 2.2: "Link your Discord account" = OAuth2 `identify` only (no bot, no guild). */
  readonly identity: IdentityCapability = {
    authorizeUrl: (ctx) => {
      const u = new URL('https://discord.com/oauth2/authorize');
      u.searchParams.set('client_id', this.config.get<string>('DISCORD_CLIENT_ID')!);
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('scope', 'identify');
      u.searchParams.set('redirect_uri', ctx.redirectUri);
      u.searchParams.set('state', ctx.state);
      return u.toString();
    },
    exchange: async (params, ctx) => {
      if (!params.code) throw new Error('Discord identity callback without code');
      const t = await this.token({
        grant_type: 'authorization_code',
        code: params.code,
        redirect_uri: ctx.redirectUri,
      });
      const me = await this.http.requestJson<{ id: string; username: string; global_name?: string | null; bot?: boolean }>({
        rateKey: 'oauth:DISCORD',
        url: `${API}/users/@me`,
        headers: { authorization: `Bearer ${t.access_token}` },
      });
      // The user token is used for this one call and dropped; Discord `identify` carries no email.
      return { id: me.id, name: me.global_name ?? me.username, isBot: me.bot === true };
    },
  };

  async exchangeCode(params: CallbackParams, ctx: ExchangeContext) {
    if (!params.code) throw new Error('Discord callback without code');
    const res = await this.token({
      grant_type: 'authorization_code',
      code: params.code,
      redirect_uri: ctx.redirectUri,
    });
    const guild = res.guild;
    if (!guild?.id) throw new Error('Discord did not report a guild: the bot scope was not granted');
    // The query's guild_id and the token response must agree: the response is the authority.
    if (params.guild_id && params.guild_id !== guild.id) {
      throw new Error('Discord guild_id mismatch between redirect and token response');
    }
    const account: ExternalAccount = { id: guild.id, name: guild.name };
    return { tokens: this.toTokens(res), account };
  }

  async refresh(tokens: TokenSet): Promise<TokenSet> {
    if (!tokens.refreshToken) throw new ProviderAuthRejectedError('No refresh token stored');
    const res = await this.token({ grant_type: 'refresh_token', refresh_token: tokens.refreshToken });
    return this.toTokens(res);
  }

  async revoke(tokens: TokenSet, account: ExternalAccount): Promise<void> {
    await this.http.request({
      rateKey: 'oauth:DISCORD',
      url: `${API}/oauth2/token/revoke`,
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.config.get<string>('DISCORD_CLIENT_ID')!,
        client_secret: this.config.get<string>('DISCORD_CLIENT_SECRET')!,
        token: tokens.accessToken,
      }),
    });
    const bot = this.config.get<string>('DISCORD_BOT_TOKEN');
    if (bot) {
      // Disconnect means the app leaves the server too; reconnecting re-adds it through the same flow.
      await this.http.request({
        rateKey: 'oauth:DISCORD',
        url: `${API}/users/@me/guilds/${encodeURIComponent(account.id)}`,
        method: 'DELETE',
        headers: { authorization: `Bot ${bot}` },
      });
    }
  }

  // ------------------------------------------------------------------ step 2.4 (ADR-0012)

  /** Per-channel rate window learned from Discord's `X-RateLimit-*` headers (in-process; the shared bucket is the HTTP client's). */
  private readonly channelResetAt = new Map<string, number>();

  /** Register the slash + context-menu commands in the guild that just connected (guild commands update instantly, global ones take up to an hour). */
  async afterConnect(account: ExternalAccount): Promise<void> {
    const bot = this.config.get<string>('DISCORD_BOT_TOKEN');
    if (!bot) return; // not configured: the connect still succeeds; commands can be registered later
    const res = await this.http.request({
      rateKey: 'oauth:DISCORD',
      url: `${API}/applications/${this.config.get<string>('DISCORD_CLIENT_ID')}/guilds/${encodeURIComponent(account.id)}/commands`,
      method: 'PUT',
      headers: { authorization: `Bot ${bot}`, 'content-type': 'application/json' },
      body: JSON.stringify(DISCORD_COMMANDS),
    });
    if (!res.ok) throw new Error(`Discord command registration HTTP ${res.status}`);
  }

  /** Edit the deferred "thinking..." message into the result. Throws on failure so the chat job retries. */
  async chatReply(target: { applicationId: string; interactionToken: string }, result: ChatResult): Promise<void> {
    if (!/^\d{5,25}$/.test(target.applicationId)) throw new Error('Invalid application id');
    const res = await this.http.request({
      rateKey: `chat:${target.applicationId}`,
      url: `${API}/webhooks/${target.applicationId}/${encodeURIComponent(target.interactionToken)}/messages/@original`,
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(renderResult(result)),
    });
    // 404 right after the ack is the race "reply before Discord processed our deferral": retry resolves it.
    if (!res.ok) throw new Error(`Discord follow-up HTTP ${res.status}`);
  }

  async notify(ctx: NotifyContext): Promise<void> {
    const bot = this.config.get<string>('DISCORD_BOT_TOKEN');
    if (!bot) throw new NotifyPermanentError('bot_not_configured');
    if (ctx.channel.kind !== 'CHANNEL' || !/^\d{5,25}$/.test(ctx.channel.externalId)) throw new NotifyPermanentError('invalid_channel');

    // Honour Discord's own window: if the last response said "0 remaining", wait for its reset (bounded).
    const wait = (this.channelResetAt.get(ctx.channel.externalId) ?? 0) - Date.now();
    if (wait > 0) {
      if (wait > 5_000) throw new Error(`Discord channel rate window open for ${wait}ms`); // transient: the queue retries later
      await new Promise((r) => setTimeout(r, wait));
    }
    const res = await this.http.request({
      rateKey: ctx.rateKey,
      url: `${API}/channels/${ctx.channel.externalId}/messages`,
      method: 'POST',
      headers: { authorization: `Bot ${bot}`, 'content-type': 'application/json' },
      body: JSON.stringify({ embeds: [toEmbed(ctx.message)], allowed_mentions: { parse: [] } }),
    });
    const remaining = res.headers.get('x-ratelimit-remaining');
    const resetAfter = Number(res.headers.get('x-ratelimit-reset-after'));
    if (remaining === '0' && Number.isFinite(resetAfter)) this.channelResetAt.set(ctx.channel.externalId, Date.now() + resetAfter * 1000);
    if (res.ok) return;
    // Gone / forbidden / malformed: retrying the same request cannot succeed.
    if ([400, 401, 403, 404].includes(res.status)) throw new NotifyPermanentError(`discord_${res.status}`);
    throw new Error(`Discord message HTTP ${res.status}`);
  }

  private async token(form: Record<string, string>): Promise<DiscordTokenResponse> {
    const res = await this.http.request({
      rateKey: 'oauth:DISCORD',
      url: `${API}/oauth2/token`,
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.config.get<string>('DISCORD_CLIENT_ID')!,
        client_secret: this.config.get<string>('DISCORD_CLIENT_SECRET')!,
        ...form,
      }),
    });
    if (res.status === 400 || res.status === 401) {
      // invalid_grant / invalid_client: the grant is dead, retrying cannot help.
      throw new ProviderAuthRejectedError(`Discord rejected the grant (HTTP ${res.status})`);
    }
    if (!res.ok) throw new Error(`Discord token endpoint HTTP ${res.status}`);
    return res.json<DiscordTokenResponse>();
  }

  private toTokens(r: DiscordTokenResponse): TokenSet {
    return {
      accessToken: r.access_token,
      refreshToken: r.refresh_token,
      expiresAt: r.expires_in ? new Date(Date.now() + r.expires_in * 1000) : undefined,
      scopes: (r.scope ?? SCOPES.join(' ')).split(' ').filter(Boolean),
      tokenType: r.token_type,
    };
  }
}

const TONE_COLOR: Record<RichMessage['tone'], number> = { info: 0x5865f2, success: 0x57f287, warning: 0xfee75c, danger: 0xed4245 };

/** RichMessage -> one Discord embed, within Discord's limits (title 256, description 4096, 25 fields of 256/1024). */
export function toEmbed(m: RichMessage): Record<string, unknown> {
  return {
    title: m.title.slice(0, 256),
    ...(m.url ? { url: m.url } : {}),
    description: m.summary.slice(0, 4096),
    color: TONE_COLOR[m.tone],
    fields: m.fields.slice(0, 25).map((f) => ({ name: f.label.slice(0, 256), value: f.value.slice(0, 1024) || '\u200b', inline: true })),
    ...(m.actor ? { footer: { text: m.actor.slice(0, 2048) } } : {}),
  };
}
