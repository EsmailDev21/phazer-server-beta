import { foldName, validateBlueprint } from '../blueprint';
import { ApplyOpsResult, EditableCollection, MAX_OPS_PER_REQUEST, Obj, OpError, RenameableCollection, StoredAssetInfo } from './editor.types';

class OpFailure extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
const fail = (code: string, message: string): never => { throw new OpFailure(code, message); };

type Any = any; // the blueprint is walked as untyped JSON here; validateBlueprint is the guard at the end

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const TASK_FIELDS = ['title', 'description', 'issueType', 'status', 'priority', 'tags', 'customValues', 'assigneeRoles', 'startOffsetDays', 'dueOffsetDays', 'estimate', 'iteration', 'comments', 'attachments'];
const REF = /^[A-Za-z0-9_]{1,30}$/;
export const EDITOR_KEY = /^n(\d+)$/;
const ASSET_KEY = /^a(\d+)$/;

/** Highest editor-minted number among the nodeKeys of a blueprint (0 if none). */
export function maxEditorKey(bp: unknown): number {
  let max = 0;
  const visit = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(visit);
    else if (isObj(v)) {
      if (typeof v.nodeKey === 'string') { const m = EDITOR_KEY.exec(v.nodeKey); if (m) max = Math.max(max, Number(m[1])); }
      if (typeof v.key === 'string' && typeof v.sha256 === 'string') { const m = ASSET_KEY.exec(v.key); if (m) max = Math.max(max, Number(m[1])); } // asset keys come from the same counter
      for (const x of Object.values(v)) visit(x);
    }
  };
  visit(bp);
  return max;
}

interface Env {
  bp: Any;
  idx: number;
  refs: Map<string, string>;
  used: Set<string>;
  seq: number;
  minted: string[];
  cascaded: Array<{ index: number; note: string }>;
  catalog: StoredAssetInfo[];
}

// ------------------------------------------------------------------ small helpers ----------
function exact(op: Obj, allowed: string[], required: string[]): void {
  for (const k of Object.keys(op)) if (k !== 'op' && !allowed.includes(k)) fail('OP_INVALID', `"${op.op}" does not take "${k}"`);
  for (const k of required) if (op[k] === undefined) fail('OP_INVALID', `"${op.op}" needs "${k}"`);
}
const str = (v: unknown, name: string): string => (typeof v === 'string' && v.length > 0 ? v : fail('OP_INVALID', `"${name}" must be a non-empty string`));
const int = (v: unknown, name: string): number => (Number.isInteger(v) ? (v as number) : fail('OP_INVALID', `"${name}" must be an integer`));
const object = (v: unknown, name: string): Obj => (isObj(v) ? v : fail('OP_INVALID', `"${name}" must be an object`));
const clean = <T>(v: T): T => JSON.parse(JSON.stringify(v));

/** `$ref` inside a task's `iteration` or `attachments` means the key an earlier op of this request created. */
function resolveTaskRefs(env: Env, fields: Obj): void {
  const one = (v: unknown, name: string) => (typeof v === 'string' && v.startsWith('$') ? key(env, v, name) : v);
  if (fields.iteration !== undefined) fields.iteration = one(fields.iteration, 'iteration');
  if (Array.isArray(fields.attachments)) fields.attachments = fields.attachments.map((a) => one(a, 'attachments[]'));
}

function note(env: Env, text: string) { env.cascaded.push({ index: env.idx, note: text }); }

function allNodeKeys(bp: Any): Set<string> {
  const out = new Set<string>();
  const visit = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(visit);
    else if (isObj(v)) { if (typeof v.nodeKey === 'string') out.add(v.nodeKey); Object.values(v).forEach(visit); }
  };
  visit(bp);
  for (const a of bp?.assets ?? []) if (typeof a?.key === 'string') out.add(a.key);
  return out;
}

