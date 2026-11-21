# ADR-0036 - ClickUp connector and importer (step 4.7)

Status: ACCEPTED by the builder; every decision names its alternative. Diagrams: `06-concept-mapping.d2` (concepts), `07-status-workflow-mapping.d2` (statuses, priorities).

## How the research was done (and what it is worth)
No ClickUp workspace and no real API responses were available. Shapes come from ClickUp's public documentation (developer.clickup.com: authentication, rate limits, tasks, comments pagination, attachments, the endpoint list) and third-party typed clients. **Every shape below is therefore unverified against a live response.** The fixtures are synthetic and written to follow those sources. First live run: record real responses and extend a contract spec (like Linear's).

Facts taken from the documentation and relied on:
- OAuth 2: authorize at `https://app.clickup.com/api?client_id&redirect_uri&state`; code -> token at `POST /api/v2/oauth/token`; **the token does not expire and has no refresh token**; no revoke endpoint. The person picks the authorized Workspace(s) on ClickUp's consent screen.
- **Rate limit: 100 requests per minute per token** (Free, Unlimited, Business; 1,000 Business Plus; 10,000 Enterprise). A 429 carries `X-RateLimit-Limit / Remaining / Reset` and **no `Retry-After`**.
- `GET /list/{id}/task`: 100 per page, `page` from 0, `last_page`, `subtasks`, `include_closed`, `archived`, `include_markdown_description`; timestamps are epoch milliseconds as strings. **The list endpoint returns files only when attached through custom fields**; all files need `GET /task/{id}`.
- Comments: newest first, 25 per page, continued with `start` (date) AND `start_id`; replies through `GET /comment/{id}/reply`.

