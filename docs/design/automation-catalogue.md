# Automation catalogue (generated)

> GENERATED from the registry (`src/automations/registry`). Do not edit by hand: change a descriptor,
> then regenerate with `UPDATE_GOLDEN=1 npx jest src/automations/registry/registry.spec.ts`.
> The same data is served by `GET workspaces/:id/automations/catalogue`.

## Triggers (12)

| Type | Label | What it does | Runs today |
|---|---|---|---|
| `TASK_CREATED` | Task created | Fires when a task is created. | yes |
| `STATUS_CHANGED` | Status changed | Fires when a task changes status; `from` and `to` narrow it. | yes |
| `FIELD_CHANGED` | Field changed | Fires when a built-in field changes (only some fields record a change yet). | yes |
| `DUE_APPROACHING` | Due date approaching | Fires once, a set time before a task is due (checked every 5 minutes). | yes |
| `EXTERNAL_LINK_STATE_CHANGED` | Linked item changed state | Fires when a linked pull request or issue changes state. Needs the GitHub/Jira adapters (Phase 2). | no: Link state changes come from the GitHub/Jira adapters (Phase 2); the rule is saved but cannot be switched on yet |
| `COMMENT_ADDED` | Comment added | Fires on a new comment, optionally containing some text. A rule's own comments are ignored unless `by` is ANYONE. | yes |
| `TASK_ARCHIVED` | Task archived | Fires when a task is archived. | yes |
| `TASK_RESTORED` | Task restored | Fires when an archived task is restored. | yes |
| `ALL_SUBTASKS_DONE` | All subtasks done | Fires on the PARENT task when its last open subtask is finished. | yes |
| `TASK_OVERDUE` | Task overdue | Fires once when an open task passes its due date (optionally some hours later). | yes |
| `SCHEDULE` | On a schedule | Fires daily, weekly or monthly at a UTC hour. Has no task: it can only create tasks. *(no task)* | yes |
| `CALLED` | When called by another rule | Never fires on its own: the rule exists to be run by another rule's Run rule action. Use it for steps several rules share. | yes |

## Actions (26)

