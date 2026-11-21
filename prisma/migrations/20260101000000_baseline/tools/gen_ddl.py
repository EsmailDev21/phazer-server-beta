import re, sys

SCHEMA_PATH = '/home/claude/proj/backend/prisma/schema.prisma'
raw = open(SCHEMA_PATH).read()

def strip_comments(text):
    out = []
    for line in text.split('\n'):
        # remove // comments (not inside strings; schema has none here)
        idx = line.find('//')
        out.append(line[:idx] if idx != -1 else line)
    return '\n'.join(out)

clean = strip_comments(raw)

# ---- enums
enums = {}  # name -> [values]
for m in re.finditer(r'^enum (\w+) \{(.*?)^\}', clean, re.S | re.M):
    name, body = m.group(1), m.group(2)
    vals = [v.strip() for v in body.split('\n') if v.strip()]
    enums[name] = vals

# ---- models
models = {}  # name -> {fields:[...], map: table_name, ids:[], uniques:[[...]], indexes:[[...]]}
for m in re.finditer(r'^model (\w+) \{(.*?)^\}', clean, re.S | re.M):
    name, body = m.group(1), m.group(2)
    fields = []
    block_uniques = []
    block_indexes = []
    block_id = None
    table_map = name  # fallback
    for line in body.split('\n'):
        line = line.strip()
        if not line:
            continue
        if line.startswith('@@map('):
            table_map = re.search(r'@@map\("([^"]+)"\)', line).group(1)
            continue
        if line.startswith('@@unique('):
            cols = re.search(r'@@unique\(\[([^\]]+)\]', line).group(1)
            block_uniques.append([c.strip() for c in cols.split(',')])
            continue
        if line.startswith('@@index('):
            cols = re.search(r'@@index\(\[([^\]]+)\]', line).group(1)
            block_indexes.append([c.strip() for c in cols.split(',')])
            continue
        if line.startswith('@@id('):
            cols = re.search(r'@@id\(\[([^\]]+)\]', line).group(1)
            block_id = [c.strip() for c in cols.split(',')]
            continue
        # field line: name Type[]? @attr @attr(...)
        fm = re.match(r'^(\w+)\s+([A-Za-z0-9_]+)(\[\])?(\?)?\s*(.*)$', line)
        if not fm:
            continue
        fname, ftype, is_list, is_opt, attrs = fm.groups()
        fields.append({
            'name': fname, 'type': ftype, 'list': bool(is_list), 'opt': bool(is_opt),
            'attrs': attrs or '', 'raw': line,
        })
    models[name] = {
        'fields': fields, 'table': table_map, 'uniques': block_uniques,
        'indexes': block_indexes, 'compound_id': block_id,
    }

SCALARS = {'String': 'TEXT', 'Int': 'INTEGER', 'Float': 'DOUBLE PRECISION',
           'Boolean': 'BOOLEAN', 'DateTime': 'TIMESTAMP(3)', 'Json': 'JSONB'}

def extract_default(attrs):
    """@default(...) can contain nested parens (now(), cuid()), so a naive
    [^)]* regex mis-captures at the FIRST ')' instead of the matching one
    (e.g. '@default(now())' -> 'now(' not 'now()'). Scan with paren balance
    instead. Returns the raw content string, or None if there's no @default."""
    key = '@default('
    i = attrs.find(key)
    if i == -1:
        return None
    start = i + len(key)
    depth = 1
    j = start
    while j < len(attrs) and depth > 0:
        if attrs[j] == '(':
            depth += 1
        elif attrs[j] == ')':
            depth -= 1
        j += 1
    return attrs[start:j - 1]

def snake(s):
    s = re.sub(r'(?<!^)(?=[A-Z])', '_', s)
    return s.lower()

def pg_enum_name(name):
    return snake(name)

model_by_name = {n: m for n, m in models.items()}

def is_relation_field(f):
    # a field whose type is a model name AND it's not a foreign-key scalar column
    return f['type'] in model_by_name

def col_type(f):
    if f['type'] in SCALARS:
        return SCALARS[f['type']]
    if f['type'] in enums:
        return f'"{pg_enum_name(f["type"])}"'
    return None

ddl = []
ddl.append('-- Baseline migration, hand-authored from prisma/schema.prisma.')
ddl.append('-- See prisma/migrations/README-BASELINE.md for how this was produced and verified.')
ddl.append('BEGIN;')
ddl.append('')

# ---- enums first
for ename, vals in enums.items():
    pgname = pg_enum_name(ename)
    vlist = ', '.join(f"'{v}'" for v in vals)
    ddl.append(f'CREATE TYPE "{pgname}" AS ENUM ({vlist});')
ddl.append('')