/** `n<seq>`, skipping any number whose key is already in the document (an uploaded blueprint can contain `n7`). */
function mint(env: Env, prefix = 'n'): string {
  for (;;) {
    const k = `${prefix}${env.seq++}`;
    if (!env.used.has(k)) { env.used.add(k); env.minted.push(k); return k; }
  }
}
function bind(env: Env, ref: unknown, key: string) {
  if (ref === undefined) return;
  const r = str(ref, 'ref');
  if (!REF.test(r)) fail('OP_INVALID', `"ref" may only use letters, digits and _ (max 30)`);
  if (env.refs.has(r)) fail('REF_DUPLICATE', `"ref" ${r} is already used in this request`);
  env.refs.set(r, key);
}
/** `$name` -> the key minted for that ref earlier in the same request; anything else is a key as is. */
function key(env: Env, v: unknown, name: string): string {
  const s = str(v, name);
  if (!s.startsWith('$')) return s;
  return env.refs.get(s.slice(1)) ?? fail('REF_UNKNOWN', `"${s}" is not defined by an earlier op in this request`);
}

interface Loc { project: Any; list: Any[]; index: number; parent: Any | null; task: Any }
function findTask(bp: Any, k: string): Loc | null {
  const walk = (list: Any[], project: Any, parent: Any | null): Loc | null => {
    for (let i = 0; i < list.length; i++) {
      if (list[i].nodeKey === k) return { project, list, index: i, parent, task: list[i] };
      const inner = walk(list[i].children ?? [], project, list[i]);
      if (inner) return inner;
    }
    return null;
  };
  for (const p of bp.projects ?? []) { const r = walk(p.tasks ?? [], p, null); if (r) return r; }
  return null;
}
const needTask = (bp: Any, k: string): Loc => findTask(bp, k) ?? fail('NOT_FOUND', `Task "${k}" does not exist`);
const needProject = (bp: Any, k: string): Any => (bp.projects ?? []).find((p: Any) => p.nodeKey === k) ?? fail('NOT_FOUND', `Project "${k}" does not exist`);
function subtree(task: Any): Any[] { return [task, ...(task.children ?? []).flatMap(subtree)]; }
function eachTask(bp: Any, fn: (t: Any, project: Any) => void) {
  for (const p of bp.projects ?? []) for (const t of (p.tasks ?? []).flatMap(subtree)) fn(t, p);
}
function insertAt(list: Any[], index: number | undefined, item: Any, what: string) {
  const i = index ?? list.length;
  if (!Number.isInteger(i) || i < 0 || i > list.length) fail('INDEX_RANGE', `index must be between 0 and ${list.length} for ${what}`);
  list.splice(i, 0, item);
}
function dropFromModules(env: Env, gone: Set<string>) {
  const mods: Any[] = env.bp.modules;
  if (!mods) return;
  let emptied = 0;
  for (const m of mods) m.includes = (m.includes ?? []).filter((k: string) => !gone.has(k));
  const keep = mods.filter((m) => m.includes.length > 0);
  emptied = mods.length - keep.length;
  if (emptied) note(env, `removed ${emptied} module(s) that no longer include anything`);
  if (keep.length === 0) delete env.bp.modules; else env.bp.modules = keep;
}
function dropDependencies(project: Any, gone: Set<string>): number {
  const deps: Any[] = project.dependencies ?? [];
  const keep = deps.filter((d) => !gone.has(d.from) && !gone.has(d.to));
  if (keep.length === 0) delete project.dependencies; else project.dependencies = keep;
  return deps.length - keep.length;
}

