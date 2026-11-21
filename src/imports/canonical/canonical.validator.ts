import Ajv from 'ajv';
import {
  DependencyType,
  FieldType,
  ImportIssueSeverity as Sev,
  IssueTypeLevel,
  IterationKind,
} from '@prisma/client';
import { foldName } from '../../templates/blueprint/blueprint.names';
import { CANONICAL_LIMITS as L } from './canonical.limits';
import { CANONICAL_V1_SCHEMA, STATUS_CATEGORIES } from './canonical.schema';
import {
  cleanText,
  hexColor,
  httpUrl,
  needsCleaning,
  oneLine,
  parseInstant,
  safeFileName,
  truncateLine,
  truncateMarkdown,
} from './canonical.text';
import {
  CANONICAL_SCHEMA_VERSION,
  BundleIssue,
  BundleIssueCode,
  BundleStats,
  BundleValidation,
  CanonicalAttachment,
  CanonicalBundle,
  CanonicalComment,
  CanonicalCustomField,
  CanonicalCustomScalar,
  CanonicalCustomValue,
  CanonicalDependency,
  CanonicalHistoryEntry,
  CanonicalIssueType,
  CanonicalIteration,
  CanonicalProject,
  CanonicalStatus,
  CanonicalTag,
  CanonicalTask,
  CanonicalUser,
  SourceStatusCategory,
} from './canonical.types';

/**
 * Step 4.2. THE gate between an adapter's output and everything downstream:
 *
 *   JSON-only + depth + clean text  ->  size  ->  version  ->  page shape  ->  repair / skip item by item
 *   ->  unknown-field check (adapter bugs)  ->  JSON Schema on the REPAIRED page
 *
 * Philosophy (diagram 05, "invalid -> ImportJobIssue, continue"): one bad task must never sink a page of 1000. So a
 * value that can be fixed is fixed (a 5 000-char title is cut, a control character removed, a due date before the start
 * date dropped), an item that cannot be used is skipped, and EVERY such decision is returned as an issue the person sees
 * in the import report. Only a problem with the page itself (not JSON, wrong version, over the page ceiling, an
 * unknown field = adapter bug) is fatal. Validation is PURE and DETERMINISTIC (`now` is a parameter) and never mutates
 * its input.
 */

const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true, coerceTypes: false, useDefaults: false, removeAdditional: false });
const validateShape = ajv.compile<CanonicalBundle>(CANONICAL_V1_SCHEMA);

export const MAX_BUNDLE_ISSUES = 5000;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export interface ValidateBundleOptions {
  /** "Now" for the not-in-the-future rule on created/updated times. Tests pass a fixed value. */
  now?: Date;
}

// ------------------------------------------------------------------------------------------------ JSON guard

type Sanitized =
  | { ok: true; value: Obj; cleaned: Set<string> }
  | { ok: false; code: 'NOT_JSON' | 'TOO_DEEP' | 'TOO_LARGE'; message: string };

/**
 * Iterative deep copy that (a) accepts JSON values only, (b) caps nesting, (c) removes control characters and lone
 * surrogates from every string and key, remembering which `collection/index` items it touched. Iterative so a hostile
 * page cannot overflow the stack; a cyclic graph hits the depth ceiling instead of looping.
 */
function sanitizeJson(root: Obj): Sanitized {
  const cleaned = new Set<string>();
  const out: Obj = {};
  type Work = { src: unknown; set: (v: unknown) => void; depth: number; item: string };
  const stack: Work[] = [{ src: root, set: () => undefined, depth: 0, item: '' }];
  let visited = 0;
  const fail = (code: 'NOT_JSON' | 'TOO_DEEP' | 'TOO_LARGE', message: string): Sanitized => ({ ok: false, code, message });

  // The root is copied by hand so `set` can stay trivial; everything below it goes through the stack.
  const rootWork: Work = { src: root, set: () => undefined, depth: 0, item: '' };
  stack.length = 0;
  stack.push(rootWork);
  const container = new Map<unknown, Obj | unknown[]>();
  container.set(root, out);

  while (stack.length > 0) {
    const { src, set, depth, item } = stack.pop() as Work;
    if (++visited > 5_000_000) return fail('TOO_LARGE', 'The page has too many values');

    if (src === null || typeof src === 'boolean') { set(src); continue; }
    if (typeof src === 'string') {
      if (needsCleaning(src)) {
        cleaned.add(item);
        set(cleanText(src));
      } else set(src);
      continue;
    }
    if (typeof src === 'number') {
      if (!Number.isFinite(src)) return fail('NOT_JSON', 'Numbers must be finite');
      set(src);
      continue;
    }
    if (typeof src !== 'object') return fail('NOT_JSON', `A ${typeof src} is not a JSON value`);
    if (depth >= L.maxJsonDepth) return fail('TOO_DEEP', `Nested more than ${L.maxJsonDepth} levels deep`);

    if (Array.isArray(src)) {
      const dst: unknown[] = new Array(src.length);
      set(dst);
      for (let i = 0; i < src.length; i++) {
        if (!(i in src)) return fail('NOT_JSON', 'Arrays cannot have holes');
        if (src[i] === undefined) return fail('NOT_JSON', 'Arrays cannot contain undefined');
        const nextItem = depth === 1 ? `${item}/${i}` : item;
        stack.push({ src: src[i], set: (v) => { dst[i] = v; }, depth: depth + 1, item: nextItem });
      }
      continue;
    }
    const proto = Object.getPrototypeOf(src);
    if (proto !== Object.prototype && proto !== null) return fail('NOT_JSON', 'Only plain objects are allowed');
    const dst: Obj = depth === 0 ? out : {};
    if (depth !== 0) set(dst);
    for (const rawKey of Object.keys(src)) {
      if (rawKey === '__proto__') return fail('NOT_JSON', 'The key "__proto__" is reserved');
      const v = (src as Obj)[rawKey];
      if (v === undefined) continue; // JSON.stringify semantics: an undefined property is absent
      let key = rawKey;
      let nextItem = item;
      if (needsCleaning(rawKey)) { key = cleanText(rawKey); cleaned.add(item); }
      if (key === '__proto__') return fail('NOT_JSON', 'The key "__proto__" is reserved');
      if (depth === 0) nextItem = key; // collection name; the index is added one level down
      stack.push({ src: v, set: (x) => { dst[key] = x; }, depth: depth + 1, item: nextItem });
    }
  }
  return { ok: true, value: out, cleaned };
}

