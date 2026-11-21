import { TASK_CAPTURE_PROPS, TOKEN, isVariableRef } from '../registry/checks';
import { BRANCH_KEYS } from '../registry/tree';
import type { Sink } from './rule.schema';

/**
 * Step 5.13. The scope rules for captured variables (`as` on a Create action, `{{name.prop}}` in text,
 * `WITH name`), checked on a structurally valid rule:
 *
 *  - a variable exists AFTER the action that captures it, for the actions that follow it in the same list
 *    and everything those contain;
 *  - it does NOT leave the list it was captured in (a capture inside a branch, a loop or a WITH may never
 *    have happened, or happens once per task), so using it outside is refused here, not at run time;
 *  - a name is captured once per scope (`VARIABLE_EXISTS`);
 *  - a placeholder must name a variable in scope and one of its properties (`UNKNOWN_VARIABLE`);
 *  - `WITH` must name a captured task.
 *
 * Pure: no database, no clock.
 */
type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** what a captured variable is, and the properties it has */
const PROPS = { task: TASK_CAPTURE_PROPS } as const;
type Kind = keyof typeof PROPS;
type Scope = Map<string, Kind>;

/** keys of an action that are not text with placeholders in it */
const NOT_TEXT = new Set([
  'type',
  'as',
  'task',
  'conditions',
  'where',
  'elseIf',
  'then',
  'else',
  'do',
]);

function scan(text: string, path: string, scope: Scope, sink: Sink): void {
  for (const m of text.matchAll(TOKEN)) {
    const ref = isVariableRef(m[1]);
    if (!ref) continue; // a built-in placeholder, or syntactically wrong (the structural check says so)
    const [, name, prop] = ref;
    const kind = scope.get(name);
    if (!kind)
      sink.add(
        'UNKNOWN_VARIABLE',
        path,
        `"${name}" is not captured here: an earlier Create action in this list (or one around it) must have \`as: "${name}"\``,
      );
    else if (!(PROPS[kind] as readonly string[]).includes(prop))
      sink.add(
        'UNKNOWN_VARIABLE',
        path,
        `"${name}" has no "${prop}"; it has ${PROPS[kind].join(', ')}`,
      );
  }
}

function walk(list: unknown, scope: Scope, base: string, sink: Sink): void {
  if (!Array.isArray(list)) return;
  list.forEach((a, i) => {
    if (!isObj(a)) return;
    const ptr = `${base}/${i}`;
    for (const [key, value] of Object.entries(a))
      if (!NOT_TEXT.has(key) && typeof value === 'string')
        scan(value, `${ptr}/${key}`, scope, sink);

    if (a.type === 'WITH' && !(typeof a.task === 'string' && scope.has(a.task)))
      sink.add(
        'UNKNOWN_VARIABLE',
        `${ptr}/task`,
        `"${String(a.task)}" is not a task captured here: use \`as\` on an earlier Create action`,
      );

    // what a branch, a loop or a WITH captures stays inside it
    for (const key of BRANCH_KEYS[String(a.type)] ?? [])
      walk(a[key], new Map(scope), `${ptr}/${key}`, sink);
    if (a.type === 'IF' && Array.isArray(a.elseIf))
      a.elseIf.forEach((c, k) => {
        if (isObj(c))
          walk(c.then, new Map(scope), `${ptr}/elseIf/${k}/then`, sink);
      });

    // the action's OWN text cannot use its own capture, so the name is added last
    if (typeof a.as === 'string') {
      if (scope.has(a.as))
        sink.add(
          'VARIABLE_EXISTS',
          `${ptr}/as`,
          `"${a.as}" is already captured above; pick another name`,
        );
      else scope.set(a.as, 'task');
    }
  });
}

export function checkCaptures(actions: unknown, sink: Sink): void {
  walk(actions, new Map(), '/actions', sink);
}