# ---- tables
# implicit m2m join tables to add at the end (Prisma default naming: _ModelAModelB)
implicit_m2m = []

for mname, m in models.items():
    table = m['table']
    cols = []
    pk_cols = []
    fk_lines = []
    uniq_single = []  # (colname,) for @unique field-level

    for f in m['fields']:
        if is_relation_field(f) and not f['list']:
            # single relation field (e.g. `user User @relation(...)`) — the actual
            # FK column is the separate `<name>Id String` scalar field; this line
            # itself becomes a FOREIGN KEY constraint using fields:[...] references:[...]
            fk_match = re.search(r'fields:\s*\[([^\]]+)\],\s*references:\s*\[([^\]]+)\]', f['attrs'])
            ondelete = re.search(r'onDelete:\s*(\w+)', f['attrs'])
            if fk_match:
                local_cols = [c.strip() for c in fk_match.group(1).split(',')]
                ref_cols = [c.strip() for c in fk_match.group(2).split(',')]
                ref_table = model_by_name[f['type']]['table']
                on_del = {'Cascade': 'CASCADE', 'SetNull': 'SET NULL', 'Restrict': 'RESTRICT'}.get(
                    ondelete.group(1) if ondelete else '', 'NO ACTION')
                local_cols_sql = ', '.join(f'"{snake(c)}"' for c in local_cols)
                ref_cols_sql = ', '.join(f'"{snake(c)}"' for c in ref_cols)
                fk_lines.append(
                    f'ALTER TABLE "{table}" ADD CONSTRAINT "fk_{table}_{snake(local_cols[0])}" '
                    f'FOREIGN KEY ({local_cols_sql}) REFERENCES "{ref_table}"({ref_cols_sql}) ON DELETE {on_del};'
                )
            continue  # relation object field never becomes its own column
        if is_relation_field(f) and f['list']:
            # 1-to-many back-relation (no column) OR implicit many-to-many (List of Model with no scalar FK on either side and both sides are List)
            other = model_by_name[f['type']]
            # detect explicit m2m: both sides List of each other with matching @relation name and neither has scalar id fields for it
            continue
        # scalar column
        colname = snake(f['name'])
        ctype = col_type(f)
        if ctype is None:
            continue
        nullable = '' if not f['opt'] else ''  # handled below
        default = ''
        dv = extract_default(f['attrs'])
        if dv is not None:
            if dv == 'now()':
                default = ' DEFAULT now()'
            elif dv == 'cuid()':
                default = ''  # handled as app-generated id, no DB default
            elif dv in ('true', 'false'):
                default = f' DEFAULT {dv}'
            elif re.match(r'^-?\d+(\.\d+)?$', dv):
                default = f' DEFAULT {dv}'
            elif f['type'] in enums:
                default = f" DEFAULT '{dv}'"
            elif dv.startswith('"'):
                default = " DEFAULT '" + dv.strip('"') + "'"
        updated = '@updatedAt' in f['attrs']
        if updated and not default:
            # Prisma Client always sets this explicitly on create/update, but
            # match what `prisma migrate dev` itself generates: a DB-level
            # fallback default so a row is never left without one.
            default = ' DEFAULT CURRENT_TIMESTAMP'
        col_sql = f'"{colname}" {ctype}'
        if not f['opt']:
            col_sql += ' NOT NULL'
        col_sql += default
        cols.append(col_sql)
        if '@id' in f['attrs']:
            pk_cols.append(colname)
        if '@unique' in f['attrs']:
            uniq_single.append(colname)

    if m['compound_id']:
        pk_cols = [snake(c) for c in m['compound_id']]

    lines = [f'CREATE TABLE "{table}" (']
    lines.append(',\n'.join('  ' + c for c in cols))
    if pk_cols:
        pk_sql = ", ".join('"' + c + '"' for c in pk_cols)
        lines.append(',\n  PRIMARY KEY (' + pk_sql + ')')
    lines.append(');')
    ddl.append('\n'.join(lines))
    for c in uniq_single:
        ddl.append(f'CREATE UNIQUE INDEX "uq_{table}_{c}" ON "{table}"("{c}");')
    for cols_ in m['uniques']:
        cs = [snake(c) for c in cols_]
        idx = 'uq_' + table + '_' + '_'.join(cs)
        cols_sql = ", ".join('"' + c + '"' for c in cs)
        ddl.append(f'CREATE UNIQUE INDEX "{idx}" ON "{table}"({cols_sql});')
    for cols_ in m['indexes']:
        cs = [snake(c) for c in cols_]
        idx = 'ix_' + table + '_' + '_'.join(cs)
        cols_sql = ", ".join('"' + c + '"' for c in cs)
        ddl.append(f'CREATE INDEX "{idx}" ON "{table}"({cols_sql});')
    ddl.append('')

