import { DefaultTreeAdapterMap, parseFragment } from 'parse5';
import {
  Block,
  Inline,
  Mark,
  Warnings,
  safeImageUrl,
  safeLinkUrl,
} from './md-model';
import { renderMarkdown } from './md-render';
import { NormalizeResult } from './adf';

/**
 * Step 4.2. HTML (ClickUp / Linear / Asana / Trello descriptions and comments, Jira rendered fields) -> markdown.
 *
 * parse5 builds the tree exactly as a browser would (malformed markup included) and executes nothing. We then walk it
 * with hard ceilings and an ALLOW-LIST of what survives: <script>, <style>, <iframe>, <object>, <embed>, <svg> and
 * friends vanish WITH their content (a script's source must never leak into a task description); event handlers and
 * attributes are never read; a URL survives only through safeLinkUrl / safeImageUrl.
 */
type El = DefaultTreeAdapterMap['element'];
type Node = DefaultTreeAdapterMap['childNode'];
type TextNode = DefaultTreeAdapterMap['textNode'];

export const HTML_LIMITS = {
  maxNodes: 100_000,
  maxDepth: 40,
  maxInputBytes: 2 * 1024 * 1024,
  maxOutputChars: 200_000,
} as const;

export interface HtmlOptions {
  /** Resolves relative links and image sources (`/uploads/x.png`). Without it a relative URL is dropped. */
  baseUrl?: string;
}

/** Removed WITH their content. */
const DROP_WITH_CONTENT = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'svg', 'math', 'template', 'noscript', 'head', 'title',
  'meta', 'link', 'base', 'canvas', 'audio', 'video', 'source', 'track', 'applet', 'frame', 'frameset',
  'select', 'textarea', 'button', 'datalist', 'option',
]);
/** Worth telling the person about (they carried content or behaviour); style/meta/head are not. */
const REPORT_DROP = new Set(['script', 'iframe', 'object', 'embed', 'svg', 'math', 'canvas', 'audio', 'video', 'applet']);

const BLOCK_CONTAINERS = new Set([
  'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav', 'figure', 'figcaption', 'center',
  'fieldset', 'address', 'form', 'body', 'html', 'dl', 'dd', 'legend', 'hgroup', 'search',
]);

class Ctx {
  nodes = 0;
  tooComplex = false;
  readonly warn = new Warnings();
  constructor(readonly opts: HtmlOptions) {}
  take(depth: number): boolean {
    if (this.tooComplex) return false;
    this.nodes += 1;
    if (this.nodes > HTML_LIMITS.maxNodes || depth > HTML_LIMITS.maxDepth) {
      this.tooComplex = true;
      this.warn.add('HTML_TOO_COMPLEX', 'The text was too large or too deeply nested; the rest was left out');
      return false;
    }
    return true;
  }
  resolve(raw: string | undefined, kind: 'link' | 'image'): string | null {
    if (!raw) return null;
    const v = raw.trim();
    const direct = kind === 'link' ? safeLinkUrl(v) : safeImageUrl(v);
    if (direct) return direct;
    if (this.opts.baseUrl && !/^[a-z][a-z0-9+.-]*:/i.test(v.replace(/[\u0000-\u001f]/g, '')) && !v.startsWith('#')) {
      try {
        const abs = new URL(v, this.opts.baseUrl).toString();
        return kind === 'link' ? safeLinkUrl(abs) : safeImageUrl(abs);
      } catch {
        return null;
      }
    }
    return null;
  }
}

const isEl = (n: Node): n is El => 'tagName' in n;
const isText = (n: Node): n is TextNode => n.nodeName === '#text';
const attr = (el: El, name: string): string | undefined => el.attrs.find((a) => a.name === name)?.value;

function textContent(n: Node, c: Ctx, depth: number): string {
  if (!c.take(depth)) return '';
  if (isText(n)) return n.value;
  if (!isEl(n) || DROP_WITH_CONTENT.has(n.tagName)) return '';
  if (n.tagName === 'br') return '\n';
  return n.childNodes.map((k) => textContent(k, c, depth + 1)).join('');
}

// -------------------------------------------------------------------------------- inline

