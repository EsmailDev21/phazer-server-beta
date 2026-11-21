import { foldName } from '../blueprint';

/**
 * Step 3.3. nodeKey rules (the decision IMPLEMENTATION s13 asked for before 3.3).
 *
 *  - TASKS:      "t<number>". The workspace task number is already permanent (ADR-0004: never
 *                reused, never changed), so a task keeps its key across renames, moves and
 *                re-extraction. No ids, no titles.
 *  - PROJECTS:   "p-<slug of name>", ITERATIONS: "i-<slug of name>". Deterministic; a clash gets
 *                "-2", "-3" in a stable order. A rename changes the key (these have no permanent
 *                number); the template editor (3.8) keeps keys across edits of a template, and
 *                that is where stability across VERSIONS is owed.
 *  - STATUSES / ASSETS: local keys inside one project / one blueprint ("s-.." slug, "a1"...).
 *  - Nothing derives from a database id or a timestamp, so extracting twice, or extracting a
 *    restored copy, gives the same document.
 */
export function slug(value: string, max: number): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
}

/** Assigns `prefix + slug`, then `-2`, `-3`... on clashes, within `taken`. */
export function uniqueKey(
  prefix: string,
  name: string,
  taken: Set<string>,
  max = 60,
  fallback = 'x',
): string {
  const base = `${prefix}${slug(name, max - prefix.length - 4) || fallback}`;
  let key = base;
  for (let n = 2; taken.has(key); n++) key = `${base}-${n}`;
  taken.add(key);
  return key;
}

/** Local key for a status: [a-z0-9][a-z0-9_-]{0,39}. */
export function statusKey(name: string, taken: Set<string>): string {
  const base = slug(name, 34) || 's';
  let key = base;
  for (let n = 2; taken.has(key); n++) key = `${base}-${n}`;
  taken.add(key);
  return key;
}

/**
 * Custom field keys are free text in the app but [A-Za-z0-9][A-Za-z0-9._-]{0,79} in a blueprint.
 * Anything else becomes "-"; clashes (compared ignoring case) get "-2"... Returns the new key.
 */
export function fieldKey(original: string, taken: Set<string>): string {
  let key = original
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, 76);
  if (key === '') key = 'field';
  let candidate = key;
  for (let n = 2; taken.has(candidate.toLowerCase()); n++)
    candidate = `${key}-${n}`;
  taken.add(candidate.toLowerCase());
  return candidate;
}

export const byFolded =
  <T>(pick: (t: T) => string) =>
  (a: T, b: T): number => {
    const x = foldName(pick(a));
    const y = foldName(pick(b));
    return x < y
      ? -1
      : x > y
        ? 1
        : pick(a) < pick(b)
          ? -1
          : pick(a) > pick(b)
            ? 1
            : 0;
  };
