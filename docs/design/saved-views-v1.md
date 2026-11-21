# Saved views (step 5.4)

A saved view is a named way of looking at tasks: a **layout** plus a **config** (filters, grouping, sort, columns) checked against the workspace's real fields. **Running a view is not part of 5.4** (see the end). Source of truth: `src/views/dsl/`.

## Layouts and what each accepts
`LIST`, `TABLE`, `BOARD`: filters, group, sort, columns, showSubtasks, hideCompleted. `CALENDAR`: filters, columns, flags, **requires** `calendar {dateField}`; no group or sort. `TIMELINE`: as a list plus **requires** `timeline {startField, endField}` (different dates). A key that means nothing for the layout is refused (`NOT_FOR_LAYOUT`), a missing required one is `MISSING`. A board groups only by STATUS / PRIORITY / ASSIGNEE / ISSUE_TYPE / ITERATION or a SELECT custom field; board cards and calendar entries show at most 8 fields.

## Config (v1)
- **filters** `{all?, any?}`, at most 20 conditions in total, using the SAME condition machinery as automation rules (`makeConditionsCheck`, `checkConditionRefs`) over a view-specific field table (`VIEW_FILTER_TABLE`): the shared fields (status, status category, priority, assignees, tags, issue type, project, estimate, is-subtask, custom fields) mean exactly what they mean in a rule, plus ITERATION, TITLE (contains), START_DATE, DUE_DATE (`DUE_WITHIN_DAYS`, overdue...), CREATED_BY. The user token is **`ME`** (whoever opens the view); `TRIGGERER`/`CREATOR` are rule tokens and are not users here.
- **group** `{by | customFieldId}`; **sort** up to 3 keys (`field | customFieldId`, `ASC|DESC`, no repeats); **columns** up to 20 built-in names or `custom:<fieldId>`, no repeats; `showSubtasks`, `hideCompleted`.
- Strict (unknown keys are errors), bounded (16 KB, depth 10), issues are `{code, path (JSON Pointer), message}`.

## Checked against the workspace (`checkViewSemantics`)
Every id exists *in this workspace* (an id from another workspace is simply not found); a specific status only in a **project** view and only that project's (a workspace view names status *categories*); custom filter values fit the field type (real dates, SELECT options); a custom field can be grouped by only if SELECT / USER / CHECKBOX (boards: SELECT), sorted by only if it has an order (not MULTI_SELECT / USER); custom columns exist.

## Personal and shared
| | personal (`isShared: false`) | shared |
|---|---|---|
| sees it | its owner only (anyone else, **including admins**: 404, not 403) | every workspace member |
| create / change / delete | its owner (any MEMBER+) | an admin (`editWorkspace`), whoever made it; 403 `SHARED_NEEDS_ADMIN` |
| names | unique per owner, per scope | unique per workspace, per scope |
| owner deleted | the view is deleted (trigger) | it stays, ownerless |
Sharing or unsharing needs an admin (an ownerless view unshared becomes the unsharer's). **Scope**: a whole-workspace view or one project's (`projectId`, fixed at creation; needs access to that project). `duplicate` makes a personal copy of any view you can see ("save as my own": `Name (copy)`, `(copy 2)`...).

## API (`workspaces/:id/views`, 404 while `FEATURE_WORKFLOW` is off)
`GET` list (`projectId` = that project's AND workspace-wide ones, `layout`, `shared`; shared first, then yours, each by its own `position`; each item has `canEdit`) · `POST validate` (dry run) · `POST` create · `GET :id` (adds `problems`: what is wrong NOW, e.g. a tag deleted since) · `PATCH :id` (name, layout, config, isShared, position; layout and config are re-validated together) · `DELETE :id` · `POST :id/duplicate`. Writes need `manageSavedViews` (MEMBER+); reads need workspace access. Errors: 422 `VIEW_INVALID {issues}`, 409 `NAME_TAKEN | VIEW_LIMIT`, 403 `SHARED_NEEDS_ADMIN`.

## Limits
100 personal views per person per workspace, 50 shared per workspace (workspace row locked while counting: races cannot exceed them).

## Data (migration `20260627000000_step_5_4_saved_views`)
`saved_views`; CHECKs: a personal view has an owner, name bounds, config an object <= 16 KB, position 0..100000; partial unique indexes for the two name rules (scope = project or whole workspace); trigger `trg_users_delete_personal_views` (a deleted user's personal views go, shared ones are kept by the FK's SET NULL). Project / workspace deletion cascades.

## Refactors this step made to 5.1/5.2 code (behaviour unchanged, 157 rule tests unchanged)
Schema combinators moved to `common/dsl/schema.ts` (the old path re-exports); condition checking parameterised by field table (`makeConditionCheck(s)`); the semantic condition checks extracted (`checkConditionRefs`); workspace context loading extracted into `WorkspaceContextLoader` (rules and views share it; it also loads iterations).

## Not done on purpose
**Running a view** (turning config into a task query with paging, grouping, sorting): the filter language is shared with rules so one meaning serves both, but the SQL translation and the equivalence tests belong to a follow-up. Reordering several views in one call (positions are set per view). Audit entries. A project-scoped view's access check is defensive today (every workspace member can see every project); it matters when project-level privacy arrives.
