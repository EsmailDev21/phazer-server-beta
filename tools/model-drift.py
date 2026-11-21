#!/usr/bin/env python3
"""Sandbox stand-in for `prisma migrate diff` (which needs the engine binaries, not available offline):
compares a Prisma model with the real table in the sandbox database. Usage: model-drift.py ModelName...
Checks columns (name, type, nullability), index names and the ON DELETE rule of each foreign key."""
import re, subprocess, sys

PGD, PGPORT, DB = '/tmp/pg', '5499', 'appdb_test'
PGTYPE = {'String': 'text', 'Int': 'integer', 'Boolean': 'boolean', 'DateTime': 'timestamp without time zone',
          'Json': 'jsonb', 'Float': 'double precision', 'BigInt': 'bigint'}
ONDELETE = {'Cascade': 'CASCADE', 'SetNull': 'SET NULL', 'Restrict': 'RESTRICT', 'NoAction': 'NO ACTION'}

def q(sql):
    out = subprocess.run(['su', 'postgres', '-c', f'psql -q -At -F "|" -h {PGD} -p {PGPORT} {DB} -c "{sql}"'],
                         capture_output=True, text=True)
    if out.returncode: raise SystemExit(out.stderr)
    return [l.split('|') for l in out.stdout.strip().split('\n') if l]

schema = open('prisma/schema.prisma').read()
enums = set(re.findall(r'^enum (\w+) \{', schema, re.M))
models = set(re.findall(r'^model (\w+) \{', schema, re.M))
bad = 0
for name in sys.argv[1:]:
    body = re.search(rf'^model {name} \{{(.*?)^\}}', schema, re.M | re.S).group(1)
    table = re.search(r'@@map\("(\w+)"\)', body).group(1)
    want, fks, idx = {}, {}, set(re.findall(r'map: "(\w+)"', body))
    for line in body.split('\n'):
        line = line.split('//')[0].strip()
        m = re.match(r'(\w+)\s+(\w+)(\?|\[\])?\s*(.*)', line)
        if not m or line.startswith('@@'): continue
        f, t, opt, rest = m.groups()
        rel = re.search(r'@relation\(fields: \[(\w+)\].*?onDelete: (\w+)', rest)
        if rel: fks[rel.group(1)] = ONDELETE[rel.group(2)]; continue
        if t in models or opt == '[]': continue          # a relation's other side
        col = (re.search(r'@map\("(\w+)"\)', rest) or [None, f])[1]
        want[col] = ('USER-DEFINED' if t in enums else PGTYPE[t], opt != '?')
    got = {r[0]: (r[1], r[2] == 'YES') for r in q(
        f"select column_name, data_type, is_nullable from information_schema.columns where table_name='{table}'")}
    for c in sorted(set(want) | set(got)):
        w, g = want.get(c), (got[c][0], got[c][1] == False) if c in got else None
        if g: g = (g[0], not got[c][1])
        if w != g: bad += 1; print(f'  DRIFT {table}.{c}: schema {w} vs database {g}')
    have_idx = {r[0] for r in q(f"select indexname from pg_indexes where tablename='{table}'")}
    for i in sorted(idx - have_idx): bad += 1; print(f'  DRIFT {table}: index {i} is in the schema, not the database')
    rules = {r[0]: r[1] for r in q(
        "select kcu.column_name, rc.delete_rule from information_schema.referential_constraints rc "
        "join information_schema.key_column_usage kcu on kcu.constraint_name=rc.constraint_name "
        f"where kcu.table_name='{table}'")}
    colmap = {f: (re.search(rf'\b{f}\s+\w+\??\s+(.*)', body) and re.search(r'@map\("(\w+)"\)', re.search(rf'\b{f}\s+\w+\??\s+(.*)', body).group(1)) or [None, f])[1] for f in fks}
    for f, rule in fks.items():
        c = colmap[f]
        if rules.get(c) != rule: bad += 1; print(f'  DRIFT {table}.{c}: schema onDelete {rule} vs database {rules.get(c)}')
    print(f'{table}: {len(want)} columns, {len(idx)} indexes, {len(fks)} foreign keys checked')
sys.exit(1 if bad else 0)
