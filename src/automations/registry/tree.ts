import type { Conditions } from '../dsl/rule.types';

/**
 * Step 5.10. Actions are a TREE now (an `IF` holds a `then` and an optional `else` list). Everything that
 * used to loop over `rule.actions` walks it through here, so a nested action is seen by the same code
 * with the same JSON pointer (`/actions/2/then/0`) everywhere.
 *
 * Works on plain JSON, structurally valid or not (a validator may call it on partial input).
 */
type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** which keys of a control-flow action hold nested actions, and which holds its conditions block */
export const BRANCH_KEYS: Readonly<Record<string, readonly string[]>> = {
  IF: ['then', 'else'],
  FOR_EACH: ['do'],
  WITH: ['do'],
};
export const CONDITIONS_KEY: Readonly<Record<string, string>> = {
  IF: 'conditions',
  FOR_EACH: 'where',
};
/** the path segments that mean "inside a control-flow action" (`/actions/0/then/1`, `/actions/2/do/0`) */
export const enclosing = (path: string): number =>
  (path.match(/\/(then|else|do)\//g) ?? []).length; // `/elseIf/0/then/` has one `/then/`

export interface Visit {
  action: Json;
  /** JSON pointer of the action, e.g. `/actions/2/then/0` */
  pointer: string;
  /** how many control-flow actions (IF, FOR_EACH) it is inside (0 = top level) */
  depth: number;
  /** the conditions block of an action that has one (IF, FOR_EACH), else undefined */
  conditions?: Conditions;
  /** the key it sits under (`conditions`, `where`), for the pointer */
  conditionsKey?: string;
  /** more conditions blocks the action carries (an IF's `elseIf` cases), each with its own pointer */
  extraConditions?: Array<{ conditions: Conditions; pointer: string }>;
}

const conditionsOf = (a: Json): Conditions | undefined => {
  const key = CONDITIONS_KEY[String(a.type)];
  return key && isObj(a[key]) ? (a[key] as Conditions) : undefined;
};

/** Depth-first, in the order a person reads the rule: an action, then its `then`, then its `else`. */
export function walkActions(
  actions: unknown,
  visit: (v: Visit) => void,
  base = '/actions',
  depth = 0,
): void {
  if (!Array.isArray(actions)) return;
  actions.forEach((a, i) => {
    if (!isObj(a)) return;
    const pointer = `${base}/${i}`;
    visit({
      action: a,
      pointer,
      depth,
      conditions: conditionsOf(a),
      conditionsKey: CONDITIONS_KEY[String(a.type)],
      extraConditions: Array.isArray(a.elseIf)
        ? a.elseIf.flatMap((c, k) =>
            isObj(c) && isObj(c.conditions)
              ? [
                  {
                    conditions: c.conditions as Conditions,
                    pointer: `${pointer}/elseIf/${k}/conditions`,
                  },
                ]
              : [],
          )
        : [],
    });
    for (const key of BRANCH_KEYS[String(a.type)] ?? []) {
      walkActions(a[key], visit, `${pointer}/${key}`, depth + 1);
      // an IF reads then, each elseIf, then else
      if (key === 'then' && Array.isArray(a.elseIf))
        a.elseIf.forEach((c, k) => {
          if (isObj(c))
            walkActions(
              c.then,
              visit,
              `${pointer}/elseIf/${k}/then`,
              depth + 1,
            );
        });
    }
  });
}

/** every action node in the tree, the IFs themselves included */
export function countActions(actions: unknown): number {
  let n = 0;
  walkActions(actions, () => n++);
  return n;
}

/** how deep the deepest action sits (0 = no IF/FOR_EACH, 1 = an action inside one) */
export function ifDepth(actions: unknown): number {
  let max = 0;
  walkActions(actions, (v) => (max = Math.max(max, v.depth)));
  return max;
}
