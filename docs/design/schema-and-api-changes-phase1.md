# Phase 1 schema and API changes (steps 1.1 - 1.7)

**Why this file exists:** step 1.7 asks to update `api_contract_graph_v2.d2` and `schema_graph_v2.d2`. Those two
files were never uploaded (not in any zip), so **the `.d2` files were NOT edited.** This is the paste-ready inventory,
built from the migrations and by scanning the controllers' decorators. Step ownership of a route is from PROGRESS.md.

## Schema (by migration)
| step | table / column / index |
|---|---|
| 1.1 | `workspaces.key` (NOT NULL, `ck_workspaces_key_format`, unique per account `uq_workspaces_account_id_key`), `workspaces.next_task_number` (>0), `tasks.number` (NOT NULL, >0, unique `uq_tasks_workspace_id_number`), table `workspace_key_aliases` (unique `(account_id,key)`, idx `workspace_id`), audit action `WORKSPACE_KEY_CHANGED` |
| 1.3 | `tasks.parent_id` (FK `fk_tasks_parent_id`, `ck_tasks_parent_not_self`, `idx_tasks_parent_id`), activity actions `PARENT_CHANGED`, `TASK_MOVED` |
| 1.4 | tables `workflow_statuses` (uq `(project_id,name_key)`, idx `(project_id,position)`, partial unique one-default-per-category - raw SQL), `workflow_transitions` (uq `(from,to)`, idx `project_id`); `projects.enforce_transitions`, `projects.default_workflow_status_id`; `tasks.workflow_status_id` (+`idx_tasks_workflow_status_id`); activity action `WORKFLOW_CHANGED` |
| 1.5 | enums `issue_type_level`, `iteration_kind`, `iteration_state`; tables `issue_types` (uq `(workspace_id,name_key)`), `iterations` (idx `(workspace_id,state)`, `project_id`); `tasks.issue_type_id`, `tasks.iteration_id` (+ idx each); activity actions `ISSUE_TYPE_CHANGED`, `ITERATION_CHANGED` |
| 1.5b | `tasks.estimate` DOUBLE PRECISION (`ck_tasks_estimate_range`); iteration close snapshot (velocity) |
| 1.6 | enum `external_link_kind`; table `external_links` (uq `(task_id,provider,kind,external_id)`, idx `(provider,kind,external_id)`, URL/external_id CHECKs) |
| **1.7** | **add** `idx_tasks_workspace_archived_created (workspace_id,is_archived,created_at DESC)`, `idx_tasks_project_archived_created (project_id,is_archived,created_at DESC)`, `idx_tasks_project_archived_status (project_id,is_archived,status)`; **drop** `ix_tasks_workspace_id`, `ix_tasks_project_id`. No columns/tables. |

Final `tasks` indexes: pkey, `ix_tasks_workspace_id_status`, `uq_tasks_workspace_id_number`, `idx_tasks_parent_id`,
`idx_tasks_workflow_status_id`, `idx_tasks_issue_type_id`, `idx_tasks_iteration_id`, and the three 1.7 indexes.

## API routes (controller scan)
**Workspaces** (`workspaces`): `PATCH :id/key` (1.1)
**Tasks** (`tasks`): `POST /`, `GET /`, `GET by-key/:key` (1.2), `GET :id` (detail: `number`, `key`, `externalLinks`, `externalLinkCount` 1.6), `GET :id/subtasks` (1.3), `GET :id/table-row`, `PATCH :id`, `DELETE :id`, `POST :id/archive`, `POST :id/restore`, `PUT :id/assignees`, `POST :id/dependencies`, `DELETE :id/dependencies/:dependencyId`
  - list query params added: `parentId`, `rootsOnly` (1.3), `workflowStatusId` (1.4), `issueTypeId`, `iterationId` (1.5); body field `estimate` (1.5b)
**Workflow** (`projects/:id/workflow`, 1.4): `GET /`, `PATCH /`, `POST statuses`, `PATCH statuses/:statusId`, `DELETE statuses/:statusId`, `PUT order`, `PUT transitions`
**Issue types** (`workspaces/:id/issue-types`, 1.5): `GET /`, `POST /`, `PATCH :typeId`, `DELETE :typeId`
**Iterations** (`workspaces/:id/iterations`, 1.5/1.5b): `GET /`, `GET current`, `GET velocity`, `GET :iterationId`, `POST /`, `PATCH :iterationId`, `DELETE :iterationId`, `POST :iterationId/start`, `POST :iterationId/close`, `POST :iterationId/reopen`
**Projects** (unchanged routes; `progress` is now leaf-based, 1.3/1.4): `POST projects`, `GET me/projects`, `GET projects/:id`, `GET workspaces/:id/projects`, `PATCH projects/:id`, `DELETE projects/:id`, `POST projects/:id/archive`, `GET projects/:id/stats`, `GET projects/:id/members`
**Tags** (0.8): `POST|GET workspaces/:id/tags`, `PATCH|DELETE tags/:id`, `PUT|DELETE tasks/:id/tags/:tagId`
**1.7 adds no routes and changes no response shape.**

Also stale and not refreshed: `diagrams/11-erd-workflow-core.d2` (design zip) predates `estimate`, `closeSummary`
and the ExternalLink unique key.
