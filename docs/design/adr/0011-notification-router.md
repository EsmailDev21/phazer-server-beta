# ADR-0011 - Notification router: activity -> chat channel

Status: ACCEPTED (step 2.3). Owner decisions: d.5 (admin REST API now); d.6 (burst policy: delegated "suggest best", accepted as written).

## Context
Diagram 08: an activity in the app should show up in subscribed Slack/Discord channels, once, without echoing a chat command's own
effect back into the channel it came from, without notifying on silent/bulk writes, and without a dead channel being retried forever.
2.1 created the tables (`channel_links`, `channel_subscriptions`, `channel_deliveries`); real provider `notify` implementations are 2.4/2.5.

## Decisions
1. **Pipeline.** `NotificationRouter` (`@OnEvent('activity.created')`) -> match -> one `ChannelDelivery(PENDING)` per match -> `notify.deliver` job on
   the new `notify` queue (flag `INTEGRATIONS`, concurrency 5, the platform's default 5 attempts / exponential backoff) -> `NotifyDeliverJob` -> `adapter.notify()`.
   The router lives in BOTH processes (`IntegrationNotifyModule`): each routes the activities it emitted itself, so a due-date reminder raised by the worker is routed
   by the worker. It never throws into the emitter. Provider plumbing moved to `IntegrationCoreModule`, shared by API and worker.
2. **Matching** (all must hold): subscription enabled; action in `events` and in the notifiable set (MENTIONED, REACTED, tags excluded); link is `CHANNEL`, not paused,
   in the activity's workspace, workspace-wide or bound to the activity's project; connection ACTIVE **and belonging to the workspace's own account** (defence in depth);
   visibility: `minVisibility = TIMELINE` accepts TIMELINE only, `SILENT` accepts both (so DUE_DATE_APPROACHING, SILENT by default, needs an opt-in subscription).
   Silent/bulk writes never reach the router at all (ActivityService does not emit them): "silent never notifies" is inherited, and tested through the real service.
3. **Message.** Provider-neutral `RichMessage {title, url, summary, fields, actor, tone}` built from the activity, resolving status names and the actor; every free-text
   value is cut (title 200, summary 300) so no provider limit can be blown. Link = `TASK_URL_TEMPLATE` (`{key}`, `{id}`) else `{FRONTEND_URL}/tasks/{KEY-N}` (**assumed path, not verified against the frontend**).
   Adapters render it; `notify?(ctx)` is an optional adapter member (`NotifyContext`), `NotifyPermanentError(code)` = destination gone/forbidden.
4. **Echo guard.** `WriteContext.integrationSource {connectionId, channelId}` is recorded in activity metadata (`integration`); the router records `SKIPPED/echo` for the one
   link whose connection and channel id match, and still notifies every OTHER channel. A write without a source (web UI) is never an echo.
5. **Admin REST API (owner decision)**, OWNER/ADMIN of the connection's account (`manageIntegrations`, resolved in the service, ids that do not exist 404):
   `GET|POST /integrations/connections/:id/channel-links`, `DELETE /integrations/channel-links/:linkId`, `GET .../channel-links/:linkId/deliveries?limit`,
   `POST .../channel-links/:linkId/subscriptions`, `PATCH|DELETE /integrations/subscriptions/:subId`. Links created here are `CHANNEL` only, in a workspace of the same account,
   optionally one project of it. Default events `CREATED, STATUS_CHANGED, ASSIGNED, COMMENTED, ARCHIVED`. Re-enabling clears `failureCount` and `disabledReason` (a human decided).
   Chat commands in 2.4-2.6 will create the same rows.
6. **Bursts (delegated -> accepted).** One message per event; per subscription at most `NOTIFY_MAX_PER_MINUTE` (default 20) non-skipped deliveries in a sliding minute, the excess is
   recorded `SKIPPED/rate_capped` and never queued. No digest: it changes message semantics and wants a product decision once real traffic exists. The cap protects the provider
   budget (the HTTP client still shares a per-connection bucket) and the channel from a flood.
7. **Failure policy.** Delivery outcomes: `SENT`; `SKIPPED` with a reason (state changed while queued: disabled/paused/inactive/no notify/target deleted/needs re-auth: nobody is blamed);
   `FAILED` (counts). Permanent error -> FAILED at once; transient -> the queue retries, FAILED `retries_exhausted` on the last attempt. Only CONSECUTIVE failures count: a SENT resets the
   streak. At 3 the subscription is disabled (atomic flip: exactly one alert however many jobs fail together), `disabledReason` is stored and one audit `INTEGRATION_SUBSCRIPTION_DISABLED` raised.
8. **Alerts reach the sole admin.** Audit rows with `metadata.system = true` no longer exclude the actor from the fan-out. AuditLog needs an actor, so system events borrow a real user (the link's
   configurer / connection creator); without this change a one-admin account would never hear that its integration broke. The 2.1 `NEEDS_REAUTH` alert uses it too (closes the 2.1 gap).
9. **Idempotency.** Unique `(subscription, activity)`: routing twice, or an event delivered twice, creates one delivery and one job (`jobId = notify-<deliveryId>`). Only PENDING rows are processed.

## Consequences
- Until 2.4/2.5 implement `notify`, real deliveries end `SKIPPED/adapter_cannot_notify`; the whole path is tested with a fake adapter only.
- The delivery job re-reads the world: a link paused or a connection revoked after routing is respected.
- `channel_deliveries` grows with traffic; no retention sweep yet.
- If the activity's task is deleted before sending: `SKIPPED/target_gone`.
