const { Client } = require('pg');
const fs = require('fs');
const raw = fs.readFileSync('/home/claude/proj/backend/prisma/schema.prisma', 'utf8');
const clean = raw.split('\n').map(l => { const i = l.indexOf('//'); return i === -1 ? l : l.slice(0, i); }).join('\n');
const snake = s => s.replace(/(?<!^)([A-Z])/g, '_$1').toLowerCase();
const enums = {};
for (const m of clean.matchAll(/^enum (\w+) \{([\s\S]*?)^\}/gm)) {
  enums[m[1]] = m[2].split('\n').map(s => s.trim()).filter(Boolean);
}
(async () => {
  const client = new Client({ connectionString: 'postgresql://user:password@localhost:5432/appdb' });
  await client.connect();
  let problems = 0;
  for (const [name, vals] of Object.entries(enums)) {
    const pgname = snake(name);
    const { rows } = await client.query(
      `SELECT e.enumlabel FROM pg_type t JOIN pg_enum e ON t.oid = e.enumtypid WHERE t.typname = $1 ORDER BY e.enumsortorder`, [pgname]);
    const live = rows.map(r => r.enumlabel);
    if (JSON.stringify(live) !== JSON.stringify(vals)) {
      console.log(`ENUM MISMATCH: ${name} (pg type "${pgname}")`);
      console.log('  schema:', vals);
      console.log('  db:    ', live);
      problems++;
    }
  }
  console.log(`enums checked: ${Object.keys(enums).length}, problems: ${problems}`);
  await client.end();
  process.exit(problems ? 1 : 0);
})();
