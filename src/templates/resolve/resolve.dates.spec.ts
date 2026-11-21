import { addDays, formatDate, offsetDate, parseIsoDate, skipWeekend, toIsoDate, weekday } from './resolve.dates';

let seed = 3202610;
const rnd = (n: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
const randomDate = () => toIsoDate(Date.UTC(1950, 0, 1) + rnd(365 * 200) * 86_400_000)!;

describe('calendar dates', () => {
  it('parses only real dates', () => {
    expect(parseIsoDate('2026-02-28')).not.toBeNull();
    for (const bad of ['2026-02-30', '2026-13-01', '2026-1-1', '', 'x', '1899-12-31', '2201-01-01', '2026-02-28T00:00:00Z']) {
      expect(parseIsoDate(bad)).toBeNull();
    }
  });

  it('adds days across month, year and leap boundaries', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-10-25', 1)).toBe('2026-10-26'); // a DST night in Europe: still one calendar day
    expect(addDays('2026-01-01', 0)).toBe('2026-01-01');
  });

  it('refuses to leave 1900..2200 or take a non-integer', () => {
    expect(addDays('2200-12-31', 1)).toBeNull();
    expect(addDays('1900-01-01', -1)).toBeNull();
    expect(addDays('2026-01-01', 1.5)).toBeNull();
    expect(addDays('nope', 1)).toBeNull();
  });

  it('weekends move FORWARD to Monday, weekdays stay', () => {
    // 2026-10-09 is a Friday
    expect(weekday('2026-10-09')).toBe(5);
    expect(skipWeekend('2026-10-09')).toBe('2026-10-09');
    expect(skipWeekend('2026-10-10')).toBe('2026-10-12'); // Saturday
    expect(skipWeekend('2026-10-11')).toBe('2026-10-12'); // Sunday
    expect(skipWeekend('2026-10-12')).toBe('2026-10-12');
  });

  it('offsetDate: skipWeekends is optional', () => {
    expect(offsetDate('2026-10-09', 1, false)).toBe('2026-10-10');
    expect(offsetDate('2026-10-09', 1, true)).toBe('2026-10-12');
    expect(offsetDate('2026-10-12', -1, true)).toBe('2026-10-12'); // Sunday back-offset still lands on Monday
    expect(offsetDate('2200-12-31', 0, false)).toBe('2200-12-31');
    expect(offsetDate('2200-12-30', 0, true)).toBe('2200-12-30'); // Wed
  });

  it('property: offsets compose, weekends never survive, order is preserved (5000 random cases)', () => {
    for (let n = 0; n < 5000; n++) {
      const d = randomDate();
      const a = rnd(2001) - 1000;
      const b = rnd(2001) - 1000;
      expect(addDays(addDays(d, a)!, b)).toBe(addDays(d, a + b));
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      const skipped = offsetDate(d, lo, true)!;
      expect([0, 6]).not.toContain(weekday(skipped));
      expect(skipped >= addDays(d, lo)!).toBe(true);
      expect(parseIsoDate(skipped)! - parseIsoDate(addDays(d, lo)!)!).toBeLessThanOrEqual(2 * 86_400_000);
      // start <= due before skipping => start <= due after
      expect(offsetDate(d, lo, true)! <= offsetDate(d, hi, true)!).toBe(true);
    }
  });
});

describe('formatDate', () => {
  it('matches Intl as an oracle for the name tokens (3000 random dates)', () => {
    const long = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long' });
    const short = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short' });
    for (let n = 0; n < 3000; n++) {
      const iso = randomDate();
      const d = new Date(parseIsoDate(iso)!);
      const l = Object.fromEntries(long.formatToParts(d).map((p) => [p.type, p.value]));
      const s = Object.fromEntries(short.formatToParts(d).map((p) => [p.type, p.value]));
      expect(formatDate(iso, 'EEEE')).toBe(l.weekday);
      expect(formatDate(iso, 'MMMM')).toBe(l.month);
      expect(formatDate(iso, 'EEE')).toBe(s.weekday.slice(0, 3));
      expect(formatDate(iso, 'MMM')).toBe(s.month.slice(0, 3));
    }
  });

  it('numeric tokens and separators', () => {
    expect(formatDate('2026-03-05', 'yyyy-MM-dd')).toBe('2026-03-05');
    expect(formatDate('2026-03-05', 'd/M/yy')).toBe('5/3/26');
    expect(formatDate('2026-03-05', 'dd.MM.yyyy')).toBe('05.03.2026');
    expect(formatDate('2026-03-05', 'EEEE, d MMMM yyyy')).toBe('Thursday, 5 March 2026');
    expect(formatDate('1905-03-05', 'yy')).toBe('05');
  });
});
