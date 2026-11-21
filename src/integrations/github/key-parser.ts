/**
 * Task keys in free text (ADR-0014 d.4): `ENG-123` in a PR title, branch name, commit message or body.
 *
 * This only finds CANDIDATES. Whether `ENG-123` means anything is decided later, and only inside the linked
 * workspace (GithubLinkService): a candidate that is not a key of that workspace (`UTF-8`, `SHA-256`, another
 * workspace's `OPS-4`, another account's `ENG-1`) is simply dropped there. So this regex may be generous.
 *
 * Rules: 2-10 chars, letter first, letters/digits (WORKSPACE_KEY_PATTERN), a dash, 1-9 digits. Not glued to other
 * letters/digits on either side (`XENG-1` is key `XENG`, never `ENG`; `ENG-12abc` is not `ENG-12`); `/`, `-`, `_`, `#`,
 * `(`, space ... are boundaries, so `feature/eng-123-fix-login` and `[ENG-123]` work. Case-insensitive (branches are
 * usually lower case); results are upper-cased.
 */
const CANDIDATE = /(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]{1,9})-(\d{1,9})(?![A-Za-z0-9])/g;

export interface TaskRef {
  key: string;
  number: number;
}

/** Hard cap per call: bounds the lookups one hostile PR body (thousands of `AB-1 AB-2 ...`) can cause. */
export const MAX_REFS = 20;

export function extractTaskRefs(texts: ReadonlyArray<string | null | undefined>, max = MAX_REFS): TaskRef[] {
  const seen = new Set<string>();
  const out: TaskRef[] = [];
  for (const text of texts) {
    if (!text) continue;
    for (const m of text.matchAll(CANDIDATE)) {
      const key = m[1].toUpperCase();
      const number = Number(m[2]);
      if (!Number.isSafeInteger(number) || number < 1) continue;
      const id = `${key}-${number}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ key, number });
      if (out.length >= max) return out;
    }
  }
  return out;
}
