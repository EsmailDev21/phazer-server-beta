# Runbook: rotating integration secrets (step 2.7)

Everything here can be done **without downtime**. Each section lists the order that makes that true, and what breaks if you
swap two steps. Do one rotation at a time.

## 1. Credential encryption key (`TOKEN_VAULT_KEYS` / `TOKEN_VAULT_CURRENT_KID`)

Provider tokens are encrypted with the key named by `TOKEN_VAULT_CURRENT_KID`; every key still listed in `TOKEN_VAULT_KEYS` can
decrypt. Rotating = adding a key, moving every stored credential onto it, then dropping the old key.

1. **Generate** a key: `openssl rand -base64 32`.
2. **Add it, keep the old one, make it current** (API **and** worker, same value everywhere):
   `TOKEN_VAULT_KEYS="k1:<old>,k2:<new>"`, `TOKEN_VAULT_CURRENT_KID="k2"`. Deploy both processes.
   *If you only set the new key, every existing credential becomes unreadable (connections go to "key retired").*
3. **Check where you are**: `GET /metrics` → `integration_credentials_by_kid{kid="k1"}` is the number still on the old key.
   New and refreshed credentials land on `k2` already.
4. **Re-encrypt the rest** (from a shell that has the API's env and database access):
   `npm run build` (if not built) then `npm run integrations:reencrypt -- --dry-run` to see the count, then
   `npm run integrations:reencrypt`.
   - Safe to repeat and to run while serving traffic; a token refresh that happens at the same moment is never overwritten.
   - Exit code `1` = some credentials could not be rotated; they are listed by **connection id** (never contents). The usual cause is a
     credential on a key already removed from the ring. Those connections must be **reconnected** by an owner/admin.
5. **Verify**: `integration_credentials_by_kid{kid="k1"}` is `0` (or absent) and no connection reports `credential_not_on_current_key`
   in `GET /integrations/connections/:id/health`.
6. **Retire the old key**: remove `k1:` from `TOKEN_VAULT_KEYS`, deploy. *Do this only after step 5, and keep the old key somewhere safe
   for as long as you have database backups you might restore (a restored row is encrypted with whatever key it had).*

**Rollback** (before step 6): set `TOKEN_VAULT_CURRENT_KID` back to `k1`; both keys still decrypt. Re-run step 4 to move credentials back.
**Suspected key leak**: do steps 1-6 immediately; also have owners reconnect high-value connections, because a leaked key plus an old
database backup still reads old tokens.

## 2. Slack signing secret (`SLACK_SIGNING_SECRET`)

Slack generates the new secret itself and starts signing with it the moment you regenerate, so **there will be a short gap** between
regenerating and your deploy during which requests signed with the new secret are rejected (401; Slack retries events, not slash
commands). `SLACK_SIGNING_SECRET_PREVIOUS` does not remove that gap; it only keeps requests still signed with the old secret (in flight,
or served by instances not yet redeployed) from failing during a rolling deploy.

1. In Slack app settings → Basic Information → **Regenerate** the signing secret, copy the new value.
2. Set `SLACK_SIGNING_SECRET=<new>` and `SLACK_SIGNING_SECRET_PREVIOUS=<old>`; deploy the API immediately.
3. Watch `integration_webhook_rejected_total{provider="SLACK"}`: it should stop growing once the deploy is complete.
4. Remove `SLACK_SIGNING_SECRET_PREVIOUS`, deploy.

## 3. GitHub webhook secret (`GITHUB_WEBHOOK_SECRET`)

GitHub lets you **choose** the secret, so this one has no gap:

1. Generate a new secret. Set `GITHUB_WEBHOOK_SECRET=<new>` and `GITHUB_WEBHOOK_SECRET_PREVIOUS=<old>`; deploy the API (both accepted).
2. In the GitHub App settings, change the webhook secret to the new value.
3. Watch `integration_webhook_rejected_total{provider="GITHUB"}`: it should stay flat.
4. Remove `GITHUB_WEBHOOK_SECRET_PREVIOUS`, deploy.

A delivery rejected for any reason can be replayed from the App's **Advanced → Recent Deliveries → Redeliver** (safe: deliveries are
de-duplicated by delivery id).

## 4. Discord

`DISCORD_PUBLIC_KEY` belongs to the Discord application and cannot be rotated in place (a new application means every guild must
reconnect). `DISCORD_BOT_TOKEN`: **Reset Token** in the Developer Portal, set the new value, deploy; notifications fail (retried, then
the subscription is disabled after repeated failures) between the reset and the deploy, so reset and deploy back to back.

## 5. GitHub App private key / provider client secrets (Slack/Discord/GitHub OAuth)

Generate the new one at the provider, set it in the environment, deploy. Existing installation tokens (GitHub) expire within the hour;
user OAuth tokens already stored keep working (they are not derived from the client secret) but **refreshing** one needs the matching client secret.

## 6. `METRICS_TOKEN`

Change it in the environment and in the Prometheus scrape config. There is no overlap mode: scrapes fail between the two changes, which
only delays metrics.

## After any rotation

`GET /integrations/connections/:id/health` (owner/admin) for one connection per provider: it should report `healthy`.