| Type | Label | What it does | Needs | Author role | Template | Runs today |
|---|---|---|---|---|---|---|
| `SET_STATUS` | Set status | Moves the task to a status (the project's workflow still applies). | task | ADMIN | yes | yes |
| `SET_PRIORITY` | Set priority | Sets the task priority. | task | ADMIN | yes | yes |
| `ASSIGN` | Assign | Sets, adds or removes assignees. TRIGGERER and CREATOR stand for people. | task | ADMIN | yes | yes |
| `SET_DUE_DATE` | Set due date | Sets the due date N days from now, or shifts the existing one. | task | ADMIN | yes | yes |
| `SET_CUSTOM_FIELD` | Set custom field | Sets (or, with null, clears) a custom field value; the value must fit the field. | task | ADMIN | yes | yes |
| `ADD_TAG` | Add tag | Puts a tag on the task. | task | ADMIN | yes | yes |
| `REMOVE_TAG` | Remove tag | Takes a tag off the task (fine if it was not there). | task | ADMIN | yes | yes |
| `COMMENT` | Comment | Posts a comment on the task (marked as written by a rule). | task | ADMIN | yes | yes |
| `CREATE_SUBTASK` | Create subtask | Adds a subtask under the task. | task + project | ADMIN | yes | yes |
| `NOTIFY_CHANNEL` | Notify a chat channel | Posts a message to a linked chat channel. Needs the chat integration (Phase 2). | task | ADMIN | no | no: Chat notifications need the chat integration (Phase 2); the rule is saved but cannot be switched on yet |
| `CREATE_TASK` | Create task | Creates a task in the rule's project (or the triggering task's project). | no task + project | ADMIN | yes | yes |
| `RENAME_TASK` | Rename task | Changes the title; {{placeholders}} are filled in. | task | ADMIN | yes | yes |
| `SET_DESCRIPTION` | Set description | Replaces the description, or appends to it (at most 10000 characters in all). | task | ADMIN | yes | yes |
| `SET_ESTIMATE` | Set estimate | Sets the estimate (null clears it). | task | ADMIN | yes | yes |
| `SET_ISSUE_TYPE` | Set issue type | Sets the issue type (null clears it). | task | ADMIN | yes | yes |
| `SET_ITERATION` | Set iteration | Puts the task in an iteration (null takes it out). | task | ADMIN | yes | yes |
| `CHANGE_PRIORITY` | Raise or lower priority | Moves the priority one step up or down; the ends stay put. | task | ADMIN | yes | yes |
| `SET_START_DATE` | Set start date | Sets the start date N days from now, or shifts the due date. | task | ADMIN | yes | yes |
| `ARCHIVE_TASK` | Archive task | Archives the task (rules archive, they never delete). | task | ADMIN | yes | yes |
| `RESTORE_TASK` | Restore task | Brings an archived task back. | task | ADMIN | yes | yes |
| `IF` | If / else | Checks conditions when it runs (earlier actions of the rule are visible) and runs the `then` actions, or the `else` actions when it does not hold. | task | ADMIN | yes | yes |
| `FOR_EACH` | For each task | Runs its actions once for each task it selects (the task's subtasks, siblings or parent, or every task of the project or workspace that matches `where`), with that task as the current one. Does nothing, and fails, if it would select more than the configured number of tasks. | task | ADMIN | yes | yes |
| `WITH` | With a captured task | Runs its actions on a task an earlier action captured with `as` (for example the one a Create task action just made): assign it, tag it, add subtasks, comment on it. Inside, that task is the current one. | no task | ADMIN | yes | yes |
| `RUN_RULE` | Run another rule | Runs another rule's actions on the current task, as part of this run (its trigger is ignored; if ITS conditions do not hold it does nothing). The called rule can have the 'When called' trigger so it never fires on its own. Rules cannot call themselves, directly or through others, and calls nest only so deep. | task | ADMIN | no | yes |
| `NOTIFY` | Notify people | Sends an in-app notification with your own text ({{placeholders}} are filled in) to people: user ids, TRIGGERER, CREATOR, or the task's ASSIGNEES or WATCHERS. Only people who can see the task receive it; a group bigger than the limit makes the action fail instead of reaching some of them. | task | ADMIN | yes | yes |
| `WAIT` | Wait | Pauses the rule for a while; the actions after it run when the time is up, if the rule is still on and the task still exists. It resumes within about a minute of the time. Not allowed inside a loop or a rule that another rule calls. | no task | ADMIN | yes | yes |

## Examples

One valid instance of each, as the validator accepts it (ids are placeholders).

- trigger `TASK_CREATED`: `{"type":"TASK_CREATED"}`
- trigger `STATUS_CHANGED`: `{"type":"STATUS_CHANGED","to":[{"category":"DONE"}]}`
- trigger `FIELD_CHANGED`: `{"type":"FIELD_CHANGED","field":"PRIORITY"}`
- trigger `DUE_APPROACHING`: `{"type":"DUE_APPROACHING","offset":{"amount":2,"unit":"DAYS"}}`
- trigger `EXTERNAL_LINK_STATE_CHANGED`: `{"type":"EXTERNAL_LINK_STATE_CHANGED","provider":"GITHUB","kind":"PR","state":"merged"}`
- trigger `COMMENT_ADDED`: `{"type":"COMMENT_ADDED","contains":"ship it"}`
- trigger `TASK_ARCHIVED`: `{"type":"TASK_ARCHIVED"}`
- trigger `TASK_RESTORED`: `{"type":"TASK_RESTORED"}`
- trigger `ALL_SUBTASKS_DONE`: `{"type":"ALL_SUBTASKS_DONE"}`
- trigger `TASK_OVERDUE`: `{"type":"TASK_OVERDUE","afterHours":24}`
- trigger `SCHEDULE`: `{"type":"SCHEDULE","frequency":"WEEKLY","hour":9,"weekdays":[1]}`
- trigger `CALLED`: `{"type":"CALLED"}`
- action `SET_STATUS`: `{"type":"SET_STATUS","status":{"category":"DONE"}}`
- action `SET_PRIORITY`: `{"type":"SET_PRIORITY","priority":"HIGH"}`
- action `ASSIGN`: `{"type":"ASSIGN","mode":"ADD","users":["TRIGGERER"]}`
- action `SET_DUE_DATE`: `{"type":"SET_DUE_DATE","inDays":3}`
- action `SET_CUSTOM_FIELD`: `{"type":"SET_CUSTOM_FIELD","customFieldId":"FIELD_ID","value":"x"}`
- action `ADD_TAG`: `{"type":"ADD_TAG","tagId":"TAG_ID"}`
- action `REMOVE_TAG`: `{"type":"REMOVE_TAG","tagId":"TAG_ID"}`
- action `COMMENT`: `{"type":"COMMENT","body":"Moved to {{task.status}}"}`
- action `CREATE_SUBTASK`: `{"type":"CREATE_SUBTASK","title":"Review {{task.key}}","assignees":["TRIGGERER"]}`
- action `NOTIFY_CHANNEL`: `{"type":"NOTIFY_CHANNEL","channelLinkId":"CHANNEL_LINK_ID","message":"{{task.title}} is done"}`
- action `CREATE_TASK`: `{"type":"CREATE_TASK","title":"Weekly review {{date}}","tags":["TAG_ID"],"assignees":["CREATOR"],"status":{"category":"TODO"}}`
- action `RENAME_TASK`: `{"type":"RENAME_TASK","title":"{{task.title}} (reviewed)"}`
- action `SET_DESCRIPTION`: `{"type":"SET_DESCRIPTION","text":"Checked on {{date}}","mode":"APPEND"}`
- action `SET_ESTIMATE`: `{"type":"SET_ESTIMATE","estimate":3}`
- action `SET_ISSUE_TYPE`: `{"type":"SET_ISSUE_TYPE","issueTypeId":"ISSUE_TYPE_ID"}`
- action `SET_ITERATION`: `{"type":"SET_ITERATION","iterationId":"ITERATION_ID"}`
- action `CHANGE_PRIORITY`: `{"type":"CHANGE_PRIORITY","direction":"UP"}`
- action `SET_START_DATE`: `{"type":"SET_START_DATE","inDays":1}`
- action `ARCHIVE_TASK`: `{"type":"ARCHIVE_TASK"}`
- action `RESTORE_TASK`: `{"type":"RESTORE_TASK"}`
- action `IF`: `{"type":"IF","conditions":{"all":[{"field":"PRIORITY","op":"IN","value":["URGENT"]}]},"then":[{"type":"ADD_TAG","tagId":"TAG_ID"}],"elseIf":[{"conditions":{"all":[{"field":"PRIORITY","op":"IN","value":["HIGH"]}]},"then":[{"type":"COMMENT","body":"High, not urgent"}]}],"else":[{"type":"COMMENT","body":"Not urgent"}]}`
- action `FOR_EACH`: `{"type":"FOR_EACH","over":"SUBTASKS","where":{"all":[{"field":"STATUS_CATEGORY","op":"NOT_IN","value":["DONE"]}]},"do":[{"type":"SET_PRIORITY","priority":"HIGH"}]}`
- action `WITH`: `{"type":"WITH","task":"followUp","do":[{"type":"ADD_TAG","tagId":"TAG_ID"}]}` (after `[{"type":"CREATE_TASK","title":"Follow up on {{task.title}}","as":"followUp"}]`)
- action `RUN_RULE`: `{"type":"RUN_RULE","rule":"RULE_ID"}`
- action `NOTIFY`: `{"type":"NOTIFY","users":["ASSIGNEES","WATCHERS"],"message":"{{task.key}} {{task.title}} is now {{task.status}}"}`
- action `WAIT`: `{"type":"WAIT","for":{"amount":2,"unit":"DAYS"}}`

## Placeholders and tokens

Placeholders: `{{task.title}}`, `{{task.key}}`, `{{task.status}}`, `{{task.priority}}`, `{{trigger.from}}`, `{{trigger.to}}`, `{{actor.name}}`, `{{date}}`.
A Create action's `as: "name"` captures the task it made: `{{name.id}}`, `{{name.key}}`, `{{name.title}}`, `{{name.status}}`, `{{name.priority}}`, `{{name.project}}`, `{{name.assignees}}`, `{{name.dueDate}}`.
User tokens: `TRIGGERER`, `CREATOR`.

## Condition fields

- `STATUS_CATEGORY`: IN (statusCategories), NOT_IN (statusCategories)
- `STATUS`: IN (ids), NOT_IN (ids)
- `PRIORITY`: IN (priorities), NOT_IN (priorities), IS_SET, IS_NOT_SET
- `ASSIGNEES`: INCLUDES_ANY (userRefs), INCLUDES_NONE (userRefs), IS_EMPTY, IS_NOT_EMPTY
- `TAGS`: HAS_ANY (ids), HAS_ALL (ids), HAS_NONE (ids)
- `ISSUE_TYPE`: IN (ids), NOT_IN (ids), IS_SET, IS_NOT_SET
- `PROJECT`: IN (ids), NOT_IN (ids)
- `ESTIMATE`: EQ (number), NE (number), GT (number), GTE (number), LT (number), LTE (number), IS_SET, IS_NOT_SET
- `DUE_DATE`: IS_SET, IS_NOT_SET, IS_OVERDUE, IS_NOT_OVERDUE
- `IS_SUBTASK`: IS_TRUE, IS_FALSE
- `CUSTOM`: EQ (customScalar), NE (customScalar), CONTAINS (customScalar), GT (customScalar), GTE (customScalar), LT (customScalar), LTE (customScalar), IN (customList), NOT_IN (customList), HAS_ANY (customList), HAS_ALL (customList), HAS_NONE (customList), INCLUDES_ANY (customList), INCLUDES_NONE (customList), IS_SET, IS_NOT_SET, IS_TRUE, IS_FALSE

At most 20 conditions per rule.
