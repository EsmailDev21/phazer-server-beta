# Manual actions inventory (state-changing endpoints) and what to do about each

Generated from the controllers (113 POST/PUT/PATCH/DELETE routes) and classified by hand. Companion to `HANDOFF_PHASE_5_NEXT.md`.

| Mark | Meaning |
|---|---|
| ✅ have | an automation action already covers it |
| 🟡 add | worth adding; no special danger beyond the usual |
| 🔒 guarded | add only behind an authority ceiling and extra safeguards (see handoff section 6.2) |
| ⛔ never | not offered to rules (identity, money, membership, destructive, authoring) |

`Required access today` is the `@RequireAccess` action on the controller; `(in service)` means the controller has no decorator and the SERVICE authorises (a rule calls the service directly, so a rule needs its own authority model). `ctx plumbing` = does the service already accept a `WriteContext` (the stamp that makes loop guards and attribution work)?

| Area | Method | Route | Required access today | Mark | Automation action(s) | Authority ceiling | ctx plumbing | Notes |
|---|---|---|---|---|---|---|---|---|
| access-control | POST | /access-control/check | (in service) | ⛔ never | - | - | - | Identity, money, AI sessions and webhooks are not workflow. |
| activity-notifications/notifications | PATCH | /notifications/:id/read | (in service) | ⛔ never | - | - | - | Personal to a user. |
| activity-notifications/notifications | PATCH | /notifications/read-all | (in service) | ⛔ never | - | - | - |  |
| activity-notifications/watches | DELETE | /watches | (in service) | 🟡 add | REMOVE_WATCHER | member | needed |  |
| activity-notifications/watches | POST | /watches | (in service) | 🟡 add | ADD_WATCHER (users) | member | needed |  |
| attachments | DELETE | /files/:id | (in service) | 🔒 guarded | REMOVE_ATTACHMENT (those a rule added) | admin | needed | COPY_ATTACHMENTS (task to task) is the more useful one. |
| attachments | POST | /files/:id/confirm | (in service) | ⛔ never | - | - | - |  |
| attachments | POST | /files/upload-url | (in service) | ⛔ never | - | - | - | Upload flow is a client concern. |
| auth | POST | /auth/login | (in service) | ⛔ never | - | - | - | Identity, money, AI sessions and webhooks are not workflow. |
| auth | POST | /auth/logout | (in service) | ⛔ never | - | - | - | Identity, money, AI sessions and webhooks are not workflow. |
| auth | POST | /auth/refresh | (in service) | ⛔ never | - | - | - | Identity, money, AI sessions and webhooks are not workflow. |
| auth | POST | /auth/register | (in service) | ⛔ never | - | - | - | Identity, money, AI sessions and webhooks are not workflow. |
| auth | POST | /auth/resend-verification | (in service) | ⛔ never | - | - | - | Identity, money, AI sessions and webhooks are not workflow. |
| auth | POST | /auth/verify-email | (in service) | ⛔ never | - | - | - | Identity, money, AI sessions and webhooks are not workflow. |
| automations | POST | /workspaces/:id/automations | manageAutomations | ⛔ never | - | - | - | A rule does not author rules. |
| automations | DELETE | /workspaces/:id/automations/:automationId | manageAutomations | ⛔ never | - | - | - | A rule does not author rules. |
| automations | PATCH | /workspaces/:id/automations/:automationId | manageAutomations | 🔒 guarded | ENABLE_AUTOMATION / DISABLE_AUTOMATION (by name) | admin | n/a | "Holiday mode": a schedule switches rules on and off. Meta-loops need a guard. |
| automations | POST | /workspaces/:id/automations/validate | manageAutomations | ⛔ never | - | - | - | A rule does not author rules. |
| billing | POST | /accounts/:id/billing/checkout | (in service) | ⛔ never | - | - | - | Identity, money, AI sessions and webhooks are not workflow. |
| billing | POST | /accounts/:id/billing/portal-url | (in service) | ⛔ never | - | - | - | Identity, money, AI sessions and webhooks are not workflow. |
| billing | POST | /accounts/:id/billing/subscription/cancel | (in service) | ⛔ never | - | - | - | Identity, money, AI sessions and webhooks are not workflow. |
| billing | POST | /accounts/:id/billing/subscription/resume | (in service) | ⛔ never | - | - | - | Identity, money, AI sessions and webhooks are not workflow. |
| billing | POST | /billing/webhook/mor | (in service) | ⛔ never | - | - | - | Identity, money, AI sessions and webhooks are not workflow. |
| billing | POST | /billing/webhook/stripe | (in service) | ⛔ never | - | - | - | Identity, money, AI sessions and webhooks are not workflow. |
| billing | POST | /billing/webhook/tunisia-gateway | (in service) | ⛔ never | - | - | - | Identity, money, AI sessions and webhooks are not workflow. |
| collaboration/comments | POST | /comments | (in service) | ✅ have | COMMENT (system author) | member | done | Mentions and replies still missing. |
| collaboration/comments | DELETE | /comments/:id | (in service) | ⛔ never | - | - | - |  |
| collaboration/comments | PATCH | /comments/:id | (in service) | ⛔ never | - | - | - | A rule edits only what it wrote; not offered. |
| collaboration/reactions | POST | /reactions | (in service) | 🟡 add | REACT (low value) | member | needed |  |
| projects-tasks/custom-fields | DELETE | /custom-fields/:id | (in service) | 🔒 guarded | DELETE_CUSTOM_FIELD | admin | needed |  |
| projects-tasks/custom-fields | PATCH | /custom-fields/:id | (in service) | 🔒 guarded | UPDATE_CUSTOM_FIELD (options only) | admin | needed | Type changes: never. |
| projects-tasks/custom-fields | DELETE | /tasks/:id/custom-values/:fieldId | (in service) | ✅ have | SET_CUSTOM_FIELD (null) | member | n/a (no activity) | No change event exists for custom values: add one before offering a trigger on it. |
| projects-tasks/custom-fields | PUT | /tasks/:id/custom-values/:fieldId | (in service) | ✅ have | SET_CUSTOM_FIELD | member | done (setValue has ctx) |  |
| projects-tasks/custom-fields | POST | /workspaces/:id/custom-fields | manageCustomFields | 🔒 guarded | CREATE_CUSTOM_FIELD | admin (manageCustomFields) | done (DomainWriter.createCustomField) |  |
| projects-tasks/issue-types | POST | /workspaces/:id/issue-types | manageWorkflow | 🔒 guarded | CREATE_ISSUE_TYPE | admin | needed |  |
| projects-tasks/issue-types | DELETE | /workspaces/:id/issue-types/:typeId | manageWorkflow | ⛔ never | - | - | - |  |
| projects-tasks/issue-types | PATCH | /workspaces/:id/issue-types/:typeId | manageWorkflow | 🔒 guarded | UPDATE_ISSUE_TYPE | admin | needed |  |
| projects-tasks/iterations | POST | /workspaces/:id/iterations | manageWorkflow | 🟡 add | CREATE_ITERATION (next sprint) | admin | needed | Natural pair with SCHEDULE. |
| projects-tasks/iterations | DELETE | /workspaces/:id/iterations/:iterationId | manageWorkflow | ⛔ never | - | - | - |  |
| projects-tasks/iterations | PATCH | /workspaces/:id/iterations/:iterationId | manageWorkflow | 🔒 guarded | UPDATE_ITERATION | admin | needed |  |
| projects-tasks/iterations | POST | /workspaces/:id/iterations/:iterationId/close | manageWorkflow | 🟡 add | CLOSE_ITERATION (+ roll over open tasks) | admin | needed | Rollover is the valuable part: a bulk action. |
| projects-tasks/iterations | POST | /workspaces/:id/iterations/:iterationId/reopen | manageWorkflow | 🔒 guarded | REOPEN_ITERATION | admin | needed |  |
| projects-tasks/iterations | POST | /workspaces/:id/iterations/:iterationId/start | manageWorkflow | 🟡 add | START_ITERATION | admin | needed |  |
| projects-tasks/projects | POST | /projects | (in service) | 🔒 guarded | CREATE_PROJECT | admin | done (ctx on create) | Workspace-level. Plan limits apply (a worker never gets the guard). |
| projects-tasks/projects | DELETE | /projects/:id | (in service) | ⛔ never | - | - | - | Never from a rule. |
| projects-tasks/projects | PATCH | /projects/:id | (in service) | 🟡 add | UPDATE_PROJECT (name, description) | admin | needed |  |
| projects-tasks/projects | POST | /projects/:id/archive | (in service) | 🔒 guarded | ARCHIVE_PROJECT | admin | needed | Reversible; owner ceiling not required. |
| projects-tasks/tags | DELETE | /tags/:id | (in service) | 🔒 guarded | DELETE_TAG | admin | needed | Rules naming the tag go stale: run the stale-rule check after. |
| projects-tasks/tags | PATCH | /tags/:id | (in service) | 🔒 guarded | RENAME_TAG / RECOLOUR_TAG | admin | needed |  |
| projects-tasks/tags | DELETE | /tasks/:id/tags/:tagId | editTask | ✅ have | REMOVE_TAG | member | done |  |
| projects-tasks/tags | PUT | /tasks/:id/tags/:tagId | editTask | ✅ have | ADD_TAG | member | done |  |
| projects-tasks/tags | POST | /workspaces/:id/tags | manageTags | 🟡 add | CREATE_TAG | admin (manageTags) | needed | Workspace-level; idempotent by name. |
| projects-tasks/tasks | POST | /tasks | (in service) | ✅ have | CREATE_TASK, CREATE_SUBTASK | member | done (DomainWriter.createTask) | Missing on CREATE_TASK: estimate, issue type, iteration, start date, custom values, parent. |
| projects-tasks/tasks | DELETE | /tasks/:id | (in service) | 🔒 guarded | DELETE_TASK (archived tasks only, optional age) | owner | needed | Destructive and irreversible: archive-first, owner ceiling, never from a template-carried rule. |
| projects-tasks/tasks | PATCH | /tasks/:id | (in service) | ✅ have | RENAME_TASK, SET_DESCRIPTION, SET_STATUS, SET_PRIORITY, SET_DUE_DATE, SET_START_DATE, SET_ESTIMATE, SET_ISSUE_TYPE, SET_ITERATION, CHANGE_PRIORITY | member | done (update has ctx) | Still missing: MOVE_UNDER_PARENT (parentId), MOVE_TO_PROJECT (TASK_MOVED), and CLEARING priority / due date (the DTO cannot express null). |
| projects-tasks/tasks | POST | /tasks/:id/archive | (in service) | ✅ have | ARCHIVE_TASK | member | done |  |
| projects-tasks/tasks | PUT | /tasks/:id/assignees | (in service) | ✅ have | ASSIGN (SET/ADD/REMOVE) | member | done |  |
| projects-tasks/tasks | POST | /tasks/:id/dependencies | (in service) | 🟡 add | ADD_DEPENDENCY | member | needed | Needs a TARGET SELECTOR (which other task?): parent, a subtask, a task by key, related. |
| projects-tasks/tasks | DELETE | /tasks/:id/dependencies/:dependencyId | (in service) | 🟡 add | REMOVE_DEPENDENCY | member | needed | Same selector need. |
| projects-tasks/tasks | POST | /tasks/:id/restore | (in service) | ✅ have | RESTORE_TASK | member | done |  |
| projects-tasks/workflow | PATCH | /projects/:id/workflow | manageWorkflow | 🔒 guarded | ADD_STATUS / RENAME_STATUS / SET_TRANSITIONS (rare) | admin | needed (WORKFLOW_CHANGED activity exists) | Low value, high blast radius: start with templates only. |
| projects-tasks/workflow | PUT | /projects/:id/workflow/order | manageWorkflow | 🔒 guarded | ADD_STATUS / RENAME_STATUS / SET_TRANSITIONS (rare) | admin | needed (WORKFLOW_CHANGED activity exists) | Low value, high blast radius: start with templates only. |
| projects-tasks/workflow | POST | /projects/:id/workflow/statuses | manageWorkflow | 🔒 guarded | ADD_STATUS / RENAME_STATUS / SET_TRANSITIONS (rare) | admin | needed (WORKFLOW_CHANGED activity exists) | Low value, high blast radius: start with templates only. |
| projects-tasks/workflow | DELETE | /projects/:id/workflow/statuses/:statusId | manageWorkflow | ⛔ never | - | - | - |  |
| projects-tasks/workflow | PATCH | /projects/:id/workflow/statuses/:statusId | manageWorkflow | 🔒 guarded | ADD_STATUS / RENAME_STATUS / SET_TRANSITIONS (rare) | admin | needed (WORKFLOW_CHANGED activity exists) | Low value, high blast radius: start with templates only. |
| projects-tasks/workflow | PUT | /projects/:id/workflow/transitions | manageWorkflow | 🔒 guarded | ADD_STATUS / RENAME_STATUS / SET_TRANSITIONS (rare) | admin | needed (WORKFLOW_CHANGED activity exists) | Low value, high blast radius: start with templates only. |
| snap | POST | /snap/sessions | (in service) | ⛔ never | - | - | - | Identity, money, AI sessions and webhooks are not workflow. |
| snap | PATCH | /snap/sessions/:id/clauses/:clauseId | (in service) | ⛔ never | - | - | - | Identity, money, AI sessions and webhooks are not workflow. |
| snap | PATCH | /snap/sessions/:id/clauses/:clauseId/execution-result | (in service) | ⛔ never | - | - | - | Identity, money, AI sessions and webhooks are not workflow. |
| templates | POST | /accounts/:id/templates | createTemplate | ⛔ never | - | - | - | Template authoring is not workflow. |
| templates | POST | /template-installs/:id/undo | (in service) | 🔒 guarded | UNDO_TEMPLATE_INSTALL | admin | n/a |  |
| templates | DELETE | /templates/:id | deleteTemplate | ⛔ never | - | - | - | Template authoring is not workflow. |
| templates | PATCH | /templates/:id | editTemplate | ⛔ never | - | - | - | Template authoring is not workflow. |
| templates | POST | /templates/:id/apply | applyTemplate | 🔒 guarded | APPLY_TEMPLATE (into this workspace) | admin | done (silent ctx) | The most powerful single action (creates a project, tasks, rules). Rules from templates may not carry it. |
| templates | POST | /templates/:id/apply/preview | applyTemplate | ⛔ never | - | - | - | Template authoring is not workflow. |
| templates | POST | /templates/:id/assets | editTemplate | ⛔ never | - | - | - | Template authoring is not workflow. |
| templates | DELETE | /templates/:id/draft | editTemplate | ⛔ never | - | - | - | Template authoring is not workflow. |
| templates | PATCH | /templates/:id/draft | editTemplate | ⛔ never | - | - | - | Template authoring is not workflow. |
| templates | POST | /templates/:id/draft | editTemplate | ⛔ never | - | - | - | Template authoring is not workflow. |
| templates | POST | /templates/:id/draft/publish | editTemplate | ⛔ never | - | - | - | Template authoring is not workflow. |
| templates | POST | /templates/:id/fork | createTemplate | ⛔ never | - | - | - | Template authoring is not workflow. |
| templates | POST | /templates/:id/versions | editTemplate | ⛔ never | - | - | - | Template authoring is not workflow. |
| templates | POST | /workspaces/:id/export-template | exportWorkspaceTemplate | ⛔ never | - | - | - | Template authoring is not workflow. |
| tenancy/accounts | POST | /accounts | (in service) | ⛔ never | - | - | - | Account, role and membership changes are never automated. |
| tenancy/accounts | DELETE | /accounts/:id | (in service) | ⛔ never | - | - | - | Account, role and membership changes are never automated. |
| tenancy/accounts | PATCH | /accounts/:id | (in service) | ⛔ never | - | - | - | Account, role and membership changes are never automated. |
| tenancy/accounts | DELETE | /accounts/:id/members/:userId | (in service) | ⛔ never | - | - | - | Account, role and membership changes are never automated. |
| tenancy/accounts | PATCH | /accounts/:id/members/:userId | (in service) | ⛔ never | - | - | - | Account, role and membership changes are never automated. |
| tenancy/invites | POST | /invites | (in service) | 🔒 guarded | INVITE_USER | owner | needed | Rate-limited; real people receive email: strongest guard of all. |
| tenancy/invites | DELETE | /invites/:id | (in service) | ⛔ never | - | - | - |  |
| tenancy/invites | POST | /invites/:token/accept | (in service) | ⛔ never | - | - | - |  |
| tenancy/invites | DELETE | /invites/batch | (in service) | ⛔ never | - | - | - |  |
| tenancy/invites | DELETE | /invites/cleanup/expired | (in service) | ⛔ never | - | - | - |  |
| tenancy/teams | POST | /teams | (in service) | ⛔ never | - | - | - |  |
| tenancy/teams | DELETE | /teams/:id | (in service) | ⛔ never | - | - | - |  |
| tenancy/teams | PATCH | /teams/:id | (in service) | ⛔ never | - | - | - |  |
| tenancy/teams | DELETE | /teams/:id/members/:userId | (in service) | 🔒 guarded | REMOVE_TEAM_MEMBER | owner | needed |  |
| tenancy/teams | POST | /teams/:id/members/:userId | (in service) | 🔒 guarded | ADD_TEAM_MEMBER | owner | needed |  |
| tenancy/workspaces | POST | /workspaces | (in service) | 🔒 guarded | CREATE_WORKSPACE | owner | needed | Account-level; plan limits; almost always via a template. |
| tenancy/workspaces | DELETE | /workspaces/:id | (in service) | ⛔ never | - | - | - |  |
| tenancy/workspaces | PATCH | /workspaces/:id | (in service) | 🔒 guarded | UPDATE_WORKSPACE (name) | admin | needed |  |
| tenancy/workspaces | POST | /workspaces/:id/collaborators | (in service) | 🔒 guarded | ADD_COLLABORATOR (membership) | owner | needed | Access control by rule: a design decision before code (see handoff, open questions). |
| tenancy/workspaces | DELETE | /workspaces/:id/collaborators/:userId | (in service) | 🔒 guarded | REMOVE_COLLABORATOR (membership) | owner | needed | Access control by rule: a design decision before code (see handoff, open questions). |
| tenancy/workspaces | POST | /workspaces/:id/guests | (in service) | 🔒 guarded | ADD_GUEST (membership) | owner | needed | Access control by rule: a design decision before code (see handoff, open questions). |
| tenancy/workspaces | DELETE | /workspaces/:id/guests/:userId | (in service) | 🔒 guarded | REMOVE_GUEST (membership) | owner | needed | Access control by rule: a design decision before code (see handoff, open questions). |
| tenancy/workspaces | PATCH | /workspaces/:id/key | editWorkspace | ⛔ never | - | - | - | Keys appear in every task key. |
| tenancy/workspaces | DELETE | /workspaces/:id/team-access/:teamId | (in service) | 🔒 guarded | REVOKE_TEAM_ACCESS (membership) | owner | needed | Access control by rule: a design decision before code (see handoff, open questions). |
| tenancy/workspaces | POST | /workspaces/:id/team-access/:teamId | (in service) | 🔒 guarded | GRANT_TEAM_ACCESS (membership) | owner | needed | Access control by rule: a design decision before code (see handoff, open questions). |
| views | POST | /workspaces/:id/views | manageSavedViews | 🟡 add | CREATE_VIEW (personal, for a person) | member | n/a | Low value. |
| views | DELETE | /workspaces/:id/views/:viewId | manageSavedViews | ⛔ never | - | - | - |  |
| views | PATCH | /workspaces/:id/views/:viewId | manageSavedViews | ⛔ never | - | - | - |  |
| views | POST | /workspaces/:id/views/:viewId/duplicate | manageSavedViews | ⛔ never | - | - | - |  |
| views | POST | /workspaces/:id/views/validate | manageSavedViews | ⛔ never | - | - | - |  |

## Totals

✅ have: 10 · 🟡 add: 11 · 🔒 guarded: 32 · ⛔ never: 60 (of 113)
