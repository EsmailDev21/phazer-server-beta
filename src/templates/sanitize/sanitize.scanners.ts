import { badTextReason } from '../blueprint/blueprint.json-guard';
import { FindingKind, FindingSeverity } from './sanitize.types';

/**
 * Step 3.4. Text scanners. `scanText` takes one string and returns the string with everything
 * unsafe removed, plus what it did. Pure; no I/O.
 *
 * Order matters and is fixed: control chars -> secrets -> URLs -> PII -> ids -> entropy ->
 * advisory scans -> braces. Secrets run first so a URL carrying credentials is judged as a
 * credential, not as a link; entropy runs late so it only sees what the precise rules left.
 *
 * KNOWN LIMITS (written down, not hidden): a 32/40/64-char hex string is treated as a hash, not
 * a key (cannot tell them apart); entropy catches random-looking tokens, not low-entropy
 * passwords; "version 1.2.3.4" can look like an IP (public-looking IPs are only flagged for
 * review, never altered); only emails, phones, card numbers, US-style SSNs and IPs are PII
 * patterns - names and addresses are not detectable by regex and are NOT scanned.
 */
export interface TextFinding {
  kind: FindingKind;
  severity: FindingSeverity;
  detail: string;
  count: number;
}
export interface ScanOutcome {
  text: string;
  findings: TextFinding[];
  blocked: boolean;
}
export interface ScanOptions {
  onSecret: 'block' | 'redact';
  /** true: the field supports placeholders, so a literal "{{" must be escaped as "\{{". */
  templated: boolean;
  /** true: the field is one line; line breaks become spaces. */
  singleLine: boolean;
}

const SECRET = '[secret removed]';

