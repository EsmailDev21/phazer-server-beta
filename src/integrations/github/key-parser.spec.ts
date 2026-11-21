import { MAX_REFS, extractTaskRefs } from './key-parser';

describe('extractTaskRefs', () => {
  const keys = (texts: Array<string | null | undefined>) => extractTaskRefs(texts).map((r) => `${r.key}-${r.number}`);

  it('finds keys in titles, branches, brackets, and upper-cases them', () => {
    expect(keys(['Fix login (ENG-123)'])).toEqual(['ENG-123']);
    expect(keys(['feature/eng-123-fix-login'])).toEqual(['ENG-123']);
    expect(keys(['[WEB-7] tidy', 'refs OPS-42, closes plat2-9.'])).toEqual(['WEB-7', 'OPS-42', 'PLAT2-9']);
  });

  it('dedupes across texts and keeps first-seen order', () => {
    expect(keys(['ENG-1 ENG-2', 'eng-1', 'ENG-3'])).toEqual(['ENG-1', 'ENG-2', 'ENG-3']);
  });

  it('does not take a key out of the middle of a longer word or number', () => {
    expect(keys(['XENG-1'])).toEqual(['XENG-1']); // that is key XENG, never ENG
    expect(keys(['ENG-12abc'])).toEqual([]);
    expect(keys(['ENG-1234567890'])).toEqual([]); // more than 9 digits
    expect(keys(['LONGERTHANTENCHARS-1'])).toEqual([]);
    expect(keys(['A-1'])).toEqual([]); // keys are at least 2 chars
  });

  it('rejects number 0 and ignores null/empty input', () => {
    expect(keys(['ENG-0', null, undefined, ''])).toEqual([]);
  });

  it('is generous about look-alikes (UTF-8): resolution inside the workspace is the real gate', () => {
    expect(keys(['encoding UTF-8 and SHA-256'])).toEqual(['UTF-8', 'SHA-256']);
  });

  it('caps the number of candidates (a hostile body cannot cause thousands of lookups)', () => {
    const body = Array.from({ length: 500 }, (_, i) => `AB-${i + 1}`).join(' ');
    expect(extractTaskRefs([body])).toHaveLength(MAX_REFS);
    expect(extractTaskRefs([body], 3)).toHaveLength(3);
  });
});
