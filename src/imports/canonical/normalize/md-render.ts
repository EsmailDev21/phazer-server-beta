import { Block, Inline, Mark } from './md-model';

/** The repoint token step 4.6 looks for: `[name](attachment:<providerMediaId>)`. Never a clickable link. */
export const ATTACHMENT_LINK_SCHEME = 'attachment:';

const MAX_NEST = 40;

// ----------------------------------------------------------------------------- escaping

/** Inline text -> literal markdown. Over-escaping is harmless; under-escaping turns source text into formatting. */
export function escapeText(s: string): string {
  return s
    .replace(/[\\`*_[\]<>~|]/g, '\\$&')
    .replace(/&(?=#?[A-Za-z0-9]+;)/g, '\\&');
}

/**
 * Things that only mean something at the start of a line. Applied to every physical line a paragraph has; exactly ONE
 * rule fires per line (`>`, `` ` ``, `*`, `_`, `~` and `|` are already escaped everywhere by escapeText).
 */
function escapeLineStart(line: string): string {
  const rules: Array<[RegExp, string]> = [
    [/^(\s*)(#{1,6})(?=\s|$)/, '$1\\$2'], // ATX heading
    [/^(\s*)(-+)(\s*)$/, '$1\\$2$3'], // `-`, `---`: empty bullet, thematic break, setext underline
    [/^(\s*)(\+)(?=\s|$)/, '$1\\$2'], // bullet
    [/^(\s*)(-)(?=\s)/, '$1\\$2'], // bullet
    [/^(\s*)(=+)(\s*)$/, '$1\\$2$3'], // setext underline
    [/^(\s*)(\d{1,9})([.)])(?=\s|$)/, '$1$2\\$3'], // ordered list
  ];
  for (const [re, to] of rules) if (re.test(line)) return line.replace(re, to);
  return line;
}

/** `]( ` and spaces / parentheses inside a URL would end the link early. */
export function encodeUrl(u: string): string {
  return u.replace(/[\s()<>]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}

function codeSpan(text: string): string {
  const flat = text.replace(/\r?\n/g, ' ');
  const runs: string[] = flat.match(/`+/g) ?? [];
  const longest = runs.reduce((n, r) => Math.max(n, r.length), 0);
  const fence = '`'.repeat(longest + 1);
  // CommonMark strips ONE blank from each side when both exist (and the span is not blanks only): pad whenever that
  // would eat real content (a backtick at an edge, or a blank at both edges).
  const pad = flat.startsWith('`') || flat.endsWith('`') || (flat.startsWith(' ') && flat.endsWith(' ') && flat.trim() !== '') ? ' ' : '';
  return `${fence}${pad}${flat}${pad}${fence}`;
}

// ----------------------------------------------------------------------------- inlines

function sameMarks(a: readonly Mark[], b: readonly Mark[]): boolean {
  return a.length === b.length && a.every((m) => b.includes(m));
}

/** Adjacent text nodes with the same marks become one, so `**a**` `**b**` is `**ab**`, not `**a****b**`. */
function mergeRuns(inlines: Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const n of inlines) {
    const last = out[out.length - 1];
    if (n.t === 'text' && last && last.t === 'text' && sameMarks(last.marks, n.marks)) {
      out[out.length - 1] = { t: 'text', text: last.text + n.text, marks: last.marks };
    } else if (n.t === 'text' && n.text === '') {
      continue;
    } else {
      out.push(n);
    }
  }
  return out;
}

/** A neighbouring run that is STRONG and touches this one with no blank between (so `**` and `*` would run together). */
const touchesStrong = (n: Inline | undefined, edge: 'end' | 'start'): boolean =>
  !!n && n.t === 'text' && n.marks.includes('strong') && !(edge === 'end' ? /\s$/ : /^\s/).test(n.text);

export function renderInlines(input: Inline[], depth = 0): string {
  if (depth > MAX_NEST) return '';
  const nodes = mergeRuns(input);
  let out = '';
  nodes.forEach((n, i) => {
    switch (n.t) {
      case 'br':
        out += '\\\n';
        return;
      case 'code':
        out += codeSpan(n.text);
        return;
      case 'image':
        out += `![${escapeText(n.alt)}](${encodeUrl(n.src)})`;
        return;
      case 'link': {
        const label = renderInlines(n.children, depth + 1);
        // blanks at the edges of the label belong outside the link
        const lm = /^(\s*)([\s\S]*?)(\s*)$/.exec(label) as RegExpExecArray;
        const inner = lm[2] === '' ? escapeText(n.href) : lm[2];
        out += `${lm[2] === '' ? '' : lm[1]}[${inner}](${encodeUrl(n.href)})${lm[2] === '' ? '' : lm[3]}`;
        return;
      }
      case 'text': {
        const next = nodes[i + 1];
        let text = escapeText(n.text);
        // "wow!" followed by a link would read as an image: `![`.
        if (next && next.t === 'link' && text.endsWith('!')) text = `${text.slice(0, -1)}\\!`;
        if (n.marks.length === 0) {
          out += text;
          return;
        }
        // Delimiters hug the words: leading / trailing blanks go OUTSIDE (`** a **` is not bold in CommonMark).
        const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(text) as RegExpExecArray;
        const [, lead, core, trail] = m;
        if (core === '') {
          out += text;
          return;
        }
        let wrapped = core;
        if (n.marks.includes('em')) {
          // `_` when a separate strong run touches this one (`*` beside `**` would run together). Inside a run that is
          // itself strong the nesting `***x***` is unambiguous, so `*` stays.
          const adjacent =
            !n.marks.includes('strong') &&
            ((!lead && touchesStrong(nodes[i - 1], 'end')) || (!trail && touchesStrong(next, 'start')));
          const d = adjacent ? '_' : '*';
          wrapped = `${d}${wrapped}${d}`;
        }
        if (n.marks.includes('strong')) wrapped = `**${wrapped}**`;
        if (n.marks.includes('strike')) wrapped = `~~${wrapped}~~`;
        out += lead + wrapped + trail;
        return;
      }
    }
  });
  return out;
}

/** A paragraph's inline markdown with line-start escapes applied to every physical line. */
function paragraph(inlines: Inline[]): string {
  const raw = renderInlines(inlines).replace(/(\\\n)+$/, '').trim();
  return raw.split('\n').map(escapeLineStart).join('\n');
}

// ----------------------------------------------------------------------------- blocks

function indent(text: string, pad: string): string {
  return text
    .split('\n')
    .map((l, i) => (i === 0 || l === '' ? l : pad + l))
    .join('\n');
}

function renderItem(blocks: Block[], depth: number): string {
  const parts: string[] = [];
  blocks.forEach((b, i) => {
    const s = renderBlock(b, depth + 1);
    if (s === '') return;
    parts.push(i === 0 ? s : (b.t === 'ul' || b.t === 'ol' ? '\n' : '\n\n') + s);
  });
  return parts.join('');
}

function renderBlock(b: Block, depth: number): string {
  if (depth > MAX_NEST) return '';
  switch (b.t) {
    case 'p':
      return paragraph(b.inlines);
    case 'h': {
      const level = Math.min(Math.max(Math.trunc(b.level) || 1, 1), 6);
      const text = renderInlines(b.inlines).replace(/\\\n/g, ' ').replace(/\s+/g, ' ').trim();
      return text === '' ? '' : `${'#'.repeat(level)} ${text}`;
    }
    case 'hr':
      return '---';
    case 'code': {
      const runs: string[] = b.text.match(/`+/g) ?? [];
      const fence = '`'.repeat(Math.max(3, runs.reduce((n, r) => Math.max(n, r.length), 0) + 1));
      const lang = /^[A-Za-z0-9+#._-]{1,30}$/.test(b.lang) ? b.lang : '';
      return `${fence}${lang}\n${b.text.replace(/\n$/, '')}\n${fence}`;
    }
    case 'quote': {
      const inner = renderBlocks(b.blocks, depth + 1);
      if (inner === '') return '';
      return inner.split('\n').map((l) => (l === '' ? '>' : `> ${l}`)).join('\n');
    }
    case 'ul': {
      const lines = b.items.map((item, i) => {
        const body = renderItem(item, depth);
        const c = b.checked?.[i];
        const marker = c === true ? '- [x] ' : c === false ? '- [ ] ' : '- ';
        return marker + indent(body, '  ');
      });
      return lines.join('\n');
    }
    case 'ol': {
      const start = Math.min(Math.max(Math.trunc(b.start) || 1, 0), 999_999_999);
      const lines = b.items.map((item, i) => {
        const marker = `${start + i}. `;
        return marker + indent(renderItem(item, depth), ' '.repeat(marker.length));
      });
      return lines.join('\n');
    }
    case 'table': {
      const rows = b.rows.map((r) =>
        r.map((cell) => renderInlines(cell).replace(/\\\n/g, '<br>').replace(/\n/g, '<br>').trim()),
      );
      const width = rows.reduce((n, r) => Math.max(n, r.length), 0);
      if (width === 0) return '';
      const pad = (r: string[]) => Array.from({ length: width }, (_, i) => r[i] ?? '');
      const line = (r: string[]) => `| ${pad(r).join(' | ')} |`;
      return [line(rows[0]), `| ${Array(width).fill('---').join(' | ')} |`, ...rows.slice(1).map(line)].join('\n');
    }
  }
}

function renderBlocks(blocks: Block[], depth: number): string {
  return blocks
    .map((b) => renderBlock(b, depth))
    .filter((s) => s !== '')
    .join('\n\n');
}

export function renderMarkdown(blocks: Block[]): string {
  return renderBlocks(blocks, 0)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '')
    .split('\n')
    .reduce<{ out: string[]; fence: string | null }>(
      (acc, line) => {
        // Trailing blanks are noise EXCEPT inside a code fence, where they are the code. Fences are ours (md-render
        // emits them; text that looks like one is escaped), possibly behind list indentation or `>` quote prefixes.
        const m = /^(?:>\s?)*\s*(?:(?:[-+]|\d{1,9}[.)])(?: \[[ x]\])?\s+)*(`{3,})/.exec(line);
        if (acc.fence === null) {
          if (m) acc.fence = m[1];
          const clean = line.replace(/[ \t]+$/, '');
          const n = acc.out.length;
          // never more than one blank line in a row OUTSIDE code (inside, blank lines are the code)
          if (clean === '' && n >= 2 && acc.out[n - 1] === '' && acc.out[n - 2] === '') return acc;
          acc.out.push(clean);
        } else {
          if (m && m[1].length >= acc.fence.length && /^(?:>\s?)*\s*`+\s*$/.test(line)) acc.fence = null;
          acc.out.push(acc.fence === null ? line.replace(/[ \t]+$/, '') : line);
        }
        return acc;
      },
      { out: [], fence: null },
    )
    .out.join('\n')
    .trim();
}
