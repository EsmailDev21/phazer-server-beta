import { ADF_CORPUS } from './corpus/adf.corpus';
import { HTML_CORPUS } from './corpus/html.corpus';
import { CorpusCase } from './corpus/corpus.types';
import { adfToMarkdown } from './adf';
import { htmlToMarkdown } from './html';
import { html as renderHtml } from './commonmark.helper';

/**
 * Step 4.2 "conversion corpus" (IMPLEMENTATION.md): fixed inputs -> exact markdown + warning codes, for both
 * converters. The expected values were reviewed by hand when the corpus was written; this spec is the regression net.
 */
const run = (kind: 'adf' | 'html', c: CorpusCase) =>
  kind === 'adf' ? adfToMarkdown(c.input) : htmlToMarkdown(c.input, c.options);

describe.each([
  ['adf', ADF_CORPUS, 40],
  ['html', HTML_CORPUS, 25],
] as const)('conversion corpus: %s', (kind, corpus, minCases) => {
  it(`has at least ${minCases} cases with unique names`, () => {
    expect(corpus.length).toBeGreaterThanOrEqual(minCases);
    expect(new Set(corpus.map((c) => c.name)).size).toBe(corpus.length);
  });

  it.each(corpus.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const r = run(kind, c);
    expect(r.markdown).toBe(c.markdown);
    expect([...new Set(r.warnings.map((w) => w.code))].sort()).toEqual(c.warnings);
  });

  it('every output is valid markdown that renders without any script, event handler or javascript: URL', () => {
    for (const c of corpus) {
      const out = renderHtml(run(kind, c).markdown);
      expect(out).not.toMatch(/<script|<iframe|<object|<embed|\son\w+=|javascript:|data:text/i);
    }
  });

  it('is deterministic: converting twice gives the same result', () => {
    for (const c of corpus) expect(run(kind, c)).toEqual(run(kind, c));
  });
});
