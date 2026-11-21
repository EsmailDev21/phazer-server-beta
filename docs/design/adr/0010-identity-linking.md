# ADR-0010 - Identity linking: who is the chat user?

Status: ACCEPTED (step 2.2). Owner decisions: d.2 (one-time link now, provider identify as well), d.3 (auto-match rule); d.4 was delegated ("suggest") and accepted as written.

## Context
Chat commands (2.4/2.5) must run **as an app user** through `PermissionResolver`; the bot has no authority of its own (diagram 09, PLAN). So every
command needs a mapping `(connection, externalUserId) -> User`, and an unmapped caller must never execute anything.

## Decisions
1. **One gate.** `IdentityService.requireLinkedUser(connectionId, externalUserId)` returns a userId or throws `UnlinkedCallerError` carrying the
   ephemeral reply to send; `resolve()` is the non-throwing form. A command handler cannot obtain a userId any other way. Resolution fails closed:
   connection not ACTIVE -> "disconnected" notice (no token issued); linked user no longer a participant of the account -> unlinked (row kept);
   provider lookup error -> unlinked, never a guess. Authority beyond "this is user X" is not granted here.
2. **One-time link (owner decision).** An unlinked caller gets an ephemeral reply with `{FRONTEND_URL}/settings/integrations/link?token=...`. The
   token (32 random bytes) exists only in that reply; only its SHA-256 is stored; TTL 15 min; consumed by one atomic `UPDATE ... RETURNING`; a new
   command from the same chat user replaces the old token (one live token per person). A logged-in user completes it
   (`POST /integrations/identities/link-token/complete`) -> `IdentityLink(method = LINK_TOKEN)`. Possession proves being the chat user, being logged
   in proves being the app user. Works for every provider, including GitHub which has no identify flow. `.../inspect` shows the page what is being
   linked (provider + integration name, never chat identifiers) without consuming. A failed completion (not a participant) still burns the token:
   a leaked token costs the victim one re-run, never an account link. If the chat user is already linked to someone else: 409, unchanged.
   The renderer (2.3) **must** deliver this reply ephemerally; a token posted to a channel lets anyone in it claim the identity.
3. **Auto-match (owner decision).** Silent link only when ALL hold: the adapter can look the user up; the provider vouches the email is confirmed
   and the user is not a bot; the user is in the connection's own tenant (Slack team); exactly one app user has that email (case-insensitive),
   `emailVerified = true`, **and is an AccountMember of the connection's account**. Two matches -> `AMBIGUOUS_EMAIL`, nobody linked. Never overwrites an
   existing link. Discord returns no email without an extra scope, so Discord callers use d.2; Slack can auto-match.
4. **Manual link (delegated -> suggestion accepted).** OWNER/ADMIN (`manageIntegrations`) maps an external user id to a user who is an AccountMember;
   it is the only operation that may **relink** an already-linked chat user (explicit, audited with the target). A plain member cannot.
5. **Self-proved links accept any participant** (AccountMember, workspace collaborator, or project member): the person proved both sides, so the
   strict AccountMember rule of d.3/d.4 (which trusts without proof) is not needed. A client collaborator can therefore use chat, still only as
   what `PermissionResolver` allows them.
6. **Provider identify (OAuth) is also available** for Discord and Slack (`POST /integrations/:provider/identity/start`, public identity callback,
   `OAuthState.purpose = IDENTITY`, method `OAUTH_LINK`). It was built in an earlier pass of this step before the one-time link was chosen as primary;
   it is tested and kept. GitHub has none. The link page can offer it using the `connectionId` and `provider` in the prompt URL.
7. **Lifecycle.** Revoking a connection keeps its links (ADR-0009 d.3), reviving restores them. Anyone can remove their own link
   (`DELETE /integrations/identities/:id`; someone else's id is a 404); admins list/unlink per connection. Audit: `INTEGRATION_IDENTITY_LINKED/UNLINKED`.

## Consequences
- Every unlinked command writes one `identity_link_tokens` row (replace-on-reissue keeps it to one per person); the hourly sweep removes rows
  expired > 1 day. No per-user rate limit beyond the platform throttler (2.3/2.4 should add one on the command route).
- A person removed from an account and re-added gets their old links back (rows are kept, resolution just re-checks membership).
- GitHub identities are not linkable by identify; `LINK_TOKEN` and `MANUAL` cover it. Real Discord/Slack identify calls were never exercised.
