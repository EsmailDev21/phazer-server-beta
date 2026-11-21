import { ADF_LIMITS, adfToMarkdown } from './adf';

const doc = (...content: unknown[]) => ({ type: 'doc', version: 1, content });
const p = (...content: unknown[]) => ({ type: 'paragraph', content });
const tx = (text: string, marks?: unknown[]) => ({ type: 'text', text, ...(marks ? { marks } : {}) });
const codes = (r: { warnings: Array<{ code: string }> }) => r.warnings.map((w) => w.code);

function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

describe('adfToMarkdown (step 4.2)', () => {
  describe('input handling', () => {
    it('accepts the document as an object or as JSON text, with the same result', () => {
      const d = doc(p(tx('Hi '), tx('there', [{ type: 'strong' }])));
      expect(adfToMarkdown(JSON.stringify(d))).toEqual(adfToMarkdown(d));
      expect(adfToMarkdown(d).markdown).toBe('Hi **there**');
    });
    it('null / undefined (an empty field) is an empty result WITHOUT a warning', () => {
      expect(adfToMarkdown(null)).toEqual({ markdown: '', warnings: [] });
      expect(adfToMarkdown(undefined)).toEqual({ markdown: '', warnings: [] });
    });
    it.each([['not json'], ['{"type":"paragraph"}'], [42], [[]], [{}], [{ type: 'doc' }], [{ type: 'doc', content: 'x' }]])(
      '%j is ADF_INVALID, never an exception',
      (v) => {
        const r = adfToMarkdown(v);
        expect(r.markdown).toBe('');
        expect(codes(r)).toEqual(['ADF_INVALID']);
      },
    );
    it('JSON text over the byte ceiling is refused before parsing', () => {
      const r = adfToMarkdown(' '.repeat(ADF_LIMITS.maxInputBytes + 1));
      expect(codes(r)).toEqual(['ADF_INVALID']);
    });
  });

  describe('bounds', () => {
    it('stops at the node ceiling, keeps what it had, and says so', () => {
      const big = doc(...Array.from({ length: ADF_LIMITS.maxNodes }, () => p(tx('x'))));
      const r = adfToMarkdown(big);
      expect(codes(r)).toContain('ADF_TOO_COMPLEX');
      expect(r.markdown.startsWith('x\n\nx')).toBe(true);
    });
    it('stops at the depth ceiling; a 20 000-level document does not overflow the stack', () => {
      let node: Record<string, unknown> = p(tx('bottom'));
      for (let i = 0; i < 20_000; i++) node = { type: 'blockquote', content: [node] };
      const r = adfToMarkdown(doc(node));
      expect(codes(r)).toContain('ADF_TOO_COMPLEX');
      expect(r.markdown).not.toContain('bottom');
    });
    it('cuts the output at the size ceiling', () => {
      const r = adfToMarkdown(doc(p(tx('a'.repeat(ADF_LIMITS.maxOutputChars + 500)))));
      expect(r.markdown).toHaveLength(ADF_LIMITS.maxOutputChars);
      expect(codes(r)).toContain('OUTPUT_TRUNCATED');
    });
    it('reports each kind of loss once, not once per occurrence', () => {
      const r = adfToMarkdown(doc(...Array.from({ length: 200 }, () => ({ type: 'futureNode', content: [p(tx('x'))] }))));
      expect(codes(r)).toEqual(['ADF_UNSUPPORTED_NODE']);
    });
  });

  describe('links: only http(s), mailto and tel survive', () => {
    const href = (h: unknown) => adfToMarkdown(doc(p(tx('t', [{ type: 'link', attrs: { href: h } }]))));
    it.each([
      ['https://example.com/a', '[t](https://example.com/a)'],
      ['http://example.com', '[t](http://example.com)'],
      ['HTTPS://EXAMPLE.COM', '[t](HTTPS://EXAMPLE.COM)'],
      ['mailto:a@b.co', '[t](mailto:a@b.co)'],
      ['tel:+15551234', '[t](tel:+15551234)'],
      ['  https://example.com  ', '[t](https://example.com)'],
    ])('keeps %j', (h, md) => expect(href(h).markdown).toBe(md));
    it.each([
      ['javascript:alert(1)'], ['JaVaScRiPt:alert(1)'], ['java\tscript:alert(1)'], ['java\nscript:alert(1)'], ['\u0001javascript:alert(1)'],
      [' javascript:alert(1)'], ['data:text/html,<script>1</script>'], ['vbscript:x'], ['file:///etc/passwd'], ['//evil.com/x'], ['/relative'], ['ftp://x.com'],
      [''], [null], [123], [{ a: 1 }], ['https://' + 'a'.repeat(2100)],
    ])('drops %j (the text stays, the link goes, and it is reported)', (h) => {
      const r = href(h);
      expect(r.markdown).toBe('t');
      expect(codes(r)).toEqual(['ADF_LINK_DROPPED']);
    });
    it('a hostile link inside a smart card is dropped too', () => {
      const r = adfToMarkdown(doc({ type: 'blockCard', attrs: { url: 'javascript:alert(1)' } }));
      expect(r.markdown).toBe('');
      expect(codes(r)).toEqual(['ADF_LINK_DROPPED']);
    });
    it('an external image needs an http(s) address', () => {
      const m = (url: string) => adfToMarkdown(doc({ type: 'mediaSingle', content: [{ type: 'media', attrs: { type: 'external', url, alt: 'a' } }] }));
      expect(m('https://x.com/i.png').markdown).toBe('![a](https://x.com/i.png)');
      expect(m('data:image/svg+xml,<svg onload=alert(1)>').markdown).toBe('');
      expect(codes(m('javascript:1'))).toEqual(['ADF_MEDIA_DROPPED']);
    });
  });

  describe('attachments', () => {
    it('a file reference becomes the attachment: token step 4.6 swaps for the copied file, and is not a clickable web link', () => {
      const r = adfToMarkdown(doc({ type: 'mediaSingle', content: [{ type: 'media', attrs: { id: 'abc-123', type: 'file', alt: 'shot.png' } }] }));
      expect(r.markdown).toBe('[shot.png](attachment:abc-123)');
      expect(codes(r)).toEqual(['ADF_MEDIA_PLACEHOLDER']);
    });
    it('a file without an id is dropped silently (nothing to look up later)', () => {
      expect(adfToMarkdown(doc({ type: 'mediaSingle', content: [{ type: 'media', attrs: { type: 'file' } }] })).markdown).toBe('');
    });
  });

  describe('odd attribute values never throw', () => {
    it.each([
      [{ type: 'heading', attrs: { level: 'x' }, content: [tx('a')] }],
      [{ type: 'heading', attrs: { level: -3 }, content: [tx('a')] }],
      [{ type: 'orderedList', attrs: { order: 'a' }, content: [{ type: 'listItem', content: [p(tx('a'))] }] }],
      [{ type: 'orderedList', attrs: { order: 1e300 }, content: [{ type: 'listItem', content: [p(tx('a'))] }] }],
      [p({ type: 'date', attrs: { timestamp: 'garbage' } })],
      [p({ type: 'date', attrs: { timestamp: '99999999999999999' } })],
      [p({ type: 'mention', attrs: null })],
      [p({ type: 'emoji' })],
      [p({ type: 'text', text: 42 })],
      [p({ type: 'text', text: 'x', marks: 'bold' })],
      [{ type: 'codeBlock', attrs: { language: { x: 1 } }, content: [{ type: 'text', text: 5 }] }],
      [{ type: 'table', content: [{ type: 'tableRow', content: [] }, 'oops', null, 7] }],
      [{ type: 'bulletList', content: [null, 3, 'x', { type: 'listItem' }] }],
    ])('%j', (block) => {
      expect(() => adfToMarkdown(doc(block))).not.toThrow();
    });
    it('a date outside a sane range renders as nothing rather than a nonsense year', () => {
      expect(adfToMarkdown(doc(p(tx('d: '), { type: 'date', attrs: { timestamp: '99999999999999999' } }))).markdown).toBe('d:');
    });
  });

  it('fuzz: 2000 random documents never throw, never emit control characters or a javascript: link', () => {
    const rnd = mulberry32(7);
    const types = ['paragraph', 'text', 'heading', 'bulletList', 'orderedList', 'listItem', 'taskList', 'taskItem', 'table', 'tableRow', 'tableCell', 'tableHeader', 'blockquote', 'codeBlock', 'panel', 'expand', 'media', 'mediaSingle', 'mention', 'emoji', 'status', 'date', 'inlineCard', 'blockCard', 'rule', 'hardBreak', 'layoutSection', 'extension', 'nope', '', 5, null];
    const markTypes = ['strong', 'em', 'strike', 'code', 'link', 'underline', 'nope', null];
    const hrefs = ['javascript:alert(1)', 'https://ok.com', 'data:x', 5, null, 'java\tscript:1'];
    const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)];
    const gen = (d: number): unknown => {
      const n: Record<string, unknown> = { type: pick(types) };
      if (rnd() < 0.5) n.text = pick(['a', '# x', '**', '', 'ctl\u0000x', 12, null]);
      if (rnd() < 0.4) n.attrs = { level: pick([1, 9, 'x', null]), href: pick(hrefs), url: pick(hrefs), id: pick(['1', 2, null]), type: pick(['file', 'external', null]), language: pick(['js', 'a\nb', null]), timestamp: pick(['1700000000000', 'x', 9e99]), state: pick(['DONE', 'TODO', null]) };
      if (rnd() < 0.3) n.marks = Array.from({ length: Math.floor(rnd() * 3) }, () => ({ type: pick(markTypes), attrs: { href: pick(hrefs) } }));
      if (d > 0 && rnd() < 0.7) n.content = Array.from({ length: Math.floor(rnd() * 4) }, () => (rnd() < 0.05 ? pick([null, 3, 'x']) : gen(d - 1)));
      return n;
    };
    for (let i = 0; i < 2000; i++) {
      const r = adfToMarkdown({ type: 'doc', version: 1, content: [gen(4), gen(4)] });
      expect(typeof r.markdown).toBe('string');
      // eslint-disable-next-line no-control-regex
      expect(r.markdown).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/);
      expect(r.markdown).not.toMatch(/\]\((?:javascript|data|vbscript):/i);
    }
  });
});
