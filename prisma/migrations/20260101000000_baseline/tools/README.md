# Baseline authoring & verification tools

One-time tools used to produce and verify `../migration.sql` when Prisma's
schema-engine was unreachable. See `../README-BASELINE.md` for the full story
and results. Kept here (not deleted) so the method is auditable and reusable
if the schema needs a second hand-authored migration before real `prisma
migrate dev` access is available again.

Run against a **disposable** local Postgres (drops and recreates the `appdb`
database):

```bash
# from the tools/ directory, with DATABASE_URL / PG* pointing at a scratch DB
python3 gen_ddl.py                     # schema.prisma -> ./baseline.sql
psql -f baseline.sql -v ON_ERROR_STOP=1
node crosscheck.js                     # structural: tables/columns/FKs vs information_schema
node enumcheck.js                      # enum values vs pg_enum
node smoke.js                          # functional: real inserts, cascades, uniqueness
```

`crosscheck.js`, `enumcheck.js` and `smoke.js` each re-parse `schema.prisma`
independently of `gen_ddl.py` (separate regex, separate code path), so they
catch generator bugs rather than just confirming the generator agrees with
itself.

Requires the `pg` package. If running from outside `backend/`, set
`NODE_PATH=<path-to-backend>/node_modules` (that's how they were run while
authoring the migration — the repo's own `pg` dependency, added by
`@prisma/adapter-pg`, was reused rather than installing a separate copy).
