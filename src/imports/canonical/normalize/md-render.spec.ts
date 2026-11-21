import { Block, Inline } from './md-model';
import { encodeUrl, escapeText, renderInlines, renderMarkdown } from './md-render';
import { destinations, nodeTypes, topLevel, visibleText, html } from './commonmark.helper';

const t = (text: string, marks: Array<'strong' | 'em' | 'strike'> = []): Inline => ({ t: 'text', text, marks });
const para = (...inlines: Inline[]): Block => ({ t: 'p', inlines });

/** Deterministic PRNG so a failure reproduces. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

describe('markdown renderer (step 4.2)', () => {
  describe('source text stays literal text (CommonMark reference parser)', () => {
    const ALPHABET = ['\\', '`', '*', '_', '[', ']', '(', ')', '<', '>', '#', '-', '+', '=', '~', '|', '!', '&', ';', ':', '.', '1', '2', 'a', 'b', ' ', ' ', '"', "'", '/', '$', '{', '}', '^', '0', '9', 'x'];

    it('4000 random strings of markdown-special characters come back as ONE paragraph with the exact same text', () => {
      const rnd = mulberry32(42);
      const bad: string[] = [];
      for (let i = 0; i < 4000; i++) {
        const len = 1 + Math.floor(rnd() * 14);
        const s = Array.from({ length: len }, () => ALPHABET[Math.floor(rnd() * ALPHABET.length)]).join('').trim();
        if (s === '') continue;
        const md = renderMarkdown([para(t(s))]);
        const ok = topLevel(md).join() === 'paragraph' && visibleText(md) === s && nodeTypes(md).size <= 3; // document, paragraph, text
        if (!ok) bad.push(JSON.stringify({ s, md, got: visibleText(md), top: topLevel(md) }));
        if (bad.length >= 5) break;
      }
      expect(bad).toEqual([]);
    });

    it.each([
      '# heading', '## h', '- item', '+ item', '* item', '1. one', '2) two', '> quote', '=== ', '---', '___', '***', '~~~', '```', '    four spaces',
      '[ref]: http://x', '![img](http://x)', '<script>alert(1)</script>', '<http://auto.link>', '&amp; &#35; &copy;', '| a | b |', '\\*not bold\\*', 'a  b', '1.', '-', '+',
    ])('%j', (s) => {
      const text = s.trim();
      const md = renderMarkdown([para(t(text))]);
      expect(topLevel(md)).toEqual(['paragraph']);
      expect(visibleText(md)).toBe(text);
    });

    it('a hard break followed by a line-start special does not start a list / heading', () => {
      const md = renderMarkdown([para(t('first'), { t: 'br' }, t('# not a heading'), { t: 'br' }, t('1. nor a list'))]);
      expect(topLevel(md)).toEqual(['paragraph']);
      expect(visibleText(md)).toBe('first\n# not a heading\n1. nor a list');
    });

    it('"wow!" before a link is not read as an image', () => {
      const md = renderMarkdown([para(t('wow!'), { t: 'link', href: 'https://x.com', children: [t('here')] })]);
      expect(nodeTypes(md).has('image')).toBe(false);
      expect(nodeTypes(md).has('link')).toBe(true);
      expect(visibleText(md)).toBe('wow!here');
    });

    it('escapeText leaves ordinary prose alone', () => {
      expect(escapeText('Fix the login bug (see #42) - thanks, Ana.')).toBe('Fix the login bug (see #42) - thanks, Ana.');
    });
  });

  describe('code', () => {
    it.each(['plain', 'a`b', '``', '`start', 'end`', '  ', 'two  spaces', ' pad ', 'a ``` b'])('inline code %j keeps its exact text', (code) => {
      const md = renderMarkdown([para({ t: 'code', text: code })]);
      // CommonMark strips ONE leading+trailing space when both exist and the span is not all spaces; our padding adds exactly that.
      expect(visibleText(md)).toBe(code);
      expect(topLevel(md)).toEqual(['paragraph']);
    });

    it('a code block uses a fence longer than any backtick run inside it', () => {
      const md = renderMarkdown([{ t: 'code', lang: 'md', text: 'a\n```\nb\n````\nc' }]);
      expect(topLevel(md)).toEqual(['code_block']);
      expect(visibleText(md)).toBe('a\n```\nb\n````\nc\n');
      expect(md.startsWith('`````md\n')).toBe(true);
    });

    it('code keeps its trailing blanks and runs of blank lines; prose around it does not', () => {
      const md = renderMarkdown([para(t('a')), { t: 'code', lang: '', text: 'x  \n\n\n\ny\t' }, para(t('b'))]);
      expect(md).toBe('a\n\n```\nx  \n\n\n\ny\t\n```\n\nb');
    });
    it('the same holds for code inside a list item and a block quote', () => {
      const code: Block = { t: 'code', lang: '', text: 'q  \n\n\nr' };
      expect(renderMarkdown([{ t: 'ul', items: [[code]] }])).toBe('- ```\n  q  \n\n\n  r\n  ```');
      expect(renderMarkdown([{ t: 'quote', blocks: [code] }])).toBe('> ```\n> q  \n>\n>\n> r\n> ```');
    });
    it('an info string that is not a plain identifier is dropped (it could carry markdown)', () => {
      const md = renderMarkdown([{ t: 'code', lang: 'js\n# pwn', text: 'x' }]);
      expect(md).toBe('```\nx\n```');
    });
  });

  describe('links and images', () => {
    it('URLs with spaces and parentheses survive intact (percent-encoded, never ending the link early)', () => {
      const u = 'https://example.com/a b/(c)?d=1&e=<f>';
      const md = renderMarkdown([para({ t: 'link', href: u, children: [t('x')] })]);
      expect(destinations(md)).toEqual([encodeUrl(u)]);
      expect(decodeURIComponent(destinations(md)[0])).toBe(u);
    });

    it('blanks at the edges of a link label move outside the link', () => {
      expect(renderMarkdown([para(t('see'), { t: 'link', href: 'https://x.com', children: [t(' docs ')] }, t('now'))])).toBe('see [docs](https://x.com) now');
    });

    it('an empty label falls back to the address', () => {
      expect(renderMarkdown([para({ t: 'link', href: 'https://x.com', children: [] })])).toBe('[https://x.com](https://x.com)');
    });

    it('image alt text cannot close the image early', () => {
      const md = renderMarkdown([para({ t: 'image', alt: 'a ](http://evil) b', src: 'https://x.com/i.png' })]);
      expect(destinations(md)).toEqual(['https://x.com/i.png']);
    });
  });

  describe('emphasis', () => {
    it('delimiters hug the words; blanks go outside', () => {
      expect(renderInlines([t('x'), t(' bold ', ['strong']), t('y')])).toBe('x **bold** y');
    });
    it('adjacent runs with the same marks merge', () => {
      expect(renderInlines([t('a', ['strong']), t('b', ['strong'])])).toBe('**ab**');
    });
    it('strong + em on one run nest', () => {
      expect(renderInlines([t('x', ['strong', 'em'])])).toBe('***x***');
    });
    it('a strong run touching an em run uses `_` for the em, and a CommonMark parser reads them as separate runs', () => {
      const md = renderInlines([t('a', ['strong']), t('b', ['em']), t('c', ['strong'])]);
      expect(md).toBe('**a**_b_**c**');
      expect(html(md).trim()).toBe('<p><strong>a</strong><em>b</em><strong>c</strong></p>');
    });
    it('strikethrough', () => {
      expect(renderInlines([t('gone', ['strike'])])).toBe('~~gone~~');
    });
    it('whitespace-only marked text stays plain', () => {
      expect(renderInlines([t('a'), t('  ', ['strong']), t('b')])).toBe('a  b');
    });
  });

  describe('blocks', () => {
    it('lists nest by marker width and keep multi-paragraph items together', () => {
      const md = renderMarkdown([
        { t: 'ul', items: [[para(t('a')), { t: 'ol', start: 9, items: [[para(t('n'))], [para(t('m'))]] }], [para(t('b')), para(t('b2'))]] },
      ]);
      expect(md).toBe('- a\n  9. n\n  10. m\n- b\n\n  b2');
      expect(topLevel(md)).toEqual(['list']);
    });
    it('task items', () => {
      expect(renderMarkdown([{ t: 'ul', items: [[para(t('x'))], [para(t('y'))], [para(t('z'))]], checked: [true, false, null] }])).toBe('- [x] x\n- [ ] y\n- z');
    });
    it('block quotes prefix every line, blank ones too', () => {
      expect(renderMarkdown([{ t: 'quote', blocks: [para(t('a')), para(t('b'))] }])).toBe('> a\n>\n> b');
    });
    it('headings clamp to 1..6 and flatten line breaks', () => {
      expect(renderMarkdown([{ t: 'h', level: 9, inlines: [t('a'), { t: 'br' }, t('b')] }])).toBe('###### a b');
      expect(renderMarkdown([{ t: 'h', level: 0, inlines: [t('a')] }])).toBe('# a');
    });
    it('tables pad ragged rows, escape pipes and keep line breaks as <br>', () => {
      const md = renderMarkdown([{ t: 'table', rows: [[[t('A')], [t('B')]], [[t('a|b')], [t('1'), { t: 'br' }, t('2')]], [[t('only')]]] }]);
      expect(md).toBe('| A | B |\n| --- | --- |\n| a\\|b | 1<br>2 |\n| only |  |');
    });
    it('empty blocks vanish; control characters are stripped from the output', () => {
      expect(renderMarkdown([para(), { t: 'quote', blocks: [] }, para(t('a\u0000b\u0007'))])).toBe('ab');
    });
    it('pathologically deep nesting terminates (depth ceiling)', () => {
      let b: Block = para(t('deep'));
      for (let i = 0; i < 500; i++) b = { t: 'quote', blocks: [b] };
      expect(() => renderMarkdown([b])).not.toThrow();
    });
  });
});
