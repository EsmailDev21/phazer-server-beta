import { BadRequestException } from '@nestjs/common';

export const TAG_NAME_MAX_LENGTH = 50;

// C0/C1 controls incl. NUL (Postgres rejects \u0000 in text with a 500-class error).
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

export interface NormalizedTagName {
  /** What users see: whitespace collapsed + trimmed, casing preserved. */
  name: string;
  /** What uniqueness is enforced on: NFKC + lower-cased display form. */
  nameKey: string;
}

/**
 * The ONE place a tag name becomes a (name, nameKey) pair. The 0.8 migration's
 * backfill (`lower(btrim(regexp_replace(normalize(name, NFKC), '\s+', ' ')))`)
 * mirrors this; keep them in step.
 *
 * Throws 400 on blank, over-long, or control-character names, so nothing
 * reaches the database that it would reject with an unhelpful 500.
 */
export function normalizeTagName(raw: string): NormalizedTagName {
  if (typeof raw !== 'string') {
    throw new BadRequestException('Tag name must be a string');
  }
  // Whitespace first: tabs/newlines (pasted text, textarea input) are
  // whitespace to be collapsed, not control characters to be rejected.
  const name = raw.replace(/\s+/g, ' ').trim();
  if (CONTROL_CHARS.test(name)) {
    throw new BadRequestException('Tag name contains control characters');
  }
  if (name.length === 0) {
    throw new BadRequestException('Tag name must not be blank');
  }
  if (name.length > TAG_NAME_MAX_LENGTH) {
    throw new BadRequestException(
      `Tag name must be at most ${TAG_NAME_MAX_LENGTH} characters`,
    );
  }
  const nameKey = name
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return { name, nameKey };
}
