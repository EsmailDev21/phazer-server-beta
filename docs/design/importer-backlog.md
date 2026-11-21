# Importer backlog - deferred improvements (recorded after step 4.8)

Nothing here is started. Each item says why it was deferred and what it needs. Owner decision (after the Jira / Linear / ClickUp
limitations review): record now, build later. Estimates of "how much of a source workspace arrives" are the builder's judgment, not
measurements (no live workspace was ever called): work data Linear ~85-90%, Jira ~85-95%, ClickUp ~70-80%; overall feel of the new
workspace Linear ~70%, Jira ~60-70%, ClickUp ~50-60%.

## Highest value first
| # | Item | Provider | Why it matters | What it needs |
|---|---|---|---|---|
| 1 | **Checklists** | ClickUp | Very common in ClickUp; users will miss them first | a checklist model on our tasks (or sub-task conversion) + ClickUp checklist reads (inside the task payload) |
| 2 | **History from time-in-status** | ClickUp | ClickUp's API has no change history; status transitions can be derived | real responses to confirm the bulk time-in-status shape; the ClickApp must be enabled by the workspace |
| 3 | **Linear projects as real projects** | Linear | only a select field today; projects are a main layer in Linear | a project-in-project (or grouping) concept on our side, or a documented decision to keep them as a field |
| 4 | **Workflow transitions** | Jira | diagram 07: "WorkflowTransition rows stored when the source defines them" | `transitionsTo` on the canonical status + validator + mapping + writer; Jira's workflow API needs admin rights (fallback when forbidden) |
| 5 | **Real SELECT fields** | Jira (and ClickUp labels) | selects arrive as text today | field-context options API (admin) with a text fallback |
| 6 | **A DUPLICATES dependency type** | Linear, Jira | duplicates become RELATES_TO plus a text line | extend the shared `DependencyType` enum, the dependency rules and the UI |
| 7 | **Linear inverse relations** | Linear | "ENG-9 blocks me" is lost when ENG-9's team is not imported | query `inverseRelations`, add them to the text fallback |
| 8 | **ClickUp Space as a tag in single-workspace mode** | ClickUp | the Space name is lost when Spaces are merged | one line in the adapter (the per-Space mode already avoids it) |
| 9 | **Boards, saved views, filters** | Jira, Linear, ClickUp | users rebuild them by hand | a saved-view model; per-provider reads |
| 10 | **Automations / rules** | all | not exposed by the APIs (ClickUp, Jira) or out of scope | a rule model and a mapping per provider; likely only a report entry ("these rules existed") |
| 11 | **Worklogs / time tracking entries** | Jira, ClickUp | only totals arrive (Jira) or nothing (ClickUp) | a time-entry model |
| 12 | **ClickUp sprints as real iterations** | ClickUp | sprints arrive as ordinary projects | detect Sprint-folder lists and map them to SPRINT iterations |
| 13 | **Rich ClickUp comments** | ClickUp | plain `comment_text` loses formatting | convert the block-based `comment` array to markdown |
| 14 | **Task in several lists** | ClickUp | arrives once, in its home list. Asana (ADR-0039) already imports such tasks as one COPY per selected project; ClickUp could do the same cheaply, a real membership concept would link the copies | a multi-project membership concept, or the Asana copy approach |
| 15 | **Linear link attachments as real links** | Linear | a text list today | `ExternalLink` kinds beyond PR / ISSUE, or a generic link model |
| 16 | **Updating on re-import** | all | a second import never updates changed comments / fields | change detection by content hash (the hash exists) + update paths in the writer |
| 17 | **@mentions resolved to people** | all | mentions arrive as text | mention parsing + identity matching |
| 18 | **Select-by-context custom field options (Jira) / user fields with several users** | Jira, ClickUp | only the first user of a multi-user field arrives | multi-user field type |
| 19 | **Asana team as a workspace** | Asana | the team (Space analogue) is only a grouping in the picker | set `workspaceNodeType = 'team'` and test `createPerSpace` against Asana's tree (workspaces without teams) |
| 20 | **Asana dependencies across projects** | Asana | an edge is only kept when both ends are in the same project copy | read the blocker's memberships, or emit candidate edges for every selected project |
| 21 | **Asana priority picker** | Asana | the shared field-role picker exists (ADR-0040) but Asana does not use it: "Priority" is guessed by name | offer the project's enum custom fields as `fields` in `discover` (one `custom_field_settings` call per project) |
| 22 | **Asana history from system stories** | Asana | system stories are prose, so no history arrives | parse the common ones ("moved to", "assigned to", "marked complete") once real responses exist |
| 23 | **ClickUp `MAX_LISTS` above the page limit** | ClickUp | 201-500 selected lists fail with `PAGE_TOO_LARGE` | set it to `CANONICAL_LIMITS.maxProjects` (200) or split the structure page |
| 24 | **monday folders** | monday | boards are listed flat under their workspace | read `folders` and nest the board nodes |
| 25 | **monday subitems' comments and files** | monday | subitems arrive as tasks with status / assignee / dates only | include subitem ids in the `items(ids:)` call (cost: more calls against the daily limit) |
| 26 | **monday status category from `done_colors`** | monday | label names are judged by the name heuristic (a guess the person confirms) | read the column's `done_colors` as a HIGH-confidence DONE hint once the settings shape is verified |
| 27 | **monday multi-level boards** | monday | only the classic item + subitem levels are read | read `hierarchy_types` and the deeper levels |
| 28 | **monday plan limits in the UI** | monday | the preview warns (`DAILY_LIMIT`) but the wizard has no way to schedule the import after the reset | allow "start at 00:00 UTC" or split by board across days |
| 29 | **Notion nested pages and inline databases** | Notion | only a row's own page text is read; child pages and databases inside it are not | follow `<page>` / `<database>` references from the markdown, or import child pages as subtasks |
| 30 | **Notion relation roles** | Notion | only self-relations NAMED "Parent item" / "Blocked by" / "Blocking" are structural | add `parent` / `dependency` field roles (ADR-0040 is a closed set: a deliberate change) so the person can choose any relation |
| 31 | **Notion formula and rollup values** | Notion | reported as skipped | import the computed value (typed in the page answer) as a read-only custom field |
| 32 | **Notion page text cost** | Notion | one markdown call per row: a 10,000-row source is about two hours | an import option "skip page text", or text only for rows edited recently |
| 33 | **Notion mentions** | Notion | people / page / date mentions in the text become their plain text | map people mentions to the matched user, page mentions to links between imported tasks |

## Verification debt (not features, but must happen)
- **A first live run per provider** with recorded responses, extending the contract specs; each ADR (0034/0035 Linear, 0036 ClickUp, 0037 Jira, 0039 Asana, 0041 monday.com, 0042 Notion) ends with an "Unverified" list of every field name and behaviour assumed from public documentation.
- Prettier / lint on all of Phase 4; the real-stack run on Prisma 5.22 (the sandbox uses Prisma 7); the HTTP routes (`POST /imports/per-space`, `GET /files/:id/content`) through a real HTTP layer.
- Performance with large imports (Linear complexity limits, ClickUp 100 requests a minute, Jira cost limits): measured, not estimated.
- `FILES_CONTENT_URL_PREFIX` must be set correctly per deployment or re-pointed images will not load; rewritten links need the session cookie (no public file route).
