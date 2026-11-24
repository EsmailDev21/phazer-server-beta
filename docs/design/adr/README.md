# Architecture Decision Records

One file per decision, so a decision can be superseded on its own. Numbered in
the order written; never renumbered. An accepted ADR is not edited except to
mark it superseded or to fix a factual error - a changed decision is a new ADR.

| ADR | Decision | Blocks |
|---|---|---|
| [0001](0001-worker-topology.md) | API + separate worker process, one codebase | 0.2, 0.3, 0.4 |
| [0002](0002-feature-flags.md) | Env-driven flags via one service, 404 when off | every flag-gated step |
| [0003](0003-domain-writer-contract.md) | `WriteContext` / `DomainWriter` contract | 0.7, Phase 2-4 |
| [0004](0004-task-key-scope.md) | Task keys: prefix unique per account, number per workspace | 1.1, 2.4, 2.6 |
| [0005](0005-subtask-semantics.md) | Subtasks: 3 levels, same project, leaf-only progress | 1.3 |
| [0006](0006-workflow-statuses.md) | Workflow statuses roll up to the 4 categories (ACCEPTED) | 1.4 |
| [0007](0007-issue-types-and-iterations.md) | Issue types and iterations (close asks, reopen allowed, admins manage) | 1.5 |
| [0008](0008-velocity-and-current-iteration.md) | Story points, current iteration, velocity (snapshot at close) | 1.5 follow-up |
| [0009](0009-integration-core.md) | Integration core: connections, encrypted credentials, OAuth state, refresh locking, soft revoke | 2.1 |
| [0010](0010-identity-linking.md) | Identity linking: one gate, one-time link, strict auto-match, admin relink | 2.2 |
| [0011](0011-notification-router.md) | Notification router: pipeline, echo guard, burst cap, failure policy, system alerts | 2.3 |
| [0012](0012-discord-adapter.md) | Discord adapter: signed interactions, chat commands, notify, one live connection per guild | 2.4 |
| [0013](0013-slack-adapter.md) | Slack adapter: signed routes, response_url + modals, markup-safe output, poster-visible unfurl | 2.5 |
| [0015](0015-hardening.md) | Hardening: Prometheus metrics, connection health, per-provider limiter, key rotation, Slack uninstall, delivery retention, prompt throttle | 2.7 |
| [0030](0030-import-core.md) | Import core: jobs, state machine, ExternalRef, preflight | 4.x |
| [0031](0031-canonical-bundle.md) | CanonicalBundle v1, its validator, and the rich-text normalizers | 4.x |
| [0032](0032-import-mapping.md) | Import mapping engine | 4.x |
| [0033](0033-import-executor.md) | Import executor, chunked writes and rollback | 4.x |
| [0034](0034-linear-adapter.md) | Linear adapter (first real importer) | 4.x |
| [0035](0035-import-content.md) | Import content: comments, history, attachments (step 4.6) | 4.x |
| [0036](0036-clickup-import.md) | ClickUp connector and importer (step 4.7) | 4.x |
| [0037](0037-jira-import.md) | Jira Cloud connector and importer (step 4.8) | 4.x |
| [0038](0038-import-as-template-and-report.md) | Import as template, the downloadable report, edge cases (step 4.9) | 4.x |
| [0039](0039-asana-import.md) | Asana connector and importer (step 4.10) | 4.x |
| [0040](0040-field-roles-selection.md) | Per-source field roles in the import selection (step 4.10) | 4.x |
| [0041](0041-monday-import.md) | monday.com connector and importer (step 4.11) | 4.x |
| [0042](0042-notion-import.md) | Notion connector and importer (step 4.12) | 4.x |
| [0043](0043-iteration-kinds.md) | Iteration kinds: sprint, cycle and milestone get their own features (step 6.0) | 6.x |
| [0044](0044-sprint-tracking.md) | Sprint tracking: commitment, burndown, capacity, one active sprint (step 6.1) | 6.x |
| [0045](0045-cycle-cadence.md) | Cycles that repeat: auto-create, auto-rollover, the ring (step 6.2) | 6.x |
| [0046](0046-milestones.md) | Milestones: exit criteria, health, date history, release notes (step 6.3) | 6.x |

**Status values:** Proposed, Accepted, Superseded by NNNN.

**Every ADR here was written from the code as it stands after step -1.4**, and
where the code contradicted an assumption in `PLAN.md` / `IMPLEMENTATION.md`
the ADR says so in a "Found in the code" section. Where a decision changes a
planned step, that step is named under "Changes to the plan".
