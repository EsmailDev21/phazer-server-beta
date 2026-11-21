import {
  Block,
  Inline,
  Mark,
  NormalizeWarning,
  Warnings,
  safeImageUrl,
  safeLinkUrl,
} from './md-model';
import { ATTACHMENT_LINK_SCHEME, renderMarkdown } from './md-render';

/**
 * Step 4.2. Atlassian Document Format (Jira Cloud REST v3 descriptions and comments) -> markdown.
 *
 * ADF is untrusted input from a third party: every walk is bounded (node count, depth, output size), unknown nodes
 * degrade to their text with a warning instead of throwing, and a URL only survives if its scheme is on the allow-list
 * (md-model.safeLinkUrl). Lossy by nature (colours, alignment, panels' icons ...): what is LOST CONTENT (an unsupported
 * node, a dropped link, a media file) is reported in `warnings`; pure styling is dropped silently.
 */
export interface NormalizeResult {
  markdown: string;
  warnings: NormalizeWarning[];
}

export const ADF_LIMITS = {
  maxNodes: 100_000,
  maxDepth: 40,
  maxInputBytes: 2 * 1024 * 1024,
  maxOutputChars: 200_000,
} as const;

type AdfNode = {
  type?: unknown;
  text?: unknown;
  attrs?: Record<string, unknown>;
  marks?: Array<{ type?: unknown; attrs?: Record<string, unknown> }>;
  content?: unknown;
};

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

class Ctx {
  nodes = 0;
  tooComplex = false;
  readonly warn = new Warnings();
  /** Count one node; false once a ceiling is hit (the walk stops descending, the result says so). */
  take(depth: number): boolean {
    if (this.tooComplex) return false;
    this.nodes += 1;
    if (this.nodes > ADF_LIMITS.maxNodes || depth > ADF_LIMITS.maxDepth) {
      this.tooComplex = true;
      this.warn.add('ADF_TOO_COMPLEX', 'The rich text was too large or too deeply nested; the rest was left out');
      return false;
    }
    return true;
  }
}