function inlines(nodes: Node[], marks: readonly Mark[], c: Ctx, depth: number): Inline[] {
  const out: Inline[] = [];
  for (const n of nodes) {
    if (!c.take(depth)) break;
    if (isText(n)) {
      const text = n.value.replace(/[ \t\r\n\f]+/g, ' ');
      if (text !== '') out.push({ t: 'text', text, marks });
      continue;
    }
    if (!isEl(n)) continue; // comments, doctype
    const tag = n.tagName;
    if (DROP_WITH_CONTENT.has(tag)) {
      if (REPORT_DROP.has(tag)) c.warn.add('HTML_ELEMENT_DROPPED', `<${tag}> content is not supported and was dropped`, tag);
      continue;
    }
    switch (tag) {
      case 'br':
        out.push({ t: 'br' });
        break;
      case 'strong': case 'b':
        out.push(...inlines(n.childNodes, addMark(marks, 'strong'), c, depth + 1));
        break;
      case 'em': case 'i': case 'cite': case 'dfn': case 'var':
        out.push(...inlines(n.childNodes, addMark(marks, 'em'), c, depth + 1));
        break;
      case 'del': case 's': case 'strike':
        out.push(...inlines(n.childNodes, addMark(marks, 'strike'), c, depth + 1));
        break;
      case 'code': case 'kbd': case 'samp': case 'tt': {
        const t = textContent(n, c, depth + 1);
        if (t !== '') out.push({ t: 'code', text: t });
        break;
      }
      case 'a': {
        const kids = inlines(n.childNodes, marks, c, depth + 1);
        const href = c.resolve(attr(n, 'href'), 'link');
        const raw = attr(n, 'href')?.trim();
        if (href) {
          out.push({ t: 'link', href, children: kids });
        } else {
          // `#anchor` / empty hrefs are not "lost links"; an unsafe or unresolvable address is
          if (raw && !raw.startsWith('#')) c.warn.add('HTML_LINK_DROPPED', 'A link with an unsupported address was turned into plain text', 'link');
          out.push(...kids);
        }
        break;
      }
      case 'img': {
        const src = c.resolve(attr(n, 'src'), 'image');
        if (src) out.push({ t: 'image', alt: attr(n, 'alt') ?? '', src });
        else c.warn.add('HTML_IMAGE_DROPPED', 'An image that is embedded or has an unsupported address was dropped', 'img');
        break;
      }
      case 'input':
        break; // checkboxes are read by <li>; nothing else is content
      default:
        // span, font, u, ins, sub, sup, mark, small, abbr, label, time, q, bdi, wbr ... and any unknown inline: transparent
        out.push(...inlines(n.childNodes, marks, c, depth + 1));
    }
  }
  return out;
}

const addMark = (marks: readonly Mark[], m: Mark): readonly Mark[] => (marks.includes(m) ? marks : [...marks, m]);

/** HTML whitespace rules at the edges of a block: no leading / trailing blanks, no double blanks, none around a break. */
function tidy(list: Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const n of list) {
    if (n.t === 'text') {
      let text = n.text;
      const prev = out[out.length - 1];
      if ((out.length === 0 || prev?.t === 'br') && text.startsWith(' ')) text = text.replace(/^ +/, '');
      if (prev?.t === 'text' && prev.text.endsWith(' ') && text.startsWith(' ')) text = text.replace(/^ +/, '');
      if (text === '') continue;
      out.push({ ...n, text });
    } else {
      out.push(n);
    }
  }
  // trailing blanks / breaks
  while (out.length) {
    const last = out[out.length - 1];
    if (last.t === 'br') out.pop();
    else if (last.t === 'text' && /\s+$/.test(last.text)) {
      const t = last.text.replace(/\s+$/, '');
      if (t === '') out.pop();
      else {
        out[out.length - 1] = { ...last, text: t };
        break;
      }
    } else break;
  }
  return out;
}

const hasContent = (list: Inline[]): boolean => list.some((n) => n.t !== 'text' || n.text.trim() !== '');

// -------------------------------------------------------------------------------- blocks

function cellInline(cell: El, c: Ctx, depth: number): Inline[] {
  // GFM cells hold inline content only: blocks inside become line breaks, nested tables / lists become text.
  const out: Inline[] = [];
  const walk = (nodes: Node[], d: number) => {
    for (const n of nodes) {
      if (!c.take(d)) return;
      if (isEl(n) && /^(p|div|li|tr|h[1-6]|ul|ol|table|thead|tbody|blockquote|pre)$/.test(n.tagName)) {
        if (out.length && out[out.length - 1].t !== 'br') out.push({ t: 'br' });
        if (n.tagName === 'li') out.push({ t: 'text', text: '• ', marks: [] });
        walk(n.childNodes, d + 1);
      } else {
        out.push(...inlines([n], [], c, d + 1));
      }
    }
  };
  walk(cell.childNodes, depth + 1);
  return tidy(out);
}

function tableRows(el: El, c: Ctx, depth: number): Inline[][][] {
  const rows: Inline[][][] = [];
  const visit = (nodes: Node[], d: number) => {
    for (const n of nodes) {
      if (!c.take(d) || !isEl(n)) continue;
      if (n.tagName === 'tr') {
        rows.push(n.childNodes.filter(isEl).filter((k) => k.tagName === 'td' || k.tagName === 'th').map((k) => cellInline(k, c, d + 1)));
      } else if (n.tagName === 'thead' || n.tagName === 'tbody' || n.tagName === 'tfoot') {
        visit(n.childNodes, d + 1);
      }
    }
  };
  visit(el.childNodes, depth + 1);
  return rows.filter((r) => r.length > 0);
}

