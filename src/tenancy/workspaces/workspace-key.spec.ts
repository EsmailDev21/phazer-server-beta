import { BadRequestException } from '@nestjs/common';
import {
  FALLBACK_KEY_BASE,
  WORKSPACE_KEY_PATTERN,
  formatTaskKey,
  generateKeyBase,
  normalizeWorkspaceKey,
  parseTaskKey,
  pickUniqueKey,
} from './workspace-key';

describe('normalizeWorkspaceKey', () => {
  it.each([
    ['ENG', 'ENG'],
    ['eng', 'ENG'],
    ['  Eng ', 'ENG'],
    ['PLAT2', 'PLAT2'],
    ['AB', 'AB'],
    ['ABCDEFGHIJ', 'ABCDEFGHIJ'], // exactly 10
  ])('%j -> %j', (raw, out) => expect(normalizeWorkspaceKey(raw)).toBe(out));

  it.each([
    '',
    'A',
    'ABCDEFGHIJK',
    '1AB',
    'AB-C',
    'A B',
    'ÄB',
    'AB_',
    'A\u0000',
  ])('rejects %j', (raw) =>
    expect(() => normalizeWorkspaceKey(raw)).toThrow(BadRequestException),
  );

  it('rejects non-strings', () => {
    expect(() => normalizeWorkspaceKey(undefined)).toThrow(BadRequestException);
    expect(() => normalizeWorkspaceKey(12)).toThrow(BadRequestException);
  });

  it('everything it returns satisfies the DB CHECK pattern', () => {
    for (const k of ['eng', 'Plat2', 'ab', 'zz9']) {
      expect(WORKSPACE_KEY_PATTERN.test(normalizeWorkspaceKey(k))).toBe(true);
    }
  });
});

describe('generateKeyBase', () => {
  it.each([
    ['Engineering', 'ENG'],
    ['My Team', 'MYT'],
    ['Café Ops', 'CAF'],
    ['Zoë', 'ZOE'],
    ['42 Labs', 'LAB'],
    ['a', FALLBACK_KEY_BASE],
    ['日本語', FALLBACK_KEY_BASE],
    ['123', FALLBACK_KEY_BASE],
    ['!!', FALLBACK_KEY_BASE],
    ['', FALLBACK_KEY_BASE],
    ['Go', 'GO'], // 2 usable characters is enough
    ['ＥＮＧ', 'ENG'], // full-width letters fold via NFKD
  ])('%j -> %j', (name, base) => expect(generateKeyBase(name)).toBe(base));

  it('always produces a valid key, whatever the name', () => {
    for (const n of [
      'x',
      '💥💥',
      '   ',
      '___',
      '9lives',
      'Ünï',
      'a'.repeat(500),
    ]) {
      expect(WORKSPACE_KEY_PATTERN.test(generateKeyBase(n))).toBe(true);
    }
  });
});

describe('pickUniqueKey', () => {
  it('uses the base when free', () => {
    expect(pickUniqueKey('Engineering', new Set())).toBe('ENG');
  });

  it('appends 2, 3, ... on collision, in order', () => {
    expect(pickUniqueKey('Engineering', new Set(['ENG']))).toBe('ENG2');
    expect(pickUniqueKey('Engineering', new Set(['ENG', 'ENG2']))).toBe('ENG3');
    expect(pickUniqueKey('Engineering', new Set(['ENG', 'ENG3']))).toBe('ENG2'); // first FREE one
  });

  it('is deterministic', () => {
    const taken = new Set(['ENG', 'ENG2']);
    expect(pickUniqueKey('Engineering', taken)).toBe(
      pickUniqueKey('Engineering', taken),
    );
  });

  it('never exceeds 10 characters, even with huge suffixes', () => {
    const taken = new Set<string>(['ENG']);
    for (let n = 2; n <= 12; n++) taken.add(`ENG${n}`);
    const k = pickUniqueKey('Engineering', taken);
    expect(k).toBe('ENG13');
    expect(WORKSPACE_KEY_PATTERN.test(k)).toBe(true);
  });

  it('two different names with the same base do not collide once the first is taken', () => {
    const taken = new Set<string>();
    for (const name of ['Engineering', 'Engine Room', 'Enggg']) {
      const k = pickUniqueKey(name, taken);
      expect(taken.has(k)).toBe(false);
      taken.add(k);
    }
    expect([...taken]).toEqual(['ENG', 'ENG2', 'ENG3']);
  });
});

describe('parseTaskKey', () => {
  it.each([
    ['ENG-123', { key: 'ENG', number: 123 }],
    ['eng-123', { key: 'ENG', number: 123 }],
    [' Plat2-7 ', { key: 'PLAT2', number: 7 }],
    ['AB-1', { key: 'AB', number: 1 }],
    ['ABCDEFGHIJ-999999999', { key: 'ABCDEFGHIJ', number: 999999999 }],
  ])('%j parses', (input, out) => expect(parseTaskKey(input)).toEqual(out));

  it.each([
    'ENG-0', // numbers start at 1
    'ENG-01', // no leading zeros: one spelling per task
    'ENG-',
    '-123',
    'ENG123',
    'E-1', // key too short
    'ENG-1234567890', // overflows int
    'ENG-12x',
    'xx ENG-12',
    'ENG-12 and more',
    'ENG--1',
    'ENG-1.5',
    'ENG-+1',
    'UTF-8x',
    'ABCDEFGHIJK-1', // key too long
    '',
  ])('rejects %j', (input) => expect(parseTaskKey(input)).toBeNull());

  it('round-trips with formatTaskKey', () => {
    expect(parseTaskKey(formatTaskKey('ENG', 42))).toEqual({
      key: 'ENG',
      number: 42,
    });
  });
});
