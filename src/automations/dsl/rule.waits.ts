import { BRANCH_KEYS } from '../registry/tree';
import type { Sink } from './rule.schema';

/**
 * Step 5.15. Where a WAIT may sit. A wait saves what is LEFT of a run, and the rest of a loop (the tasks
 * not yet processed) cannot be saved, so a WAIT is refused anywhere inside a FOR_EACH body, however deep.
 * (Inside a rule that is CALLED by another is refused by the caller's own check: `RUN_RULE_HAS_WAIT`.)
 *
 * Pure.
 */
type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function walk(list: unknown, inLoop: boolean, base: string, sink: Sink): void {
  if (!Array.isArray(list)) return;
  list.forEach((a, i) => {
    if (!isObj(a)) return;
    const ptr = `${base}/${i}`;
    if (a.type === 'WAIT' && inLoop)
      sink.add(
        'WAIT_IN_LOOP',
        ptr,
        'A Wait cannot be inside a loop: the tasks the loop has not reached yet cannot be saved. Wait before the loop, or after it.',
      );
    const inside = inLoop || a.type === 'FOR_EACH';
    for (const key of BRANCH_KEYS[String(a.type)] ?? [])
      walk(a[key], inside, `${ptr}/${key}`, sink);
    if (a.type === 'IF' && Array.isArray(a.elseIf))
      a.elseIf.forEach((c, k) => {
        if (isObj(c)) walk(c.then, inside, `${ptr}/elseIf/${k}/then`, sink);
      });
  });
}

export function checkWaits(actions: unknown, sink: Sink): void {
  walk(actions, false, '/actions', sink);
}
