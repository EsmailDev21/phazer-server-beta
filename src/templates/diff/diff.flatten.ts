import { createHash } from 'crypto';
import { canonicalJson, foldName } from '../blueprint';
import type { BlueprintV1, BlueprintTask } from '../blueprint';
import { DiffEntity } from './diff.types';

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** One thing with an identity: a task, a tag, a status... and its fields (dotted path -> value). */
export interface Ent {
  id: string; // unique in the document: `<entity>:<scope/>key`
  entity: DiffEntity;
  scope?: string;
  key: string;
  label: string;
  fields: Record<string, Json>;
}

/** An ordered list of entity ids inside a container (the children of a task, the tags of the workspace...). */
export interface Order {
  container: { entity: DiffEntity; id: string; field: string };
  ids: string[];
  minor: boolean;
}

export interface Flat {
  ents: Map<string, Ent>;
  orders: Map<string, Order>;
}

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Every leaf of `obj` as `dotted.path -> value`, except the keys in `skip` (the caller handles
 * those). Plain objects are walked; arrays are leaves (their members are compared by the diff);
 * an EMPTY object is a leaf too, otherwise `{}` and "absent" would look identical.
 */
export function flattenFields(obj: Record<string, unknown>, skip: ReadonlySet<string> = new Set(), prefix = ''): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const k of Object.keys(obj).sort()) {
    if (prefix === '' && skip.has(k)) continue;
    const v = obj[k];
    if (v === undefined) continue;
    const path = prefix + k;
    if (isPlain(v) && Object.keys(v).length > 0) Object.assign(out, flattenFields(v, skip, path + '.'));
    else out[path] = v as Json;
  }
  return out;
}

type Shape = 'array' | 'object';
/**
 * Keys the caller will handle structurally - but ONLY when the value has the expected shape. A value
 * of any other shape (a corrupt or hand-made document) is left in the plain fields, so it still
 * takes part in the comparison and the diff never throws.
 */
