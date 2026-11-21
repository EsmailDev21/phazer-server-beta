import { BLUEPRINT_LIMITS } from './blueprint.limits';
import { IssueList, pointer } from './blueprint.issues';

// C0 controls except \t \n \r, DEL, and C1 controls. NUL in particular: Postgres rejects it.
// eslint-disable-next-line no-control-regex
const BAD_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
// a UTF-16 surrogate that is not half of a valid pair (JSON.parse accepts "\ud800"; UTF-8 cannot)
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export function badTextReason(s: string): string | null {
  if (BAD_CONTROL.test(s)) return 'contains a control character';
  if (LONE_SURROGATE.test(s)) return 'contains an invalid Unicode character';
  return null;
}

/**
 * Iterative walk (no recursion, so a hostile document cannot overflow the stack, and a
 * cyclic object graph is caught by the depth ceiling instead of looping). Checks, before any
 * recursive validator runs:
 *  - only JSON values (no undefined / NaN / Infinity / bigint / functions / class instances)
 *  - nesting <= maxJsonDepth
 *  - every string value and every object key is clean text
 * Returns false when a problem was found.
 */
export function inspectJson(root: unknown, issues: IssueList): boolean {
  const before = issues.count;
  const stack: Array<{ value: unknown; path: string; depth: number }> = [
    { value: root, path: '', depth: 0 },
  ];
  let visited = 0;

  while (stack.length > 0 && !issues.full) {
    const { value, path, depth } = stack.pop()!;
    visited += 1;
    if (visited > 5_000_000) {
      issues.add('TOO_LARGE', path, 'The document has too many values');
      break;
    }

    if (value === null || typeof value === 'boolean') continue;
    if (typeof value === 'string') {
      const reason = badTextReason(value);
      if (reason) issues.add('BAD_TEXT', path, `Text ${reason}`);
      continue;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        issues.add('NOT_JSON', path, 'Numbers must be finite');
      }
      continue;
    }
    if (typeof value !== 'object') {
      issues.add('NOT_JSON', path, `A ${typeof value} is not a JSON value`);
      continue;
    }
    if (depth >= BLUEPRINT_LIMITS.maxJsonDepth) {
      issues.add(
        'TOO_DEEP',
        path,
        `Nested more than ${BLUEPRINT_LIMITS.maxJsonDepth} levels deep`,
      );
      continue;
    }
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        if (!(i in value)) {
          issues.add('NOT_JSON', pointer(path, i), 'Arrays cannot have holes');
          continue;
        }
        stack.push({
          value: value[i],
          path: pointer(path, i),
          depth: depth + 1,
        });
      }
      continue;
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      issues.add('NOT_JSON', path, 'Only plain objects are allowed');
      continue;
    }
    for (const key of Object.keys(value)) {
      if (key === '__proto__') {
        issues.add(
          'NOT_JSON',
          pointer(path, key),
          'The key "__proto__" is reserved',
        );
        continue;
      }
      const reason = badTextReason(key);
      if (reason) issues.add('BAD_TEXT', pointer(path, key), `A key ${reason}`);
      stack.push({
        value: (value as Record<string, unknown>)[key],
        path: pointer(path, key),
        depth: depth + 1,
      });
    }
  }
  return issues.count === before;
}
