# ADR-0034 - Linear adapter (first real importer)

Status: ACCEPTED (step 4.5). Written against Linear's public documentation and tested on SYNTHETIC responses: no live Linear workspace was ever called.

## Context
Steps 4.1-4.4 built the import core, CanonicalBundle, mapping and executor on a fake source. 4.5 is the first adapter that talks to a real provider API, so it is where the provider's quirks must end: after the adapter, everything is canonical.

## Decisions
1. **A Linear TEAM is one of our projects.** Workflow states, the issue key (ENG-42) and cycles all belong to the team, and our project needs exactly one workflow. A Linear *project* can span several teams with different workflows, so it cannot be our project. Supersedes the 4.3 fixture's `team:project` guess.
2. **A Linear PROJECT becomes a value of a "Linear project" SELECT custom field** (options = the distinct project names of the selected teams, case-insensitive). Over 100 distinct names the field is left out (never cut at random) and the estimate warns `PROJECT_FIELD_SKIPPED`. Picker shows teams only; a "pick one Linear project" selection is not offered (deliberate deviation from the handoff's "teams -> projects tree").
3. **Status ids are `<teamId>:<stateId>`.** Linear scopes states per team; the composed id is globally unique and stable. State types map: triage/backlog -> BACKLOG, unstarted -> TODO, started -> IN_PROGRESS, completed -> DONE, canceled -> CANCELED.
4. **Cycles -> iterations (kind CYCLE), scoped to the team**; they ride with the team's first issue page so a page never exceeds the iteration ceiling and a task never references a later cycle. Labels -> tags (names), estimate -> estimate, sub-issue -> parent, priority label (Urgent/High/Medium/Low; "No priority" = no value). Only `blocks` relations become BLOCKS dependencies, and only when the partner's team is in the selection.
5. **Paging.** Page 0 = structure (users incl. disabled, labels, a project per team with statuses, the project field). Then issue pages, 50 issues each, team by team (team ids sorted, so the cursor does not depend on click order). Cursor `{v:1, team, after, pf}` is plain JSON and re-fetchable. Labels / relations beyond 10 per issue are fetched by follow-up queries. Archived issues are included (`includeArchived`) and flagged `archived`.
6. **Errors are translated in `LinearClient`**, because Linear reports failures inside the body: 401 / `AUTHENTICATION_ERROR` -> ProviderAuthRejectedError (pause); `RATELIMITED` (HTTP 400) -> ProviderRateLimitedError with the delay from the reset header (seconds or ms, capped at an hour, default a minute); errors with no data -> ProviderHttpError (4xx fail, 5xx retry). Data plus errors is used as partial data.
7. **OAuth:** `read` scope only (the adapter has no write path; every document is a `query`, asserted in tests). Handles both non-expiring tokens and expiring ones with refresh token (kept when the provider does not rotate). Organization id = the external account.
8. **Estimate** counts issues by paging ids (250 per request, no count field relied on) up to 100 requests per team, then reports "at least" (`COUNT_CAPPED`). Builds the inventory from the structure page and adds Linear's fixed priorities. It warns `NOT_IMPORTED_YET` while comments / attachments / history are requested: 4.6 adds them and removes the warning.
9. **Task `archived` is now written** (found by the end-to-end test: the mapping carried it but the writer ignored it, so Linear's auto-archived issues would have arrived active). Additive: `TaskWriteExtras.archived`, honoured on an IMPORT context only; `archivedAt` = source update time.

## Not in this step / limits
- Comments, attachments, history (4.6). Linear-hosted images in descriptions stay as links.
- Complexity model (about 3,000 points per issue page, 250k/hour budget => a few thousand issues per hour at best) is from Linear's documentation, not measured. Big workspaces will pause and resume many times by design.
- Unverified against the live API: `includeDisabled` on `users`, `orderBy: createdAt`, the revoke call shape, the rate-limit header units, the token response `scope` shape. Each has a defensive path; the first live run will tell.
- Issues created in Linear while an import runs may or may not be included. A Linear project shared by several teams appears as the same option label in each.


Deferred improvements for this provider: see `docs/design/importer-backlog.md`.
