import { badTextReason } from '../../templates/blueprint/blueprint.json-guard';
import {
  TRUNCATION_MARKER,
  cleanText,
  hexColor,
  httpUrl,
  needsCleaning,
  oneLine,
  parseInstant,
  safeFileName,
  truncateLine,
  truncateMarkdown,
} from './canonical.text';

describe('canonical text helpers (step 4.2)', () => {
  describe('cleanText stays in step with the Blueprint guard that only detects', () => {
    const SAMPLES = ['plain', 'tab\tnewline\ncr\r ok', 'nul\u0000x', 'bell\u0007', 'c1\u0085', 'del\u007f', 'lone\ud800high', 'lone\udc00low', 'pair 😀 ok', '\u200bzwsp', 'a\u2028b', 'x\u0000\ud800\u0001y'];
    it.each(SAMPLES.map((s) => [s]))('%j', (s) => {
      expect(badTextReason(cleanText(s))).toBeNull(); // what we repair is exactly what the guard rejects
      expect(needsCleaning(s)).toBe(badTextReason(s) !== null);
    });
    it('keeps tab, newline, carriage return, emoji and valid pairs', () => {
      expect(cleanText('a\tb\nc\r😀')).toBe('a\tb\nc\r😀');
    });
    it('is a no-op (same string) for clean text', () => {
      const s = 'nothing to do';
      expect(cleanText(s)).toBe(s);
    });
  });

  describe('oneLine / truncateLine', () => {
    it('collapses every kind of blank, including NBSP and newlines', () => {
      expect(oneLine('  a \n\t b\u00a0 c  ')).toBe('a b c');
    });
    it('cuts to the limit with an ellipsis, never splits an emoji, never exceeds max', () => {
      expect(truncateLine('abcdef', 6)).toBe('abcdef');
      expect(truncateLine('abcdefg', 6)).toBe('abcde…');
      const s = truncateLine('x'.repeat(4) + '😀😀😀', 6); // 4 + 2 units per emoji
      expect(s.length).toBeLessThanOrEqual(6);
      expect(badTextReason(s)).toBeNull();
      expect(truncateLine('a'.repeat(50), 1)).toBe('…');
    });
  });

  describe('truncateMarkdown', () => {
    it('leaves short text alone', () => {
      expect(truncateMarkdown('short', 100)).toBe('short');
    });
    it('cuts at a line boundary, appends the visible marker and stays within max', () => {
      const text = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
      const out = truncateMarkdown(text, 500);
      expect(out.length).toBeLessThanOrEqual(500);
      expect(out.endsWith(TRUNCATION_MARKER)).toBe(true);
      expect(out.slice(0, -TRUNCATION_MARKER.length)).toMatch(/line \d+$/); // no half line
    });
    it('closes a code fence it cut inside', () => {
      const text = 'intro\n```js\n' + 'let x = 1;\n'.repeat(500) + '```\nafter';
      const out = truncateMarkdown(text, 300);
      expect(out.length).toBeLessThanOrEqual(300);
      expect((out.match(/^```/gm) ?? []).length % 2).toBe(0);
    });
    it('does not split a surrogate pair', () => {
      const out = truncateMarkdown('😀'.repeat(500), 101);
      expect(badTextReason(out)).toBeNull();
      expect(out.length).toBeLessThanOrEqual(101);
    });
  });

  describe('parseInstant', () => {
    it.each([
      ['2026-03-04', '2026-03-04T00:00:00.000Z'],
      ['2026-03-04T10:20:30Z', '2026-03-04T10:20:30.000Z'],
      ['2026-03-04T10:20:30.5Z', '2026-03-04T10:20:30.500Z'],
      ['2026-03-04T10:20:30.123456789Z', '2026-03-04T10:20:30.123Z'],
      ['2026-03-04T10:20:30+02:00', '2026-03-04T08:20:30.000Z'],
      ['2026-03-04T10:20:30-0530', '2026-03-04T15:50:30.000Z'],
      ['2026-03-04T10:20', '2026-03-04T10:20:00.000Z'],
      ['2026-03-04 10:20:30', '2026-03-04T10:20:30.000Z'],
      ['2026-03-04t10:20:30z', '2026-03-04T10:20:30.000Z'],
      ['  2026-03-04  ', '2026-03-04T00:00:00.000Z'],
      ['2026-12-31T23:30:00-01:00', '2027-01-01T00:30:00.000Z'],
      ['2024-02-29', '2024-02-29T00:00:00.000Z'],
    ])('%j -> %j', (inp, out) => expect(parseInstant(inp)).toBe(out));

    it.each([
      ['03/04/2026'], ['2026-3-4'], ['2026-02-30'], ['2025-02-29'], ['2026-13-01'], ['2026-00-10'], ['2026-04-31'], ['2026-03-04T24:00:00Z'],
      ['2026-03-04T10:60:00Z'], ['2026-03-04T10:20:30+25:00'], ['0001-01-01'], ['9999-12-31'], ['1969-12-31'], ['2101-01-01'],
      [''], ['not a date'], ['2026-03-04T10:20:30 UTC'], [null], [undefined], [20260304], [{}], [['2026-03-04']],
    ])('rejects %j', (v) => expect(parseInstant(v)).toBeNull());

    it('output always matches the canonical pattern', () => {
      expect(parseInstant('2026-03-04T10:20:30+02:00')).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });
  });

  describe('httpUrl / hexColor / safeFileName', () => {
    it('http(s) only; control characters removed before judging; bounded', () => {
      expect(httpUrl('https://x.com/a')).toBe('https://x.com/a');
      expect(httpUrl('  http://x.com ')).toBe('http://x.com');
      for (const bad of ['javascript:alert(1)', 'java\tscript:alert(1)', 'ftp://x.com', '//x.com', '/rel', 'mailto:a@b.c', 'https://', 'https://' + 'a'.repeat(2100), '', null, 5]) {
        expect(httpUrl(bad)).toBeNull();
      }
    });
    it('hex colors only', () => {
      expect(hexColor('#aBc123')).toBe('#aBc123');
      for (const bad of ['red', '#abc', '#12345g', 'abc123', null, 7]) expect(hexColor(bad)).toBeNull();
    });
    it.each([
      ['report.pdf', 'report.pdf'],
      ['../../etc/passwd', '.._.._etc_passwd'.replace(/^\.+/, (d) => '_'.repeat(d.length))],
      ['C:\\Users\\x\\a.txt', 'C:_Users_x_a.txt'],
      ['.htaccess', '_htaccess'],
      ['..', '__'],
      ['  spaced   name.txt ', 'spaced name.txt'],
      ['nul\u0000byte.txt', 'nulbyte.txt'],
      ['', 'attachment'],
      ['   ', 'attachment'],
    ])('safeFileName(%j) = %j', (inp, out) => expect(safeFileName(inp, 255)).toBe(out));
    it('a too-long name is cut but keeps its extension', () => {
      const n = safeFileName('a'.repeat(400) + '.png', 255);
      expect(n).toHaveLength(255);
      expect(n.endsWith('.png')).toBe(true);
      expect(safeFileName('b'.repeat(400), 100)).toHaveLength(100);
    });
  });
});