const children = (n: AdfNode): AdfNode[] => (Array.isArray(n.content) ? (n.content as AdfNode[]).filter(isObj) : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

// ------------------------------------------------------------------------------------ inline

function textMarks(n: AdfNode, c: Ctx): { marks: Mark[]; code: boolean; href: string | null; linkDropped: boolean } {
  const marks: Mark[] = [];
  let code = false;
  let href: string | null = null;
  let linkDropped = false;
  for (const m of n.marks ?? []) {
    switch (m?.type) {
      case 'strong': marks.push('strong'); break;
      case 'em': marks.push('em'); break;
      case 'strike': marks.push('strike'); break;
      case 'code': code = true; break;
      case 'link': {
        const u = safeLinkUrl(m.attrs?.href);
        if (u) href = u;
        else linkDropped = true;
        break;
      }
      // pure styling: dropped without a word
      case 'underline': case 'textColor': case 'subsup': case 'backgroundColor': case 'border':
      case 'annotation': case 'alignment': case 'indentation': case 'breakout': case 'fontSize':
        break;
      default:
        c.warn.add('ADF_MARK_DROPPED', `Formatting "${String(m?.type)}" is not supported and was dropped`, String(m?.type));
    }
  }
  return { marks, code, href, linkDropped };
}

function inlineNodes(list: AdfNode[], c: Ctx, depth: number): Inline[] {
  const out: Inline[] = [];
  for (const n of list) {
    if (!c.take(depth)) break;
    switch (n.type) {
      case 'text': {
        const text = str(n.text);
        if (text === '') break;
        const { marks, code, href, linkDropped } = textMarks(n, c);
        if (linkDropped) c.warn.add('ADF_LINK_DROPPED', 'A link with an unsupported address was turned into plain text', 'link');
        const leaf: Inline = code ? { t: 'code', text } : { t: 'text', text, marks };
        out.push(href ? { t: 'link', href, children: [leaf] } : leaf);
        break;
      }
      case 'hardBreak':
        out.push({ t: 'br' });
        break;
      case 'mention': {
        const raw = str(n.attrs?.text) || str(n.attrs?.id) || 'someone';
        out.push({ t: 'text', text: `@${raw.replace(/^@/, '')}`, marks: [] });
        break;
      }
      case 'emoji':
        out.push({ t: 'text', text: str(n.attrs?.text) || str(n.attrs?.shortName), marks: [] });
        break;
      case 'status':
        out.push({ t: 'text', text: `[${str(n.attrs?.text)}]`, marks: [] });
        break;
      case 'date': {
        const ms = Number(n.attrs?.timestamp);
        out.push({ t: 'text', text: Number.isFinite(ms) && ms > 0 && ms < 4.1e12 ? new Date(ms).toISOString().slice(0, 10) : '', marks: [] });
        break;
      }
      case 'inlineCard':
      case 'blockCard':
      case 'embedCard': {
        const url = safeLinkUrl(n.attrs?.url ?? (isObj(n.attrs?.data) ? (n.attrs?.data as Record<string, unknown>).url : undefined));
        if (url) out.push({ t: 'link', href: url, children: [{ t: 'text', text: url, marks: [] }] });
        else c.warn.add('ADF_LINK_DROPPED', 'A smart link without a usable address was dropped', 'card');
        break;
      }
      case 'mediaInline':
      case 'media':
        out.push(...mediaInline(n, c));
        break;
      case 'inlineExtension':
        c.warn.add('ADF_UNSUPPORTED_NODE', 'An Atlassian app macro could not be converted and was dropped', 'extension');
        break;
      default: {
        // unknown inline: keep any text it carries
        c.warn.add('ADF_UNSUPPORTED_NODE', `Content of type "${String(n.type)}" is not supported`, String(n.type));
        if (typeof n.text === 'string') out.push({ t: 'text', text: n.text, marks: [] });
        else out.push(...inlineNodes(children(n), c, depth + 1));
      }
    }
  }
  return out;
}

/** A file referenced from the text. The bytes arrive separately (step 4.6), which swaps this token for the new file. */
function mediaInline(n: AdfNode, c: Ctx): Inline[] {
  const a = n.attrs ?? {};
  if (a.type === 'external') {
    const src = safeImageUrl(a.url);
    if (src) return [{ t: 'image', alt: str(a.alt), src }];
    c.warn.add('ADF_MEDIA_DROPPED', 'An embedded image with an unsupported address was dropped', 'external');
    return [];
  }
  const id = str(a.id);
  if (id === '') return [];
  c.warn.add('ADF_MEDIA_PLACEHOLDER', 'Embedded files are kept as placeholders until their attachments are copied', 'media');
  const name = str(a.alt) || 'attachment';
  return [{ t: 'link', href: `${ATTACHMENT_LINK_SCHEME}${id}`, children: [{ t: 'text', text: name, marks: [] }] }];
}

// ------------------------------------------------------------------------------------ blocks

function flattenInline(list: AdfNode[], c: Ctx, depth: number): Inline[] {
  // For table cells and similar: whatever blocks it holds, as one inline run joined by line breaks.
  const out: Inline[] = [];
  for (const n of list) {
    if (!c.take(depth)) break;
    if (n.type === 'paragraph' || n.type === 'heading') {
      if (out.length) out.push({ t: 'br' });
      out.push(...inlineNodes(children(n), c, depth + 1));
    } else if (n.type === 'bulletList' || n.type === 'orderedList' || n.type === 'taskList') {
      for (const li of children(n)) {
        if (out.length) out.push({ t: 'br' });
        out.push({ t: 'text', text: '• ', marks: [] }, ...flattenInline(children(li), c, depth + 2));
      }
    } else if (n.type === 'text' || n.type === 'hardBreak' || n.type === 'mention' || n.type === 'emoji' || n.type === 'status' || n.type === 'date' || n.type === 'inlineCard' || n.type === 'media' || n.type === 'mediaInline') {
      out.push(...inlineNodes([n], c, depth + 1));
    } else {
      out.push(...flattenInline(children(n), c, depth + 1));
    }
  }
  return out;
}

function listItems(list: AdfNode[], c: Ctx, depth: number): Block[][] {
  const items: Block[][] = [];
  for (const li of list) {
    if (!c.take(depth)) break;
    const kids = children(li);
    // taskItem / decisionItem hold inline content directly; listItem holds blocks
    const inlineLike = kids.length > 0 && kids.every((k) => k.type === 'text' || k.type === 'mention' || k.type === 'emoji' || k.type === 'hardBreak' || k.type === 'status' || k.type === 'date' || k.type === 'inlineCard' || k.type === 'media' || k.type === 'mediaInline');
    items.push(inlineLike ? [{ t: 'p', inlines: inlineNodes(kids, c, depth + 1) }] : blockNodes(kids, c, depth + 1));
  }
  return items;
}

const PANEL_LABEL: Record<string, string> = { info: 'Info', note: 'Note', warning: 'Warning', error: 'Error', success: 'Success', tip: 'Tip' };

function blockNodes(list: AdfNode[], c: Ctx, depth: number): Block[] {
  const out: Block[] = [];
  for (const n of list) {
    if (!c.take(depth)) break;
    switch (n.type) {
      case 'paragraph':
        out.push({ t: 'p', inlines: inlineNodes(children(n), c, depth + 1) });
        break;
      case 'heading':
        out.push({ t: 'h', level: Number(n.attrs?.level) || 1, inlines: inlineNodes(children(n), c, depth + 1) });
        break;
      case 'blockquote':
        out.push({ t: 'quote', blocks: blockNodes(children(n), c, depth + 1) });
        break;
      case 'rule':
        out.push({ t: 'hr' });
        break;
      case 'codeBlock':
        out.push({
          t: 'code',
          lang: str(n.attrs?.language),
          text: children(n).map((k) => str(k.text)).join(''),
        });
        break;
      case 'bulletList':
        out.push({ t: 'ul', items: listItems(children(n), c, depth + 1) });
        break;
      case 'orderedList': {
        const start = Number(n.attrs?.order);
        out.push({ t: 'ol', start: Number.isFinite(start) ? start : 1, items: listItems(children(n), c, depth + 1) });
        break;
      }
      case 'taskList': {
        const items = children(n);
        out.push({
          t: 'ul',
          items: listItems(items, c, depth + 1),
          checked: items.map((i) => i.attrs?.state === 'DONE'),
        });
        break;
      }
      case 'decisionList': {
        const items = listItems(children(n), c, depth + 1);
        out.push({ t: 'ul', items: items.map((b) => [{ t: 'p', inlines: [{ t: 'text', text: 'Decision: ', marks: ['strong'] }, ...(b[0]?.t === 'p' ? b[0].inlines : [])] } as Block]) });
        break;
      }
      case 'panel': {
        const label = PANEL_LABEL[str(n.attrs?.panelType)] ?? 'Note';
        out.push({
          t: 'quote',
          blocks: [{ t: 'p', inlines: [{ t: 'text', text: `${label}:`, marks: ['strong'] }] }, ...blockNodes(children(n), c, depth + 1)],
        });
        break;
      }
      case 'expand':
      case 'nestedExpand': {
        const title = str(n.attrs?.title);
        if (title) out.push({ t: 'p', inlines: [{ t: 'text', text: title, marks: ['strong'] }] });
        out.push(...blockNodes(children(n), c, depth + 1));
        break;
      }
      case 'table': {
        const rows = children(n).filter((r) => r.type === 'tableRow');
        if (rows.some((r) => children(r).some((cell) => Number(cell.attrs?.colspan) > 1 || Number(cell.attrs?.rowspan) > 1))) {
          c.warn.add('ADF_TABLE_SPAN', 'Merged table cells were split into single cells', 'span');
        }
        out.push({
          t: 'table',
          rows: rows.map((r) => children(r).map((cell) => flattenInline(children(cell), c, depth + 2))),
        });
        break;
      }
      case 'mediaSingle':
      case 'mediaGroup': {
        const inl = inlineNodes(children(n), c, depth + 1);
        if (inl.length) out.push({ t: 'p', inlines: inl });
        break;
      }
      case 'blockCard':
      case 'embedCard':
        out.push({ t: 'p', inlines: inlineNodes([n], c, depth + 1) });
        break;
      case 'layoutSection':
      case 'layoutColumn':
        out.push(...blockNodes(children(n), c, depth + 1));
        break;
      case 'extension':
      case 'bodiedExtension':
        c.warn.add('ADF_UNSUPPORTED_NODE', 'An Atlassian app macro could not be converted; only its text was kept', 'extension');
        out.push(...blockNodes(children(n), c, depth + 1));
        break;
      default: {
        c.warn.add('ADF_UNSUPPORTED_NODE', `Content of type "${String(n.type)}" is not supported`, String(n.type));
        const kids = children(n);
        if (typeof n.text === 'string') out.push({ t: 'p', inlines: [{ t: 'text', text: n.text, marks: [] }] });
        else out.push(...blockNodes(kids, c, depth + 1));
      }
    }
  }
  return out;
}

/**
 * `value` is a parsed ADF document, or its JSON text. Anything else (null, a plain string that is not JSON,
 * an object that is not a `doc`) yields an empty result and an ADF_INVALID warning: never an exception.
 */
export function adfToMarkdown(value: unknown): NormalizeResult {
  const c = new Ctx();
  let doc: unknown = value;
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > ADF_LIMITS.maxInputBytes) {
      c.warn.add('ADF_INVALID', 'The rich text is too large to convert');
      return { markdown: '', warnings: c.warn.items };
    }
    try {
      doc = JSON.parse(value);
    } catch {
      c.warn.add('ADF_INVALID', 'The rich text is not valid ADF');
      return { markdown: '', warnings: c.warn.items };
    }
  }
  if (!isObj(doc) || doc.type !== 'doc' || !Array.isArray(doc.content)) {
    if (doc !== null && doc !== undefined) c.warn.add('ADF_INVALID', 'The rich text is not an ADF document');
    return { markdown: '', warnings: c.warn.items };
  }
  const blocks = blockNodes((doc.content as unknown[]).filter(isObj) as AdfNode[], c, 1);
  let markdown = renderMarkdown(blocks);
  if (markdown.length > ADF_LIMITS.maxOutputChars) {
    markdown = markdown.slice(0, ADF_LIMITS.maxOutputChars);
    c.warn.add('OUTPUT_TRUNCATED', 'The converted text was cut at the size limit');
  }
  return { markdown, warnings: c.warn.items };
}