// ------------------------------------------------------------------ collections ------------
const WORKSPACE_COLLECTIONS = new Set<EditableCollection>(['tags', 'customFields', 'issueTypes', 'iterations']);
function itemKey(c: EditableCollection, item: Any): string | undefined {
  switch (c) {
    case 'tags': case 'issueTypes': return typeof item?.name === 'string' ? foldName(item.name) : undefined;
    case 'iterations': return item?.nodeKey;
    case 'variables': case 'customFields': return typeof item?.key === 'string' ? item.key.toLowerCase() : undefined; // compared ignoring case
    default: return item?.key;
  }
}
const lookupKey = (c: EditableCollection, k: string) => (c === 'tags' || c === 'issueTypes' ? foldName(k) : c === 'variables' || c === 'customFields' ? k.toLowerCase() : k);
function listFor(bp: Any, c: EditableCollection, create: boolean): Any[] | undefined {
  const holder = WORKSPACE_COLLECTIONS.has(c) ? (create ? (bp.workspace ??= {}) : bp.workspace) : bp;
  if (!holder) return undefined;
  if (create) return (holder[c] ??= []);
  return holder[c];
}
function tidy(bp: Any, c: EditableCollection) {
  const holder = WORKSPACE_COLLECTIONS.has(c) ? bp.workspace : bp;
  if (holder && Array.isArray(holder[c]) && holder[c].length === 0) delete holder[c];
  if (WORKSPACE_COLLECTIONS.has(c) && bp.workspace && Object.keys(bp.workspace).length === 0) delete bp.workspace;
}

/** Updates every reference to a tag / issue type / role / custom field when it is renamed (`to` set) or removed (`to` undefined). */
function rewriteRefs(env: Env, c: EditableCollection, from: string, to?: string): number {
  let n = 0;
  eachTask(env.bp, (t) => {
    if (c === 'tags' && Array.isArray(t.tags)) {
      const next = t.tags.flatMap((x: string) => (foldName(x) === foldName(from) ? (to ? [to] : []) : [x]));
      if (JSON.stringify(next) !== JSON.stringify(t.tags)) { n++; if (next.length) t.tags = next; else delete t.tags; }
    }
    if (c === 'issueTypes' && typeof t.issueType === 'string' && foldName(t.issueType) === foldName(from)) { n++; if (to) t.issueType = to; else delete t.issueType; }
    if (c === 'iterations' && t.iteration === from) { n++; delete t.iteration; }
    if (c === 'roles') {
      if (Array.isArray(t.assigneeRoles) && t.assigneeRoles.includes(from)) {
        n++;
        const next = t.assigneeRoles.flatMap((x: string) => (x === from ? (to ? [to] : []) : [x]));
        if (next.length) t.assigneeRoles = next; else delete t.assigneeRoles;
      }
      for (const cm of t.comments ?? []) if (cm.authorRole === from) { n++; if (to) cm.authorRole = to; else delete cm.authorRole; }
    }
    if (c === 'customFields' && isObj(t.customValues)) {
      for (const k of Object.keys(t.customValues)) {
        if (k.toLowerCase() !== from.toLowerCase()) continue;
        n++;
        const v = t.customValues[k];
        delete t.customValues[k];
        if (to) t.customValues[to] = v;
      }
      if (Object.keys(t.customValues).length === 0) delete t.customValues;
    }
  });
  return n;
}

