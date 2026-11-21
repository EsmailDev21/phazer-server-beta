# Automation registry (step 5.8)

One **descriptor** per trigger and per action, in `src/automations/registry/`. It replaces the switches that used to be spread over five files. The DSL's JSON shape is unchanged (`ruleVersion 1` rows keep working); this step changes no behaviour.

## What a descriptor holds

| Field | Triggers | Actions | Read by |
|---|---|---|---|
| `type`, `label`, `summary`, `example` | yes | yes | catalogue, docs, tests |
| `schema` (structural check) | yes | yes | `validateRule` (via `tagged`) |
| `refs` (reference slots) | yes | yes | reference collection, workspace checks, template `RefWalker` |
| `unavailable` (stored, cannot be enabled: why) | yes | yes | validator (reports it), catalogue |
| `needs` | `{task}` | `{task, project}` | SCHEDULE rules (task-less), catalogue |
| `match(t, event)` | yes | | `matchesTrigger` |
| `execute(a, run, services)` | | yes | `ActionExecutor` |
| `semantic(a, base, ctx, add)` | | optional | `checkRuleSemantics` (custom-field value must fit its type) |
| `ruleCheck(...)` | optional | optional | `checkRuleSemantics`, once per rule at the first use (recursion guards, SCHEDULE needs a project) |
| `ceiling`, `portable` | | yes | catalogue. **Declared, not enforced** (5.9) |
| `describe` | yes | yes | not used at run time yet (dry run, run detail: 5.18) |

### Reference slots
`{key, kind, shape}` with shape `one | list | statusRef | statusRefList`. A `null`/missing value is skipped. The same declaration answers "which ids does this rule mention" (collect), "does each exist in this workspace/project" (check; same codes, messages and JSON pointers as before) and "rewrite each through a mapper" (the template walker). Conditions and view configs still have their own walkers (`collectConditionReferences`, `checkConditionRefs`, `RefWalker.conditions/viewConfig`).

