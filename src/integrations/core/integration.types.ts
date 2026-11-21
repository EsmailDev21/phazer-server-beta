import { IntegrationProvider } from '@prisma/client';

/** What an adapter can do (diagram 02). 2.1 only uses the set for display; later steps gate features on it. */
export type Capability =
  | 'IMPORT'
  | 'NOTIFY'
  | 'COMMANDS'
  | 'LINKS'
  | 'WEBHOOKS';

/** Provider tokens as the adapter sees them. Stored encrypted as JSON (ADR-0009 d.5). */
export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** Absent = the access token does not expire. */
  expiresAt?: Date;
  scopes: string[];
  tokenType?: string;
  /** Provider-specific, non-secret-by-name but stored encrypted anyway (e.g. GitHub installationId). */
  extra?: Record<string, string>;
}

/** The provider-side thing being connected: a guild, a Slack team, a GitHub installation. */
export interface ExternalAccount {
  id: string;
  name: string;
}

export interface AuthorizeContext {
  state: string;
  redirectUri: string;
  /** Present only when the adapter declared `usesPkce`. */
  pkceChallenge?: string;
}

export interface ExchangeContext {
  redirectUri: string;
  pkceVerifier?: string;
}

/** The raw query of the provider's redirect back to us (string values only). */
export type CallbackParams = Readonly<Record<string, string>>;

/** A person as the provider knows them (identity linking, ADR-0010). */
export interface ExternalUser {
  id: string;
  name: string;
  email?: string;
  /** Provider vouches the email is confirmed. Absent/false = never used for auto-matching. */
  emailConfirmed?: boolean;
  isBot?: boolean;
  /** The provider tenant the user belongs to (Slack team id); compared to the connection's externalAccountId when present. */
  tenantId?: string;
}

/** Optional adapter capability: let a USER prove who they are at the provider. */
export interface IdentityCapability {
  /** `ctx.redirectUri` is the identity callback, not the connect callback. */
  authorizeUrl(ctx: AuthorizeContext): string;
  exchange(params: CallbackParams, ctx: ExchangeContext): Promise<ExternalUser>;
  /** Look a user up with the connection's own token (no user interaction) - used for verified-email auto-match. */
  lookup?(accessToken: string, externalUserId: string, rateKey: string): Promise<ExternalUser | null>;
}

/**
 * ADR-0009 d.2. The 2.1 slice of diagram 02's contract: connect, refresh, revoke.
 * `identify` is folded into `exchangeCode` (GitHub's installation id only exists in the callback
 * query, so a separate identify(token) cannot work for it). Later steps add discover / fetchBundle /
 * verifyWebhook / parseWebhook / notify as optional members next to the capability that needs them.
 */
export interface ConnectorAdapter {
  readonly provider: IntegrationProvider;
  readonly capabilities: ReadonlySet<Capability>;
  /** When true, OAuthService generates a PKCE pair and passes challenge / verifier through. */
  readonly usesPkce: boolean;
  /** Env present? An unconfigured provider answers 503 on connect rather than crashing at boot. */
  isConfigured(): boolean;
  authorizeUrl(ctx: AuthorizeContext): string;
  exchangeCode(
    params: CallbackParams,
    ctx: ExchangeContext,
  ): Promise<{ tokens: TokenSet; account: ExternalAccount }>;
  /** Absent = this provider cannot link user identities. */
  readonly identity?: IdentityCapability;
  /** Absent = tokens never expire / cannot be refreshed. Throws ProviderAuthRejectedError when the grant is dead. */
  refresh?(tokens: TokenSet): Promise<TokenSet>;
  /** Called once after a successful connect/reconnect (e.g. Discord registers its slash commands). Failure never fails the connect. */
  afterConnect?(account: ExternalAccount): Promise<void>;
  /**
   * COMMANDS capability (2.4/2.5): deliver the result of a deferred command back to where it was typed
   * (Discord: edit the interaction's original response; Slack: response_url). Throws on failure so the job retries.
   */
  chatReply?(
    target: { applicationId: string; interactionToken: string; reply?: { channelId?: string; threadTs?: string; userId?: string }; accessToken?: string },
    result: import('../chat/chat.types').ChatResult,
  ): Promise<void>;
  /**
   * NOTIFY capability (2.3 defines it, 2.4/2.5 implement it). Throws `NotifyPermanentError` when the destination
   * is gone/forbidden; any other error is treated as transient (the job retries with backoff).
   */
  notify?(ctx: NotifyContext): Promise<void>;
  /** Best effort at the provider; the caller already treats failure as non-fatal. */
  revoke(tokens: TokenSet, account: ExternalAccount): Promise<void>;
}

/** Provider-neutral message (ADR-0011 d.3). Each adapter renders it as Block Kit / an embed / etc. */
export interface RichMessage {
  /** One line, e.g. "ENG-12 Fix login". Rendered as the heading. */
  title: string;
  /** Deep link to the task in the web app. */
  url?: string;
  /** What happened, one sentence: "Status: To Do -> Done". */
  summary: string;
  fields: Array<{ label: string; value: string }>;
  /** Who did it (display name), if known. */
  actor?: string;
  tone: 'info' | 'success' | 'warning' | 'danger';
}

export interface NotifyContext {
  /** The connection's current access token (refreshed if needed). Adapters whose API uses an app-level token may ignore it. */
  accessToken: string;
  connection: { id: string; externalAccountId: string };
  channel: { kind: 'CHANNEL' | 'GUILD' | 'REPO'; externalId: string };
  message: RichMessage;
  /** Pass to ProviderHttpClient so every call shares the connection's rate budget. */
  rateKey: string;
}

/** The destination is gone or forbids us (403/404, channel deleted, bot removed): retrying cannot help. */
export class NotifyPermanentError extends Error {
  constructor(
    readonly code: string,
    message?: string,
  ) {
    super(message ?? `Notify failed permanently: ${code}`);
    this.name = 'NotifyPermanentError';
  }
}

export const INTEGRATION_ADAPTERS = Symbol('INTEGRATION_ADAPTERS');
export const PROVIDER_FETCH = Symbol('PROVIDER_FETCH');
export const PROVIDER_HTTP_OPTIONS = Symbol('PROVIDER_HTTP_OPTIONS');
export type FetchFn = typeof fetch;

/** The provider rejected the credential for good (invalid_grant, revoked, 401): flip to NEEDS_REAUTH. */
export class ProviderAuthRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderAuthRejectedError';
  }
}

/** Retry-After longer than we are willing to block a request for. Callers may queue and retry later. */
export class ProviderRateLimitedError extends Error {
  constructor(
    readonly retryAfterMs: number,
    readonly rateKey: string,
  ) {
    super(`Provider rate limited; retry after ${retryAfterMs}ms (${rateKey})`);
    this.name = 'ProviderRateLimitedError';
  }
}

export class ProviderCircuitOpenError extends Error {
  constructor(readonly host: string) {
    super(`Circuit open for ${host}; not calling it right now`);
    this.name = 'ProviderCircuitOpenError';
  }
}

export class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly bodySnippet: string,
  ) {
    super(`Provider call failed: HTTP ${status} ${url}`);
    this.name = 'ProviderHttpError';
  }
}
