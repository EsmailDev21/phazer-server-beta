import { BadRequestException } from '@nestjs/common';

/**
 * ADR-0004. Pure functions only: the same rules are used by workspace
 * creation, key rename and the backfill CLI, which must never disagree.
 */

/** 2-10 characters, letter first, upper-case letters and digits (decision 2). */
export const WORKSPACE_KEY_PATTERN = /^[A-Z][A-Z0-9]{1,9}$/;
export const WORKSPACE_KEY_MAX_LENGTH = 10;
/** Used when a name yields nothing usable (e.g. "日本語", "123", "!!"). */
export const FALLBACK_KEY_BASE = 'WS';
const BASE_LENGTH = 3;

/**
 * Upper-cases and validates a user-supplied key. Matching is
 * case-insensitive, storage is upper-case, so `eng`, `Eng` and `ENG` are one key.
 */
export function normalizeWorkspaceKey(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new BadRequestException('Workspace key must be a string');
  }
  const key = raw.trim().toUpperCase();
  if (!WORKSPACE_KEY_PATTERN.test(key)) {
    throw new BadRequestException(
      'Workspace key must be 2-10 characters: a letter followed by letters or digits (e.g. ENG, PLAT2)',
    );
  }
  return key;
}

/**
 * The first letters of a workspace name as a candidate key (ADR-0004 decision
 * 6): diacritics folded, upper-cased, stripped to [A-Z0-9], must start with a
 * letter, 3 characters. A name that yields fewer than 2 usable characters gets
 * the fallback base instead.
 *
 *   "Engineering"   -> ENG        "Café Ops"  -> CAF
 *   "My Team"       -> MYT        "42 Labs"   -> LAB   (leading digits dropped)
 *   "日本語"         -> WS
 */
export function generateKeyBase(name: string): string {
  const stripped = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // combining marks: é -> e
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/^[0-9]+/, ''); // a key must start with a letter
  const base = stripped.slice(0, BASE_LENGTH);
  return base.length >= 2 ? base : FALLBACK_KEY_BASE;
}

/**
 * First free key for `name`, given every key the account already has
 * (current keys AND retired aliases - both are reserved). On collision a
 * number is appended: ENG, ENG2, ENG3, ... The base is shortened if needed so
 * the result never exceeds 10 characters. Deterministic: same input, same output.
 */
export function pickUniqueKey(
  name: string,
  taken: ReadonlySet<string>,
): string {
  const base = generateKeyBase(name);
  if (!taken.has(base)) return base;
  for (let n = 2; n < 10_000_000; n++) {
    const suffix = String(n);
    const candidate =
      base.slice(0, WORKSPACE_KEY_MAX_LENGTH - suffix.length) + suffix;
    if (!taken.has(candidate)) return candidate;
  }
  /* istanbul ignore next - 10 million keys under one prefix is not a real state */
  throw new Error(`No free workspace key for "${name}"`);
}

export interface ParsedTaskKey {
  /** Upper-cased workspace key. */
  key: string;
  number: number;
}

/**
 * Parses a WHOLE string as a task key ("ENG-123", "eng-123"). Returns null for
 * anything else - including a key-like string that is not a well-formed key,
 * a zero or absurdly long number, or surrounding text. (Finding keys inside
 * free text is a different, account-aware operation: ADR-0004 decision 7,
 * built with the chat adapters.)
 */
export function parseTaskKey(input: string): ParsedTaskKey | null {
  const m = /^([A-Za-z][A-Za-z0-9]{1,9})-([1-9][0-9]{0,8})$/.exec(input.trim());
  if (!m) return null;
  return { key: m[1].toUpperCase(), number: Number(m[2]) };
}

export function formatTaskKey(key: string, number: number): string {
  return `${key}-${number}`;
}