interface SecretRule {
  label: string;
  re: RegExp;
  replace?: (m: string, ...g: string[]) => string;
}
const SECRET_RULES: SecretRule[] = [
  {
    label: 'private key block',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
  },
  {
    label: 'AWS access key id',
    re: /(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[0-9A-Z]{16}/g,
  },
  {
    label: 'GitHub token',
    re: /(?:gh[pousr]_[A-Za-z0-9]{30,255}|github_pat_[A-Za-z0-9_]{22,255})/g,
  },
  { label: 'GitLab token', re: /glpat-[A-Za-z0-9_-]{20,}/g },
  { label: 'Slack token', re: /xox[abprso]-[A-Za-z0-9-]{10,}/g },
  {
    label: 'Slack webhook',
    re: /https:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9/_-]+/g,
  },
  {
    label: 'Discord webhook',
    re: /https:\/\/(?:[a-z]+\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/g,
  },
  { label: 'Stripe key', re: /[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { label: 'Google API key', re: /AIza[0-9A-Za-z_-]{35}/g },
  {
    label: 'API key (sk- style)',
    re: /\bsk-(?:ant-|proj-|live-)?[A-Za-z0-9_-]{20,}\b/g,
  },
  { label: 'npm token', re: /npm_[A-Za-z0-9]{36}/g },
  {
    label: 'JSON web token',
    re: /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  },
  {
    label: 'bearer / basic credential',
    re: /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{20,}/g,
  },
  {
    label: 'credentials inside a URL',
    re: /\b[a-z][a-z0-9+.-]{1,15}:\/\/[^\s:@/]+:[^\s@/]+@[^\s]+/gi,
  },
  {
    label: 'password / key assignment',
    re: /\b(password|passwd|pwd|passphrase|secret|client[_-]?secret|token|access[_-]?token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|auth(?:orization)?)\b(\s*[:=]\s*)(["']?)([^\s"',;]{8,})\3/gi,
    // a value must look like a credential (a digit or a symbol), so "password: required" is prose
    replace: (m, k, sep, q, v) =>
      /[0-9]|[^A-Za-z]/.test(v) ? `${k}${sep}${SECRET}` : m,
  },
];

const EXTERNAL_REF_HOSTS: Array<{ host: RegExp; path?: RegExp }> = [
  { host: /(^|\.)atlassian\.net$/ },
  { host: /(^|\.)atlassian\.com$/ },
  { host: /(^|\.)slack\.com$/ },
  { host: /(^|\.)linear\.app$/ },
  { host: /(^|\.)notion\.(so|site)$/ },
  { host: /(^|\.)trello\.com$/ },
  { host: /(^|\.)asana\.com$/ },
  { host: /(^|\.)monday\.com$/ },
  { host: /(^|\.)clickup\.com$/ },
  { host: /(^|\.)figma\.com$/ },
  { host: /^(docs|drive|sheets|slides|calendar|mail)\.google\.com$/ },
  { host: /(^|\.)sharepoint\.com$/ },
  { host: /(^|\.)(1drv\.ms|onedrive\.live\.com)$/ },
  { host: /^discord\.com$/, path: /^\/channels\// },
  {
    host: /^(www\.)?github\.com$/,
    path: /^\/[^/]+\/[^/]+\/(issues|pull|pulls|discussions|actions|projects|commit)\b/,
  },
  {
    host: /^(www\.)?gitlab\.com$/,
    path: /\/(issues|merge_requests|pipelines|-\/(issues|merge_requests|pipelines|jobs))\b/,
  },
  { host: /^bitbucket\.org$/, path: /\/(issues|pull-requests|pipelines)\b/ },
];

const URL_RE =
  /\b[a-z][a-z0-9+.-]{1,15}:\/\/(?:\[[0-9a-f:.]+\][^\s<>"'`\\)\]]*|[^\s<>"'`\\)\]]+)/gi;
// everything up to whitespace or a quote; a trailing ")" that closes a markdown link is given back
const DANGEROUS_SCHEME_RE =
  /\b(?:javascript|vbscript|data|file|blob|about):[^\s"'`\\]*/gi;
function giveBackClosers(match: string): { body: string; tail: string } {
  let end = match.length;
  const opens = (match.match(/\(/g) ?? []).length;
  let closes = (match.match(/\)/g) ?? []).length;
  while (end > 0 && match[end - 1] === ')' && closes > opens) {
    end -= 1;
    closes -= 1;
  }
  return { body: match.slice(0, end), tail: match.slice(end) };
}
const TRAILING = /[.,;:!?]+$/;

function isInternalHost(host: string): boolean {
  const h = host.toLowerCase();
  if (
    h === 'localhost' ||
    /\.(local|localhost|internal|intranet|corp|lan|home|private|test)$/.test(h)
  )
    return true;
  if (!h.includes('.') && !h.includes(':')) return true; // single-label intranet name
  if (h.startsWith('[') || h.includes(':')) return true; // IPv6 literal
  const ip = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (ip) {
    const [a, b] = [Number(ip[1]), Number(ip[2])];
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }
  return false;
}

export function shannonEntropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Real cards are one block of 13-19 digits, or 4-4-4-4(+1..3), 4-4-4-(1..4), 4-6-5, with ONE kind of separator. */
function cardShape(w: string): boolean {
  if (/[^\d -]/.test(w) || (w.includes(' ') && w.includes('-'))) return false;
  const g = w.split(/[ -]/).map((x) => x.length);
  if (g.length === 1) return true;
  const key = g.join(',');
  return (
    /^4,4,4,4(,[1-3])?$/.test(key) ||
    /^4,4,4,[1-4]$/.test(key) ||
    key === '4,6,5'
  );
}

function luhn(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

interface Group {
  start: number;
  end: number;
  len: number;
  sepBefore: string;
}

/**
 * Digit groups joined by short separators, found in ONE pass over the text (so cost is linear in
 * the text, however hostile). `sep` says what may join two groups. Windows of consecutive groups
 * are then offered to `pick`, which returns how many groups form a hit starting at group `i`
 * (0 = none). Replaced windows are skipped; scanning resumes after them.
 */
function replaceGroupWindows(
  text: string,
  sep: RegExp,
  pick: (groups: Group[], i: number, text: string) => number,
  replacement: () => string,
): string {
  const re = new RegExp(`\\+?\\d+(?:${sep.source}\\d+)*`, 'g');
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const base = m.index;
    const groups: Group[] = [];
    const gre = /\d+/g;
    let g: RegExpExecArray | null;
    let prevEnd = -1;
    while ((g = gre.exec(m[0])) !== null) {
      groups.push({
        start: base + g.index,
        end: base + g.index + g[0].length,
        len: g[0].length,
        sepBefore: prevEnd < 0 ? '' : m[0].slice(prevEnd, g.index),
      });
      prevEnd = g.index + g[0].length;
    }
    for (let i = 0; i < groups.length;) {
      const take = pick(groups, i, text);
      if (take > 0) {
        const start =
          text[groups[i].start - 1] === '+' && groups[i].start - 1 >= base
            ? groups[i].start - 1
            : groups[i].start;
        out += text.slice(last, start) + replacement();
        last = groups[i + take - 1].end;
        i += take;
      } else i += 1;
    }
  }
  return out + text.slice(last);
}

const isWordish = (ch: string | undefined, extra = '') =>
  ch !== undefined && (/\w/.test(ch) || extra.includes(ch));

class Collector {
  private readonly map = new Map<string, TextFinding>();
  add(
    kind: FindingKind,
    severity: FindingSeverity,
    detail: string,
    n = 1,
  ): void {
    const k = `${kind}|${severity}|${detail}`;
    const f = this.map.get(k);
    if (f) f.count += n;
    else this.map.set(k, { kind, severity, detail, count: n });
  }
  get list(): TextFinding[] {
    return [...this.map.values()];
  }
}

export function scanText(input: string, opts: ScanOptions): ScanOutcome {
  const out = new Collector();
  let text = input;
  let blocked = false;

  // 1. control characters / lone surrogates
  if (badTextReason(text)) {
    text = text
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '')
      .replace(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
        '',
      );
    out.add('control-chars', 'info', 'control characters removed');
  }
  if (opts.singleLine && /[\r\n\t]/.test(text))
    text = text.replace(/[\r\n\t]+/g, ' ');

  // 2. credentials (precise patterns)
  const secretSeverity: FindingSeverity =
    opts.onSecret === 'block' ? 'blocked' : 'redacted';
  for (const rule of SECRET_RULES) {
    text = text.replace(rule.re, (m, ...g) => {
      const replaced = rule.replace
        ? rule.replace(m, ...(g as string[]))
        : SECRET;
      if (replaced === m) return m;
      out.add('secret', secretSeverity, rule.label);
      if (opts.onSecret === 'block') blocked = true;
      return replaced === SECRET || rule.replace ? replaced : SECRET;
    });
  }

  // 3. URLs
  text = text.replace(DANGEROUS_SCHEME_RE, (m) => {
    out.add('unsafe-url', 'redacted', 'script / data / file link');
    return `[unsafe link removed]${giveBackClosers(m).tail}`;
  });
  const keptHosts = new Set<string>();
  text = text.replace(URL_RE, (raw) => {
    const trail = TRAILING.exec(raw)?.[0] ?? '';
    const candidate = trail ? raw.slice(0, -trail.length) : raw;
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      out.add('unsafe-url', 'redacted', 'unparseable link');
      return `[unsafe link removed]${trail}`;
    }
    if (url.protocol !== 'https:') {
      out.add(
        'unsafe-url',
        'redacted',
        `${url.protocol.replace(':', '')} link (https only)`,
      );
      return `[unsafe link removed]${trail}`;
    }
    if (isInternalHost(url.hostname)) {
      out.add('internal-url', 'redacted', 'link to an internal host');
      return `[internal link removed]${trail}`;
    }
    if (
      EXTERNAL_REF_HOSTS.some(
        (r) =>
          r.host.test(url.hostname.toLowerCase()) &&
          (!r.path || r.path.test(url.pathname)),
      )
    ) {
      out.add(
        'external-ref-url',
        'redacted',
        'link to a private tracker / document',
      );
      return `[link removed]${trail}`;
    }
    keptHosts.add(url.hostname.toLowerCase());
    return raw;
  });
  for (const h of keptHosts) out.add('url-kept', 'review', `link kept: ${h}`);

  // 4. PII
  text = text.replace(
    /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
    () => {
      out.add('email', 'redacted', 'email address');
      return '[email removed]';
    },
  );
  text = text.replace(/(?<![\w-])\d{3}-\d{2}-\d{4}(?![\w-])/g, () => {
    out.add('national-id', 'redacted', 'SSN-shaped number');
    return '[id number removed]';
  });
  text = replaceGroupWindows(
    text,
    /[ -]/,
    (gs, i, t) => {
      if (isWordish(t[gs[i].start - 1], '-') && !(i > 0)) return 0;
      let digits = 0;
      for (let j = i; j < gs.length && digits + gs[j].len <= 19; j++) {
        digits += gs[j].len;
        if (digits < 13) continue;
        const w = t.slice(gs[i].start, gs[j].end);
        if (isWordish(t[gs[j].end])) continue;
        if (/^[2-6]/.test(w) && cardShape(w) && luhn(w.replace(/\D/g, '')))
          return j - i + 1;
      }
      return 0;
    },
    () => {
      out.add('card-number', 'redacted', 'payment card number');
      return '[card number removed]';
    },
  );
  text = replaceGroupWindows(
    text,
    /[\s().-]{1,2}/,
    (gs, i, t) => {
      if (
        i === 0 &&
        isWordish(t[gs[0].start - (t[gs[0].start - 1] === '+' ? 2 : 1)], '/.-')
      )
        return 0;
      const plus = t[gs[i].start - 1] === '+';
      let digits = 0;
      for (let j = i; j < gs.length && digits + gs[j].len <= 15; j++) {
        digits += gs[j].len;
        if (
          j > i &&
          /-/.test(gs[j].sepBefore) === false &&
          /-/.test(t.slice(gs[i].end, gs[j].start)) &&
          j > i
        ) {
          return 0; // "-" then a plain space: two numbers written next to each other
        }
        if (digits < 9) continue;
        const w = t.slice(gs[i].start, gs[j].end);
        if (isWordish(t[gs[j].end])) continue;
        const seps = (w.match(/[\s().-]/g) ?? []).length;
        if (!plus && seps < 2) continue;
        if (/\d{4}-\d{2}-\d{2}/.test(w) || /^\d+(\.\d+){2,}$/.test(w)) return 0; // dates and versions
        // take the shortest window, then keep going while the next group is a short continuation ("+33 1 23 45 67 89")
        let end = j;
        while (
          end + 1 < gs.length &&
          gs[end + 1].len <= 2 &&
          digits + gs[end + 1].len <= 15 &&
          gs[end + 1].sepBefore === gs[end].sepBefore
        ) {
          end += 1;
          digits += gs[end].len;
        }
        return end - i + 1;
      }
      return 0;
    },
    () => {
      out.add('phone', 'redacted', 'phone number');
      return '[phone removed]';
    },
  );
  text = text.replace(
    /(?<![\w.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?![\w.])/g,
    (m) => {
      if (isInternalHost(m)) {
        out.add('internal-ip', 'redacted', 'private / loopback IP address');
        return '[ip removed]';
      }
      out.add('public-ip', 'review', 'IP-address-shaped text (left as is)');
      return m;
    },
  );

  // 5. internal ids
  text = text.replace(
    /\bc(?=[a-z0-9]{24}\b)(?=[a-z]*\d)[a-z0-9]{24}\b/g,
    () => {
      out.add('internal-id', 'redacted', 'database-id-shaped value');
      return '[id removed]';
    },
  );

  // 6. high-entropy tokens (never blocking)
  text = text.replace(
    /(?<![A-Za-z0-9+/_=-])[A-Za-z0-9+/_=-]{28,}(?![A-Za-z0-9+/_=-])/g,
    (m) => {
      if (/^[0-9a-f]+$/i.test(m)) return m; // hashes
      const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter((r) =>
        r.test(m),
      ).length;
      if (classes < 2 || shannonEntropy(m) < 4.0) return m;
      out.add('entropy-secret', 'redacted', 'long random-looking token');
      return '[secret removed]';
    },
  );

  // 7. advisory scans (text unchanged)
  const handles = text.match(/(?<![\w.@])@[A-Za-z0-9_][A-Za-z0-9_.-]{1,30}/g);
  if (handles)
    out.add('handle', 'review', '@handle-shaped text', handles.length);
  const refs = text.match(/\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b/g);
  if (refs)
    out.add(
      'task-reference',
      'info',
      'mentions another task by key; it will not resolve',
      refs.length,
    );

  // 8. keep the text from being read as a placeholder
  if (text.includes('{{')) {
    text = opts.templated
      ? text.replace(/\{\{/g, '\\{{')
      : text.replace(/\{\{/g, '{ {');
    out.add(
      'braces',
      'info',
      opts.templated ? '"{{" escaped' : '"{{" adjusted',
    );
  }

  return { text, findings: out.list, blocked };
}

/** An https URL that may be kept as a custom URL value, or why not. */
export function urlValueProblem(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'not a URL';
  }
  if (url.protocol !== 'https:') return 'not https';
  if (url.username || url.password) return 'contains credentials';
  if (isInternalHost(url.hostname)) return 'internal host';
  if (
    EXTERNAL_REF_HOSTS.some(
      (r) =>
        r.host.test(url.hostname.toLowerCase()) &&
        (!r.path || r.path.test(url.pathname)),
    )
  )
    return 'private tracker / document link';
  if (
    SECRET_RULES.some((r) => {
      r.re.lastIndex = 0;
      return r.re.test(value);
    })
  )
    return 'looks like a credential';
  return null;
}
