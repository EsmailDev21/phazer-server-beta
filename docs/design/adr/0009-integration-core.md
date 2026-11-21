# ADR-0009 - Integration core: connections, credentials, OAuth, refresh

Status: ACCEPTED (step 2.1). Owner decisions: d.3 (soft revoke) and d.8 (all three providers' OAuth in 2.1).

## Context
Phase 2 needs Discord, Slack and GitHub connected to an Account. Step 0.10 already shipped the building blocks:
`TokenVaultService` (AES-256-GCM, key ids), `RedisService`, the `manageIntegrations` action (OWNER/ADMIN, account scope),
the `integration` plan counter slot, `FEATURE_INTEGRATIONS`, and audit actions `INTEGRATION_CONNECTED/DISCONNECTED`.
2.1 adds the framework on top; 2.2 (identity), 2.3 (router), 2.4-2.6 (provider features) build on it.

## Decisions
1. **A connection is one provider-side tenant** (Discord guild, Slack team, GitHub installation) connected to one
   Account: unique `(account, provider, externalAccountId)`. Only OWNER/ADMIN of the account may connect/disconnect (`manageIntegrations`).
2. **Adapter contract** (`ConnectorAdapter`): `isConfigured`, `authorizeUrl`, `exchangeCode`, optional `refresh`, `revoke`,
   plus a capability set. Deviation from diagram 02: `identify` is folded into `exchangeCode` (GitHub's installation id exists
   only in the callback query). Later steps add optional members next to their capability. Providers are registered through one
   multi-provider token; a missing adapter is a 404, an unconfigured one a 503 (no boot-time crash).
3. **Soft revoke (owner decision).** Disconnect = delete the credential, set status `REVOKED`, set `paused_at` on the connection's
   channel links; the provider is told best-effort first (token revoke; Discord also leaves the guild). Reconnecting the same
   provider account revives the same row, sets ACTIVE and clears `paused_at`. REVOKED rows do not count against the plan.
   Subscriptions are untouched (they are inert while their link is paused).
4. **OAuth state**: single-use row, 10 min TTL, bound to `(user, account, provider)`; `nonce` is the `state` value. Consumed by one
   `UPDATE ... WHERE consumed_at IS NULL AND expires_at > now() RETURNING`, so replays and races lose. The callback is `@Public`
   (browser has no bearer token); authority comes from the state and `manageIntegrations` is **re-checked at callback**. Every callback
   outcome is a 302 to `{FRONTEND_URL}/settings/integrations?connected=` or `?error=<invalid_state|denied|forbidden|plan_limit|provider_error>`.
   PKCE is implemented generically (`usesPkce`; verifier stored vault-encrypted) but **no shipped provider enables it**: Slack and GitHub
   have none, and Discord does not document it for confidential clients. Not verified against a live Discord app.
   **GitHub**: the callback's `installation_id` is attacker-controlled, so the adapter requires the App's "user authorization during
   installation" `code`, exchanges it, and refuses unless that user's `/user/installations` contains the id. The user token is discarded.
5. **Credentials**: one row per connection, the whole token JSON encrypted with the vault; plaintext only inside `CredentialService`.
   Deviation from the ERD: one `ciphertext` TEXT (self-describing `v1:kid:iv:tag:ct`) plus a denormalised `kid` column for key rotation,
   instead of separate iv/authTag columns. No API response can include it: the list/revoke paths use an explicit field whitelist.
6. **Refresh** (`CredentialService.getAccessToken`): refresh when < 60 s remain, under a per-connection Redis lock, **re-reading after
   acquiring it** so concurrent callers (and other processes) cause exactly one provider refresh. A kept refresh token survives providers that
   do not return a new one. A dead grant (`ProviderAuthRejectedError`) -> `NEEDS_REAUTH` + one audit row `INTEGRATION_NEEDS_REAUTH` (fan-out makes
   `ACCOUNT_ALERT` for owners/admins); transient errors leave the connection ACTIVE. Reconnecting repairs NEEDS_REAUTH without taking a slot.
7. **Outbound calls** all use `ProviderHttpClient`: Redis token bucket per `rateKey` (in-process fallback), `Retry-After` honoured
   (inline up to 10 s, longer throws `ProviderRateLimitedError` with the delay), 5xx/network retried twice, **per-host circuit breaker kept
   per process** (stops this process hammering a dead host; sharing it would cost a Redis round trip per call).
8. **All three providers' OAuth now (owner decision)**: Discord (bot install, guild), Slack (OAuth v2 bot token, team), GitHub App (installation,
   tokens minted from an app JWT; "refresh" re-mints). Written against the providers' documentation and unit-tested with mocked HTTP.
   **No real provider was called**; first live run is on the owner.
9. **Plan limit**: counter = connections in `ACTIVE | NEEDS_REAUTH | ERROR`. Checked at `start` and exactly at callback. At the cap, `start`
   is still allowed when the account already has a live connection of that provider (it may be a repair); the callback decides.
10. **Tables created now, logic later**: `identity_links` (2.2), `channel_links` (+ `paused_at`), `channel_subscriptions`, `channel_deliveries` (2.3-2.6).
    The ERD's `NotificationDelivery` is named **`ChannelDelivery`** here: that name already exists for in-app notification delivery.

## Consequences
- `AuditLog.actorId` is required, so `INTEGRATION_NEEDS_REAUTH` uses the connection's creator as actor; the fan-out excludes the actor, so the
  creator does not get the ACCOUNT_ALERT (other owners/admins do). A system actor would fix it (not done).
- `GET /integrations` is admin-only (same action as connect).
- Rate-limit buckets and locks need Redis in production (ADR-0002); without it they degrade to per-process.
- Not built: re-auth reminders, credential re-encryption job for key rotation, HTTP-level (supertest) tests of the four routes.
