# ADR-0037 - Jira Cloud connector and importer (step 4.8)

Status: ACCEPTED by the builder; every decision names its alternative. Diagrams: `06-concept-mapping.d2` (Jira column), `07-status-workflow-mapping.d2`.
Goal set by the owner: translate as much Jira data as possible into our data.

## How the research was done (and what it is worth)
No Jira site and no real responses were available. Shapes come from Atlassian's public documentation and typed clients. **All of it is unverified live**; the fixtures are synthetic. Relied on:
- OAuth 2.0 (3LO): authorize `https://auth.atlassian.com/authorize?audience=api.atlassian.com&scope=...&prompt=consent`, token `POST https://auth.atlassian.com/oauth/token` (JSON), **rotating refresh tokens** (every refresh returns a new refresh token; the old one is dead), access tokens last ~1 h, `GET https://api.atlassian.com/oauth/token/accessible-resources` lists the granted sites (`id` = cloudId). Jira calls go to `https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/...`.
- The classic `/rest/api/3/search` is retired: **`POST /rest/api/3/search/jql`** with `nextPageToken` (no `startAt`), `fields: ['*all']`, `expand: 'changelog'`; counts through `POST /search/approximate-count`.
- Project statuses `GET /project/{id}/statuses` (readable without admin), versions, Agile boards and sprints, the field catalog `GET /field`, comments and changelog with `startAt`.

## What is translated
| Jira | Becomes |
|---|---|
| Site (cloudId) | the connection (one site per connection; several authorized -> refused, never guessed) |
| Project | project (key kept) |
| Issue | task (key kept as the task key; id is the external id: keys change when issues move) |
| Sub-task, children of an epic (`parent`) | parent |
| Issue type | issue type; hierarchy level >= 1 -> EPIC, sub-task -> SUBTASK, else STANDARD |
| Status + status category | workflow status of the project (ids `<projectId>:<statusId>`: Jira statuses are shared between projects); `new` -> TODO (BACKLOG by name), `indeterminate` -> IN_PROGRESS, `done` -> DONE; the mapping step lets the person adjust (e.g. Blocked) |
| Priority | priority (the existing table: Highest -> Urgent, Lowest -> Low) |
| Sprint | SPRINT iteration (closed + active + future, through the board's sprints) |
| Fix version | MILESTONE iteration. A task has ONE iteration: its active (else last) sprint, else its first release; the other releases stay as tags `version: X` |
| Labels, components, labels-type custom fields | tags |
| Assignee / reporter | assignee / creator (matched by verified e-mail when Jira shows it; else the importer, with the name in the text) |
| Due date, created, updated | the same |
| Story points | estimate |
| Time tracking | two number fields, original estimate and time spent, in hours |
| Environment | a "Environment" section at the end of the description |
| Custom fields: text, textarea, url, number, date, datetime, user | TEXT / URL / NUMBER / DATE / USER fields |
| Custom fields: select, radio, cascading, multi-select, checkboxes, version, project, group | TEXT fields holding the readable value ("iOS, Web", "EU / DE") |
| Description, comments, environment (ADF) | markdown through the existing ADF converter |
| Files embedded in ADF text | the placeholder is re-linked to the attachment (by exact file name, one match), then re-pointed to our stable file address once copied (4.7b) |
| Attachments | files through the 4.6 pipeline |
| Issue links | "Blocks" -> BLOCKS (the outward side blocks); every other type -> RELATES_TO. Link kinds a dependency cannot say (duplicates, clones, custom) and every link to an issue outside the import are ALSO kept as text ("Links in Jira" at the end of the description) |
| Changelog | history: one entry per changed field, Jira's own field name, original time and actor |

## Decisions
1. **Custom fields are declared on page 0** (the structure page), all supported ones from `GET /field`, plus the two time fields. Found by the integration test: declared lazily on task pages they were silently ignored, because the mapping step and the preview's inventory only know what the structure page declares. The person decides in the mapping step which become fields. *Alternative:* only fields used in the selected projects (needs admin-only field search).
2. **Selects become TEXT.** The options of a select field live in field contexts behind an admin-only API; without them a SELECT cannot be declared. Values keep their meaning as text. *Alternative:* try the options API and fall back; later.
3. **Pacing / paging:** pages of 50 issues (25 with changelog expanded); comments and history longer than the first page are read through follow-up queries; the cursor is `{projects, keys, i, nextPageToken, baseUrl}`.
4. **Rotating refresh tokens:** `refresh()` returns the new refresh token; two concurrent refreshes would kill the connection, so the CALLER (`CredentialService`) must keep serializing them under the per-connection lock, as it already does. A rejected refresh (400/401/403, "invalid_grant") is `ProviderAuthRejectedError`: the job pauses for reconnection.
5. **Attachment addresses are built from ids, never taken from a response**: `https://api.atlassian.com/ex/jira/<this site>/rest/api/3/attachment/content/<id>`. `fetchAttachment` accepts exactly that shape for exactly this site (https, host, path prefix, one id segment, no userinfo) and refuses anything else before any request; the token goes only there. Jira redirects to its media service; fetch does not forward Authorization across hosts. Mutation-checked.
6. **The `toString` trap:** a changelog item without its own `toString` key would, read naively, yield `Object.prototype.toString`. Only an OWN string value is used (test written for it).

## Unverified (list for the first live run)
Token / accessible-resources shapes (and the scope names that identify a Jira site), `search/jql` request and response (token field names, `expand: changelog` limits), `approximate-count`, `users/search` (and whether e-mails are visible), `project/{id}/statuses`, `versions`, Agile `board` / `sprint` shapes and scopes, the sprint field's value shape and its `schema.custom` identifiers (also story points), custom field value shapes, ADF media `alt` carrying the file name, attachment content redirect behaviour, comment / changelog follow-up paging.

## Not done (said in the preview where possible)
- **Workflow transitions and post-functions.** Diagram 07 says "WorkflowTransition rows are stored when the source defines them": the canonical format has no transitions and Jira's workflow API needs administrator rights. The statuses come across; `Project.enforceTransitions` stays off. A later step could add `transitionsTo` to the canonical status and read workflows when allowed.
- Worklogs (only the totals as numbers), boards, filters, dashboards, automation rules, watchers, votes, affected versions, resolution, the legacy "Epic Link" custom field (modern `parent` is used), security levels, Advanced Roadmaps hierarchy beyond one epic level.
- Select options as real SELECT fields (decision 2); users whose e-mail Jira hides cannot be matched.


Deferred improvements for this provider: see `docs/design/importer-backlog.md`.
