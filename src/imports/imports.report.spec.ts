import { csvCell, csvRow, parseTemplateTarget } from './imports.service';

describe('report CSV (step 4.9)', () => {
  it.each([['=1+1', `"'=1+1"`], ['+SUM(A1)', `"'+SUM(A1)"`], ['-2', `"'-2"`], ['@x', `"'@x"`], ['\tx', `"'\tx"`], ['\rx', `"'\rx"`], ['plain', '"plain"'], ['a=b', '"a=b"'], ['', '""']])('%j -> %s', (input, out) => expect(csvCell(input)).toBe(out));
  it('quotes are doubled, commas and newlines stay inside the quotes', () => {
    expect(csvCell('say "hi", ok\nnext')).toBe('"say ""hi"", ok\nnext"');
    expect(csvRow(['a', 'b,c', '=d'])).toBe(`"a","b,c","'=d"`);
  });
});

describe('parseTemplateTarget (step 4.9)', () => {
  it('nothing given: the default name, nothing else', () => expect(parseTemplateTarget(undefined, 'From source')).toEqual({ name: 'From source' }));
  it('keeps what is valid, trims the name', () => {
    expect(parseTemplateTarget({ name: '  My starter ', description: 'd', category: 'software-dev', includeComments: true, onSecret: 'redact' }, 'x')).toEqual({ name: 'My starter', description: 'd', category: 'software-dev', includeComments: true, onSecret: 'redact' });
  });
  it.each([
    [{ visibility: 'PUBLIC' }, /Unknown template setting/], [{ name: 'x'.repeat(121) }, /at most 120/], [{ category: 'Bad Cat' }, /category/], [{ onSecret: 'maybe' }, /onSecret/],
    [{ includeComments: 'yes' }, /includeComments/], [{ description: 5 }, /description/], [[], /object/], [{ name: '   ' }, /needs a name/],
  ])('refuses %j', (input, msg) => expect(() => parseTemplateTarget(input, 'x')).toThrow(msg));
  it('a template can never be made public through this path (no visibility setting exists)', () => {
    expect(() => parseTemplateTarget({ visibility: 'PUBLIC' }, 'x')).toThrow();
  });
});
