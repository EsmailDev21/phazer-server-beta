# Offline schema-vs-migrations drift check (Prisma's schema engine needs network). Usage: apply all migrations to a scratch Postgres on port 5499 (db appdb_test), run from backend/: python3 scripts/check-schema-drift.py
# Checks enum types+values, tables, columns and explicitly named indexes/constraints. It does NOT check column types, nullability or FK actions.
import re,subprocess,sys
def q(sql):
    r=subprocess.run(['/usr/lib/postgresql/16/bin/psql','-h','/tmp','-p','5499','-U','postgres','-d','appdb_test','-Atc',sql],capture_output=True,text=True)
    if r.returncode!=0:
        sys.exit('CANNOT CONNECT to the scratch database (port 5499, db appdb_test): '+r.stderr.strip()+'\nThe check proved nothing. Start it, apply the migrations, rerun.')
    return [l for l in r.stdout.split('\n') if l]
s=open('prisma/schema.prisma').read()
pg_enums={}
for r in q("select t.typname||'|'||string_agg(e.enumlabel,',' order by e.enumsortorder) from pg_type t join pg_enum e on e.enumtypid=t.oid group by t.typname"):
    n,v=r.split('|'); pg_enums[n]=set(v.split(','))
idx=set(q("select indexname from pg_indexes where schemaname='public'")); cons=set(q("select conname from pg_constraint"))
tables=set(q("select table_name from information_schema.tables where table_schema='public'"))
cols=set(q("select table_name||'.'||column_name from information_schema.columns where table_schema='public'"))
if not tables: sys.exit('The scratch database has no tables: apply the migrations first. The check proved nothing.')
problems=[]
for m in re.finditer(r'^enum (\w+) \{(.*?)^\}',s,re.S|re.M):
    name,body=m.groups(); mp=re.search(r'@@map\("(\w+)"\)',body); db=mp.group(1) if mp else name
    vals=[re.match(r'\s*(\w+)',l).group(1) for l in body.split('\n') if re.match(r'\s*[A-Z_0-9a-z]+\s*(//.*)?$',l) and not l.strip().startswith('@@') and not l.strip().startswith('//')]
    if db not in pg_enums: problems.append(f'enum {name}: db type "{db}" missing'); continue
    for v in vals:
        if v not in pg_enums[db]: problems.append(f'enum {name}: value {v} not in db type {db}')
for m in re.finditer(r'^model (\w+) \{(.*?)^\}',s,re.S|re.M):
    name,body=m.groups(); mp=re.search(r'@@map\("(\w+)"\)',body); t=mp.group(1) if mp else name
    if t not in tables: problems.append(f'model {name}: table "{t}" missing'); continue
    for l in body.split('\n'):
        f=re.match(r'\s+(\w+)\s+([A-Za-z]+)(\[\])?(\?)?(.*)',l)
        if not f or l.strip().startswith(('@@','//','///')): continue
        fname,ftype,rest=f.group(1),f.group(2),f.group(5)
        if ftype in ('String','Int','Boolean','DateTime','Float','Json','BigInt','Decimal','Bytes') or ftype in {e for e in re.findall(r'^enum (\w+)',s,re.M)}:
            cm=re.search(r'@map\("(\w+)"\)',rest); c=cm.group(1) if cm else fname
            if f'{t}.{c}' not in cols: problems.append(f'{name}.{fname}: column {t}.{c} missing')
    for n in re.findall(r'map:\s*"(\w+)"',body):
        if n not in idx and n not in cons: problems.append(f'{name}: index/constraint {n} missing')
print(len(problems),'problems'); print('\n'.join(problems[:40]))
