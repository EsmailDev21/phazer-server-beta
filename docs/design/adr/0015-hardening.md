# ADR-0015 - Integrations hardening: metrics, connection health, limiter tuning, rotation, lifecycle

**Status:** Accepted (2026-10, step 2.7). **Owner decisions:** Prometheus via `prom-client`; `/metrics` behind a bearer token and the
health endpoint per account for OWNER/ADMIN; the three known-gap items are in scope.

## Context
Steps 2.1-2.6 shipped the adapters. Nothing observed them (no metrics existed), an admin had no way to ask "why is Slack not
posting", the outbound limiter used one setting for every provider, a key rotation had a vault but no way to finish it, and three
known gaps were open: an uninstalled Slack app stayed "ACTIVE", `channel_deliveries` grew forever, unlinked chat users could
trigger a provider lookup and a token write on every message.

## Decisions
1. **Metrics: Prometheus text at `GET /metrics`, two kinds of series.** In-process *counters* (webhook rejections by provider and
   reason, duplicates dropped, provider calls by host/outcome, breaker trips) exist only in the process that serves `/metrics` (the API;
   the worker has no HTTP listener). Everything that must be right whichever process did the work - queue depth and oldest-waiting
   age, deliveries by status in the last hour, oldest pending delivery, disabled subscriptions, connections by status, credentials by
   key id - is a *gauge computed at scrape time* from Redis/Postgres (5 s cache, 2 s Redis timeout, a failing collector drops only
   its own series). Consequence: worker-side provider counters are **not** exported; delivery failures are visible through the DB
   gauge instead. If worker-side counters are wanted later, give the worker a tiny metrics listener (a new decision).
2. **Access.** `/metrics` is `@Public` but requires `Authorization: Bearer <METRICS_TOKEN>` (constant-time compare). No token, or one
   under 16 characters = **404**, so an unconfigured deployment does not advertise it. Labels carry only enumerated values
   (provider, status, reason, host, queue, kid); never ids, names or payloads. The health endpoint is
   `GET /integrations/connections/:id/health`, `manageIntegrations` (OWNER/ADMIN) of the connection's account, resolved in the service.
3. **Limiter tuning.** The budget stays per connection but is now a per-host *profile* (Discord 40/25 per s, Slack 10/1, GitHub
   20/5), overridable with `PROVIDER_HTTP_TUNING`. These numbers sit below each provider's documented ceiling and are a starting point
   to tune from the new metrics, **not a measurement** (nothing was run against the real providers). Also changed: 5xx/network
   retries now back off with full jitter (they used to retry instantly); a 403 carrying `Retry-After` or `X-RateLimit-Remaining: 0`
   (GitHub's limits) is treated as rate limiting while a plain 403 is still a permission error; the half-open breaker lets **one**
   probe through instead of a burst, and a probe that ends without a verdict releases its slot.
4. **Health endpoint answers from our own state, makes no provider call** (a page refresh must not spend the rate budget): status,
   credential key id/expiry/refreshability, provider configuration, link and subscription state, 24 h delivery counts, last failure,
   backlog. Verdict: any *error* issue = `down`, only warnings = `degraded`, none = `healthy`. It never returns token material.
5. **Rotation.** `integrations:reencrypt` moves credentials onto the current key with a compare-and-swap on the ciphertext it read
   (a concurrent refresh wins), reports undecryptable rows by connection id and error name, and is idempotent. Slack and GitHub accept an
   optional `*_PREVIOUS` secret for the overlap window; the primary must always be valid and the previous one never extends the replay
   window. Procedure: `docs/runbooks/key-rotation.md`.
6. **Lifecycle gaps closed.** Slack `app_uninstalled`, and `tokens_revoked` when it lists a **bot** token, soft-revoke the connection
   (REVOKED, credential deleted, links paused and kept, one `INTEGRATION_DISCONNECTED` audit with `system: true`); user tokens in
   `tokens_revoked` are ignored (we hold none). `channel_deliveries` older than `CHANNEL_DELIVERY_RETENTION_DAYS` (default 30, floor 7)
   are deleted hourly in batches whatever their status, on the always-on `system` queue (new index on `created_at`). Identity prompts are
   limited per (connection, chat user) 3 per 15 min and per connection 60 per 15 min; over the limit **no token is issued and no
   provider lookup is made** and the user is told to use their earlier message. The counter is in Redis, falling back to in-process (never
   fails closed).

## Consequences / not done
- Existing Slack apps must add `app_uninstalled` and `tokens_revoked` to their bot events (the manifest has them; installed apps do not
  change by themselves).
- No dashboards or alert rules are shipped; suggested alerts: `queue_oldest_waiting_age_seconds > 300`, `queue_inspection_up == 0`,
  `integration_channel_delivery_oldest_pending_age_seconds > 600`, rising `integration_webhook_rejected_total{reason!="expired"}`,
  `integration_credentials_by_kid{kid=<retired>} > 0`.
- Identity-prompt throttling is a fixed window (a user can get a burst at a window edge); fine for its purpose.
- Enterprise Grid, unlink/comment commands, review/CI events remain open (unchanged from 2.5/2.6).
