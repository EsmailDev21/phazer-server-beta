/**
 * Step 4.2. The tiny document model both rich-text converters (ADF, HTML) build, and the ONE renderer
 * (md-render.ts) turns into markdown. Converters decide WHAT the content is; the renderer alone decides how
 * markdown is written and escaped, so "does this source text come out as literal text, not as formatting"
 * is tested in one place.
 */
export type Mark = 'strong' | 'em' | 'strike';

export type Inline =
  | { t: 'text'; text: string; marks: readonly Mark[] }
  | { t: 'code'; text: string }
  | { t: 'br' }
  | { t: 'link'; href: string; children: Inline[] }
  | { t: 'image'; alt: string; src: string };

export type Block =
  | { t: 'p'; inlines: Inline[] }
  | { t: 'h'; level: number; inlines: Inline[] }
  | { t: 'quote'; blocks: Block[] }
  /** `checked[i]`: null = ordinary item, true/false = task item. */
  | { t: 'ul'; items: Block[][]; checked?: Array<boolean | null> }
  | { t: 'ol'; start: number; items: Block[][] }
  | { t: 'code'; lang: string; text: string }
  | { t: 'hr' }
  /** Cells are flattened to inline content (GFM cells cannot hold blocks). Row 0 is the header. */
  | { t: 'table'; rows: Inline[][][] };

export interface NormalizeWarning {
  code: string;
  message: string;
}

/** Collects warnings once per (code, detail) so a 10 000-node document cannot produce 10 000 identical lines. */
export class Warnings {
  private readonly seen = new Set<string>();
  readonly items: NormalizeWarning[] = [];
  constructor(private readonly max = 50) {}

  add(code: string, message: string, detail = ''): void {
    const k = `${code}|${detail}`;
    if (this.seen.has(k) || this.items.length >= this.max) return;
    this.seen.add(k);
    this.items.push({ code, message });
  }
}

/** Only these schemes survive into a link or image. `javascript:`, `data:`, `vbscript:` and friends are dropped. */
const SAFE_LINK = /^(https?:|mailto:|tel:)/i;
const SAFE_IMAGE = /^https?:/i;

export function safeLinkUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // Browsers ignore tabs / newlines / other controls inside a scheme ("java\tscript:"): remove them BEFORE judging, and
  // return the cleaned string, so what we test is what a browser would act on. Plain spaces stay (encodeUrl handles them).
  // eslint-disable-next-line no-control-regex
  const u = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
  if (u.length === 0 || u.length > 2048) return null;
  return SAFE_LINK.test(u) ? u : null;
}

export function safeImageUrl(raw: unknown): string | null {
  const u = safeLinkUrl(raw);
  return u && SAFE_IMAGE.test(u) ? u : null;
}
