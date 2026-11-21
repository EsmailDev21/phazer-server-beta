import { isCalendarDate } from '../blueprint';

/**
 * Step 3.2. Calendar-date arithmetic on "YYYY-MM-DD" strings, in UTC, with no clock and no time
 * zone: a template's dates are CALENDAR days, so "+7 days" means the same date label everywhere
 * and a DST change can never move one. Years are kept within 1900..2200 (the same range a DATE
 * variable accepts); leaving it is an error the caller reports, never a silent wrap.
 */
const DAY_MS = 86_400_000;

export const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;
export const WEEKDAYS = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
] as const;

export function parseIsoDate(iso: string): number | null {
  if (typeof iso !== 'string' || !isCalendarDate(iso)) return null;
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

export function toIsoDate(ms: number): string | null {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  if (!Number.isFinite(ms) || y < 1900 || y > 2200) return null;
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${String(y).padStart(4, '0')}-${mm}-${dd}`;
}

/** null when the input is not a real date or the result leaves 1900..2200. */
export function addDays(iso: string, days: number): string | null {
  const ms = parseIsoDate(iso);
  if (ms === null || !Number.isInteger(days)) return null;
  return toIsoDate(ms + days * DAY_MS);
}

/** 0 = Sunday ... 6 = Saturday. */
export function weekday(iso: string): number {
  const ms = parseIsoDate(iso);
  if (ms === null) throw new Error(`not a date: ${iso}`);
  return new Date(ms).getUTCDay();
}

/** A Saturday or Sunday moves FORWARD to Monday; any other day is unchanged. */
export function skipWeekend(iso: string): string | null {
  const w = weekday(iso);
  if (w === 6) return addDays(iso, 2);
  if (w === 0) return addDays(iso, 1);
  return iso;
}

/**
 * anchor + offset, then (optionally) off the weekend. Moving weekends forward is monotone, so
 * start <= due before skipping is still start <= due after.
 */
export function offsetDate(
  anchor: string,
  offsetDays: number,
  skipWeekends: boolean,
): string | null {
  const raw = addDays(anchor, offsetDays);
  if (raw === null) return null;
  return skipWeekends ? skipWeekend(raw) : raw;
}

const TOKEN = /yyyy|yy|MMMM|MMM|MM|M|dd|d|EEEE|EEE|[\s\S]/g;

/** The pattern language of `format()` (validated upstream by DATE_PATTERN). English names. */
export function formatDate(iso: string, pattern: string): string {
  const ms = parseIsoDate(iso);
  if (ms === null) throw new Error(`not a date: ${iso}`);
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = d.getUTCDate();
  const w = d.getUTCDay();
  return pattern.replace(TOKEN, (t) => {
    switch (t) {
      case 'yyyy': return String(y).padStart(4, '0');
      case 'yy': return String(y % 100).padStart(2, '0');
      case 'MMMM': return MONTHS[m];
      case 'MMM': return MONTHS[m].slice(0, 3);
      case 'MM': return String(m + 1).padStart(2, '0');
      case 'M': return String(m + 1);
      case 'dd': return String(day).padStart(2, '0');
      case 'd': return String(day);
      case 'EEEE': return WEEKDAYS[w];
      case 'EEE': return WEEKDAYS[w].slice(0, 3);
      default: return t;
    }
  });
}
