# ADR-0004: Task keys - prefix unique per account, number per workspace

- **Status:** Accepted (2026-09-24)
- **Blocks:** step 1.1, then Discord/Slack/GitHub adapters (2.4-2.6)

## Context

Chat and GitHub integrations refer to tasks by a short key such as `ENG-123`.
Connections (Discord/Slack/GitHub) are **account-level**, so the account is
known when a key is resolved but the workspace is not. `PLAN.md` and step 1.1
already sketch `Workspace.key`, `Workspace.nextTaskNumber` and `Task.number`.

### Found in the code

- `Workspace` has `accountId` and no key. `Task` has `workspaceId` and no
  number. Tasks cannot move between workspaces (update rejects a project from a
  different workspace), so a number tied to a workspace is stable.
- A user can belong to several accounts, so a bare `ENG-123` is ambiguous
  unless an account is supplied.

## Decision

A task's key is `<workspace key>-<task number>`.

1. **Workspace key is unique per account:** `UNIQUE (accountId, key)`.
   **Task number is unique per workspace:** `UNIQUE (workspaceId, number)`.
   Therefore `ENG-123` identifies exactly one task within an account.
2. **Key format:** `^[A-Z][A-Z0-9]{1,9}$` (2-10 characters), stored uppercase,
   matched case-insensitively. Enforced by a `CHECK` in the migration (Prisma
   cannot express it) as well as in the service.
3. **Numbers are permanent and never reused.** The counter is incremented with a
   single atomic `UPDATE workspaces SET "nextTaskNumber" = "nextTaskNumber" + n
   ... RETURNING` inside the create transaction, so a rollback also rolls the
   counter back (gapless) and concurrent creates serialize on that row.
4. **Renaming a key is allowed, and the old key stays reserved and resolvable.**
   *This amends step 1.1*, which says "key rename allowed" without saying what
   happens to old references. Without this, `ENG-12` in an old PR title would
   either break or, worse, silently resolve to a different task once another
   workspace in the account takes `ENG`. So: a `WorkspaceKeyAlias
   (accountId, key, workspaceId)` table, `UNIQUE (accountId, key)`, *and* the
   current key of every workspace is checked against it, so a retired key can
   never be reissued within the account. Resolution tries the current key, then
   aliases.
5. **`GET /tasks/by-key/:key` requires an account.** *This amends step 1.1*: it
   takes `accountId` (query parameter) and is authorised as viewing that
   account's task, because a key alone is ambiguous across a user's accounts.
   Integrations pass their connection's account.
6. **Key generation for existing workspaces (backfill):** the first 3-4 letters
   of the name, uppercased and stripped to `[A-Z0-9]`; on collision within the
   account append a digit; deterministic order by `createdAt`. The backfill is
   idempotent and resumable, per the expand/backfill/contract policy.
7. **Parsing keys out of free text** uses `\b([A-Za-z][A-Za-z0-9]{1,9})-(\d+)\b`
   and **only accepts a match whose key exists in the account**. Strings like
   `UTF-8`, `SHA-256` and `COVID-19` fall out naturally because no workspace has
   that key. It never guesses across accounts.

## Alternatives rejected

- **Globally unique keys.** Tenants would collide and squat common prefixes.
- **Unique per workspace only.** Fine in-app, ambiguous for an account-level
  chat or GitHub connection, which is the reason this ADR exists.
- **No aliases, disallow rename.** Simpler, but a workspace named badly at
  creation would be stuck with its key forever.
- **UUID or slug references.** Unreadable in chat and commit messages, which is
  the point of a key.

## Consequences

- The counter row lock is held for the whole create transaction. A bulk import
  chunk (ADR-0003) holds it for the chunk. **Chunk size must be chosen against
  measured lock time**; this is an explicit item in the step 1.7 load test, not
  an assumption.
- One more small table (aliases) and a `CHECK` constraint in step 1.1.
- Moving a workspace between accounts is unsupported today; if it is ever added
  it must re-check key uniqueness in the destination account.

## Revisit if

Cross-account references become a product feature (then a key needs an account
qualifier, and this decision is superseded).