// ------------------------------------------------------------------ the ops ----------------
const HANDLERS: Record<string, (env: Env, op: Any) => void> = {
  replaceBlueprint(env, op) {
    if (!isObj(op.blueprint)) fail('OP_INVALID', '"blueprint" must be an object');
    const next = clean(op.blueprint) as Any;
    const before = env.bp?.meta?.kind;
    if (before !== undefined && next?.meta?.kind !== before) fail('KIND_CHANGE', 'The kind of a template cannot change');
    env.bp = next;
    env.used = allNodeKeys(next);
    env.seq = Math.max(env.seq, maxEditorKey(next) + 1);
  },
  setMeta(env, op) {
    exact(op, ['set'], ['set']);
    const set = object(op.set, 'set');
    env.bp.meta ??= {};
    for (const [k, v] of Object.entries(set)) {
      if (k === 'kind') fail('KIND_IMMUTABLE', 'A template cannot change between workspace and project');
      if (!['name', 'description', 'category', 'locale'].includes(k)) fail('OP_INVALID', `meta has no editable field "${k}"`);
      if (v === null && k !== 'name') delete env.bp.meta[k]; else env.bp.meta[k] = v;
    }
  },
  setDateAnchor(env, op) {
    exact(op, ['value'], ['value']);
    if (op.value === null) delete env.bp.dateAnchor; else env.bp.dateAnchor = clean(object(op.value, 'value'));
  },
  setWorkspace(env, op) {
    exact(op, ['set'], ['set']);
    const set = object(op.set, 'set');
    const ws = (env.bp.workspace ??= {});
    for (const [k, v] of Object.entries(set)) {
      if (!['name', 'key', 'icon', 'description'].includes(k)) fail('OP_INVALID', `workspace has no editable field "${k}" (use upsert/remove for its lists)`);
      if (v === null) delete ws[k]; else ws[k] = v;
    }
  },

  upsert(env, op) {
    exact(op, ['collection', 'item', 'index', 'ref'], ['collection', 'item']);
    const c = op.collection as EditableCollection;
    if (!(c in { variables: 1, roles: 1, modules: 1, tags: 1, customFields: 1, issueTypes: 1, iterations: 1 })) fail('OP_INVALID', `unknown collection "${c}"`);
    const item = clean(object(op.item, 'item'));
    if (op.ref !== undefined && c !== 'iterations') fail('OP_INVALID', '"ref" is only for iterations (the only collection whose key the server assigns)');
    if (c === 'iterations' && typeof item.project === 'string') item.project = key(env, item.project, 'item.project');
    const probe = listFor(env.bp, c, false) ?? [];
    if (c === 'iterations' && item.nodeKey === undefined) {
      item.nodeKey = mint(env);
      bind(env, op.ref, item.nodeKey as string);
    } else {
      const k = itemKey(c, item);
      if (k === undefined) fail('OP_INVALID', `item needs ${c === 'tags' || c === 'issueTypes' ? '"name"' : c === 'iterations' ? '"nodeKey"' : '"key"'}`);
      if (c === 'iterations' && !probe.some((x) => x.nodeKey === item.nodeKey)) fail('KEY_NOT_MINTED', 'A new iteration gets its nodeKey from the server: leave "nodeKey" out');
    }
    const k = itemKey(c, item)!;
    const list = listFor(env.bp, c, true)!;
    const at = list.findIndex((x) => itemKey(c, x) === k);
    if (at >= 0) {
      if (op.index !== undefined) fail('OP_INVALID', '"index" is only for a new item (use reorder to move an existing one)');
      list[at] = item;
    } else insertAt(list, op.index, item, c);
  },
  remove(env, op) {
    exact(op, ['collection', 'key'], ['collection', 'key']);
    const c = op.collection as EditableCollection;
    const k = str(op.key, 'key');
    const list = listFor(env.bp, c, false);
    const at = list ? list.findIndex((x) => itemKey(c, x) === lookupKey(c, k)) : -1;
    if (!list || at < 0) fail('NOT_FOUND', `${c}: "${k}" does not exist`);
    const gone = list![at];
    list!.splice(at, 1);
    const stored: string = c === 'tags' || c === 'issueTypes' ? gone.name : c === 'iterations' ? gone.nodeKey : gone.key;
    if (c !== 'variables' && c !== 'modules') {
      const n = rewriteRefs(env, c, stored);
      if (n) note(env, `removed "${stored}" from ${n} place(s) that referenced it`);
    }
    if (c === 'iterations') dropFromModules(env, new Set([stored]));
    tidy(env.bp, c);
  },
  rename(env, op) {
    exact(op, ['collection', 'from', 'to'], ['collection', 'from', 'to']);
    const c = op.collection as RenameableCollection;
    if (!['tags', 'issueTypes', 'roles', 'customFields'].includes(c)) fail('RENAME_UNSUPPORTED', `"${c}" cannot be renamed (variables are referenced from text; nodeKeys never change)`);
    const from = str(op.from, 'from');
    const to = str(op.to, 'to');
    const list = listFor(env.bp, c, false) ?? [];
    const at = list.findIndex((x) => itemKey(c, x) === lookupKey(c, from));
    if (at < 0) fail('NOT_FOUND', `${c}: "${from}" does not exist`);
    const field = c === 'tags' || c === 'issueTypes' ? 'name' : 'key';
    const stored = list[at][field];
    list[at][field] = to;
    const n = rewriteRefs(env, c, stored, to);
    if (n) note(env, `updated ${n} reference(s) to "${stored}"`);
  },
  reorder(env, op) {
    exact(op, ['collection', 'keys'], ['collection', 'keys']);
    const c = op.collection as EditableCollection;
    if (!Array.isArray(op.keys)) fail('OP_INVALID', '"keys" must be a list');
    const list = listFor(env.bp, c, false) ?? [];
    const want = (op.keys as unknown[]).map((k) => lookupKey(c, str(k, 'keys[]')));
    const have = list.map((x) => itemKey(c, x)!);
    if (want.length !== have.length || new Set(want).size !== want.length || want.some((k) => !have.includes(k))) fail('ORDER_MISMATCH', `"keys" must list every existing ${c} item exactly once`);
    const sorted = want.map((k) => list.find((x) => itemKey(c, x) === k));
    list.splice(0, list.length, ...sorted);
  },

  addProject(env, op) {
    exact(op, ['ref', 'project', 'index'], ['project']);
    const p = clean(object(op.project, 'project'));
    for (const k of Object.keys(p)) if (!['name', 'description', 'workflow'].includes(k)) fail('OP_INVALID', `a new project takes name, description, workflow (not "${k}"); add tasks with addTask`);
    str(p.name, 'project.name');
    const nodeKey = mint(env);
    bind(env, op.ref, nodeKey);
    insertAt((env.bp.projects ??= []), op.index, { nodeKey, ...p, tasks: [] }, 'projects');
  },
  updateProject(env, op) {
    exact(op, ['nodeKey', 'set'], ['nodeKey', 'set']);
    const p = needProject(env.bp, key(env, op.nodeKey, 'nodeKey'));
    for (const [k, v] of Object.entries(object(op.set, 'set'))) {
      if (!['name', 'description', 'workflow'].includes(k)) fail('OP_INVALID', `a project has no editable field "${k}"`);
      if (v === null && k !== 'name') delete p[k]; else p[k] = clean(v);
    }
  },
  moveProject(env, op) {
    exact(op, ['nodeKey', 'index'], ['nodeKey', 'index']);
    const list: Any[] = env.bp.projects;
    const k = key(env, op.nodeKey, 'nodeKey');
    const at = list.findIndex((p) => p.nodeKey === k);
    if (at < 0) fail('NOT_FOUND', `Project "${k}" does not exist`);
    const i = int(op.index, 'index');
    if (i < 0 || i >= list.length) fail('INDEX_RANGE', `index must be between 0 and ${list.length - 1}`);
    const [p] = list.splice(at, 1);
    list.splice(i, 0, p);
  },
  removeProject(env, op) {
    exact(op, ['nodeKey'], ['nodeKey']);
    const k = key(env, op.nodeKey, 'nodeKey');
    const p = needProject(env.bp, k);
    const gone = new Set<string>([k, ...(p.tasks ?? []).flatMap(subtree).map((t: Any) => t.nodeKey)]);
    env.bp.projects = env.bp.projects.filter((x: Any) => x !== p);
    const its: Any[] = env.bp.workspace?.iterations ?? [];
    const scoped = its.filter((i) => i.project === k);
    if (scoped.length) {
      scoped.forEach((i) => gone.add(i.nodeKey));
      env.bp.workspace.iterations = its.filter((i) => i.project !== k);
      tidy(env.bp, 'iterations');
      note(env, `removed ${scoped.length} iteration(s) that belonged to the project`);
    }
    dropFromModules(env, gone);
    if (gone.size > 1) note(env, `removed ${gone.size - 1 - scoped.length} task(s) with the project`);
  },

  addTask(env, op) {
    exact(op, ['ref', 'project', 'parent', 'index', 'task'], ['task']);
    const t = clean(object(op.task, 'task'));
    for (const k of Object.keys(t)) {
      if (k === 'children' || k === 'nodeKey') fail('OP_INVALID', `"${k}" cannot be set: sub-tasks are added with their own addTask (parent), the key is assigned by the server`);
      if (!TASK_FIELDS.includes(k)) fail('OP_INVALID', `a task has no field "${k}"`);
    }
    str(t.title, 'task.title');
    resolveTaskRefs(env, t);
    let project: Any;
    let parent: Any | null = null;
    if (op.parent !== undefined) {
      const loc = needTask(env.bp, key(env, op.parent, 'parent'));
      parent = loc.task;
      project = loc.project;
      if (op.project !== undefined && key(env, op.project, 'project') !== project.nodeKey) fail('PARENT_PROJECT_MISMATCH', 'The parent task is in another project');
    } else {
      if (op.project === undefined) fail('OP_INVALID', 'addTask needs "project" or "parent"');
      project = needProject(env.bp, key(env, op.project, 'project'));
    }
    const nodeKey = mint(env);
    bind(env, op.ref, nodeKey);
    const list = parent ? (parent.children ??= []) : (project.tasks ??= []);
    insertAt(list, op.index, { nodeKey, ...t }, 'tasks');
  },
  updateTask(env, op) {
    exact(op, ['nodeKey', 'set', 'unset'], ['nodeKey']);
    const { task } = needTask(env.bp, key(env, op.nodeKey, 'nodeKey'));
    const set = op.set === undefined ? {} : clean(object(op.set, 'set'));
    const unset: string[] = op.unset === undefined ? [] : Array.isArray(op.unset) ? op.unset : fail('OP_INVALID', '"unset" must be a list');
    if (Object.keys(set).length === 0 && unset.length === 0) fail('OP_INVALID', 'updateTask needs "set" or "unset"');
    for (const k of Object.keys(set)) if (!TASK_FIELDS.includes(k)) fail('OP_INVALID', `a task has no editable field "${k}" (keys never change; use moveTask to move it)`);
    for (const k of unset) {
      if (k === 'title') fail('OP_INVALID', 'a task cannot lose its title');
      if (!TASK_FIELDS.includes(k)) fail('OP_INVALID', `a task has no field "${k}"`);
      if (k in set) fail('OP_INVALID', `"${k}" is both set and unset`);
    }
    resolveTaskRefs(env, set);
    Object.assign(task, set);
    for (const k of unset) delete task[k];
  },
  moveTask(env, op) {
    exact(op, ['nodeKey', 'project', 'parent', 'index', 'clear'], ['nodeKey']);
    const k = key(env, op.nodeKey, 'nodeKey');
    const loc = needTask(env.bp, k);
    // a status or an iteration belongs to a project; `clear` drops them from the moved task and its sub-tasks
    const clear: string[] = op.clear === undefined ? [] : Array.isArray(op.clear) ? op.clear : fail('OP_INVALID', '"clear" must be a list');
    for (const c of clear) if (c !== 'status' && c !== 'iteration') fail('OP_INVALID', '"clear" may contain "status" and "iteration"');
    const dest = op.project !== undefined ? needProject(env.bp, key(env, op.project, 'project')) : loc.project;
    const crossing = dest !== loc.project;
    let parent: Any | null;
    if (op.parent === undefined) parent = crossing ? null : loc.parent;
    else if (op.parent === null) parent = null;
    else {
      const pl = needTask(env.bp, key(env, op.parent, 'parent'));
      if (pl.project !== dest) fail('PARENT_PROJECT_MISMATCH', 'The new parent is not in the destination project');
      parent = pl.task;
    }
    const moving = subtree(loc.task);
    const keys = new Set<string>(moving.map((t) => t.nodeKey));
    if (parent && keys.has(parent.nodeKey)) fail('CYCLE', 'A task cannot be moved under itself or its own sub-task');

    loc.list.splice(loc.index, 1);
    if (loc.parent && loc.list.length === 0) delete loc.parent.children;
    const list = parent ? (parent.children ??= []) : (dest.tasks ??= []);
    insertAt(list, op.index, loc.task, 'tasks');
    for (const t of moving) for (const c of clear) delete t[c];

    if (crossing) {
      // dependencies between moved tasks travel with them; ones that tie them to tasks staying behind cannot exist across projects
      const deps: Any[] = loc.project.dependencies ?? [];
      const inside = deps.filter((d) => keys.has(d.from) && keys.has(d.to));
      const dropped = deps.filter((d) => (keys.has(d.from) || keys.has(d.to)) && !(keys.has(d.from) && keys.has(d.to)));
      const rest = deps.filter((d) => !inside.includes(d) && !dropped.includes(d));
      if (rest.length) loc.project.dependencies = rest; else delete loc.project.dependencies;
      if (inside.length) dest.dependencies = [...(dest.dependencies ?? []), ...inside];
      if (dropped.length) note(env, `removed ${dropped.length} dependency(ies) that tied the moved task to tasks left in the other project`);
    }
  },
  duplicateTask(env, op) {
    exact(op, ['ref', 'nodeKey'], ['nodeKey']);
    const loc = needTask(env.bp, key(env, op.nodeKey, 'nodeKey'));
    const map = new Map<string, string>();
    const copy = (t: Any): Any => {
      const c = clean(t);
      const walk = (x: Any) => { const nk = mint(env); map.set(x.nodeKey, nk); x.nodeKey = nk; (x.children ?? []).forEach(walk); };
      walk(c);
      return c;
    };
    const copied = copy(loc.task);
    bind(env, op.ref, copied.nodeKey);
    loc.list.splice(loc.index + 1, 0, copied);
    // dependencies inside the copied subtree are copied with the new keys
    const deps: Any[] = loc.project.dependencies ?? [];
    const inner = deps.filter((d) => map.has(d.from) && map.has(d.to)).map((d) => ({ ...d, from: map.get(d.from), to: map.get(d.to) }));
    if (inner.length) loc.project.dependencies = [...deps, ...inner];
    // the copy belongs to every module the original belongs to, so toggling the module hides both
    for (const m of env.bp.modules ?? []) {
      const add = m.includes.filter((x: string) => map.has(x)).map((x: string) => map.get(x));
      if (add.length) m.includes = [...m.includes, ...add];
    }
  },
  removeTask(env, op) {
    exact(op, ['nodeKey'], ['nodeKey']);
    const loc = needTask(env.bp, key(env, op.nodeKey, 'nodeKey'));
    const gone = new Set(subtree(loc.task).map((t) => t.nodeKey));
    loc.list.splice(loc.index, 1);
    if (loc.parent && loc.list.length === 0) delete loc.parent.children;
    const deps = dropDependencies(loc.project, gone);
    if (deps) note(env, `removed ${deps} dependency(ies) of the removed task(s)`);
    if (gone.size > 1) note(env, `removed ${gone.size - 1} sub-task(s) with it`);
    dropFromModules(env, gone);
  },

  addDependency(env, op) {
    exact(op, ['from', 'to', 'type'], ['from', 'to']);
    const from = needTask(env.bp, key(env, op.from, 'from'));
    const to = key(env, op.to, 'to');
    const dep: Obj = { from: from.task.nodeKey, to };
    if (op.type !== undefined) dep.type = str(op.type, 'type');
    (from.project.dependencies ??= []).push(dep);
  },
  addAsset(env, op) {
    exact(op, ['ref', 'sha256'], ['sha256']);
    const sha = str(op.sha256, 'sha256').toLowerCase();
    const file = env.catalog.find((a) => a.sha256 === sha) ?? fail('ASSET_NOT_STORED', 'That file is not stored with this template: upload it first');
    const list: Any[] = (env.bp.assets ??= []);
    const have = list.find((a) => a.sha256 === sha);
    if (have) { bind(env, op.ref, have.key); return; } // already in the blueprint: nothing to add
    const k = mint(env, 'a');
    bind(env, op.ref, k);
    list.push({ key: k, fileName: file.fileName, mimeType: file.mimeType, sizeBytes: file.sizeBytes, sha256: file.sha256 });
  },
  removeAsset(env, op) {
    exact(op, ['key'], ['key']);
    const k = key(env, op.key, 'key');
    const list: Any[] = env.bp.assets ?? [];
    const at = list.findIndex((a) => a.key === k);
    if (at < 0) fail('NOT_FOUND', `Asset "${k}" does not exist`);
    list.splice(at, 1);
    if (list.length === 0) delete env.bp.assets;
    let n = 0;
    eachTask(env.bp, (t) => {
      if (Array.isArray(t.attachments) && t.attachments.includes(k)) { n++; const next = t.attachments.filter((x: string) => x !== k); if (next.length) t.attachments = next; else delete t.attachments; }
    });
    if (n) note(env, `removed the file from ${n} task(s)`);
  },
  removeDependency(env, op) {
    exact(op, ['from', 'to', 'type'], ['from', 'to']);
    const from = needTask(env.bp, key(env, op.from, 'from'));
    const to = key(env, op.to, 'to');
    const type = op.type === undefined ? 'BLOCKS' : str(op.type, 'type');
    const deps: Any[] = from.project.dependencies ?? [];
    const at = deps.findIndex((d) => d.from === from.task.nodeKey && d.to === to && (d.type ?? 'BLOCKS') === type);
    if (at < 0) fail('NOT_FOUND', 'That dependency does not exist');
    deps.splice(at, 1);
    if (deps.length === 0) delete from.project.dependencies;
  },
};

