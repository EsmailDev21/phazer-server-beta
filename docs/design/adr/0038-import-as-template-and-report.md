# ADR-0038 - Import as template, the downloadable report, edge cases (step 4.9)

Status: ACCEPTED by the builder. Plan sentence this implements: "Importers emit a CanonicalBundle; templates are a Blueprint ... so 'import a Jira project -> save as template' costs nothing extra, and both go through one validator and one writer."

## Import as template
`POST /imports/:id/start-as-template { name?, description?, category?, includeComments?, onSecret? }` on a PREVIEWED job.
- **Nothing is written to the workspace.** The executor's `drive()` branches on the internal option `target: 'TEMPLATE'`; `ImportTemplateRunner` reads the provider with the same adapters, validator and mapping engine, then `buildRawFromImport` (pure) re-shapes the mapped pages into the blueprint's RAW form, the ONE sanitizer (3.4: secrets, personal data, dates -> offsets from a start-date variable, people -> roles) validates it, and the ONE template service (3.5, `createFromBlueprint`) stores it as a **PRIVATE** template of the account. Publishing stays the normal template flow.
- **Mapping for a template** ignores the job's mapping choices: an empty destination context (nothing exists, so every status / issue type / field is created) and every source person is a placeholder (`src:<id>`) that the sanitizer turns into a role. *Alternative:* honour the stored mapping; rejected, a template cannot point at entities of one workspace.
- **Who:** `createTemplate` on the account (includes the plan's template limit) on top of the job's own access. `target` / `template` are never accepted from a request body (`parseOptions` refuses unknown keys): only `startAsTemplate` sets them.
- **Kind:** one project selected -> a PROJECT template, several -> WORKSPACE. A template holds at most 5,000 items; more is refused with the number and the limit ("select fewer projects").
- **What is carried:** projects, workflows (statuses with category and default), the task tree (parents inside the project; a missing parent makes a root, a parent loop is broken, a chain deeper than the template allows is flattened), issue types, iterations, tags, custom fields and values, priorities, dates (as day strings, then offsets), estimates, same-project dependencies, assignees (as roles), optionally comments (role-attributed reference comments, replies flattened).
- **What is NOT, and said so in the report:** files (a template would have to copy and hash them), history, archived tasks, cross-project dependencies, dependencies to tasks that are not in the template.
- **Found by the tests:** the blueprint rule "a workflow needs a To Do, an In Progress and a Done status" makes a source board of just To Do / Done (e.g. a ClickUp "backlog / done" list, a Jira "To Do / Done" project) an INVALID template. The builder adds the standard missing status and reports it (`TEMPLATE_WORKFLOW_COMPLETED`); two source statuses with the same name fold into one.
- **Not resumable by checkpoint** (the pages are in memory): a transient failure restarts the read; bounded by the 5,000-item cap. A credential-shaped string stops the build (`onSecret: 'block'`, default) or is removed (`'redact'`).
- **Proof it is usable:** the integration spec applies the made template to a fresh workspace and gets the imported structure back.

## Downloadable report
`GET /imports/:id/report/download?format=csv|json` (default csv), same permission as the on-screen report. CSV: UTF-8 BOM, a header, one row per recorded issue, quotes doubled, **a cell starting with `=` `+` `-` `@` (or tab / CR) is prefixed with `'`** so a spreadsheet never runs it as a formula (the source's text is untrusted). JSON: the whole report plus the rows. Capped at 50,000 rows (`REPORT_TRUNCATED` row / `truncated: true`). `Cache-Control: no-store`.

## Edge-case suite (`imports-edge.int-spec.ts`, against the real executor and Postgres)
Parent loop (two issues, one issue its own parent), a parent that is not part of the import, a 30-level chain, a blocks-cycle of two and of three (one edge / the closing edge is dropped), a mapped person who left before the run, a 2 MB description, a 5,000-character title, a 500 KB and an empty comment, a non-date, a duplicated issue and a blank title, and a provider that answers "slow down" for ever (bounded automatic retries, then a message and resume). **No importer bug was found by these** (the earlier steps already handle them); they now pin that behaviour.

## Prerequisite: the Phase 3 merge
This step needed the template module (Phase 3, up to 3.9). Reconciled in the merge: Phase 3's `ProjectCreateExtras` (`{ workflow: { statuses, transitions, enforceTransitions } }`) replaced my earlier `ProjectWriteExtras` (the importer now passes `{ workflow: { statuses } }`; it can pass transitions the day the canonical format carries them); `StorageProvider.putObject(key, Buffer, mime)` is Phase 3's and the importer's streaming upload is **`putObjectStream`**; the schema gained the template tables and `Account.isSystem` next to the importer's; Phase 3's migrations (20260620-24) sort after the importer's.

## Not done
Template from a SINGLE issue tree through the API only (no UI), files / history in templates, honouring the mapping step for templates, resumable template builds, a template version bump when the same import is repeated (each run makes a new template).