export function structural(obj: unknown, spec: Record<string, Shape>): Set<string> {
  const out = new Set<string>();
  if (!isPlain(obj)) return out;
  for (const [k, shape] of Object.entries(spec)) {
    const v = obj[k];
    if (shape === 'array' ? Array.isArray(v) : isPlain(v)) out.add(k);
  }
  return out;
}
const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const short = (v: unknown) => createHash('sha1').update(canonicalJson(v)).digest('hex').slice(0, 8);
const clip = (s: string, n = 60) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export function flattenBlueprint(bp: BlueprintV1): Flat {
  const ents = new Map<string, Ent>();
  const orders = new Map<string, Order>();
  const docContainer = (field: string) => ({ entity: 'document' as DiffEntity, id: 'document', field });

  /** Adds an entity; a repeated key (only possible in an INVALID document) gets `#2`, `#3`... so nothing is lost. */
  const add = (entity: DiffEntity, scope: string | undefined, key: string, label: string, fields: Record<string, Json>): Ent => {
    const base = `${entity}:${scope ? scope + '/' : ''}`;
    let k = key;
    for (let n = 2; ents.has(base + k); n++) k = `${key}#${n}`;
    const e: Ent = { id: base + k, entity, scope, key: k, label, fields };
    ents.set(e.id, e);
    return e;
  };
  const order = (container: Order['container'], ids: string[], minor = false) => {
    if (ids.length > 0) orders.set(`${container.entity}:${container.id}#${container.field}`, { container, ids, minor });
  };
  /** Keyed collection -> entities + an order record. */
  const collection = <T extends Record<string, unknown>>(
    list: T[] | undefined,
    entity: DiffEntity,
    scope: string | undefined,
    container: Order['container'],
    keyOf: (x: T) => string,
    labelOf: (x: T) => string,
    skip: string[] = [],
    minor = false,
  ): Ent[] => {
    const made = asList(list).map((raw) => {
      if (!isPlain(raw)) return add(entity, scope, `h:${short(raw)}`, clip(String(raw)), { value: raw as Json });
      const x = raw as T;
      const k = keyOf(x);
      return add(entity, scope, k === undefined || k === null ? `h:${short(x)}` : String(k), String(labelOf(x) ?? ''), flattenFields(x, new Set(skip)));
    });
    order(container, made.map((m) => m.id), minor);
    return made;
  };
  /** Unkeyed object list (comments, automations, views): identity = content hash (+ occurrence number). */
  const unkeyed = (list: unknown[] | undefined, entity: DiffEntity, scope: string, container: Order['container'], labelOf: (x: any) => string, minor: boolean) => {
    const seen = new Map<string, number>();
    const made = asList(list).map((x) => {
      const h = short(x);
      const n = (seen.get(h) ?? 0) + 1;
      seen.set(h, n);
      return add(entity, scope, n === 1 ? h : `${h}~${n}`, labelOf(x), flattenFields(isPlain(x) ? x : { value: x }));
    });
    order(container, made.map((m) => m.id), minor);
  };

  // ---- document-level
  const doc = bp as unknown as Record<string, unknown>;
  add('document', undefined, 'document', 'Template', flattenFields(doc, structural(doc, { meta: 'object', dateAnchor: 'object', variables: 'array', roles: 'array', modules: 'array', workspace: 'object', projects: 'array', assets: 'array' })));
  if (isPlain(doc.meta)) add('meta', undefined, 'meta', String(doc.meta.name ?? 'Template'), flattenFields(doc.meta));
  if (isPlain(doc.dateAnchor)) add('dateAnchor', undefined, 'dateAnchor', 'Date anchor', flattenFields(doc.dateAnchor));

  collection(bp.variables as any, 'variable', undefined, docContainer('variables'), (x: any) => x.key, (x: any) => x.label ?? x.key);
  collection(bp.roles as any, 'role', undefined, docContainer('roles'), (x: any) => x.key, (x: any) => x.label ?? x.key);
  collection(bp.modules as any, 'module', undefined, docContainer('modules'), (x: any) => x.key, (x: any) => x.label ?? x.key);
  collection(bp.assets as any, 'asset', undefined, docContainer('assets'), (x: any) => x.key, (x: any) => x.fileName ?? x.key);

  // ---- workspace
  if (isPlain(doc.workspace)) {
    const ws = doc.workspace;
    add('workspace', undefined, 'workspace', String(ws.name ?? 'Workspace'), flattenFields(ws, structural(ws, { tags: 'array', customFields: 'array', issueTypes: 'array', iterations: 'array' })));
    const wc = (field: string) => ({ entity: 'workspace' as DiffEntity, id: 'workspace', field });
    const fold = (x: any) => (typeof x.name === 'string' ? foldName(x.name) : undefined);
    collection(ws.tags as any, 'tag', undefined, wc('tags'), fold as any, (x: any) => x.name, [], true);
    collection(ws.customFields as any, 'customField', undefined, wc('customFields'), (x: any) => x.key, (x: any) => x.name ?? x.key);
    collection(ws.issueTypes as any, 'issueType', undefined, wc('issueTypes'), fold as any, (x: any) => x.name);
    collection(ws.iterations as any, 'iteration', undefined, wc('iterations'), (x: any) => x.nodeKey, (x: any) => x.name ?? x.nodeKey);
  }

  // ---- projects
  const projectContainer = docContainer('projects');
  // a project that is not an object is kept whole, under a hash key, and has no tasks to look into
  const projects = asList(doc.projects).map((p) => (isPlain(p) ? (p as Record<string, any>) : null));
  const pEnts = projects.map((p, i) =>
    p
      ? add('project', undefined, p.nodeKey === undefined ? `h:${short(p)}` : String(p.nodeKey), String(p.name ?? p.nodeKey ?? ''), flattenFields(p, new Set(['nodeKey', ...structural(p, { tasks: 'array', dependencies: 'array', workflow: 'object', automations: 'array', views: 'array' })])))
      : add('project', undefined, `h:${short(asList(doc.projects)[i])}`, '', { value: asList(doc.projects)[i] as Json }),
  );
  order(projectContainer, pEnts.map((p) => p.id));

  projects.forEach((p, i) => {
    if (!p) return;
    const pk = pEnts[i].key; // the (possibly de-duplicated) key
    const pc = (field: string) => ({ entity: 'project' as DiffEntity, id: pk, field });
    if (isPlain(p.workflow)) {
      add('workflow', pk, 'workflow', 'Workflow', flattenFields(p.workflow, structural(p.workflow, { statuses: 'array', transitions: 'array' })));
      collection(p.workflow.statuses as any[], 'status', pk, pc('workflow.statuses'), (x: any) => x.key, (x: any) => x.name ?? x.key);
      collection(p.workflow.transitions as any[], 'transition', pk, pc('workflow.transitions'), (x: any) => `${x.from}>${x.to}`, (x: any) => `${x.from} → ${x.to}`, [], true);
    }
    collection(p.dependencies, 'dependency', pk, pc('dependencies'), (x: any) => `${x.from}>${x.to}>${x.type ?? 'BLOCKS'}`, (x: any) => `${x.from} → ${x.to}`, [], true);
    unkeyed(p.automations, 'automation', pk, pc('automations'), (x) => `automation ${short(x)}`, true);
    unkeyed(p.views, 'view', pk, pc('views'), (x) => `view ${short(x)}`, true);

    // tasks: one entity each, wherever it sits; WHERE it sits is two fields (project, parent)
    const walk = (list: BlueprintTask[], parent: string | null, container: Order['container']) => {
      const ids: string[] = [];
      for (const raw of asList(list)) {
        if (!isPlain(raw)) { ids.push(add('task', undefined, `h:${short(raw)}`, '', { value: raw as Json, project: pk, parent }).id); continue; }
        const t = raw as unknown as BlueprintTask;
        const e = add('task', undefined, t.nodeKey === undefined ? `h:${short(t)}` : String(t.nodeKey), String(t.title ?? t.nodeKey ?? ''), {
          ...flattenFields(raw, new Set(['nodeKey', ...structural(raw, { children: 'array', comments: 'array' })])),
          project: pk,
          parent,
        });
        ids.push(e.id);
        unkeyed(t.comments, 'comment', e.key, { entity: 'task', id: e.key, field: 'comments' }, (x) => clip(String(x?.body ?? '')), false);
        walk(asList(t.children) as BlueprintTask[], e.key, { entity: 'task', id: e.key, field: 'children' });
      }
      order(container, ids);
    };
    walk(asList(p.tasks) as BlueprintTask[], null, pc('tasks'));
  });
  return { ents, orders };
}