/**
 * Applies a batch to a COPY of `blueprint`. Either every op applies and the whole result
 * validates, or nothing does (and the error says which op, or which validation issues).
 * `nextSeq` is the editor key counter the batch starts from.
 */
export function applyOps(blueprint: unknown, ops: unknown, nextSeq: number, catalog: StoredAssetInfo[] = []): ApplyOpsResult {
  const bad = (index: number, op: string, code: string, message: string): ApplyOpsResult => ({ ok: false, kind: 'op', error: { index, op, code, message } as OpError });
  if (!Array.isArray(ops) || ops.length === 0) return bad(0, '', 'OP_INVALID', '"ops" must be a non-empty list');
  if (ops.length > MAX_OPS_PER_REQUEST) return bad(0, '', 'TOO_MANY_OPS', `At most ${MAX_OPS_PER_REQUEST} operations per request`);

  const bp = clean(blueprint) as Any;
  const env: Env = { bp, idx: 0, refs: new Map(), used: allNodeKeys(bp), seq: Math.max(nextSeq, maxEditorKey(bp) + 1), minted: [], cascaded: [], catalog };
  for (let i = 0; i < ops.length; i++) {
    env.idx = i;
    const op = ops[i];
    const name = isObj(op) && typeof op.op === 'string' ? op.op : '';
    try {
      if (!isObj(op)) fail('OP_INVALID', 'each operation must be an object');
      const h = Object.prototype.hasOwnProperty.call(HANDLERS, name) ? HANDLERS[name] : undefined;
      if (!h) fail('OP_UNKNOWN', `Unknown operation "${name}"`);
      h!(env, op);
    } catch (err) {
      if (err instanceof OpFailure) return bad(i, name, err.code, err.message);
      throw err;
    }
  }
  const check = validateBlueprint(env.bp);
  if (check.ok === false) return { ok: false, kind: 'invalid', issues: check.issues, truncated: check.truncated };
  return { ok: true, blueprint: check.blueprint, created: Object.fromEntries(env.refs), minted: env.minted, nextSeq: env.seq, cascaded: env.cascaded };
}
