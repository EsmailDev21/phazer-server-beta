/**
 * Step 3.5. Template version numbers. "1.0.0" for the first version; an author picks how the next
 * one moves (default minor). Strictly increasing within a template, matching the DB CHECK.
 */
export type Bump = 'major' | 'minor' | 'patch';
export const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseSemver(v: string): [number, number, number] | null {
  const m = SEMVER.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function bumpSemver(previous: string | null, bump: Bump = 'minor'): string {
  if (previous === null) return '1.0.0';
  const p = parseSemver(previous);
  if (!p) throw new Error(`not a semantic version: ${previous}`);
  const [major, minor, patch] = p;
  switch (bump) {
    case 'major': return `${major + 1}.0.0`;
    case 'minor': return `${major}.${minor + 1}.0`;
    case 'patch': return `${major}.${minor}.${patch + 1}`;
  }
}

export function compareSemver(a: string, b: string): number {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) throw new Error('not a semantic version');
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}
