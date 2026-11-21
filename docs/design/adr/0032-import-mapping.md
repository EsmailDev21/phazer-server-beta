# ADR-0032 - Import mapping engine

Status: ACCEPTED (step 4.3). Follows ADR-0030 (import core) and ADR-0031 (CanonicalBundle).

## Context
Between "the provider's words" (a CanonicalBundle) and "our rows" (tasks, workflow statuses, assignees) sit decisions a person must be able to see and change:
which status is Blocked, what "Showstopper" means, who Ana is. Step 4.3 makes those decisions explicit, suggested, overridable, and testable as tables.

## Decisions
1. **A pure engine with a thin database shell.** `src/imports/mapping/mapping.*.ts` has no database, clock or randomness: `suggest -> resolve (suggestion + overrides) -> applyMapping (page -> MappedPage)`.
   `MappingService` only fetches facts (who may be targeted, what exists) and enforces authority. Every rule below is a table-driven unit test.
2. **Three inputs, kept apart.** *Inventory* = what the source contains (statuses per project, priorities seen, people, issue types, fields), built by the adapter with `buildInventory`, returned from `estimate()`, **re-validated through the CanonicalBundle validator** (`parseInventory`) and stored on the job (new column `import_jobs.inventory`, never in the job view).
   *Context* = the workspace (members, existing types / fields, identity links). *Config* = the person's overrides, rows only, strict ajv schema (`MappingConfigV1`), unknown keys refused.
3. **Statuses (diagram 07).** Source category -> TaskStatus (BACKLOG/TODO->TODO, IN_PROGRESS, DONE); **CANCELED -> DONE + `excludeFromProgress`**; UNKNOWN -> judged by name. **BLOCKED is never derived from a category** (no tracker has one): only a LOW-confidence name guess on a not-finished status, always listed in "attention" until confirmed; a source that says DONE/CANCELED is never turned into Blocked by its name.
   One WorkflowStatus per source status, with merging (`mergeInto`: one level, same project, no chains/loops); exclusion only means something on DONE, so moving a status off DONE clears it.
4. **Priorities.** Each provider's own scheme first (Jira, ClickUp, Linear tables), then generic words/conventions (MEDIUM confidence), else "no priority" and flagged. Keys are normalised (`High (2)`, `priority:high`, `HIGH` are one) and matching is by `hasOwnProperty`, never by prototype lookup.
5. **People: members only, verified e-mail only.** Match order: bot -> importer; an IdentityLink on this connection (to a member); verified-e-mail match to a member; else the importer. **Members** = the workspace account's members + *accepted* collaborators. A local address only counts if `emailVerified`; two members with one address are ambiguous (nobody guessed); `matchByEmail:false` turns it off.
   Unmatched: not assigned; what they authored (comments, history, creation) is credited to the importer, and a comment says so in bold on its own line, **"Name (via Jira)"**, with the name markdown-escaped.
   **Membership is judged again at run time** (`resolveForRun` re-reads it): someone removed after the preview is no longer assigned or credited; a saved override to someone who left is ignored and reported.
   Trust note: the e-mail comes from the source. A malicious admin of the source could set an arbitrary e-mail on a guest and have their comments attributed to a local member. Impact is attribution inside a workspace whose admin chose to run the import; mitigations are the verified-only rule, members-only, the preview list, and `matchByEmail:false`.
6. **Issue types / custom fields** match the workspace's by folded name (fields also by type; same name + different type = a NEW field named "Name (Jira)", flagged). Targets: existing / create / skip, per row.
7. **Saving is strict, using is tolerant.** `PUT mapping` returns a 400 listing every problem (shape, duplicates, unknown source ids, merge rules, name collisions, non-members, unknown existing targets, field type mismatch, exclusion on non-DONE). Reading a saved config never throws: rows that no longer match the selection are ignored, counted (`stale`) and reported, and apply again if the selection returns.
8. **Selection change clears the inventory** (the next preview rebuilds it) and keeps the saved rows. Preview stores the inventory, fills `previewSummary.unmappedUsers` (people nobody matched *or chose*; a deliberate "importer" is decided) and `previewSummary.mapping.attention`.
9. **`mappedTaskHash`** hashes what will be WRITTEN, not the source, so changing the mapping and re-running updates exactly the tasks it affects while an unchanged re-run is a no-op (comments / attachments / history / `updatedAt` excluded, as in ADR-0031). The executor should use it for `ExternalRef.contentHash` in preference to `taskContentHash`.
10. `MappedPage` lists only what must be CREATED (issue types / fields with a `create` target); references to existing workspace entities are already local ids; references to other pages stay source external ids (ExternalRef resolves them).

## Left to later steps
Writing anything (4.4); per-project target selection / merging into an existing project (every imported source project becomes a new project in 4.4); option merging for an existing SELECT field (4.4 decides); fetching real structure (adapters 4.5/4.7/4.8 must fill `estimate().inventory`); the UI.

## Known limitations
Fixtures are synthetic (modelled on provider docs): the first recorded real structure responses will find shapes they did not anticipate. Name heuristics are English-only. `P1` meaning varies between teams (generic table: P0 urgent, P1 high, P2 medium, P3/P4 low).
