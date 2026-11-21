import { badTextReason } from '../../templates/blueprint/blueprint.json-guard';
import { CANONICAL_LIMITS as L } from './canonical.limits';

/**
 * Step 4.2. Text and value repair helpers for the validator. Pure.
 *
 * Provider data is not trusted and not tidy. These never throw and never reject: they return the nearest usable value
 * (or null for "drop the field") and the validator decides what to report.
 */

// Same classes as the Blueprint's json-guard (it only DETECTS; we REPAIR). A test ties the two together.
// eslint-disable-next-line no-control-regex
const BAD_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function cleanText(s: string): string {
  return s.replace(BAD_CONTROL, '').replace(LONE_SURROGATE, '');
}

/** Whether cleanText would change it (without allocating when it would not). */
export function needsCleaning(s: string): boolean {
  return badTextReason(s) !== null;
}

/** A single-line field: blanks (incl. newlines, NBSP-like) collapsed, trimmed. */
export function oneLine(s: string): string {
  return s.replace(/[\s\u00a0]+/g, ' ').trim();
}

/** Cut to at most `max` UTF-16 units without splitting a surrogate pair. */
function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = max;
  const c = s.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end -= 1;
  return s.slice(0, end);
}

/** `…` marks a cut single-line value. Result length <= max. */
export function truncateLine(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${cut(s, Math.max(max - 1, 0)).trimEnd()}…`;
}

export const TRUNCATION_MARKER = '\n\n… (truncated)';

/**
 * Markdown cut to `max`, kept well-formed: prefers a line boundary, closes an open code fence, and ends with a marker the
 * reader can see. Result length <= max.
 */
export function truncateMarkdown(s: string, max: number): string {
  if (s.length <= max) return s;
  let body = cut(s, Math.max(max - TRUNCATION_MARKER.length - 8, 0));
  const nl = body.lastIndexOf('\n');
  if (nl > body.length - 200 && nl > 0) body = body.slice(0, nl);
  // an odd number of fence lines = we cut inside a code block: close it
  const fences = body.split('\n').filter((l) => /^\s*(`{3,}|~{3,})/.test(l)).length;
  const close = fences % 2 === 1 ? '\n```' : '';
  return `${body.trimEnd()}${close}${TRUNCATION_MARKER}`;
}

const INSTANT_IN =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/i;

/**
 * ISO-8601 -> canonical instant ("YYYY-MM-DDTHH:mm:ss.sssZ", UTC), or null. Accepted: date-only (midnight UTC), local
 * time without an offset (read as UTC: the adapter owns time zones), offsets +hh:mm / +hhmm. Rejected: anything else
 * ("03/04/2026" is ambiguous), impossible dates (Feb 30), and years outside the window (0001, 9999 are garbage).
 */
export function parseInstant(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const m = INSTANT_IN.exec(v.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const h = m[4] === undefined ? 0 : Number(m[4]);
  const mi = m[5] === undefined ? 0 : Number(m[5]);
  const se = m[6] === undefined ? 0 : Number(m[6]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || se > 59) return null;
  const ms = m[7] ? Number(`0.${m[7].padEnd(3, '0').slice(0, 3)}`) * 1000 : 0;
  let offsetMin = 0;
  if (m[8] && m[8].toUpperCase() !== 'Z') {
    const sign = m[8][0] === '-' ? -1 : 1;
    const digits = m[8].slice(1).replace(':', '');
    const oh = Number(digits.slice(0, 2));
    const om = Number(digits.slice(2, 4));
    if (oh > 23 || om > 59) return null;
    offsetMin = sign * (oh * 60 + om);
  }
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, se, Math.round(ms)));
  // Date.UTC rolls Feb 30 into March: the day coming back different means the input was not a real date
  if (date.getUTCDate() !== d || date.getUTCMonth() !== mo - 1) return null;
  const t = date.getTime() - offsetMin * 60_000;
  const out = new Date(t);
  const year = out.getUTCFullYear();
  if (year < L.minYear || year > L.maxYear) return null;
  return out.toISOString();
}

/** http / https only, at most 2048 chars, control characters removed first (browsers ignore them inside a scheme). */
export function httpUrl(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const u = v.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
  if (u.length === 0 || u.length > L.url) return null;
  if (!/^https?:\/\//i.test(u)) return null;
  try {
    new URL(u);
  } catch {
    return null;
  }
  return u;
}

export function hexColor(v: unknown): string | null {
  return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v : null;
}

/** A file name with no path, no control characters, at most `max` long, keeping a short extension when it must cut. */
export function safeFileName(raw: string, max: number): string {
  let n = oneLine(cleanText(raw).replace(/[\\/]+/g, '_'));
  n = n.replace(/^\.+/, (dots) => '_'.repeat(dots.length)); // ".htaccess", ".." are not names
  if (n === '') return 'attachment';
  if (n.length <= max) return n;
  const dot = n.lastIndexOf('.');
  const ext = dot > 0 && n.length - dot <= 20 ? n.slice(dot) : '';
  return cut(n.slice(0, ext ? dot : n.length), max - ext.length) + ext;
}
