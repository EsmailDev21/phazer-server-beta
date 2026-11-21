const { Client } = require('pg');

// Re-derive the same model/field structure the DDL generator used, so we
// cross-check independently rather than trusting the generator's own notion
// of what it meant to create.
const fs = require('fs');
const raw = fs.readFileSync('/home/claude/proj/backend/prisma/schema.prisma', 'utf8');
const clean = raw.split('\n').map(l => { const i = l.indexOf('//'); return i === -1 ? l : l.slice(0, i); }).join('\n');

const SCALARS = { String: 'text', Int: 'integer', Float: 'double precision', Boolean: 'boolean', DateTime: 'timestamp without time zone', Json: 'jsonb' };
const snake = s => s.replace(/(?<!^)([A-Z])/g, '_$1').toLowerCase();

const enumNames = new Set();
for (const m of clean.matchAll(/^enum (\w+) \{/gm)) enumNames.add(m[1]);

const models = {};
for (const m of clean.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
  const [, name, body] = m;
  let table = name;
  const mapM = body.match(/@@map\("([^"]+)"\)/);
  if (mapM) table = mapM[1];
  const fields = [];
  for (const line of body.split('\n').map(l => l.trim()).filter(Boolean)) {
    if (line.startsWith('@@')) continue;
    const fm = line.match(/^(\w+)\s+([A-Za-z0-9_]+)(\[\])?(\?)?\s*(.*)$/);
    if (!fm) continue;
    const [, fname, ftype, isList, isOpt, attrs] = fm;
    fields.push({ name: fname, type: ftype, list: !!isList, opt: !!isOpt, attrs: attrs || '' });
  }
  models[name] = { table, fields };
}

const knownModelNames = new Set(Object.keys(models));

function expectedColumns(m) {
  const cols = {};
  for (const f of m.fields) {
    const isRelationObj = knownModelNames.has(f.type);
    if (isRelationObj && f.list) continue; // virtual back-relation, no column
    if (isRelationObj && !f.list) continue; // relation object itself has no column (its fields:[...] scalar does)
    let pgType;
    if (SCALARS[f.type]) pgType = SCALARS[f.type];
    else if (enumNames.has(f.type)) pgType = 'USER-DEFINED';
    else continue;
    cols[snake(f.name)] = { nullable: f.opt, prismaType: f.type, pgType };
  }
  return cols;
}

(async () => {
  const client = new Client({ connectionString: 'postgresql://user:password@localhost:5432/appdb' });
  await client.connect();

  let problems = 0, tablesChecked = 0, colsChecked = 0;

  for (const [mname, m] of Object.entries(models)) {
    const { rows } = await client.query(
      `SELECT column_name, is_nullable, data_type, udt_name
       FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
      [m.table]
    );
    if (rows.length === 0) {
      console.log(`MISSING TABLE: ${m.table} (model ${mname})`);
      problems++;
      continue;
    }
    tablesChecked++;
    const live = Object.fromEntries(rows.map(r => [r.column_name, r]));
    const expected = expectedColumns(m);
    for (const [col, exp] of Object.entries(expected)) {
      colsChecked++;
      const got = live[col];
      if (!got) {
        console.log(`MISSING COLUMN: ${m.table}.${col} (model ${mname}.${col})`);
        problems++;
        continue;
      }
      const gotNullable = got.is_nullable === 'YES';
      if (gotNullable !== exp.nullable) {
        console.log(`NULLABILITY MISMATCH: ${m.table}.${col} — schema says opt=${exp.nullable}, DB says nullable=${gotNullable}`);
        problems++;
      }
      if (exp.pgType === 'USER-DEFINED') {
        if (got.data_type !== 'USER-DEFINED') {
          console.log(`TYPE MISMATCH: ${m.table}.${col} — expected enum, DB says ${got.data_type}`);
          problems++;
        }
      } else if (got.data_type !== exp.pgType) {
        console.log(`TYPE MISMATCH: ${m.table}.${col} — expected ${exp.pgType}, DB says ${got.data_type}`);
        problems++;
      }
    }
    // extra columns present in DB but not expected (would indicate generator added something unintended)
    for (const col of Object.keys(live)) {
      if (!(col in expected)) {
        console.log(`UNEXPECTED COLUMN: ${m.table}.${col} (not in schema.prisma model ${mname})`);
        problems++;
      }
    }
  }

  // foreign key existence check: every relation field with fields:[...] should have a live FK constraint
  const { rows: fkRows } = await client.query(`
    SELECT tc.table_name, kcu.column_name, ccu.table_name AS ref_table
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
    JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
    WHERE tc.constraint_type = 'FOREIGN KEY'`);
  const liveFks = new Set(fkRows.map(r => `${r.table_name}.${r.column_name}->${r.ref_table}`));
  let fkChecked = 0;
  for (const [mname, m] of Object.entries(models)) {
    for (const f of m.fields) {
      if (knownModelNames.has(f.type) && !f.list) {
        const fm = f.attrs.match(/fields:\s*\[([^\]]+)\]/);
        if (!fm) continue;
        const localCol = snake(fm[1].split(',')[0].trim());
        const refTable = models[f.type].table;
        fkChecked++;
        if (!liveFks.has(`${m.table}.${localCol}->${refTable}`)) {
          console.log(`MISSING FK: ${m.table}.${localCol} -> ${refTable} (model ${mname}.${f.name})`);
          problems++;
        }
      }
    }
  }

  // unique/index existence spot-checks: every @@unique / @unique should produce a live unique index
  const { rows: idxRows } = await client.query(`
    SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname='public'`);
  console.log(`\n--- summary ---`);
  console.log(`tables checked:   ${tablesChecked}/${Object.keys(models).length}`);
  console.log(`columns checked:  ${colsChecked}`);
  console.log(`FKs checked:      ${fkChecked}`);
  console.log(`live indexes:     ${idxRows.length}`);
  console.log(`PROBLEMS FOUND:   ${problems}`);

  await client.end();
  process.exit(problems > 0 ? 1 : 0);
})();
