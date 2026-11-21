import { ImportJobStatus as S } from '@prisma/client';
import {
  CANCELABLE,
  IMPORT_TRANSITIONS,
  IllegalImportTransitionError,
  MAPPING_EDITABLE,
  PREVIEWABLE,
  RESUMABLE,
  ROLLBACKABLE,
  SELECTION_EDITABLE,
  assertTransition,
  canTransition,
  isActive,
  isFinished,
  isSetup,
} from './import-state-machine';

/**
 * The transition matrix, written out as a literal list that is NOT derived from the table under test.
 * Reading it against diagram 04 is the review; the test then walks all 13 x 13 pairs.
 */
const EXPECTED: ReadonlyArray<[S, S]> = [
  // setup
  [S.DRAFT, S.SOURCES_SELECTED],
  [S.SOURCES_SELECTED, S.SOURCES_SELECTED],
  [S.SOURCES_SELECTED, S.MAPPING],
  [S.SOURCES_SELECTED, S.PREVIEW_READY],
  [S.MAPPING, S.SOURCES_SELECTED],
  [S.MAPPING, S.MAPPING],
  [S.MAPPING, S.PREVIEW_READY],
  [S.PREVIEW_READY, S.SOURCES_SELECTED],
  [S.PREVIEW_READY, S.MAPPING],
  [S.PREVIEW_READY, S.PREVIEW_READY],
  [S.PREVIEW_READY, S.QUEUED],
  // run
  [S.QUEUED, S.RUNNING],
  [S.QUEUED, S.CANCELED],
  [S.RUNNING, S.QUEUED],
  [S.RUNNING, S.PAUSED],
  [S.RUNNING, S.COMPLETED],
  [S.RUNNING, S.COMPLETED_WITH_WARNINGS],
  [S.RUNNING, S.FAILED],
  [S.RUNNING, S.CANCELED],
  [S.PAUSED, S.RUNNING],
  [S.PAUSED, S.QUEUED],
  [S.PAUSED, S.CANCELED],
  // finished
  [S.COMPLETED, S.ROLLING_BACK],
  [S.COMPLETED_WITH_WARNINGS, S.ROLLING_BACK],
  [S.FAILED, S.QUEUED],
  [S.FAILED, S.ROLLING_BACK],
  [S.CANCELED, S.ROLLING_BACK],
  // rollback
  [S.ROLLING_BACK, S.ROLLED_BACK],
  [S.ROLLING_BACK, S.ROLLING_BACK],
];

const ALL = Object.values(S) as S[];

describe('import state machine (step 4.1)', () => {
  it('covers every status', () => {
    expect(ALL).toHaveLength(13);
    expect(Object.keys(IMPORT_TRANSITIONS).sort()).toEqual([...ALL].sort());
  });

  it('allows exactly the expected edges: all 13 x 13 pairs', () => {
    const allowed = new Set(EXPECTED.map(([a, b]) => `${a}>${b}`));
    expect(allowed.size).toBe(EXPECTED.length); // no duplicates in the literal list
    const wrong: string[] = [];
    for (const from of ALL) {
      for (const to of ALL) {
        const want = allowed.has(`${from}>${to}`);
        if (canTransition(from, to) !== want) wrong.push(`${from} -> ${to} (want ${want})`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('ROLLED_BACK is final; nothing leaves it', () => {
    for (const to of ALL) expect(canTransition(S.ROLLED_BACK, to)).toBe(false);
  });

  it('a finished import can only be rolled back (or, for FAILED, resumed): it never silently restarts or "un-completes"', () => {
    for (const from of [S.COMPLETED, S.COMPLETED_WITH_WARNINGS, S.CANCELED]) {
      expect(IMPORT_TRANSITIONS[from]).toEqual([S.ROLLING_BACK]);
    }
    expect([...IMPORT_TRANSITIONS[S.FAILED]].sort()).toEqual([S.QUEUED, S.ROLLING_BACK].sort());
  });

  it('nothing but a preview can reach QUEUED from setup; a running import cannot be rolled back mid-flight', () => {
    for (const from of [S.DRAFT, S.SOURCES_SELECTED, S.MAPPING]) expect(canTransition(from, S.QUEUED)).toBe(false);
    for (const from of [S.QUEUED, S.RUNNING, S.PAUSED]) expect(canTransition(from, S.ROLLING_BACK)).toBe(false);
  });

  it('assertTransition throws a typed error naming both statuses', () => {
    expect(() => assertTransition(S.DRAFT, S.QUEUED)).toThrow(IllegalImportTransitionError);
    expect(() => assertTransition(S.DRAFT, S.QUEUED)).toThrow('DRAFT cannot move to QUEUED');
    expect(() => assertTransition(S.PREVIEW_READY, S.QUEUED)).not.toThrow();
  });

  describe('the allowed-from lists ImportsService uses are legal edges', () => {
    const edge = (list: readonly S[], to: S) => list.filter((from) => !canTransition(from, to));
    it('selection edits -> SOURCES_SELECTED', () => expect(edge(SELECTION_EDITABLE, S.SOURCES_SELECTED)).toEqual([]));
    it('mapping edits -> MAPPING', () => expect(edge(MAPPING_EDITABLE, S.MAPPING)).toEqual([]));
    it('preview -> PREVIEW_READY', () => expect(edge(PREVIEWABLE, S.PREVIEW_READY)).toEqual([]));
    it('cancel -> CANCELED', () => expect(edge(CANCELABLE, S.CANCELED)).toEqual([]));
    it('resume -> QUEUED', () => expect(edge(RESUMABLE, S.QUEUED)).toEqual([]));
    it('rollback -> ROLLING_BACK', () => expect(edge([...ROLLBACKABLE, S.ROLLING_BACK], S.ROLLING_BACK)).toEqual([]));
    it('start: PREVIEW_READY -> QUEUED', () => expect(canTransition(S.PREVIEW_READY, S.QUEUED)).toBe(true));
  });

  describe('predicates partition the statuses sensibly', () => {
    it('setup / active / finished never overlap, and ROLLING_BACK counts as active', () => {
      for (const s of ALL) {
        const n = [isSetup(s), isActive(s), isFinished(s)].filter(Boolean).length;
        expect(n).toBeLessThanOrEqual(1);
      }
      expect(isActive(S.ROLLING_BACK)).toBe(true);
      expect(isFinished(S.ROLLED_BACK)).toBe(true);
      expect(isSetup(S.PREVIEW_READY)).toBe(true);
      expect(isSetup(S.QUEUED)).toBe(false);
    });
    it('every status is setup, active or finished', () => {
      for (const s of ALL) expect(isSetup(s) || isActive(s) || isFinished(s)).toBe(true);
    });
  });
});
