# Design docs

| File | What it is |
|---|---|
| [`PLAN.md`](PLAN.md) | The design: what is being built and why (diagram index in section 13). |
| [`IMPLEMENTATION.md`](IMPLEMENTATION.md) | The build order: PR-sized steps, tests, gates, risks. |
| [`adr/`](adr/README.md) | Architecture decision records: worker topology, feature flags, `DomainWriter` contract, task-key scope. |
| [`20-implementation-dependencies.svg`](20-implementation-dependencies.svg) | Diagram 20: step-level dependency graph (critical path, gates, parallel waves), generated from the step table in `IMPLEMENTATION.md`. |

## Diagrams

`PLAN.md` refers to diagrams 01-20 by number. Only **diagram 20** was included
in the handoff this repo was resumed from, so it is the only one committed.
Diagrams 01-19 (`*.d2` sources and/or rendered SVGs) still need to be added
here; keep the `NN-name.d2` naming from the index in `PLAN.md` section 13 and
commit the rendered `.svg` beside each source.
