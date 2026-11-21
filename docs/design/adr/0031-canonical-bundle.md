# ADR-0031 - CanonicalBundle v1, its validator, and the rich-text normalizers

Status: ACCEPTED (step 4.2). Follows ADR-0030 (import core).

## Context
Every importer (Linear, Jira, Trello, Asana, ClickUp, GitHub ...) must hand the executor the same thing, so the mapping engine (4.3) and the
executor (4.4) never see a provider. Provider data is also untrusted and untidy: 5 000-character titles, control characters, `javascript:` links,
ADF/HTML descriptions, dates in odd shapes, parent loops. Step 4.2 defines the format and the gate in front of it.

## Decisions
1. **A bundle is ONE PAGE of a live source, not a document** (diagram 05: `fetchBundle(cursor) -> Normalize -> CanonicalBundle page`). Collections are flat
   (`tasks[]` with `parentExternalId`, not nested children), so a page can be any slice and a reference may point at an entity on ANOTHER page; the executor
   resolves it through ExternalRef. Every entity carries the provider's `externalId` (adapters compose a globally unique one when the provider scopes ids).
2. **Not a Blueprint.** A blueprint is a self-contained document with local keys, relative dates, roles and placeholders; a bundle has absolute dates, real people,
   provider ids, history, attachments by reference. They share only what does not care, **imported, not copied, with ZERO edits to the 3.1 files**:
   `badTextReason` (json-guard), `canonicalJson`/`blueprintChecksum`, `foldName`, and the text limits (`BLUEPRINT_LIMITS`, themselves the app's DTO limits: what passes here passes
   the write path). 4.9 (import-as-template) is the one place that converts bundle -> blueprint (people to roles, dates to offsets).
3. **The validator repairs, skips, or fails the page - in that order of preference** (`validateBundle`). A fixable value is fixed (cut, cleaned, normalised, dropped), an unusable
   item is skipped, and every decision is returned as a `BundleIssue` whose shape equals step 4.1's `NewImportIssue` (the executor passes them straight to `ImportIssueService`).
   Only a problem with the PAGE is fatal: not JSON / too deep / too large (20 MB) / wrong `schemaVersion` / a collection over its page ceiling (page size is the adapter's choice) /
   **an unknown field (ADAPTER_BUG: a typo must be loud, never silently ignored)**. After repair the page is checked against a strict closed JSON Schema (ajv) as a final gate;
   a test pins the schema's property names to the validator's allowed keys so they cannot drift.
4. **Rules worth knowing** (all tested): control characters / lone surrogates removed (one INFO per item); titles one line, empty -> "(untitled)", cut with an ellipsis; markdown cut at a line
   boundary with a visible marker and an unterminated code fence closed; dates -> canonical UTC instants (date-only = midnight UTC, no offset = UTC, years outside 1990-2100 are garbage); due before start drops the
   START; created/updated more than a day in the future are dropped; estimates 0..1000; URLs http(s) only; labels folded-unique; custom values checked against their field definition when the page has it
   (select labels matched case-insensitively and returned in the field's spelling); status names that fold equal are renamed `Name (2)`; comment threads are one level (replies to replies re-attach to the root);
   parent loops inside a page are cut at exactly one link; BLOCKS-dependency loops skip the closing link; issues capped at 5 000 per page + one ISSUES_TRUNCATED. Validation is pure, deterministic (`now` is a parameter) and never mutates its input.
5. **`contentHash`** (for `ExternalRef.contentHash`): the Blueprint's canonical-JSON SHA-256 over the item AS REPAIRED. `taskContentHash` excludes comments, attachments, history and `updatedAt` (separate ExternalRef types /
   volatile): a new comment must not re-write the task.
6. **Rich text -> markdown through ONE intermediate model and ONE renderer** (`md-model` / `md-render`). ADF and HTML converters decide what the content is; the renderer alone writes and escapes markdown, so
   "source text stays literal" is proved once, against the CommonMark reference parser (`commonmark`, devDependency): 4 000 random strings of special characters round-trip to the same text. Both converters are bounded (100 000 nodes,
   depth 40, 2 MB in, 200 000 chars out), never throw, and warn once per kind of loss. Safety: only http / https / mailto / tel survive in a link (controls stripped before judging, so `java<TAB>script:` fails), images http(s) only, and
   HTML `<script>/<style>/<iframe>/<svg>/<form controls>` are removed WITH their content. HTML is parsed with `parse5@7.3.0` (spec-compliant tree, executes nothing; 7.x ships CommonJS, 8.x is ESM-only and would break the Nest/Jest build).
7. **Attachments referenced from text** become `[name](attachment:<providerMediaId>)` (`ATTACHMENT_LINK_SCHEME`): not a clickable web link, and the stable token step 4.6 swaps for the copied file.

## Left to later steps (by design)
Priority / status-category / user mapping (4.3); cross-page reference resolution, parent depth > 3, cross-page cycles (4.4, against the database); fetching bytes (4.6); ADF/HTML is lossy by nature (colours, merged cells, macros) and says so.

## Known limitations
A `_`-delimited emphasis run that is also intraword AND touches a strong run is not parsed as emphasis by CommonMark (rare; text stays correct, formatting lost). HTML table cells are flattened to inline content. A timestamp with no offset is read as UTC (the adapter owns time zones).

## Dependencies added
`parse5@7.3.0` (runtime), `commonmark@0.31.2` + `@types/commonmark@0.27.10` (dev, tests only). Both exact-pinned, both older than two weeks.
