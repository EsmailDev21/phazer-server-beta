import { HTML_LIMITS, htmlToMarkdown } from './html';

const codes = (r: { warnings: Array<{ code: string }> }) => r.warnings.map((w) => w.code);
const md = (h: string, o?: { baseUrl?: string }) => htmlToMarkdown(h, o).markdown;

function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

describe('htmlToMarkdown (step 4.2)', () => {
  describe('input handling', () => {
    it.each([[null], [undefined], [''], ['   \n'], [42], [{}], [[]]])('%j is an empty result with no warning', (v) => {
      expect(htmlToMarkdown(v)).toEqual({ markdown: '', warnings: [] });
    });
    it('text without tags passes through (escaped as text)', () => {
      expect(md('a * b')).toBe('a \\* b');
    });
    it('input over the byte ceiling is refused', () => {
      const r = htmlToMarkdown('<p>' + 'a'.repeat(HTML_LIMITS.maxInputBytes) + '</p>');
      expect(r.markdown).toBe('');
      expect(codes(r)).toEqual(['HTML_TOO_LARGE']);
    });
  });

  describe('hostile markup: nothing executable or leaking survives', () => {
    const PAYLOADS = [
      '<img src=x onerror=alert(1)>',
      '<a href="JaVaScRiPt:alert(1)">x</a>',
      '<a href="java&#x0A;script:alert(1)">x</a>',
      '<a href="&#106;avascript:alert(1)">x</a>',
      '<a href=" \tjavascript:alert(1)">x</a>',
      '<svg onload=alert(1)><text>alert(1)</text></svg>',
      '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
      '<math><mi xlink:href="javascript:alert(1)">x</mi></math>',
      '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>',
      '<form action="javascript:alert(1)"><button formaction="javascript:alert(1)">go</button></form>',
      '<style>@import "javascript:alert(1)"; body{background:url(javascript:alert(1))}</style>',
      '<object data="javascript:alert(1)"></object><embed src="javascript:alert(1)">',
      '<base href="javascript:alert(1)//"><a href="x">y</a>',
      '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
      '<script>alert(1)</script><script src="https://evil/x.js"></script>',
      '<p style="background:url(javascript:alert(1))" onclick="alert(1)">t</p>',
      '<img src="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">',
      '<img src="javascript:alert(1)">',
      '<video><source src="javascript:alert(1)"></video><audio src="x" onerror="alert(1)"></audio>',
      '<template><script>alert(1)</script></template>',
      '<textarea>alert(1)</textarea><select><option>alert(1)</option></select>',
      '<a href="https://ok.example/a" onclick="alert(1)">ok</a>',
    ];
    it.each(PAYLOADS.map((p) => [p]))('%s', (payload) => {
      const out = htmlToMarkdown(payload, { baseUrl: 'https://tracker.example.com/' }).markdown;
      expect(out).not.toMatch(/alert|javascript:|onerror|onload|onclick|<script|<iframe|srcdoc|data:/i);
    });
    it('the one safe link in the mix survives', () => {
      expect(md('<a href="https://ok.example/a" onclick="alert(1)">ok</a>')).toBe('[ok](https://ok.example/a)');
    });
    it('dropped scripts and frames are reported, harmless <style>/<meta> is not', () => {
      expect(codes(htmlToMarkdown('<script>x</script><iframe></iframe><style>a{}</style><meta charset=x>')).sort()).toEqual(['HTML_ELEMENT_DROPPED', 'HTML_ELEMENT_DROPPED']);
    });
  });

  describe('relative addresses', () => {
    it('are dropped without a baseUrl, resolved against it with one; schemes are still judged first', () => {
      expect(md('<a href="/a/b">x</a>')).toBe('x');
      expect(md('<a href="/a/b">x</a>', { baseUrl: 'https://t.example.com/' })).toBe('[x](https://t.example.com/a/b)');
      expect(md('<a href="../up">x</a>', { baseUrl: 'https://t.example.com/a/b/' })).toBe('[x](https://t.example.com/a/up)');
      expect(md('<a href="javascript:alert(1)">x</a>', { baseUrl: 'https://t.example.com/' })).toBe('x');
      expect(md('<a href="java\tscript:alert(1)">x</a>', { baseUrl: 'https://t.example.com/' })).toBe('x');
    });
    it('a same-page anchor is plain text and NOT reported as a lost link', () => {
      const r = htmlToMarkdown('<a href="#top">x</a>');
      expect(r.markdown).toBe('x');
      expect(r.warnings).toEqual([]);
    });
    it('a nonsense baseUrl cannot make a link appear', () => {
      expect(md('<a href="/x">y</a>', { baseUrl: 'not a url' })).toBe('y');
    });
  });

  describe('structure', () => {
    it('collapses whitespace like a browser, but not inside <pre>', () => {
      expect(md('<p>a \n\n   b</p>')).toBe('a b');
      expect(md('<pre>a  \n   b</pre>')).toBe('```\na  \n   b\n```');
    });
    it('checklists in several shapes', () => {
      expect(md('<ul><li><label><input type="checkbox" checked=""> a</label></li><li><p><input type=checkbox> b</p></li></ul>')).toBe('- [x] a\n- [ ] b');
    });
    it('the first table row is the header even when it uses <td>', () => {
      expect(md('<table><tr><td>a</td><td>b</td></tr><tr><td>1</td><td>2</td></tr></table>')).toBe('| a | b |\n| --- | --- |\n| 1 | 2 |');
    });
    it('an empty table or list produces nothing', () => {
      expect(md('<table></table><ul></ul><p></p>')).toBe('');
    });
    it('a <pre> language comes from class="language-x", lang-x or data-language, and only if it is a plain identifier', () => {
      expect(md('<pre><code class="lang-py">x</code></pre>')).toBe('```py\nx\n```');
      expect(md('<pre data-language="rb">x</pre>')).toBe('```rb\nx\n```');
      expect(md('<pre data-language="a b#">x</pre>')).toBe('```\nx\n```');
    });
  });

  describe('bounds', () => {
    it('stops at the node ceiling and says so', () => {
      const r = htmlToMarkdown('<p>x</p>'.repeat(HTML_LIMITS.maxNodes));
      expect(codes(r)).toContain('HTML_TOO_COMPLEX');
      expect(r.markdown.startsWith('x\n\nx')).toBe(true);
    });
    it('3000 nested <div>s / 1000 nested <b>s: no stack overflow, depth ceiling reported', () => {
      const r1 = htmlToMarkdown('<div>'.repeat(3000) + 'bottom' + '</div>'.repeat(3000));
      expect(codes(r1)).toContain('HTML_TOO_COMPLEX');
      const r2 = htmlToMarkdown('<b>'.repeat(1000) + 'x' + '</b>'.repeat(1000));
      expect(typeof r2.markdown).toBe('string');
    });
    it('cuts the output at the size ceiling', () => {
      const r = htmlToMarkdown('<p>' + 'a'.repeat(HTML_LIMITS.maxOutputChars + 500) + '</p>');
      expect(r.markdown).toHaveLength(HTML_LIMITS.maxOutputChars);
      expect(codes(r)).toContain('OUTPUT_TRUNCATED');
    });
  });

  it('fuzz: 1500 random tag soups never throw and never emit a script, handler or javascript: link', () => {
    const rnd = mulberry32(11);
    const tags = ['p', 'div', 'b', 'i', 's', 'a', 'img', 'ul', 'ol', 'li', 'table', 'tr', 'td', 'th', 'pre', 'code', 'blockquote', 'script', 'style', 'iframe', 'svg', 'input', 'br', 'hr', 'h1', 'span', 'details', 'summary', 'form', 'button', 'unknown-el'];
    const attrs = ['href="javascript:alert(1)"', 'href="https://ok.com"', 'src="x"', 'src="https://ok.com/i.png"', 'onerror="alert(1)"', 'onclick="alert(1)"', 'type="checkbox"', 'checked', 'style="x"', 'class="language-js"', 'start="3"', 'colspan="2"'];
    const texts = ['a', '# h', '* x', '&lt;b&gt;', '&amp;', '\u0000', '1. x', '| p |', 'alert(1)'];
    const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)];
    const gen = (d: number): string => {
      const parts: string[] = [];
      const n = 1 + Math.floor(rnd() * 4);
      for (let i = 0; i < n; i++) {
        const r = rnd();
        if (r < 0.35 || d === 0) parts.push(pick(texts));
        else {
          const tag = pick(tags);
          const at = Array.from({ length: Math.floor(rnd() * 3) }, () => pick(attrs)).join(' ');
          parts.push(rnd() < 0.15 ? `<${tag} ${at}>` : `<${tag} ${at}>${gen(d - 1)}${rnd() < 0.8 ? `</${tag}>` : ''}`);
        }
      }
      return parts.join(rnd() < 0.5 ? '' : ' ');
    };
    for (let i = 0; i < 1500; i++) {
      const out = htmlToMarkdown(gen(4)).markdown;
      expect(typeof out).toBe('string');
      expect(out).not.toMatch(/onerror|onclick|<script|<iframe/i);
      expect(out).not.toMatch(/\]\((?:javascript|data|vbscript):/i);
      // eslint-disable-next-line no-control-regex
      expect(out).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/);
    }
  });
});