## Decisions
1. **Concept mapping (diagram 06).** List -> project (the unit that owns statuses in ClickUp); the folder it sits in -> a tag on its tasks (folderless lists report a folder named "hidden": no tag); Space -> the job's destination workspace (the selection may be spaces, folders or lists, resolved once to a sorted list-id set kept in the cursor). **Superseded in part by 4.7b below: a Space can also be its own workspace.**; tags -> tags; subtask `parent` -> parent; assignees (several) -> assignees; custom task types -> issue types (+ built-in Milestone, id 1); `points` -> estimate; dependencies -> BLOCKS, linked tasks -> RELATES_TO.
2. **Statuses (diagram 07).** Per-list statuses with list-scoped ids (`<listId>:<name>`): `open` -> TODO (BACKLOG when named so), `custom` -> IN_PROGRESS, `done` / `closed` -> DONE; ClickUp has no "canceled". The existing mapping step then lets the person adjust (e.g. "blocked"). Priorities Urgent / High / Normal / Low go through the existing table (Normal -> MEDIUM).
3. **Dependency direction.** An entry `{task_id, depends_on}` reads "task_id waits for depends_on" (the API's own wording for the write side), so the blocker is `depends_on`. Both tasks list the same relation; the external id is one deterministic string per edge. *Unverified*; mutation-checked in tests.
4. **Custom fields are Workspace-wide in our model:** a ClickUp field is identified by its id, options are the union over the lists. Mapped: text-likes, url, number / currency / rating, date, checkbox, drop_down (value is an orderindex or option id), labels, users (first user). Not mapped (reported by name and count in the preview): formula, location, relationship, files, progress, ...
5. **History is NOT imported.** ClickUp's public API has no task change history. The optional "time in status" endpoints need a ClickApp enabled and their shape is uncertain, so nothing is derived or invented; the preview says so (`HISTORY_NOT_AVAILABLE`). *Alternative:* derive status changes from time-in-status once real responses exist.
6. **Sprints, views, automations are not imported** (sprints are ordinary lists in a Sprint folder: they arrive as projects; the API exposes no views / automations to copy). Not reported per item: they are not in the API the importer reads.
7. **Pacing (the real constraint).** Each request carries its own bucket (`ProviderRequest.rate`, additive in `ProviderHttpClient`): default 90 a minute with a burst of 5, `CLICKUP_REQUESTS_PER_MINUTE` (10-10,000) for higher plans. A real 429 becomes `ProviderRateLimitedError` using `X-RateLimit-Reset` (the client now understands it when `Retry-After` is absent) -> the executor's delayed retry. **Comments and files cost one request per task each** (comments are not in the task list; files need `GET /task/{id}`): at 90 a minute, comments + files for 6,000 tasks take about 2.2 hours. The preview computes and shows this (`CONTENT_SLOW`). Without content: about 100 tasks per request.
8. **One Workspace per connection.** A token can cover several; if the consent screen authorized more than one the connection is refused with a clear message (never a guess), as is none.
9. **Files.** Only `https` URLs on ClickUp-owned hosts (`clickup.com`, `*.clickup.com`, `clickup-attachments.com`, `*.clickup-attachments.com`, no port, no userinfo) are ever requested, and the token is sent only there (`isClickUpFileUrl`, checked when the attachment is built AND again in `fetchAttachment`; mutation-checked). Whether downloads need the header depends on the Workspace's private-attachment-links setting: it is sent either way. Everything else (quota, dedupe, caps, pauses) is the 4.6 pipeline.
10. **Archived tasks** come in a second pass per list (`archived=true`); the writer's references make an overlap harmless.

## Found while building (by the tests)
Folderless lists carry a `folder` object named "hidden" in the API shape the fixtures encode: without the `hidden` check every task of such a list got a tag "hidden". Fixed in the cursor builder.

## Unverified (list for the first live run)
Token endpoint body format (JSON vs query), `GET /team` members shape, `GET /list/{id}` including `statuses` and `folder`, `/list/{id}/field` option shapes and drop_down value semantics, dependency / link entry fields, `custom_item` endpoint, `markdown_description` on the list endpoint, `archived=true` returning archived only, comment `date` / `reply_count`, attachment object (`url`, `size`, `mimetype`, `extension`), the file hosts, the Authorization header on downloads.

## Not done
History, per-list "task in several lists" (a task appears once, in its home list), checklists, time tracking, goals, docs, whiteboards, guests, comment attachments / reactions, comment markup (plain `comment_text` is used).


## Addendum 4.7b - Space = Workspace; Linear relations; stable file links
Requested by the owner after the first limitations review.

### Space = Workspace (diagram 06: "new, or merge into existing")
- `POST /imports/per-space { connectionId, options?, spaces: [{ spaceId, workspaceId?, sources? }] }` (`ImportsService.createPerSpace`). For each Space: a NEW workspace named after it, or the EXISTING one named in `workspaceId` (merge). `sources` optionally narrows the Space to some of its folders / lists.
- **A job still has exactly ONE destination workspace.** The method only prepares N jobs (DRAFT, selection set); mapping, quota, progress, rollback and the executor are untouched. *Alternative:* one job spanning workspaces (a per-page workspace in the writer, mapping per workspace): rejected, every invariant of 4.4 would change.
- Order: parse -> connection (active) -> permissions (creating needs `createWorkspace` on the account, i.e. ADMIN+; an existing target needs `runImport` and must be in the connection's account; nothing of the provider's tree is revealed before) -> tree -> validate every Space / source belongs together -> plan limit for ALL new workspaces at once -> create. If anything fails after a workspace was made, the workspaces made by this call are deleted again (empty: nothing was imported).
- Generic by capability: an adapter opts in with `workspaceNodeType` (ClickUp: `'space'`); Linear has none (its organization is the connection, a team is one of our projects) and is refused with a 400.
- The Space name is therefore no longer lost in this mode. In the old single-workspace mode the Spaces still merge without a trace (use per-space to avoid that).
- Folder -> project was considered and NOT done: ClickUp statuses belong to the LIST, so folders would merge unrelated status sets, and folderless lists need a fallback. List -> project with the folder as a tag stays.

### Linear relations
`blocks` -> BLOCKS (as before); `related`, `similar`, `duplicate` -> RELATES_TO. We have no DUPLICATES type (a shared enum, not touched), so every `duplicate`, and every relation of ANY kind to an issue of a team that is not imported, is also kept as text: a "Relations in Linear" list at the end of the description ("Marked as a duplicate of ENG-4 - title", "Blocks OTH-9 - title (not imported)"). Still not seen: relations where ANOTHER issue is the source and that issue is not imported (Linear's inverse side is not queried).

### Stable file links (the diagram's "repoint link")
- New `GET /files/:id/content`: same permission as `download-url`, answers 302 to a fresh signed URL. Authentication is the existing httpOnly session cookie, so an `<img src>` works from the app. The address can live in text for ever, unlike a signed URL.
- After a file is copied, in the SAME transaction that confirms it, every occurrence of the address it was fetched from is replaced by `<FILES_CONTENT_URL_PREFIX>/files/<attachmentId>/content` in the task's description and in the task's comments. `TasksService.rewriteImportedText` (IMPORT origin only, silent, `updatedAt` put back) is the only new write to a task; comments keep their `updatedAt`. A file that was not copied (gone, too large) keeps its source link. Sources whose text never contains the file address (ClickUp) are untouched.
- `FILES_CONTENT_URL_PREFIX` (e.g. `/api`) is where the API is reachable from the browser; default none. It must be set correctly per deployment or the rewritten images will not load.
- Rewritten links are only as good as that route's session auth: a shared / public view of a task would not show them (no public file route exists).


Deferred improvements for this provider: see `docs/design/importer-backlog.md`.
