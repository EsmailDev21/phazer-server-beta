#!/usr/bin/env node
// Offline sanity check: does schema.prisma's understanding of column/type
// names actually match what prisma/migrations/ has created in the real
// database? Needs neither a live Postgres nor a Prisma engine binary - pure
// text parsing of schema.prisma + the migration SQL - so it runs even in a
// sandbox with no route to binaries.prisma.sh (this one).
//
// WHY THIS EXISTS: this exact class of bug was found and fixed in step 0.6
// (see PROGRESS.md) - the ORIGINAL hand-authored baseline migration (step
// -1.1) created snake_case columns/enum types (`google_id`, `creation_mode`,
// ...), but schema.prisma had ZERO `@map`/`@@map` on any FIELD or ENUM
// (only on models/tables), so it silently declared every multi-word field
// and every enum type to Prisma Client under its camelCase/PascalCase
// Prisma-schema name instead. Prisma Client's generated SQL casts by that
// declared name - `SELECT ... "googleId" ...` against a table that only has
// "google_id" - which would fail immediately with a real engine, but every
// verification available in the network-restricted sandboxes this project
// has been built in so far (prisma generate --no-engine, unit tests with
// PrismaService mocked, raw-`pg`-client smoke tests) is blind to it: none
// of them ask Prisma Client to generate real SQL from schema.prisma against
// the real database. 208 fields and 35 enum types were silently wrong.
// `db:verify` (prisma migrate diff, needs a real engine) is the fully
// authoritative check and WOULD catch this - but only once real network
// access exists. This script exists so the sandbox itself can catch a
// regression of the exact same bug, right now, for free.
//
// This is deliberately narrower than `db:verify`: it only checks NAMING
// (does every field/enum's effective DB name exist in the tables/types the
// migrations actually create), not full DDL equivalence (types, defaults,
// constraints, indexes) - that broader guarantee is still `db:verify`'s job
// once a real engine is available.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCHEMA_PATH = path.join(ROOT, 'prisma', 'schema.prisma');
const MIGRATIONS_DIR = path.join(ROOT, 'prisma', 'migrations');

function snake(s) {
  return s.replace(/(?<!^)([A-Z])/g, '_$1').toLowerCase();
}

function stripComments(text) {
  return text
    .split('\n')
    .map((l) => {
      const i = l.indexOf('//');
      return i === -1 ? l : l.slice(0, i);
    })
    .join('\n');
}

function loadAllMigrationSql() {
  const dirs = fs
    .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort(); // migration folders are timestamp-prefixed - order doesn't
  // actually matter here (CREATE/ALTER accumulate; nothing in this
  // checker needs to replay them in sequence), but sorted is deterministic.
  let sql = '';
  for (const dir of dirs) {
    const file = path.join(MIGRATIONS_DIR, dir, 'migration.sql');
    if (fs.existsSync(file)) sql += fs.readFileSync(file, 'utf8') + '\n';
  }
  return sql;
}

function parseTables(sql) {
  const tables = {};
  const createRe = /CREATE TABLE "(\w+)" \(\n([\s\S]*?)\n\);/g;
  let m;
  while ((m = createRe.exec(sql))) {
    const cols = [...m[2].matchAll(/^\s*"(\w+)"/gm)].map((c) => c[1]);
    tables[m[1]] = new Set(cols);
  }
  // A later migration can ADD COLUMN onto a table CREATE TABLE'd earlier -
  // same reason enum values accumulate via separate ALTER TYPE statements.
  const alterRe = /ALTER TABLE "(\w+)" ADD COLUMN "(\w+)"/g;
  while ((m = alterRe.exec(sql))) {
    (tables[m[1]] ??= new Set()).add(m[2]);
  }
  return tables;
}

function parseEnumTypes(sql) {
  const types = new Set();
  const re = /CREATE TYPE "(\w+)" AS ENUM/g;
  let m;
  while ((m = re.exec(sql))) types.add(m[1]);
  return types;
}

function parseSchemaModels(clean) {
  const modelNames = new Set(
    [...clean.matchAll(/^model (\w+) \{/gm)].map((m) => m[1]),
  );
  const models = {};
  const re = /^model (\w+) \{\n([\s\S]*?)^\}/gm;
  let m;
  while ((m = re.exec(clean))) {
    const [, name, body] = m;
    const tableMap = body.match(/@@map\("(\w+)"\)/);
    const table = tableMap ? tableMap[1] : null;
    const fields = [];
    for (const rawLine of body.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('@@')) continue;
      const fm = line.match(/^(\w+)\s+([\w[\]?]+)(.*)$/);
      if (!fm) continue;
      const [, fname, ftype, rest] = fm;
      const baseType = ftype.replace(/\?$/, '').replace(/\[\]$/, '');
      fields.push({
        fname,
        isRelationObject: modelNames.has(baseType),
        fieldMap: (rest.match(/@map\("(\w+)"\)/) || [])[1] ?? null,
      });
    }
    models[name] = { table, fields };
  }
  return models;
}

function parseSchemaEnums(clean) {
  const enums = {};
  const re = /^enum (\w+) \{\n([\s\S]*?)^\}/gm;
  let m;
  while ((m = re.exec(clean))) {
    const [, name, body] = m;
    const typeMap = body.match(/@@map\("(\w+)"\)/);
    enums[name] = typeMap ? typeMap[1] : null;
  }
  return enums;
}

function main() {
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
  const clean = stripComments(schema);
  const sql = loadAllMigrationSql();

  const tables = parseTables(sql);
  const enumTypes = parseEnumTypes(sql);
  const models = parseSchemaModels(clean);
  const enums = parseSchemaEnums(clean);

  const problems = [];

  for (const [mname, { table, fields }] of Object.entries(models)) {
    if (!table) {
      problems.push(`Model ${mname} has no @@map(...) - cannot verify it.`);
      continue;
    }
    if (!tables[table]) {
      problems.push(
        `Model ${mname} maps to table "${table}", which no migration creates.`,
      );
      continue;
    }
    const cols = tables[table];
    for (const { fname, isRelationObject, fieldMap } of fields) {
      if (isRelationObject) continue; // no column of its own
      const effective = fieldMap ?? fname;
      if (!cols.has(effective)) {
        const suggestion = cols.has(snake(fname))
          ? ` (did you mean @map("${snake(fname)}")? that column exists)`
          : '';
        problems.push(
          `${mname}.${fname} expects column "${effective}", not found in table "${table}"${suggestion}.`,
        );
      }
    }
  }

  for (const [ename, mapped] of Object.entries(enums)) {
    const effective = mapped ?? ename;
    if (!enumTypes.has(effective)) {
      const suggestion = enumTypes.has(snake(ename))
        ? ` (did you mean @@map("${snake(ename)}")? that type exists)`
        : '';
      problems.push(
        `enum ${ename} expects DB type "${effective}", not found in migrations${suggestion}.`,
      );
    }
  }

  if (problems.length > 0) {
    console.error(
      `schema-mapping check FAILED: ${problems.length} problem(s)\n`,
    );
    for (const p of problems) console.error('  - ' + p);
    process.exit(1);
  }

  const fieldCount = Object.values(models).reduce(
    (n, { fields }) => n + fields.filter((f) => !f.isRelationObject).length,
    0,
  );
  console.log(
    `OK: ${Object.keys(models).length} models (${fieldCount} scalar fields) and ${
      Object.keys(enums).length
    } enums all @map onto columns/types the migration history actually creates.`,
  );
}

main();
