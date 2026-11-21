import {
  getAction,
  getTrigger,
  mapSlotReferences,
} from '../../automations/registry';
import { RefIssue, RefKind } from './portable.types';

/** Translates one reference. `undefined` = it cannot be translated (unknown name, or not portable at all). */
export type RefMapper = (
  kind: RefKind,
  value: string,
  path: string,
) => string | undefined;

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const REASON: Record<RefKind, string> = {
  status: 'a status',
  tag: 'a tag',
  issueType: 'an issue type',
  customField: 'a custom field',
  iteration: 'an iteration',
  project: 'a project',
  user: 'a person',
  channel: 'a chat channel',
  rule: 'a rule',
  view: 'a saved view',
};

/**
 * Rewrites every reference in a rule or view config through `map`, at every position the DSL
 * puts one. This is the ONE place that knows where references live, so extracting (id -> name),
 * checking a template (name -> placeholder) and applying it (name -> id) cannot disagree.
 * Works on a structurally valid document; ignores shapes it does not know. Never mutates its input.
 */
export class RefWalker {
  readonly issues: RefIssue[] = [];

  constructor(private readonly map: RefMapper) {}

  private ref(kind: RefKind, value: unknown, path: string): unknown {
    if (typeof value !== 'string') return value;
    const out = this.map(kind, value, path);
    if (out === undefined) {
      this.issues.push(
        kind === 'user' || kind === 'channel'
          ? {
              code: 'NOT_PORTABLE',
              path,
              message: `${REASON[kind]} cannot be part of a template`,
            }
          : {
              code: 'UNKNOWN_REF',
              path,
              message: `${REASON[kind]} named "${value.slice(0, 60)}" is not defined by the template`,
            },
      );
      return value;
    }
    return out;
  }

  private list(kind: RefKind, v: unknown, path: string): unknown {
    return Array.isArray(v)
      ? v.map((x, i) => this.ref(kind, x, `${path}/${i}`))
      : v;
  }

  private statusRefs(v: unknown, path: string): unknown {
    if (!Array.isArray(v)) return v;
    return v.map((s, i) =>
      isObj(s) && s.statusId !== undefined
        ? {
            ...s,
            statusId: this.ref('status', s.statusId, `${path}/${i}/statusId`),
          }
        : s,
    );
  }

  /** `{all?, any?}`: filters of a view and conditions of a rule share this. */
  conditions(c: unknown, path: string): unknown {
    if (!isObj(c)) return c;
    const out: Json = { ...c };
    for (const group of ['all', 'any'] as const) {
      const items = c[group];
      if (!Array.isArray(items)) continue;
      out[group] = items.map((raw, i) => {
        if (!isObj(raw)) return raw;
        const p = `${path}/${group}/${i}`;
        const x: Json = { ...raw };
        switch (raw.field) {
          case 'STATUS':
            x.value = this.list('status', raw.value, `${p}/value`);
            break;
          case 'TAGS':
            x.value = this.list('tag', raw.value, `${p}/value`);
            break;
          case 'ISSUE_TYPE':
            x.value = this.list('issueType', raw.value, `${p}/value`);
            break;
          case 'PROJECT':
            x.value = this.list('project', raw.value, `${p}/value`);
            break;
          case 'ITERATION':
            x.value = this.list('iteration', raw.value, `${p}/value`);
            break;
          case 'ASSIGNEES':
          case 'CREATED_BY':
            x.value = this.list('user', raw.value, `${p}/value`);
            break;
          case 'CUSTOM':
            if (raw.customFieldId !== undefined)
              x.customFieldId = this.ref(
                'customField',
                raw.customFieldId,
                `${p}/customFieldId`,
              );
            // INCLUDES_* are the user operators; every other custom value is data, not a reference
            if (raw.op === 'INCLUDES_ANY' || raw.op === 'INCLUDES_NONE')
              x.value = this.list('user', raw.value, `${p}/value`);
            break;
          default:
            break;
        }
        return x;
      });
    }
    return out;
  }

  rule(rule: { trigger: unknown; conditions?: unknown; actions: unknown }): {
    trigger: unknown;
    conditions?: unknown;
    actions: unknown;
  } {
    const r = clone(rule);
    const ref = (kind: RefKind, value: unknown, path: string) =>
      this.ref(kind, value, path);
    // WHERE a trigger's or an action's ids live is its descriptor's `refs` (step 5.8): the same
    // declaration the validator's reference collection and the workspace checks read.
    const t = r.trigger;
    const triggerDescriptor =
      isObj(t) && typeof t.type === 'string' ? getTrigger(t.type) : undefined;
    const trigger =
      isObj(t) && triggerDescriptor
        ? mapSlotReferences(triggerDescriptor.refs, t, '/trigger', ref)
        : t;
    const conditions =
      r.conditions === undefined
        ? undefined
        : this.conditions(r.conditions, '/conditions');
    // actions are a tree (IF): an action's own slots, then the conditions and branches it nests
    const mapActions = (list: unknown, base: string): unknown =>
      Array.isArray(list)
        ? list.map((raw, i) => {
            if (!isObj(raw) || typeof raw.type !== 'string') return raw;
            const d = getAction(raw.type);
            if (!d) return raw;
            const path = `${base}/${i}`;
            const node = mapSlotReferences(d.refs, raw, path, ref);
            const key = d.nested?.conditions;
            if (key && node[key] !== undefined)
              node[key] = this.conditions(node[key], `${path}/${key}`);
            for (const branch of d.nested?.branches ?? [])
              if (node[branch] !== undefined)
                node[branch] = mapActions(node[branch], `${path}/${branch}`);
            // an IF's `elseIf`: each case has its own conditions and actions
            const cases = d.nested?.cases;
            if (cases && Array.isArray(node[cases]))
              node[cases] = (node[cases] as unknown[]).map((c, k) =>
                isObj(c)
                  ? {
                      ...c,
                      conditions: this.conditions(
                        c.conditions,
                        `${path}/${cases}/${k}/conditions`,
                      ),
                      then: mapActions(c.then, `${path}/${cases}/${k}/then`),
                    }
                  : c,
              );
            return node;
          })
        : list;
    const actions = mapActions(r.actions, '/actions');
    return {
      trigger,
      ...(conditions === undefined ? {} : { conditions }),
      actions,
    };
  }

  viewConfig(config: unknown): unknown {
    if (!isObj(config)) return config;
    const out: Json = clone(config);
    if (config.filters !== undefined)
      out.filters = this.conditions(clone(config.filters), '/filters');
    if (isObj(out.group) && out.group.customFieldId !== undefined)
      out.group = {
        ...out.group,
        customFieldId: this.ref(
          'customField',
          out.group.customFieldId,
          '/group/customFieldId',
        ),
      };
    if (Array.isArray(out.sort)) {
      out.sort = out.sort.map((k, i) =>
        isObj(k) && k.customFieldId !== undefined
          ? {
              ...k,
              customFieldId: this.ref(
                'customField',
                k.customFieldId,
                `/sort/${i}/customFieldId`,
              ),
            }
          : k,
      );
    }
    if (Array.isArray(out.columns)) {
      out.columns = out.columns.map((c, i) => {
        if (typeof c !== 'string' || !c.startsWith('custom:')) return c;
        const mapped = this.ref(
          'customField',
          c.slice('custom:'.length),
          `/columns/${i}`,
        );
        return typeof mapped === 'string' &&
          mapped !== c.slice('custom:'.length)
          ? `custom:${mapped}`
          : c;
      });
    }
    return out;
  }
}