// ------------------------------------------------------------------------------------------------ reporter

class Reporter {
  readonly items: BundleIssue[] = [];
  skipped = 0;
  private truncated = false;

  add(severity: Sev, code: BundleIssueCode, ref: string | null, message: string): void {
    if (this.items.length >= MAX_BUNDLE_ISSUES) {
      if (!this.truncated) {
        this.truncated = true;
        this.items.push({ severity: Sev.WARN, code: 'ISSUES_TRUNCATED', externalRef: null, message: `More than ${MAX_BUNDLE_ISSUES} issues on this page; the rest were not listed` });
      }
      return;
    }
    this.items.push({ severity, code, externalRef: ref, message });
  }
  warn(code: BundleIssueCode, ref: string | null, message: string): void { this.add(Sev.WARN, code, ref, message); }
  info(code: BundleIssueCode, ref: string | null, message: string): void { this.add(Sev.INFO, code, ref, message); }
  /** The item is gone from the page. */
  skip(code: BundleIssueCode, ref: string | null, message: string): void {
    this.skipped += 1;
    this.add(Sev.ERROR, code, ref, message);
  }
}

// ------------------------------------------------------------------------------------------------ allowed keys

/** Exported for the drift test: these must equal the schema's property names, kind by kind. */
export const CANONICAL_ITEM_KEYS = {
  source: ['system', 'displayName'],
  user: ['externalId', 'name', 'email', 'avatarUrl', 'isBot'],
  project: ['externalId', 'key', 'name', 'description', 'url', 'archived', 'createdAt', 'statuses'],
  status: ['externalId', 'name', 'category', 'color', 'position'],
  tag: ['name', 'color'],
  customField: ['externalId', 'name', 'dataType', 'options'],
  option: ['externalId', 'label'],
  issueType: ['externalId', 'name', 'level', 'color'],
  iteration: ['externalId', 'kind', 'name', 'goal', 'startDate', 'endDate', 'projectExternalId'],
  task: ['externalId', 'key', 'url', 'projectExternalId', 'parentExternalId', 'title', 'description', 'statusExternalId', 'priority', 'issueTypeExternalId', 'tags', 'customValues', 'assigneeExternalIds', 'creatorExternalId', 'createdAt', 'updatedAt', 'startDate', 'dueDate', 'estimate', 'iterationExternalId', 'archived', 'comments', 'attachments', 'history'],
  customValue: ['fieldExternalId', 'value'],
  comment: ['externalId', 'authorExternalId', 'authorName', 'body', 'createdAt', 'editedAt', 'parentExternalId'],
  attachment: ['externalId', 'fileName', 'mimeType', 'sizeBytes', 'providerRef', 'uploaderExternalId', 'createdAt'],
  history: ['externalId', 'actorExternalId', 'at', 'field', 'from', 'to'],
  dependency: ['externalId', 'fromExternalId', 'toExternalId', 'type'],
} as const;
const KEYS = CANONICAL_ITEM_KEYS;

const TOP_KEYS = ['schemaVersion', 'source', 'users', 'projects', 'tags', 'customFields', 'issueTypes', 'iterations', 'tasks', 'dependencies'];
const COLLECTIONS: Array<[key: keyof CanonicalBundle & string, kind: string, max: number]> = [
  ['users', 'user', L.maxUsers],
  ['projects', 'project', L.maxProjects],
  ['tags', 'tag', L.maxTags],
  ['customFields', 'customField', L.maxCustomFields],
  ['issueTypes', 'issueType', L.maxIssueTypes],
  ['iterations', 'iteration', L.maxIterations],
  ['tasks', 'task', L.maxTasks],
  ['dependencies', 'dependency', L.maxDependencies],
];

// ------------------------------------------------------------------------------------------------ repair

class Repair {
  readonly adapterErrors: string[] = [];
  readonly counts = { comments: 0, attachments: 0, history: 0 };
  private readonly future: number;

  constructor(readonly rep: Reporter, now: Date) {
    this.future = now.getTime() + 24 * 3600 * 1000;
  }

  // ---- field helpers (each returns the repaired value, or undefined = leave the field out)

  unknownKeys(o: Obj, allowed: readonly string[], where: string): void {
    for (const k of Object.keys(o)) {
      if (!allowed.includes(k) && this.adapterErrors.length < 10) this.adapterErrors.push(`${where}: unknown field "${k}"`);
    }
  }

  id(o: Obj, kind: string, index: number): string | null {
    const v = o.externalId;
    if (typeof v !== 'string' || v === '' || v.length > L.externalId) {
      this.rep.skip('ITEM_INVALID', `${kind}[${index}]`, `A ${kind} without a usable id (1-${L.externalId} characters) was skipped`);
      return null;
    }
    return v;
  }

