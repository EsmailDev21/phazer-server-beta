import * as commonmark from 'commonmark';

/** Test-only: parse with the CommonMark reference implementation and report what a reader would SEE. */
export function parse(md: string) {
  return new commonmark.Parser().parse(md);
}

export function html(md: string): string {
  // safe: true => raw HTML and unsafe URLs are neutralised by the renderer; we also assert on the AST below
  return new commonmark.HtmlRenderer({ safe: true }).render(parse(md));
}

/** Block types of the document's direct children, e.g. ['paragraph', 'list']. */
export function topLevel(md: string): string[] {
  const out: string[] = [];
  for (let n = parse(md).firstChild; n; n = n.next) out.push(n.type);
  return out;
}

/** Concatenated literal text of every text / code leaf, with soft and hard breaks as "\n". */
export function visibleText(md: string): string {
  const w = parse(md).walker();
  let out = '';
  for (let e = w.next(); e; e = w.next()) {
    const n = e.node;
    if (!e.entering) continue;
    if (n.type === 'text' || n.type === 'code' || n.type === 'code_block') out += n.literal ?? '';
    else if (n.type === 'softbreak' || n.type === 'linebreak') out += '\n';
  }
  return out;
}

/** Every node type that occurs anywhere in the document. */
export function nodeTypes(md: string): Set<string> {
  const w = parse(md).walker();
  const out = new Set<string>();
  for (let e = w.next(); e; e = w.next()) if (e.entering) out.add(e.node.type);
  return out;
}

export function destinations(md: string): string[] {
  const w = parse(md).walker();
  const out: string[] = [];
  for (let e = w.next(); e; e = w.next()) {
    if (e.entering && (e.node.type === 'link' || e.node.type === 'image')) out.push(e.node.destination ?? '');
  }
  return out;
}
