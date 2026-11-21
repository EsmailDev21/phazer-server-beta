# Templates that carry automations and saved views (step 5.5)

A blueprint project may list `automations` and `views`. Until now they were opaque JSON that no one interpreted (the apply warned `AUTOMATIONS_IGNORED`). From 5.5 an item that says what it is is checked, applied, undone and exported; everything else stays opaque, as before. Source: `src/templates/portable/`.

## The portable form
Ids do not exist in a template, so references are NAMES the way the rest of the blueprint names things:
`status` -> the project's workflow status key · `tag` -> tag name · `issue type` -> its name · `custom field` -> its key · `iteration` / `project` -> `nodeKey` · people -> **only tokens** (rules: `TRIGGERER` / `CREATOR`; views: `ME`), never a user id.

```
{ "kind": "rule.v1", "name": "...", "trigger": {...}, "conditions": {...}?, "actions": [...] }
{ "kind": "view.v1", "name": "...", "layout": "BOARD", "shared": true?, "config": {...} }
```
The shape is exactly the rule DSL / view config; only the strings that carry ids hold names. There is no `enabled`: a template cannot ask for a rule to be on. Chat channels (`NOTIFY_CHANNEL`) are not portable (a channel belongs to a workspace). An item with no recognised `kind` is **raw**: carried untouched.

One walker (`RefWalker`) knows every position a reference can live in (trigger, conditions, actions, view filters, group, sort keys, custom columns), and the SAME code runs in all three directions (extract: id -> name; publish check: name -> placeholder; apply: name -> id), so they cannot disagree.

## The pipeline (`evaluateRuleItem` / `evaluateViewItem`, pure)
bind names to the ids of a model -> the SAME structural validation and workspace checks a stored rule or view passes. The model is: the blueprint itself (publish), what this apply will leave in the workspace (preview), the real ids (apply). A field the apply would SKIP is absent from the model; a REUSED field keeps the options it already has, so a rule can pass at publish and be skipped in a workspace whose same-named field is different (reported, never guessed).

## Publish
`createFromBlueprint` / new versions refuse a portable item that does not hold up (`AUTOMATION_INVALID`, `VIEW_INVALID`, with JSON-pointer paths) and duplicate names within a project (per kind). Raw items are size-checked only.

## Preview and apply
The plan lists each item with its fate: automations `CREATE` / `RAW` / `SKIP`, views `CREATE` / `SKIP`, plus warnings (`AUTOMATIONS_CREATED_OFF`, `AUTOMATION_SKIPPED`, `AUTOMATION_RENAMED`, `VIEW_SKIPPED`, `VIEW_NOT_SHARED`) and blockers (`AUTOMATION_LIMIT` 100/workspace, `VIEW_LIMIT` 100 personal per person / 50 shared). A plan carries names, counts and reasons, **never a rule's text**.
- **Automations are always created OFF** (`createdVia TEMPLATE`, by the person applying); an admin reviews and enables them. Ones using a construct this build cannot run stay un-enableable (as for any rule); a raw item becomes an inert imported rule (`ruleVersion 0`, its JSON kept in `sourceDefinition`, the input the 5.3 upgrade will translate).
- **Views** are shared only when the template asks AND the person applying is an admin; otherwise they are that person's personal views (a warning says so).
- Names that already exist get a number (`Name (2)`), decided again under the workspace lock; if the workspace changed since the preview and a limit would now be exceeded, these extras are skipped and counted (`portableSkipped`) while the rest of the apply stands.
- The ledger (`template_install_items`) accepts `AUTOMATION` and `SAVED_VIEW` (migration `20260628000000`).

## Undo
Removes the automations and views the install created unless a person changed them since (enabling a rule counts), exactly like every other entity (`confirmEdited` removes them too). A project is kept while any automation or view remains in it, including ones somebody else added.

## Export
Only **project-scoped automations** and **shared views** are read (workspace-wide ones have no place in a blueprint; **personal views are never read**: they belong to one person). Ids become names; people, deleted references, other projects' statuses and chat channels cannot be named, so those items are left out and listed in the extraction report (`automations.skipped`, `views.skipped`). Raw rules are carried as received. Every string inside is scanned for secrets like any other text, with a rule's own `{{placeholders}}` protected so the scan does not rewrite them (a bug the round-trip test found).

## Not done on purpose
The template editor has no operations for these items (edit by publishing a new version). Diffs treat them as unkeyed items. Workspace-wide rules/views are not exported. No seed ships any yet. 5.3's translator for raw items is not written (raw items are now stored with their source, ready for it).

---

# First-party content (step 5.7)

The three seeds now ship real automations (always created OFF) and saved views, in the portable form, replacing the old opaque placeholder items. Content lives in `src/templates/seeds/definitions/*.blueprint.ts`.

| Seed | Automations (4 / 5 / 4) | Views (5 / 5 / 4: team ones shared, "My ..." personal) |
|---|---|---|
| **student-workspace** | ask for review when an assignment reaches professor review (sets "pending", comments) · raise an assignment's priority when overdue · weekly planning task (Mondays 07:00 UTC) · reopen finished work when someone comments | Board, Due this week, Exams by weight, My open work, Lab calendar |
| **sprint-board** | flag blocked work (priority up + note) · give review work an owner (the person who moved it) · close a story **in review** when all its sub-tasks are done · late bugs become urgent · archive "Won't do" | Sprint 1 board, Backlog, Open bugs, Timeline, My work |
| **content-calendar** | warn the day before an unapproved piece is due · escalate late posts · close a piece when all its steps are done · weekly content planning (tagged "social") | Calendar, Needs approval, By channel, My content |

## What testing them found (and changed)
- A rule that restored a not-archived task could never work: the action is now "set status back to To do".
- A rule conditioned on a custom field at task creation could never fire (values are set after creation, and custom-field changes are not events): replaced by two that can.
- The sprint board's workflow only allows Code review -> Done, and rules obey workflow transitions like anyone: the story rule is conditioned on being in review instead of failing for the rest.

## Upgrading existing deployments
`SeedDefinition.changelog` is the note for a CHANGED seed, `initialChangelog` for version 1.0.0. A deployment that already has the seeds gets 1.1.0 ("Adds ready-made automations (all start switched off) and saved views."); version 1.0.0 is untouched; a fresh install starts at 1.0.0 with everything and "First release.". Re-running the seeder changes nothing.

## Tests
Unit (`seed.prepare.spec`): counts per seed, every item portable, names unique, every rule RUNNABLE (nothing unsupported), the range of triggers and actions exercised, a broken item stops the seed. Integration (`template-seeds`): apply each seed (admin: team views shared; member: all personal), preview equals result, every shipped rule can be switched on through the real service with no problems, undo, the upgrade path. Behaviour (`seed-behaviour`, 16 tests): real task changes drive each shipped rule and the right thing happens (and the right non-thing for tasks a rule should leave alone), plus "all rules on, ordinary work: no failed run, nothing paused".