  refId(o: Obj, key: string, ref: string): string | undefined {
    const v = o[key];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'string' || v === '' || v.length > L.externalId) {
      this.rep.warn('FIELD_INVALID', ref, `"${key}" is not a usable id and was dropped`);
      return undefined;
    }
    return v;
  }

  line(o: Obj, key: string, max: number, ref: string, code: BundleIssueCode = 'NAME_TRUNCATED'): string | undefined {
    const v = o[key];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'string') { this.rep.warn('FIELD_INVALID', ref, `"${key}" is not text and was dropped`); return undefined; }
    const s = oneLine(v);
    if (s === '') return undefined;
    if (s.length > max) { this.rep.warn(code, ref, `"${key}" was ${s.length} characters; cut to ${max}`); return truncateLine(s, max); }
    return s;
  }

  markdown(o: Obj, key: string, max: number, ref: string, code: BundleIssueCode): string | undefined {
    const v = o[key];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'string') { this.rep.warn('FIELD_INVALID', ref, `"${key}" is not text and was dropped`); return undefined; }
    const s = v.replace(/\r\n?/g, '\n').trim();
    if (s === '') return undefined;
    if (s.length > max) { this.rep.warn(code, ref, `"${key}" was ${s.length} characters; cut to ${max}`); return truncateMarkdown(s, max); }
    return s;
  }

  instant(o: Obj, key: string, ref: string, opts: { noFuture?: boolean } = {}): string | undefined {
    const v = o[key];
    if (v === undefined || v === null) return undefined;
    const t = parseInstant(v);
    if (t === null) { this.rep.warn('DATE_INVALID', ref, `"${key}" is not a usable date and was dropped`); return undefined; }
    if (opts.noFuture && Date.parse(t) > this.future) { this.rep.warn('DATE_INVALID', ref, `"${key}" is in the future and was dropped`); return undefined; }
    return t;
  }

  url(o: Obj, key: string, ref: string): string | undefined {
    const v = o[key];
    if (v === undefined || v === null) return undefined;
    const u = httpUrl(v);
    if (u === null) { this.rep.warn('URL_INVALID', ref, `"${key}" is not an http(s) address and was dropped`); return undefined; }
    return u;
  }

  bool(o: Obj, key: string, ref: string): boolean | undefined {
    const v = o[key];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'boolean') { this.rep.warn('FIELD_INVALID', ref, `"${key}" is not true/false and was dropped`); return undefined; }
    return v;
  }

  enumOf<T extends string>(o: Obj, key: string, allowed: readonly T[], ref: string): T | undefined {
    const v = o[key];
    if (v === undefined || v === null) return undefined;
    if (typeof v === 'string' && (allowed as readonly string[]).includes(v)) return v as T;
    this.rep.warn('FIELD_INVALID', ref, `"${key}" is not one of ${allowed.join(', ')} and was dropped`);
    return undefined;
  }

  /** The array at `o[key]`, or [] (reporting once if it is present but not an array). */
  arr(o: Obj, key: string, ref: string): unknown[] {
    const v = o[key];
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) { this.rep.warn('FIELD_INVALID', ref, `"${key}" is not a list and was dropped`); return []; }
    return v;
  }

  // ---- collections

  users(list: unknown[]): CanonicalUser[] {
    const seen = new Set<string>();
    const out: CanonicalUser[] = [];
    list.forEach((raw, i) => {
      if (!isObj(raw)) return this.rep.skip('ITEM_INVALID', `user[${i}]`, 'A user entry was not an object and was skipped');
      this.unknownKeys(raw, KEYS.user, `users[${i}]`);
      const id = this.id(raw, 'user', i);
      if (id === null) return;
      const ref = `user:${id}`;
      if (seen.has(id)) return this.rep.skip('DUPLICATE_ID', ref, 'The same user appeared twice on this page; the second was skipped');
      seen.add(id);
      const email = this.line(raw, 'email', L.email, ref);
      const goodEmail = email && /^[^\s@]+@[^\s@]+$/.test(email) ? email.toLowerCase() : undefined;
      if (email && !goodEmail) this.rep.warn('FIELD_INVALID', ref, '"email" is not an address and was dropped');
      const name = this.line(raw, 'name', L.userName, ref) ?? goodEmail ?? id;
      const u: CanonicalUser = { externalId: id, name };
      if (goodEmail) u.email = goodEmail;
      const avatarUrl = this.url(raw, 'avatarUrl', ref);
      if (avatarUrl) u.avatarUrl = avatarUrl;
      const isBot = this.bool(raw, 'isBot', ref);
      if (isBot !== undefined) u.isBot = isBot;
      out.push(u);
    });
    return out;
  }

  statuses(list: unknown[], projectRef: string): CanonicalStatus[] {
    const seenId = new Set<string>();
    const seenName = new Set<string>();
    const out: CanonicalStatus[] = [];
    list.forEach((raw, i) => {
      if (!isObj(raw)) return this.rep.skip('ITEM_INVALID', `status[${i}]`, 'A status entry was not an object and was skipped');
      this.unknownKeys(raw, KEYS.status, `${projectRef}.statuses[${i}]`);
      const id = this.id(raw, 'status', i);
      if (id === null) return;
      const ref = `status:${id}`;
      if (seenId.has(id)) return this.rep.skip('DUPLICATE_ID', ref, 'The same status appeared twice in a project; the second was skipped');
      if (out.length >= L.maxStatusesPerProject) return this.rep.warn('STATUSES_LIMIT', ref, `A project can have ${L.maxStatusesPerProject} statuses; this one was left out`);
      seenId.add(id);
      let name = this.line(raw, 'name', L.statusName, ref) ?? id;
      // two statuses whose names fold to the same thing would collide in the database: make the later one distinct
      if (seenName.has(foldName(name))) {
        let n = 2;
        let candidate = '';
        do { candidate = `${truncateLine(name, L.statusName - 6)} (${n++})`; } while (seenName.has(foldName(candidate)));
        this.rep.warn('STATUS_NAME_DUPLICATE', ref, `Another status in this project is already called "${name}"; renamed to "${candidate}"`);
        name = candidate;
      }
      seenName.add(foldName(name));
      let category = this.enumOf<SourceStatusCategory>(raw, 'category', STATUS_CATEGORIES, ref);
      if (category === undefined) category = 'UNKNOWN';
      const s: CanonicalStatus = { externalId: id, name, category };
      const c = hexColor(raw.color);
      if (c) s.color = c;
      if (Number.isInteger(raw.position) && Math.abs(raw.position as number) <= 1_000_000) s.position = raw.position as number;
      out.push(s);
    });
    return out;
  }

  projects(list: unknown[]): CanonicalProject[] {
    const seen = new Set<string>();
    const out: CanonicalProject[] = [];
    list.forEach((raw, i) => {
      if (!isObj(raw)) return this.rep.skip('ITEM_INVALID', `project[${i}]`, 'A project entry was not an object and was skipped');
      this.unknownKeys(raw, KEYS.project, `projects[${i}]`);
      const id = this.id(raw, 'project', i);
      if (id === null) return;
      const ref = `project:${id}`;
      if (seen.has(id)) return this.rep.skip('DUPLICATE_ID', ref, 'The same project appeared twice on this page; the second was skipped');
      seen.add(id);
      let name = this.line(raw, 'name', L.projectName, ref);
      if (name === undefined) { this.rep.warn('TITLE_EMPTY', ref, 'The project has no name; it was called "(unnamed project)"'); name = '(unnamed project)'; }
      const p: CanonicalProject = { externalId: id, name };
      const key = this.line(raw, 'key', L.externalKey, ref);
      if (key) p.key = key;
      const description = this.markdown(raw, 'description', L.projectDescription, ref, 'DESCRIPTION_TRUNCATED');
      if (description) p.description = description;
      const url = this.url(raw, 'url', ref);
      if (url) p.url = url;
      const archived = this.bool(raw, 'archived', ref);
      if (archived !== undefined) p.archived = archived;
      const createdAt = this.instant(raw, 'createdAt', ref, { noFuture: true });
      if (createdAt) p.createdAt = createdAt;
      if (raw.statuses !== undefined && raw.statuses !== null) {
        const st = this.statuses(this.arr(raw, 'statuses', ref), ref);
        if (st.length > 0) p.statuses = st;
      }
      out.push(p);
    });
    return out;
  }

  tags(list: unknown[]): CanonicalTag[] {
    const seen = new Set<string>();
    const out: CanonicalTag[] = [];
    list.forEach((raw, i) => {
      if (!isObj(raw)) return this.rep.skip('ITEM_INVALID', `tag[${i}]`, 'A label entry was not an object and was skipped');
      this.unknownKeys(raw, KEYS.tag, `tags[${i}]`);
      const name = this.line(raw, 'name', L.tagName, `tag[${i}]`);
      if (name === undefined) return this.rep.skip('ITEM_INVALID', `tag[${i}]`, 'A label without a name was skipped');
      const ref = `tag:${name}`;
      if (seen.has(foldName(name))) return this.rep.info('DUPLICATE_ID', ref, 'The same label appeared twice; merged');
      seen.add(foldName(name));
      const t: CanonicalTag = { name };
      const c = hexColor(raw.color);
      if (c) t.color = c;
      out.push(t);
    });
    return out;
  }

  customFields(list: unknown[]): CanonicalCustomField[] {
    const seen = new Set<string>();
    const out: CanonicalCustomField[] = [];
    list.forEach((raw, i) => {
      if (!isObj(raw)) return this.rep.skip('ITEM_INVALID', `customField[${i}]`, 'A custom field entry was not an object and was skipped');
      this.unknownKeys(raw, KEYS.customField, `customFields[${i}]`);
      const id = this.id(raw, 'customField', i);
      if (id === null) return;
      const ref = `customField:${id}`;
      if (seen.has(id)) return this.rep.skip('DUPLICATE_ID', ref, 'The same custom field appeared twice on this page; the second was skipped');
      const dataType = this.enumOf<FieldType>(raw, 'dataType', Object.values(FieldType), ref);
      if (dataType === undefined) return this.rep.skip('ITEM_INVALID', ref, 'A custom field without a usable type was skipped');
      seen.add(id);
      const f: CanonicalCustomField = { externalId: id, name: this.line(raw, 'name', L.customFieldName, ref) ?? id, dataType };
      if (raw.options !== undefined && raw.options !== null) {
        const labels = new Set<string>();
        const options: Array<{ externalId?: string; label: string }> = [];
        this.arr(raw, 'options', ref).forEach((o, j) => {
          if (!isObj(o)) return this.rep.warn('FIELD_INVALID', ref, `Option ${j} was not an object and was dropped`);
          this.unknownKeys(o, KEYS.option, `${ref}.options[${j}]`);
          const label = this.line(o, 'label', L.customOption, ref);
          if (label === undefined || labels.has(foldName(label))) return;
          if (options.length >= L.maxCustomOptions) return;
          labels.add(foldName(label));
          const opt: { externalId?: string; label: string } = { label };
          const oid = this.refId(o, 'externalId', ref);
          if (oid) opt.externalId = oid;
          options.push(opt);
        });
        if (options.length > 0) f.options = options;
      }
      out.push(f);
    });
    return out;
  }

  issueTypes(list: unknown[]): CanonicalIssueType[] {
    const seen = new Set<string>();
    const out: CanonicalIssueType[] = [];
    list.forEach((raw, i) => {
      if (!isObj(raw)) return this.rep.skip('ITEM_INVALID', `issueType[${i}]`, 'An issue type entry was not an object and was skipped');
      this.unknownKeys(raw, KEYS.issueType, `issueTypes[${i}]`);
      const id = this.id(raw, 'issueType', i);
      if (id === null) return;
      const ref = `issueType:${id}`;
      if (seen.has(id)) return this.rep.skip('DUPLICATE_ID', ref, 'The same issue type appeared twice on this page; the second was skipped');
      seen.add(id);
      const t: CanonicalIssueType = { externalId: id, name: this.line(raw, 'name', L.issueTypeName, ref) ?? id };
      const level = this.enumOf<IssueTypeLevel>(raw, 'level', Object.values(IssueTypeLevel), ref);
      if (level) t.level = level;
      const c = hexColor(raw.color);
      if (c) t.color = c;
      out.push(t);
    });
    return out;
  }

  iterations(list: unknown[]): CanonicalIteration[] {
    const seen = new Set<string>();
    const out: CanonicalIteration[] = [];
    list.forEach((raw, i) => {
      if (!isObj(raw)) return this.rep.skip('ITEM_INVALID', `iteration[${i}]`, 'An iteration entry was not an object and was skipped');
      this.unknownKeys(raw, KEYS.iteration, `iterations[${i}]`);
      const id = this.id(raw, 'iteration', i);
      if (id === null) return;
      const ref = `iteration:${id}`;
      if (seen.has(id)) return this.rep.skip('DUPLICATE_ID', ref, 'The same iteration appeared twice on this page; the second was skipped');
      const kind = this.enumOf<IterationKind>(raw, 'kind', Object.values(IterationKind), ref);
      if (kind === undefined) return this.rep.skip('ITEM_INVALID', ref, 'An iteration without a usable kind was skipped');
      seen.add(id);
      const it: CanonicalIteration = { externalId: id, kind, name: this.line(raw, 'name', L.iterationName, ref) ?? id };
      const goal = this.markdown(raw, 'goal', L.iterationGoal, ref, 'DESCRIPTION_TRUNCATED');
      if (goal) it.goal = goal;
      const startDate = this.instant(raw, 'startDate', ref);
      let endDate = this.instant(raw, 'endDate', ref);
      if (startDate && endDate && Date.parse(endDate) < Date.parse(startDate)) {
        this.rep.warn('DATE_ORDER', ref, 'The end date is before the start date; the end date was dropped');
        endDate = undefined;
      }
      if (startDate) it.startDate = startDate;
      if (endDate) it.endDate = endDate;
      const project = this.refId(raw, 'projectExternalId', ref);
      if (project) it.projectExternalId = project;
      out.push(it);
    });
    return out;
  }

  // ---- tasks

  /** Value of one custom field, repaired against its definition when the page has it. */
  private customValue(raw: unknown, defs: Map<string, CanonicalCustomField>, ref: string): CanonicalCustomValue | null {
    if (!isObj(raw)) { this.rep.warn('CUSTOM_VALUE_INVALID', ref, 'A custom value was not an object and was dropped'); return null; }
    this.unknownKeys(raw, KEYS.customValue, `${ref}.customValues`);
    const fid = this.refId(raw, 'fieldExternalId', ref);
    if (!fid) { this.rep.warn('CUSTOM_VALUE_INVALID', ref, 'A custom value without a field id was dropped'); return null; }
    const def = defs.get(fid);
    const v = raw.value;
    const drop = (why: string): null => { this.rep.warn('CUSTOM_VALUE_INVALID', ref, `Custom field ${fid}: ${why}; the value was dropped`); return null; };
    const text = (s: string): string => (s.length > L.customTextValue ? truncateLine(s, L.customTextValue) : s);
    const labelOf = (s: string): string | null => {
      if (!def?.options || def.options.length === 0) return s.length <= L.customOption ? s : null;
      return def.options.find((o) => foldName(o.label) === foldName(s))?.label ?? null;
    };
    const type = def?.dataType;

    if (type === undefined) {
      // definition lives on another page: only generic sanity (the executor re-checks after mapping)
      if (typeof v === 'string') return { fieldExternalId: fid, value: text(cleanText(v)) };
      if (typeof v === 'number' && Number.isFinite(v)) return { fieldExternalId: fid, value: v };
      if (typeof v === 'boolean') return { fieldExternalId: fid, value: v };
      if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return { fieldExternalId: fid, value: [...new Set(v as string[])].slice(0, L.maxCustomOptions).map((x) => truncateLine(x, L.customOption)) };
      return drop('the value has an unsupported type');
    }
    switch (type) {
      case FieldType.TEXT:
        return typeof v === 'string' && v.trim() !== '' ? { fieldExternalId: fid, value: text(v.trim()) } : drop('expected text');
      case FieldType.NUMBER:
        return typeof v === 'number' && Number.isFinite(v) ? { fieldExternalId: fid, value: v } : drop('expected a number');
      case FieldType.CHECKBOX:
        return typeof v === 'boolean' ? { fieldExternalId: fid, value: v } : drop('expected true/false');
      case FieldType.DATE: {
        const t = parseInstant(v);
        return t ? { fieldExternalId: fid, value: t } : drop('expected a date');
      }
      case FieldType.URL: {
        const u = httpUrl(v);
        return u ? { fieldExternalId: fid, value: u } : drop('expected an http(s) address');
      }
      case FieldType.USER:
        return typeof v === 'string' && v !== '' && v.length <= L.externalId ? { fieldExternalId: fid, value: v } : drop('expected a user id');
      case FieldType.SELECT: {
        if (typeof v !== 'string') return drop('expected one of the field\'s options');
        const label = labelOf(oneLine(v));
        return label ? { fieldExternalId: fid, value: label } : drop(`"${truncateLine(oneLine(v), 40)}" is not one of the field's options`);
      }
      case FieldType.MULTI_SELECT: {
        if (!Array.isArray(v)) return drop('expected a list of options');
        const labels: string[] = [];
        for (const x of v) {
          const l = typeof x === 'string' ? labelOf(oneLine(x)) : null;
          if (l && !labels.includes(l)) labels.push(l);
        }
        return labels.length > 0 ? { fieldExternalId: fid, value: labels.slice(0, L.maxCustomOptions) as CanonicalCustomScalar } : drop('none of the options are known');
      }
    }
  }

  private comments(list: unknown[], taskRef: string): CanonicalComment[] {
    const seen = new Set<string>();
    const out: CanonicalComment[] = [];
    list.forEach((raw, i) => {
      if (!isObj(raw)) return this.rep.skip('ITEM_INVALID', `comment[${i}]`, `A comment on ${taskRef} was not an object and was skipped`);
      this.unknownKeys(raw, KEYS.comment, `${taskRef}.comments[${i}]`);
      const id = this.id(raw, 'comment', i);
      if (id === null) return;
      const ref = `comment:${id}`;
      if (seen.has(id)) return this.rep.skip('DUPLICATE_ID', ref, 'The same comment appeared twice; the second was skipped');
      if (out.length >= L.maxCommentsPerTask) {
        if (out.length === L.maxCommentsPerTask) this.rep.warn('COMMENTS_LIMIT', taskRef, `Only the first ${L.maxCommentsPerTask} comments were kept`);
        out.push(undefined as never); // placeholder so the warning fires once; removed below
        return;
      }
      seen.add(id);
      const body = this.markdown(raw, 'body', L.commentBody, ref, 'COMMENT_TRUNCATED');
      if (body === undefined) return this.rep.info('COMMENT_EMPTY', ref, 'An empty comment was left out');
      const c: CanonicalComment = { externalId: id, body };
      const author = this.refId(raw, 'authorExternalId', ref);
      if (author) c.authorExternalId = author;
      const authorName = this.line(raw, 'authorName', L.userName, ref);
      if (authorName) c.authorName = authorName;
      const createdAt = this.instant(raw, 'createdAt', ref, { noFuture: true });
      if (createdAt) c.createdAt = createdAt;
      let editedAt = this.instant(raw, 'editedAt', ref, { noFuture: true });
      if (editedAt && createdAt && Date.parse(editedAt) < Date.parse(createdAt)) editedAt = createdAt;
      if (editedAt) c.editedAt = editedAt;
      const parent = this.refId(raw, 'parentExternalId', ref);
      if (parent) c.parentExternalId = parent;
      out.push(c);
    });
    const real = out.filter((c) => c !== undefined);
    // Threads are one level deep: re-attach a reply-to-a-reply to the thread's root; drop links to unknown / cyclic parents.
    const byId = new Map(real.map((c) => [c.externalId, c]));
    for (const c of real) {
      if (!c.parentExternalId) continue;
      let parent = byId.get(c.parentExternalId);
      const walked = new Set<string>([c.externalId]);
      while (parent && parent.parentExternalId && !walked.has(parent.externalId)) {
        walked.add(parent.externalId);
        parent = byId.get(parent.parentExternalId);
      }
      if (!parent || walked.has(parent.externalId) || parent.parentExternalId) {
        this.rep.warn('COMMENT_PARENT_INVALID', `comment:${c.externalId}`, 'The comment replies to something that is not on this task; it became a top-level comment');
        delete c.parentExternalId;
      } else if (parent.externalId !== c.parentExternalId) {
        c.parentExternalId = parent.externalId;
      }
    }
    return real;
  }

  private attachments(list: unknown[], taskRef: string): CanonicalAttachment[] {
    const seen = new Set<string>();
    const out: CanonicalAttachment[] = [];
    list.forEach((raw, i) => {
      if (!isObj(raw)) return this.rep.skip('ITEM_INVALID', `attachment[${i}]`, `An attachment on ${taskRef} was not an object and was skipped`);
      this.unknownKeys(raw, KEYS.attachment, `${taskRef}.attachments[${i}]`);
      const id = this.id(raw, 'attachment', i);
      if (id === null) return;
      const ref = `attachment:${id}`;
      if (seen.has(id)) return this.rep.skip('DUPLICATE_ID', ref, 'The same attachment appeared twice; the second was skipped');
      const pr = raw.providerRef;
      if (typeof pr !== 'string' || pr === '' || pr.length > L.providerRef) return this.rep.skip('ITEM_INVALID', ref, 'An attachment without a usable reference to its file was skipped');
      if (out.length >= L.maxAttachmentsPerTask) {
        if (out.length === L.maxAttachmentsPerTask) this.rep.warn('ATTACHMENTS_LIMIT', taskRef, `Only the first ${L.maxAttachmentsPerTask} attachments were kept`);
        out.push(undefined as never);
        return;
      }
      seen.add(id);
      const a: CanonicalAttachment = {
        externalId: id,
        fileName: safeFileName(typeof raw.fileName === 'string' ? raw.fileName : '', L.fileName),
        providerRef: pr,
      };
      const mime = typeof raw.mimeType === 'string' ? raw.mimeType.trim().toLowerCase() : undefined;
      if (mime !== undefined) {
        if (mime.length <= L.mimeType && /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mime)) a.mimeType = mime;
        else this.rep.warn('MIME_INVALID', ref, 'The file type is not valid and was dropped');
      }
      if (raw.sizeBytes !== undefined && raw.sizeBytes !== null) {
        if (Number.isSafeInteger(raw.sizeBytes) && (raw.sizeBytes as number) >= 0) a.sizeBytes = raw.sizeBytes as number;
        else this.rep.warn('FIELD_INVALID', ref, '"sizeBytes" is not a whole number of bytes and was dropped');
      }
      const up = this.refId(raw, 'uploaderExternalId', ref);
      if (up) a.uploaderExternalId = up;
      const createdAt = this.instant(raw, 'createdAt', ref, { noFuture: true });
      if (createdAt) a.createdAt = createdAt;
      out.push(a);
    });
    return out.filter((a) => a !== undefined);
  }

  private history(list: unknown[], taskRef: string): CanonicalHistoryEntry[] {
    const seen = new Set<string>();
    const out: CanonicalHistoryEntry[] = [];
    list.forEach((raw, i) => {
      if (!isObj(raw)) return this.rep.skip('ITEM_INVALID', `history[${i}]`, `A history entry on ${taskRef} was not an object and was skipped`);
      this.unknownKeys(raw, KEYS.history, `${taskRef}.history[${i}]`);
      const id = this.id(raw, 'history', i);
      if (id === null) return;
      const ref = `history:${id}`;
      if (seen.has(id)) return this.rep.skip('DUPLICATE_ID', ref, 'The same history entry appeared twice; the second was skipped');
      const at = parseInstant(raw.at);
      if (at === null || Date.parse(at) > this.future) return this.rep.skip('DATE_INVALID', ref, 'A history entry without a usable time was skipped');
      const field = this.line(raw, 'field', L.historyField, ref);
      if (field === undefined) return this.rep.skip('ITEM_INVALID', ref, 'A history entry without a field name was skipped');
      if (out.length >= L.maxHistoryPerTask) {
        if (out.length === L.maxHistoryPerTask) this.rep.warn('HISTORY_LIMIT', taskRef, `Only the first ${L.maxHistoryPerTask} history entries were kept`);
        out.push(undefined as never);
        return;
      }
      seen.add(id);
      const h: CanonicalHistoryEntry = { externalId: id, at, field };
      const actor = this.refId(raw, 'actorExternalId', ref);
      if (actor) h.actorExternalId = actor;
      for (const k of ['from', 'to'] as const) {
        const v = raw[k];
        if (v === null) h[k] = null;
        else if (typeof v === 'string') h[k] = truncateLine(oneLine(v), L.historyValue);
        else if (v !== undefined) this.rep.warn('FIELD_INVALID', ref, `"${k}" is not text and was dropped`);
      }
      out.push(h);
    });
    return out.filter((h) => h !== undefined);
  }

  tasks(list: unknown[], defs: Map<string, CanonicalCustomField>): CanonicalTask[] {
    const seen = new Set<string>();
    const out: CanonicalTask[] = [];
    list.forEach((raw, i) => {
      if (!isObj(raw)) return this.rep.skip('ITEM_INVALID', `task[${i}]`, 'A task entry was not an object and was skipped');
      this.unknownKeys(raw, KEYS.task, `tasks[${i}]`);
      const id = this.id(raw, 'task', i);
      if (id === null) return;
      const ref = `task:${id}`;
      if (seen.has(id)) return this.rep.skip('DUPLICATE_ID', ref, 'The same task appeared twice on this page; the second was skipped');
      seen.add(id);

      let title = this.line(raw, 'title', L.title, ref, 'TITLE_TRUNCATED');
      if (title === undefined) { this.rep.warn('TITLE_EMPTY', ref, 'The task has no title; it was called "(untitled)"'); title = '(untitled)'; }
      const t: CanonicalTask = { externalId: id, title };

      const key = this.line(raw, 'key', L.externalKey, ref);
      if (key) t.key = key;
      const url = this.url(raw, 'url', ref);
      if (url) t.url = url;
      const project = this.refId(raw, 'projectExternalId', ref);
      if (project) t.projectExternalId = project;
      let parent = this.refId(raw, 'parentExternalId', ref);
      if (parent === id) { this.rep.warn('SELF_PARENT', ref, 'The task was its own parent; the link was dropped'); parent = undefined; }
      if (parent) t.parentExternalId = parent;
      const description = this.markdown(raw, 'description', L.description, ref, 'DESCRIPTION_TRUNCATED');
      if (description) t.description = description;
      const status = this.refId(raw, 'statusExternalId', ref);
      if (status) t.statusExternalId = status;
      const priority = this.line(raw, 'priority', L.priority, ref);
      if (priority) t.priority = priority;
      const issueType = this.refId(raw, 'issueTypeExternalId', ref);
      if (issueType) t.issueTypeExternalId = issueType;
      const creator = this.refId(raw, 'creatorExternalId', ref);
      if (creator) t.creatorExternalId = creator;
      const iteration = this.refId(raw, 'iterationExternalId', ref);
      if (iteration) t.iterationExternalId = iteration;
      const archived = this.bool(raw, 'archived', ref);
      if (archived !== undefined) t.archived = archived;

      // tags: names, folded-unique, bounded
      if (raw.tags !== undefined && raw.tags !== null) {
        const names: string[] = [];
        const folded = new Set<string>();
        for (const x of this.arr(raw, 'tags', ref)) {
          const n = typeof x === 'string' ? oneLine(x) : '';
          if (n === '') { this.rep.warn('TAG_INVALID', ref, 'A label that is not text was dropped'); continue; }
          const name = n.length > L.tagName ? truncateLine(n, L.tagName) : n;
          if (folded.has(foldName(name))) continue;
          if (names.length >= L.maxTagsPerTask) { this.rep.warn('TAGS_LIMIT', ref, `Only the first ${L.maxTagsPerTask} labels were kept`); break; }
          folded.add(foldName(name));
          names.push(name);
        }
        if (names.length > 0) t.tags = names;
      }

      // assignees
      if (raw.assigneeExternalIds !== undefined && raw.assigneeExternalIds !== null) {
        const ids: string[] = [];
        for (const x of this.arr(raw, 'assigneeExternalIds', ref)) {
          if (typeof x !== 'string' || x === '' || x.length > L.externalId) { this.rep.warn('FIELD_INVALID', ref, 'An assignee id was not usable and was dropped'); continue; }
          if (ids.includes(x)) continue;
          if (ids.length >= L.maxAssigneesPerTask) { this.rep.warn('ASSIGNEES_LIMIT', ref, `Only the first ${L.maxAssigneesPerTask} assignees were kept`); break; }
          ids.push(x);
        }
        if (ids.length > 0) t.assigneeExternalIds = ids;
      }

      // custom values
      if (raw.customValues !== undefined && raw.customValues !== null) {
        const values: CanonicalCustomValue[] = [];
        const fields = new Set<string>();
        for (const x of this.arr(raw, 'customValues', ref)) {
          if (values.length >= L.maxCustomValuesPerTask) { this.rep.warn('CUSTOM_VALUE_INVALID', ref, `Only the first ${L.maxCustomValuesPerTask} custom values were kept`); break; }
          const v = this.customValue(x, defs, ref);
          if (!v || fields.has(v.fieldExternalId)) continue;
          fields.add(v.fieldExternalId);
          values.push(v);
        }
        if (values.length > 0) t.customValues = values;
      }

      // dates
      const createdAt = this.instant(raw, 'createdAt', ref, { noFuture: true });
      let updatedAt = this.instant(raw, 'updatedAt', ref, { noFuture: true });
      if (createdAt && updatedAt && Date.parse(updatedAt) < Date.parse(createdAt)) {
        this.rep.warn('DATE_ORDER', ref, '"updatedAt" was before "createdAt"; set equal to it');
        updatedAt = createdAt;
      }
      if (createdAt) t.createdAt = createdAt;
      if (updatedAt) t.updatedAt = updatedAt;
      let startDate = this.instant(raw, 'startDate', ref);
      const dueDate = this.instant(raw, 'dueDate', ref);
      if (startDate && dueDate && Date.parse(dueDate) < Date.parse(startDate)) {
        this.rep.warn('DATE_ORDER', ref, 'The due date was before the start date; the start date was dropped');
        startDate = undefined;
      }
      if (startDate) t.startDate = startDate;
      if (dueDate) t.dueDate = dueDate;

      // estimate
      if (raw.estimate !== undefined && raw.estimate !== null) {
        const e = raw.estimate;
        if (typeof e === 'number' && Number.isFinite(e) && e >= 0 && e <= L.maxEstimate) t.estimate = e;
        else this.rep.warn('ESTIMATE_INVALID', ref, `The estimate must be a number from 0 to ${L.maxEstimate}; it was dropped`);
      }

      // nested lists
      const comments = this.comments(this.arr(raw, 'comments', ref), ref);
      if (comments.length > 0) t.comments = comments;
      const attachments = this.attachments(this.arr(raw, 'attachments', ref), ref);
      if (attachments.length > 0) t.attachments = attachments;
      const history = this.history(this.arr(raw, 'history', ref), ref);
      if (history.length > 0) t.history = history;
      this.counts.comments += comments.length;
      this.counts.attachments += attachments.length;
      this.counts.history += history.length;
      out.push(t);
    });

    // Parent cycles WITHIN the page. (A parent on another page cannot be judged here; the executor guards depth/cycles
    // against the database.) Walk up from each task; the edge that closes a loop is the one cut.
    const byId = new Map(out.map((t) => [t.externalId, t]));
    for (const start of out) {
      const path = new Set<string>([start.externalId]);
      let cur = start;
      while (cur.parentExternalId) {
        const next = byId.get(cur.parentExternalId);
        if (!next) break;
        if (path.has(next.externalId)) {
          this.rep.warn('PARENT_CYCLE', `task:${cur.externalId}`, 'The parent links form a loop; this link was dropped');
          delete cur.parentExternalId;
          break;
        }
        path.add(next.externalId);
        cur = next;
      }
    }
    return out;
  }

  dependencies(list: unknown[]): CanonicalDependency[] {
    const seenId = new Set<string>();
    const seenEdge = new Set<string>();
    const out: CanonicalDependency[] = [];
    const blocks = new Map<string, string[]>(); // blocker -> blocked, for cycle checks (BLOCKS only)
    const reaches = (from: string, to: string): boolean => {
      const stack = [from];
      const seen = new Set<string>();
      while (stack.length) {
        const n = stack.pop() as string;
        if (n === to) return true;
        if (seen.has(n)) continue;
        seen.add(n);
        for (const m of blocks.get(n) ?? []) stack.push(m);
      }
      return false;
    };
    list.forEach((raw, i) => {
      if (!isObj(raw)) return this.rep.skip('ITEM_INVALID', `dependency[${i}]`, 'A dependency entry was not an object and was skipped');
      this.unknownKeys(raw, KEYS.dependency, `dependencies[${i}]`);
      const id = this.id(raw, 'dependency', i);
      if (id === null) return;
      const ref = `dependency:${id}`;
      if (seenId.has(id)) return this.rep.skip('DUPLICATE_ID', ref, 'The same dependency appeared twice; the second was skipped');
      const from = raw.fromExternalId;
      const to = raw.toExternalId;
      const type = this.enumOf<DependencyType>(raw, 'type', Object.values(DependencyType), ref);
      if (typeof from !== 'string' || from === '' || from.length > L.externalId || typeof to !== 'string' || to === '' || to.length > L.externalId || type === undefined) {
        return this.rep.skip('ITEM_INVALID', ref, 'A dependency without both tasks and a type was skipped');
      }
      seenId.add(id);
      if (from === to) return this.rep.skip('DEPENDENCY_SELF', ref, 'A task cannot depend on itself; the link was skipped');
      const edge = `${type}\u0000${from}\u0000${to}`;
      if (seenEdge.has(edge)) return this.rep.info('DUPLICATE_ID', ref, 'The same link was listed twice; merged');
      if (type === DependencyType.BLOCKS && reaches(to, from)) {
        return this.rep.skip('DEPENDENCY_CYCLE', ref, 'This link would make tasks block each other in a loop; it was skipped');
      }
      seenEdge.add(edge);
      if (type === DependencyType.BLOCKS) blocks.set(from, [...(blocks.get(from) ?? []), to]);
      out.push({ externalId: id, fromExternalId: from, toExternalId: to, type });
    });
    return out;
  }
}

