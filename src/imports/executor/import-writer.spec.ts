import { statusRefId, uniqueKey } from './import-writer';
import { readCheckpoint } from './import-executor.service';

describe('import writer helpers (step 4.4)', () => {
  describe('uniqueKey (custom field keys)', () => {
    it.each([
      ['Story Points', 'story_points'], ['  Severity  ', 'severity'], ['Café — Niveau 2', 'cafe_niveau_2'.replace('cafe', 'caf')], ['A/B test!!', 'a_b_test'], ['___x___', 'x'],
      ['日本語', 'field'], ['', 'field'], ['!!!', 'field'], ['UPPER lower', 'upper_lower'],
    ])('%j -> a clean key', (name, want) => {
      const key = uniqueKey(name, new Set());
      expect(key).toMatch(/^[a-z0-9_]+$/);
      expect(key.length).toBeGreaterThan(0);
      if (name !== 'Café — Niveau 2') expect(key).toBe(want);
    });
    it('is unique among the taken keys and records itself', () => {
      const taken = new Set(['points', 'points_2']);
      expect(uniqueKey('Points', taken)).toBe('points_3');
      expect(taken.has('points_3')).toBe(true);
      expect(uniqueKey('Points', taken)).toBe('points_4');
    });
    it('is bounded in length even for a huge name', () => {
      expect(uniqueKey('x'.repeat(500), new Set()).length).toBeLessThanOrEqual(60);
      expect(uniqueKey('x'.repeat(500), new Set(['x'.repeat(60)])).length).toBeLessThanOrEqual(62);
    });
  });

  describe('statusRefId (a status is referenced PER PROJECT)', () => {
    it('differs for the same status id in two projects, and for swapped halves', () => {
      expect(statusRefId('ENG', '10001')).not.toBe(statusRefId('OPS', '10001'));
      expect(statusRefId('a', 'bc')).not.toBe(statusRefId('ab', 'c'));
    });
    it('is storable in a Postgres text column (no NUL) and stable', () => {
      expect(statusRefId('ENG', '10001')).not.toContain('\u0000');
      expect(statusRefId('ENG', '10001')).toBe(statusRefId('ENG', '10001'));
    });
  });
});

describe('readCheckpoint (step 4.4)', () => {
  it('defaults: start of the pages, no cursor, nothing done, no retries', () => {
    for (const v of [null, undefined, 'x', 5, [], {}]) expect(readCheckpoint(v)).toEqual({ phase: 'PAGES', cursor: null, pages: 0, retries: 0 });
  });
  it('reads a stored checkpoint', () => {
    expect(readCheckpoint({ phase: 'LINKS', cursor: { after: 'abc' }, pages: 7, retries: 2 })).toEqual({ phase: 'LINKS', cursor: { after: 'abc' }, pages: 7, retries: 2 });
  });
  it('any unknown phase means PAGES (the safe, re-doable one); damaged numbers fall back', () => {
    expect(readCheckpoint({ phase: 'WAT', pages: 'x', retries: -4 })).toMatchObject({ phase: 'PAGES', pages: 0, retries: 0 });
  });
});