# ---- FKs (after all tables exist)
for mname, m in models.items():
    pass  # fk_lines were collected per-model above; re-collect in second pass since we need them after ALL tables
ddl.append('-- Foreign keys (all tables now exist)')

all_fk_lines = []
for mname, m in models.items():
    table = m['table']
    for f in m['fields']:
        if is_relation_field(f) and not f['list']:
            fk_match = re.search(r'fields:\s*\[([^\]]+)\],\s*references:\s*\[([^\]]+)\]', f['attrs'])
            if not fk_match:
                continue
            ondelete = re.search(r'onDelete:\s*(\w+)', f['attrs'])
            local_cols = [c.strip() for c in fk_match.group(1).split(',')]
            ref_cols = [c.strip() for c in fk_match.group(2).split(',')]
            ref_table = model_by_name[f['type']]['table']
            on_del = {'Cascade': 'CASCADE', 'SetNull': 'SET NULL', 'Restrict': 'RESTRICT'}.get(
                ondelete.group(1) if ondelete else '', 'NO ACTION')
            local_cols_sql = ', '.join(f'"{snake(c)}"' for c in local_cols)
            ref_cols_sql = ', '.join(f'"{snake(c)}"' for c in ref_cols)
            cname = f'fk_{table}_{snake(local_cols[0])}'
            all_fk_lines.append(
                f'ALTER TABLE "{table}" ADD CONSTRAINT "{cname}" '
                f'FOREIGN KEY ({local_cols_sql}) REFERENCES "{ref_table}"({ref_cols_sql}) ON DELETE {on_del};'
            )
for l in all_fk_lines:
    ddl.append(l)
ddl.append('')

# ---- implicit many-to-many join tables
# Find pairs of List-relation fields across models that DON'T correspond to an
# explicit back-relation via a scalar FK model (i.e. neither side has a model
# in between). Prisma naming: _<A><B> alphabetically for unnamed, or the
# @relation("Name") name for named ones, table "_TaskAssignees" style: "_" + RelationName.
m2m_pairs = {}
for mname, m in models.items():
    for f in m['fields']:
        if is_relation_field(f) and f['list']:
            other_model = model_by_name[f['type']]
            # if the OTHER model has no scalar/back field pointing here with fields:[...] it's m2m
            rel_name_m = re.search(r'@relation\("([^"]+)"\)', f['attrs'])
            rel_name = rel_name_m.group(1) if rel_name_m else None
            # check other side: does other_model have a list field back to mname with same relation name and no fields:[]?
            for of in other_model['fields']:
                if of is f:
                    continue  # a self-relation field must never pair with itself
                if of['type'] == mname and of['list']:
                    orel = re.search(r'@relation\("([^"]+)"\)', of['attrs'])
                    orel_name = orel.group(1) if orel else None
                    if orel_name == rel_name:
                        key = tuple(sorted([mname, other_model['table']]) ) if not rel_name else rel_name
                        m2m_pairs[(mname, f['name'])] = (mname, other_model, rel_name)

seen_join = set()
for (mname, fname), (src_model, dst, relname) in m2m_pairs.items():
    ident = relname or '_'.join(sorted([mname, dst['table']]))
    if ident in seen_join:
        continue
    seen_join.add(ident)
    jt = '_' + (relname if relname else f'{mname}To{dst["table"]}')
    a_table, b_table = models[mname]['table'], dst['table']
    # Prisma orders implicit m2m columns as A/B alphabetically by model name
    m1, m2 = sorted([mname, [k for k,v in models.items() if v is dst][0]])
    ta, tb = models[m1]['table'], models[m2]['table']
    ddl.append(f'CREATE TABLE "{jt}" (')
    ddl.append(f'  "A" TEXT NOT NULL REFERENCES "{ta}"(id) ON DELETE CASCADE,')
    ddl.append(f'  "B" TEXT NOT NULL REFERENCES "{tb}"(id) ON DELETE CASCADE')
    ddl.append(');')
    ddl.append(f'CREATE UNIQUE INDEX "{jt}_AB_unique" ON "{jt}"("A", "B");')
    ddl.append(f'CREATE INDEX "{jt}_B_index" ON "{jt}"("B");')
    ddl.append('')

ddl.append('COMMIT;')

open('/home/claude/baseline/baseline.sql', 'w').write('\n'.join(ddl))
print('models:', len(models), 'enums:', len(enums), 'implicit m2m found:', len(seen_join))
print('WROTE /home/claude/baseline/baseline.sql —', len(ddl), 'lines/statements-ish')