## Adding an action (the whole job now)
1. A descriptor in `actions.task.ts` / `actions.work.ts` (or a new file), using `action<'TYPE'>({...})`; add the type to the `Action` union in `rule.types.ts`.
2. Put it in `ACTION_ORDER` in `registry/index.ts` (the order is the API's order; append).
3. `npx jest src/automations/registry` tells you what is missing: label/summary/example/describe, the example validating, each slot being a real property, one declaration driving collect/check/walker, a reference-like key in the example that no slot declares.
4. Regenerate the reference: `UPDATE_GOLDEN=1 npx jest src/automations/registry/registry.spec.ts` (writes `automation-catalogue.md`). Add a fixture to `rule-surface.golden.spec.ts` and regenerate it **only if you mean to record new behaviour**.
Triggers are the same with `triggers.ts` and `TRIGGER_ORDER` (and `TRIGGER_TYPES` in `rule.types.ts`, which a test pins to the registry).

## Catalogue
`GET workspaces/:id/automations/catalogue` (needs `manageAutomations`, like `validate`; static, same for every workspace): triggers and actions with label, summary, whether they run today and why not, `needsTask`/`needsProject`, `ceiling`, `portable`, a valid `example`; condition fields with operators and value kinds; placeholders; user tokens; limits. It is **not a JSON Schema**: the validator is the contract and `POST .../validate` is how an editor checks a draft. `automation-catalogue.md` is the same data, generated; a test fails when it is stale.

## Guards on this step
- `src/automations/rule-surface.golden.spec.ts` + `__golden__/*.json`: recorded BEFORE the refactor from the old code (76 rules, 45 executor call traces, trigger matching). The refactor leaves them byte-identical.
- Import cycles: the registry must not import the `dsl` barrel or the `engine` barrel (the DSL imports the registry). A test loads 11 entry modules first, one by one.

## Not changed / limits
- `collectCustomUserIds` still special-cases `SET_CUSTOM_FIELD` (a USER-typed field's value holds user ids). A second action needing the same would want a descriptor hook.
- `ceiling` is `ADMIN` everywhere and `portable` is `true` except `NOTIFY_CHANNEL`; nothing enforces either yet (5.9). A test pins `NOTIFY_CHANNEL` as the only non-portable action and requires it to hold a channel slot.
- The executor now answers an unknown action type with a 422 failure; the old switch silently did nothing. Unreachable for stored rules (validated), noted for completeness.

## Control flow in the registry (5.10)
An action descriptor may say `nested: {conditions?, branches?}` (IF: `conditions`, `then`, `else`). `registry/tree.ts` (`walkActions`, `countActions`, `ifDepth`) is the ONE way to walk the action tree; reference collection, the workspace checks, rule-wide checks and the template walker all use it, and `ruleCheck` now receives the action's JSON pointer instead of an index. `ActionServices` gained `snapshot()` (the task as it is now) and `runBranch()` (run a branch through the same executor). The `IF` schema calls the full action and conditions checks recursively through late-bound hooks (`bindActionCheck`, `bindConditionsCheck`) to avoid an import cycle with the validator.

## FOR_EACH in the registry (5.12)
`nested` generalizes: `FOR_EACH` has `conditions: 'where'` and `branches: ['do']`; `registry/tree.ts` knows both control-flow actions (`BRANCH_KEYS`, `CONDITIONS_KEY`) and the depth they share. `taskless?(a)` lets one instance of an action work with no task (a FOR_EACH over a query), and `semantic` receives `{rule, scopeProjectId}`. The loop itself (selection, per-item context, onError, the run budget) is in the executor like IF's branch running, behind `ActionServices.runLoop`.

## Captures and WITH in the registry (5.13)
An action's `execute` may return `{createdTaskId}` (`ActionOutput`); if the action has an `as`, the executor captures that task (`captureTask`) and the actions after it in the same list see `{{name.prop}}` in `run.vars` (a branch, loop body or WITH starts from a copy, so nothing leaks out). `WITH` is a control-flow action like IF and FOR_EACH (`nested.branches: ['do']`, `taskless`, runs via `ActionServices.runWith`). `exampleBefore` lists actions an example needs ahead of it (WITH needs the Create that captures its task). The scope rules live in `dsl/rule.captures.ts` (pure); the property list is `TASK_CAPTURE_PROPS` in `registry/checks.ts` and is served in the catalogue as `captures`. An `IF`'s `elseIf` is `nested.cases`; the tree walker reports each case's conditions as `extraConditions`.

## Rules and views as references (5.14)
`RuleRefKind` has `rule` and `view`: `RuleReferences.ruleIds/viewIds`, `WorkspaceRuleContext.rules/views` (loaded by `WorkspaceContextLoader`; the rules come with what THEY call, transitively, so a cycle or an over-deep chain is visible), `UNKNOWN_RULE` / `UNKNOWN_VIEW`. `ruleCheck`-style graph checks live in `RUN_RULE`'s `semantic` hook (it gets `ctx.selfRuleId`). Templates do not carry either kind by name yet (`portable: false` on `RUN_RULE`).

## WAIT in the registry (5.15)
The executor keeps a stack of the lists being run (`state.stack`: list pointer, the index running, the run context). A WAIT throws `WaitSignal` carrying those as `WaitFrame`s (innermost first, each "carry on FROM here"); `execute` returns them as `result.waiting`. `ActionExecutor.resume(actionsSnapshot, frames)` runs each frame's remainder innermost-first and keeps the outer frames on the stack so a second WAIT saves them again. Saving and carrying on is `AutomationWaitService` (`schedule`, `resumeDue`, `cancel`) driven by `AutomationWaitJob` (every minute). `WAIT` has `needs.task: false` (it needs nothing), `nested: {}` (control flow: it counts what runs after it, not itself) and refuses to run when `run.inLoop` is set or inside a RUN_RULE call.

