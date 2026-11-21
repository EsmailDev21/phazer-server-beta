# ADR-0040 - Per-source field roles in the import selection (step 4.10)

Status: Proposed by the builder. Implements option 2 of the handoff's "which column is the status?" (the owner chose it, with a heuristic as the suggestion).

## Problem
Monday (several status columns per board; "Priority" is usually just another status column) and Notion (arbitrary properties) cannot say which field is THE workflow status, assignee or due date. The Map step only maps what an adapter already put in the inventory, after a preview, so it cannot express this choice.

## Decision
A closed set of **roles** (`status`, `priority`, `assignee`, `due`, `start`) and a per-source choice **role -> field id**, made in the Select step, before anything is read.

- `discover()` may return `fields` on a selectable node: `{ id, name, type, roles[], suggested?[] }`. `roles` = what the field can sensibly do (the adapter decides from the provider's type); `suggested` = what it would be by default.
- `ImportSelection.sources[i].fieldRoles` = `{ role: fieldId | null }`. Absent role = use the suggestion; `null` = do not map this role. Absent object = exactly the old shape (`{ id, type }`), so nothing changes for providers without fields.
- **Shared code, once** (`imports/field-roles.ts`): `suggestFieldRoles` (called by `discover`), `resolveFieldRoles` (called by `estimate` and `fetchBundle`), and two preview warnings (`FIELD_ROLES_GUESSED`, `FIELD_ROLES_MISSING`).
- **Validation** (`imports.validation.ts`): the request shape is checked on parse (unknown role, non-string id, empty/over-long id, one field for two roles: 400); and against the provider's own tree on save (the field must be a field of THAT source and able to play THAT role: 400).

## The suggestion rules (and why)
By name first (`Status`, then anything status-like), with fallbacks only where a wrong guess is cheap:
- **status:** the first status-typed field is the fallback (a board must have a workflow).
- **priority / start:** never guessed from type alone: a second status column is as likely to be "Customer tier" as a priority.
- **assignee / due:** a single candidate of the right type is taken even with an odd name; several unnamed candidates are not guessed.
- Priority is decided **before** the rest so a "Priority" status column is never spent as the workflow; a field never serves two roles.

## Two rules that keep the picker honest
1. **A field the person chose for one role is not also suggested for another** (resolution and picker both apply it; otherwise choosing "Priority" as the status would still map it as the priority). Mirrored on the client and checked exhaustively: all 924 valid combinations on a realistic board give identical results on the server and the picker.
2. **A chosen field that disappears is "missing", never silently replaced by the guess** (`FIELD_ROLES_MISSING`): the person said what they meant.

## Client
Fields are optional on `SourceNode`; the Select step draws one small control group under a PICKED source that offers fields, and nothing otherwise. The rules live in pure, tested helpers (`lib/imports/sources.ts`): choosing a column another role uses swaps instead of failing; stale choices are pruned before saving (the server would refuse them); `<select>` values cannot collide with a field whose id is literally "none".

## First consumer
monday.com (ADR-0041): status columns offer `status` + `priority`, a timeline is split into two virtual fields so each half can play its own role (one field never plays two), and the board's group is a virtual `status` candidate. The helper and the validation needed no change.
Notion (ADR-0042) is the second: property ids as field ids, a date range's end as a virtual `due` field, a status / select / checkbox as the workflow.

## Not done
- `createPerSpace` builds its sources without `fieldRoles` (ClickUp-only today); a provider that needs both must edit the selection after the drafts are created.
- Asana does not use it: offering its enum custom fields as a priority picker needs one `custom_field_settings` call per project in `discover` (backlog #21).
- Role-specific validation of the field's TYPE is the adapter's job (`roles`), not the server's: a wrong `roles` list from an adapter is an adapter bug.
- The two existing component suites that touch the Select step were not run here (they need the repo's test infrastructure).
