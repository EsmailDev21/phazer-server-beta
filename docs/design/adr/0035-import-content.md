# ADR-0035 - Import content: comments, history, attachments (step 4.6)

Status: ACCEPTED by the builder on the owner's attaching diagrams 04 and 05 without objection to the four recommendations; the owner can still overturn any decision below (each names its alternative).

Diagrams: `04-import-job-lifecycle.d2` (P6 comments, P7 history, P8 attachments), `05-import-run-dataflow.d2` (lane "Attachment copy").

## What is written, and where
| Content | Written as | Visible where |
|---|---|---|
| Comment | `comments` row (TASK target), one reply level, original `createdAt` / `updatedAt` / `editedAt` when the job keeps dates; author = verified member, else the importer (name already in the text, see mapping) | the task's comments, as any comment |
| History entry | `activities` row, action `IMPORTED_CHANGE`, visibility `IMPORTED`, original time when keepDates (always in `metadata.at`), actor = member or importer + `metadata.actor.name` | **only** `GET /activities?targetType=TASK&targetId=..&includeImported=true`. Never the workspace feed, never emitted, never notified |
| File | `attachments` row + object, copied server-side | the task's attachments, as any file |

## Decisions (the four forks)
1. **`IMPORTED` visibility** (not a flag on TIMELINE rows). The feed filters `visibility = TIMELINE` positively, so a new value is invisible everywhere that was not changed. `includeImported` needs a task target (400 otherwise): imported history is the task's own tab. *Alternative:* a flag column; rejected, every feed query would need to learn it.
2. **`createdAt` override on `ActivityService.record(Many)`**, honoured only when the context says `keepOriginalDates` (which `assertWriteContext` already restricts to origin IMPORT); a silent IMPORT write may ask for `IMPORTED`, every other silent write is still forced SILENT.
3. **`StorageProvider.putObject(key, stream, {mimeType, maxBytes})`**: S3 multipart, 8 MiB parts, one part in memory, SHA-256 and size while streaming, `StorageObjectTooLargeError` the moment the cap is crossed, abort on any failure. No `@aws-sdk/lib-storage` (no new dependency).
4. **Comments are written directly, NOT through DomainWriter** (deviation from the recommendation). Comments carry no rule an import must keep (no permission check, notification, mention fan-out, COMMENTED activity), and wrapping them would pull the collaboration module into DomainWriterModule for no reuse. Idempotency is the `ExternalRef` (written in the same transaction as the comment), not a new unique column. *Alternative:* a `DomainWriter.createCommentsBulk`; cheap to add if a later rule needs it.

## The file pipeline (diagram 05)
- `afterTaskChunk` writes `import_file_items` rows in the SAME transaction as the tasks (new table, per job: provider ref, name, declared size, uploader, status PENDING/DONE/SKIPPED/FAILED, attempts, reserved attachment id).
- After the pages and LINKS the executor sets `checkpoint.phase = 'FILES'` and enqueues `imports.copy-files` on the new queue **`import-files`** (concurrency 1) in one transaction with the checkpoint write. The job stays RUNNING; `runFiles` drains the items (at most 200 per run, then hands back like a page budget) and calls the same `finish()`. A resume / retry in phase FILES just re-enqueues the copy job with the new attempt. Stale attempts act on nothing.
- Per file (`ImportFileCopier`): open stream -> per-file cap (declared size) -> **reserve quota** (PENDING row, one advisory lock per account around check + insert) -> stream into storage -> confirm. Confirm = ONE transaction: row CONFIRMED (+ real size, sha256, original `createdAt`), `ExternalRef`, item DONE; it refuses if the job is no longer RUNNING (a cancel mid-copy leaves no ref and no confirmed row).
- **Sha dedupe:** if the same account already holds a CONFIRMED row with the same SHA-256 and size, the new row points at THAT object and the fresh one is released. One object, several rows; the quota still counts every row (a deliberate, conservative choice). `AttachmentsService.delete` is now reference-aware (row first, then the object only if no row references it); the twin is locked `FOR SHARE` during confirm so a concurrent delete cannot strand it.
- Per-file outcomes never fail the job: gone at the source (400/403/404/410/422/451) -> FAILED + WARN `ATTACHMENT_UNAVAILABLE`; over the plan's per-file limit (declared or measured while streaming) -> SKIPPED + WARN `ATTACHMENT_TOO_LARGE`; 3 failed attempts -> FAILED + `ATTACHMENT_FAILED`. Job-level: 401 -> PAUSED (reconnect); 429 / 5xx / network / S3 5xx -> delayed retry; **storage plan full -> PAUSED** with the plan-limit message (nothing reserved past the limit). Attachment counters are derived from the item rows, so a replay cannot double them.
- `ProviderHttpClient.openStream`: same breaker / token bucket / Retry-After as `request()` (shared `fetchWithPolicy`), body never buffered, own 15-minute transfer timeout.

## Linear specifics
- **Linear's own "attachments" are links**, not files. They are appended to the description as a short "Linked in Linear" list (http/https only). *Alternative:* `ExternalLink` rows; its kinds are PR / ISSUE and belong to the webhook adapters. The files are the **uploads referenced in the description and comments** (`uploads.linear.app`), attached to the task. The text is NOT rewritten (our attachments are served by short-lived signed URLs, which cannot live in markdown): the original links stay as written. This is a limit; the diagram's "repoint link" is not done.
- **SSRF guard:** a providerRef comes from text a Linear user wrote. The adapter only ever emits, and `fetchAttachment` re-checks, `https://uploads.linear.app/...` (no port, no userinfo); anything else is refused before any request, and the token is only sent there. Mutation-checked.
- **Cost:** content makes an issue far costlier for Linear's complexity limit. With content the page is 10 issues (nested 25 comments / 25 history); on a "too complex" answer the page is halved (down to 1) and remembered in the cursor (`ps`). Rough model: ~6,500 points per content page, i.e. only a few hundred issues per hour if the limit is ~250k/hour. **Importing history of a large Linear workspace will be slow**; the estimate says so (`CONTENT_COUNT_UNKNOWN`).
- One Linear history record can change several fields: one entry per field (`<recordId>:<field>`), values as display strings.

## Rollback (never deletes what a person added)
Order: files -> comments -> history -> tasks. Imported replies go first; an imported comment somebody replied to is KEPT (deleting it would delete their reply). A task that still has a comment or a file after the import's own are gone is KEPT (a person engaged with it) and reported. Imported history is removed by job id even from kept tasks. Objects are deleted only when no row references them.

## Unverified (no live Linear in the sandbox)
Field names of `comments`, `history` (`fromState`, `toState`, `fromAssignee`, `addedLabels`, `updatedDescription`, ...), `attachments`, the `Authorization` header on `uploads.linear.app` downloads, and the "too complex" error text (matched on `/complex/i` in the response body). First live run: record responses and extend `linear.contract.spec.ts`.

## Not done
Re-import does not update changed comments; attachments' activity (`ATTACHMENT_ADDED`) and `COMMENTED` rows are deliberately not written (the content is the record); no "skip remaining files" escape when the storage plan is full (free space or upgrade, then resume); 100k-issue performance is not measured.


Deferred improvements for this provider: see `docs/design/importer-backlog.md`.