/** `<li><input type=checkbox checked> text</li>` (GitHub, ClickUp checklists) -> task item. */
function checkboxOf(li: El): boolean | null {
  const find = (nodes: Node[], d = 0): El | null => {
    for (const n of nodes) {
      if (!isEl(n)) continue;
      if (n.tagName === 'input' && attr(n, 'type')?.toLowerCase() === 'checkbox') return n;
      if (d < 2 && (n.tagName === 'p' || n.tagName === 'label' || n.tagName === 'span')) {
        const f = find(n.childNodes, d + 1);
        if (f) return f;
      }
    }
    return null;
  };
  const box = find(li.childNodes);
  return box ? attr(box, 'checked') !== undefined : null;
}

function blocks(nodes: Node[], c: Ctx, depth: number): Block[] {
  const out: Block[] = [];
  let pending: Inline[] = [];
  const flush = () => {
    const t = tidy(pending);
    if (hasContent(t)) out.push({ t: 'p', inlines: t });
    pending = [];
  };

  for (const n of nodes) {
    if (!c.take(depth)) break;
    if (!isEl(n)) {
      if (isText(n)) pending.push(...inlines([n], [], c, depth + 1));
      continue;
    }
    const tag = n.tagName;
    if (DROP_WITH_CONTENT.has(tag)) {
      if (REPORT_DROP.has(tag)) c.warn.add('HTML_ELEMENT_DROPPED', `<${tag}> content is not supported and was dropped`, tag);
      continue;
    }
    if (tag === 'p') {
      flush();
      const t = tidy(inlines(n.childNodes, [], c, depth + 1));
      if (hasContent(t)) out.push({ t: 'p', inlines: t });
    } else if (/^h[1-6]$/.test(tag)) {
      flush();
      const t = tidy(inlines(n.childNodes, [], c, depth + 1));
      if (hasContent(t)) out.push({ t: 'h', level: Number(tag[1]), inlines: t });
    } else if (tag === 'hr') {
      flush();
      out.push({ t: 'hr' });
    } else if (tag === 'blockquote') {
      flush();
      out.push({ t: 'quote', blocks: blocks(n.childNodes, c, depth + 1) });
    } else if (tag === 'pre') {
      flush();
      const codeEl = n.childNodes.find((k): k is El => isEl(k) && k.tagName === 'code');
      const cls = (codeEl && attr(codeEl, 'class')) || attr(n, 'class') || '';
      const lang = attr(n, 'data-language') ?? /(?:^|\s)(?:language|lang)-([A-Za-z0-9+#._-]+)/.exec(cls)?.[1] ?? '';
      out.push({ t: 'code', lang, text: textContent(n, c, depth + 1) });
    } else if (tag === 'ul' || tag === 'ol' || tag === 'menu') {
      flush();
      const lis = n.childNodes.filter(isEl).filter((k) => k.tagName === 'li');
      const items = lis.map((li) => blocks(li.childNodes, c, depth + 1));
      const checks = lis.map(checkboxOf);
      if (tag === 'ol') out.push({ t: 'ol', start: Number(attr(n, 'start')) || 1, items });
      else out.push({ t: 'ul', items, ...(checks.some((x) => x !== null) ? { checked: checks } : {}) });
    } else if (tag === 'li') {
      // a stray <li> outside a list: its content as a block
      flush();
      out.push(...blocks(n.childNodes, c, depth + 1));
    } else if (tag === 'table') {
      flush();
      const rows = tableRows(n, c, depth + 1);
      if (rows.length) out.push({ t: 'table', rows });
    } else if (tag === 'details') {
      flush();
      out.push(...blocks(n.childNodes, c, depth + 1));
    } else if (tag === 'summary' || tag === 'dt') {
      flush();
      const t = tidy(inlines(n.childNodes, ['strong'], c, depth + 1));
      if (hasContent(t)) out.push({ t: 'p', inlines: t });
    } else if (BLOCK_CONTAINERS.has(tag)) {
      flush();
      out.push(...blocks(n.childNodes, c, depth + 1));
    } else {
      // inline element (or unknown) at block level: part of the current paragraph
      pending.push(...inlines([n], [], c, depth + 1));
    }
  }
  flush();
  return out;
}

/** `html` may be a full document or a fragment. null / empty / non-string -> empty result, never an exception. */
export function htmlToMarkdown(html: unknown, opts: HtmlOptions = {}): NormalizeResult {
  const c = new Ctx(opts);
  if (typeof html !== 'string' || html.trim() === '') return { markdown: '', warnings: [] };
  if (Buffer.byteLength(html, 'utf8') > HTML_LIMITS.maxInputBytes) {
    c.warn.add('HTML_TOO_LARGE', 'The text is too large to convert');
    return { markdown: '', warnings: c.warn.items };
  }
  const fragment = parseFragment(html);
  let markdown = renderMarkdown(blocks(fragment.childNodes as Node[], c, 1));
  if (markdown.length > HTML_LIMITS.maxOutputChars) {
    markdown = markdown.slice(0, HTML_LIMITS.maxOutputChars);
    c.warn.add('OUTPUT_TRUNCATED', 'The converted text was cut at the size limit');
  }
  return { markdown, warnings: c.warn.items };
}