// ------------------------------------------------------------------------------------------------ entry point

/** Collection key -> the kind used in issue refs. */
const KIND_OF = new Map(COLLECTIONS.map(([key, kind]) => [key as string, kind]));

export function validateBundle(raw: unknown, options: ValidateBundleOptions = {}): BundleValidation {
  const rep = new Reporter();
  const fatal = (code: Parameters<typeof mk>[0], message: string, details?: string[]): BundleValidation => ({ ok: false, fatal: mk(code, message, details), issues: rep.items });
  const mk = (code: 'NOT_JSON' | 'TOO_DEEP' | 'TOO_LARGE' | 'VERSION_INVALID' | 'BAD_SHAPE' | 'PAGE_TOO_LARGE' | 'ADAPTER_BUG', message: string, details?: string[]) => ({ code, message, ...(details ? { details } : {}) });

  if (!isObj(raw)) return fatal('NOT_JSON', 'A bundle page must be a JSON object');

  const s = sanitizeJson(raw);
  if ('code' in s) return fatal(s.code, s.message);
  const page = s.value;

  // A conservative size check on what we are about to hold: the clean copy is at most depth 20, so this cannot overflow.
  const bytes = Buffer.byteLength(JSON.stringify(page), 'utf8');
  if (bytes > L.maxPageBytes) return fatal('TOO_LARGE', `The page is ${bytes} bytes; the limit is ${L.maxPageBytes}`);

  if (page.schemaVersion !== CANONICAL_SCHEMA_VERSION) {
    return fatal('VERSION_INVALID', `schemaVersion must be ${CANONICAL_SCHEMA_VERSION}, got ${JSON.stringify(page.schemaVersion)}`);
  }
  for (const [key, , max] of COLLECTIONS) {
    const v = page[key];
    if (v === undefined) continue;
    if (!Array.isArray(v)) return fatal('BAD_SHAPE', `"${key}" must be a list`);
    if (v.length > max) return fatal('PAGE_TOO_LARGE', `"${key}" has ${v.length} items; a page holds at most ${max}. Page size is the adapter's choice.`);
  }

  // text that had control characters / lone surrogates removed: one INFO per item
  for (const item of s.cleaned) {
    // '' = the page root; no '/' = a non-collection part of the page (`source`): both are about the page, not an item
    if (!item.includes('/')) { rep.info('TEXT_SANITIZED', null, 'Invalid characters were removed from the page'); continue; }
    const [collection, idx] = item.split('/');
    const entry = (page[collection] as unknown[] | undefined)?.[Number(idx)];
    const id = isObj(entry) && typeof entry.externalId === 'string' ? entry.externalId : null;
    rep.info('TEXT_SANITIZED', id ? `${KIND_OF.get(collection) ?? collection}:${id}` : `${KIND_OF.get(collection) ?? collection}[${idx}]`, 'Invalid characters (control or broken Unicode) were removed from the text');
  }

  const r = new Repair(rep, options.now ?? new Date());
  const unknownTop = Object.keys(page).filter((k) => !TOP_KEYS.includes(k));
  unknownTop.forEach((k) => r.adapterErrors.push(`page: unknown field "${k}"`));
  if (isObj(page.source)) r.unknownKeys(page.source, KEYS.source, 'source');

  const arr = (k: string): unknown[] => (Array.isArray(page[k]) ? (page[k] as unknown[]) : []);
  const out: CanonicalBundle = { schemaVersion: CANONICAL_SCHEMA_VERSION, source: page.source as CanonicalBundle['source'] };

  // order matters: custom fields first (task values are checked against them)
  const customFields = r.customFields(arr('customFields'));
  const defs = new Map(customFields.map((f) => [f.externalId, f]));
  const users = r.users(arr('users'));
  const projects = r.projects(arr('projects'));
  const tags = r.tags(arr('tags'));
  const issueTypes = r.issueTypes(arr('issueTypes'));
  const iterations = r.iterations(arr('iterations'));
  const tasks = r.tasks(arr('tasks'), defs);
  const dependencies = r.dependencies(arr('dependencies'));

  if (page.users !== undefined) out.users = users;
  if (page.projects !== undefined) out.projects = projects;
  if (page.tags !== undefined) out.tags = tags;
  if (page.customFields !== undefined) out.customFields = customFields;
  if (page.issueTypes !== undefined) out.issueTypes = issueTypes;
  if (page.iterations !== undefined) out.iterations = iterations;
  if (page.tasks !== undefined) out.tasks = tasks;
  if (page.dependencies !== undefined) out.dependencies = dependencies;

  if (r.adapterErrors.length > 0) {
    return fatal('ADAPTER_BUG', 'The adapter produced fields the format does not have', r.adapterErrors);
  }
  if (!validateShape(out)) {
    const details = (validateShape.errors ?? []).slice(0, 10).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`.trim());
    return fatal('ADAPTER_BUG', 'The page does not match the CanonicalBundle schema after repair', details);
  }

  const stats: BundleStats = {
    users: users.length,
    projects: projects.length,
    tags: tags.length,
    customFields: customFields.length,
    issueTypes: issueTypes.length,
    iterations: iterations.length,
    tasks: tasks.length,
    comments: r.counts.comments,
    attachments: r.counts.attachments,
    history: r.counts.history,
    dependencies: dependencies.length,
    skipped: rep.skipped,
  };
  return { ok: true, bundle: out, issues: rep.items, stats };
}
