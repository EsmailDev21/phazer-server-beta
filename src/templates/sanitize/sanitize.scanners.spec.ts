import { scanText, shannonEntropy, urlValueProblem } from './sanitize.scanners';

// Fake credentials are assembled from pieces so THIS FILE never contains a string a secret
// scanner (ours or GitHub's push protection) would flag.
const rep = (s: string, n: number) => s.repeat(n);
const FAKE = {
  github: 'gh' + 'p_' + rep('aB3dE5', 7),
  githubPat: 'github' + '_pat_' + rep('Ab1Cd2Ef3G', 3),
  awsKey: 'AK' + 'IA' + 'IOSFODNN7EXAMPLE',
  slack: 'xo' + 'xb-' + '1234567890-' + 'abcdefghijkl',
  slackHook:
    'https://hooks.' +
    'slack.com/' +
    'services/T0000000/B0000000/' +
    rep('Xy9', 8),
  discordHook:
    'https://discord' +
    '.com/api/' +
    'webhooks/123456789012345678/' +
    rep('aZ_9', 10),
  stripe: 'sk_' + 'live_' + rep('a1B2c3', 4),
  google: 'AI' + 'za' + rep('Ab1_-', 7),
  jwt:
    'ey' +
    'JhbGciOiJIUzI1NiJ9.' +
    'ey' +
    'JzdWIiOiIxMjM0NTY3ODkwIn0.' +
    'dozjgNryP4J3jVmNHl0w5N',
  skKey: 'sk-' + 'ant-' + rep('Ab1Cd2', 5),
  npm: 'npm' + '_' + rep('aB1cD2eF3g', 4).slice(0, 36),
  gitlab: 'gl' + 'pat-' + rep('aB1cD2eF3g', 3),
  random: 'q8Zr3kLm0XvB7nTjP2wYc5Hd9FgA1sEu',
  pem:
    '-----BEGIN ' +
    'RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA7\n-----END ' +
    'RSA PRIVATE KEY-----',
  urlCreds: 'https://admin:' + 'hunter2hunter2' + '@db.example.com/x',
  pgUrl: 'postgres' + '://app:' + 'S3cr3tPassw0rd' + '@10.0.0.5:5432/prod',
  bearer: 'Bearer ' + 'abcdefghijklmnopqrstuvwxyz0123456789',
  assignment: 'pass' + 'word: ' + 'Tr0ub4dor&3xyz',
  apiKeyAssign: 'API_' + 'KEY=' + 'live_9f8e7d6c5b4a',
};
const scan = (t: string, o: Partial<Parameters<typeof scanText>[1]> = {}) =>
  scanText(t, { onSecret: 'block', templated: false, singleLine: false, ...o });
const kinds = (t: string, o = {}) => scan(t, o).findings.map((f) => f.kind);

describe('credentials', () => {
  it.each(
    Object.entries({
      github: FAKE.github,
      githubPat: FAKE.githubPat,
      aws: FAKE.awsKey,
      slack: FAKE.slack,
      slackHook: FAKE.slackHook,
      discordHook: FAKE.discordHook,
      stripe: FAKE.stripe,
      google: FAKE.google,
      jwt: FAKE.jwt,
      skKey: FAKE.skKey,
      npm: FAKE.npm,
      gitlab: FAKE.gitlab,
      pem: FAKE.pem,
      urlCreds: FAKE.urlCreds,
      pgUrl: FAKE.pgUrl,
      bearer: FAKE.bearer,
      assignment: FAKE.assignment,
      apiKeyAssign: FAKE.apiKeyAssign,
    }),
  )('%s: blocks, removes the text, and never echoes it', (name, secret) => {
    const r = scan(`before ${secret} after`);
    expect(r.blocked).toBe(true);
    expect(
      r.findings.some((f) => f.kind === 'secret' && f.severity === 'blocked'),
    ).toBe(true);
    expect(r.text).not.toContain(secret.slice(4, 20 + 4));
    expect(r.text.startsWith('before ')).toBe(true);
    expect(r.text.endsWith(' after') || name === 'pem').toBe(true);
    expect(JSON.stringify(r.findings)).not.toContain(secret.slice(5, 25));
  });

  it("onSecret: 'redact' removes without blocking", () => {
    const r = scan(`key ${FAKE.github}`, { onSecret: 'redact' });
    expect(r.blocked).toBe(false);
    expect(r.text).toBe('key [secret removed]');
    expect(r.findings[0]).toMatchObject({
      kind: 'secret',
      severity: 'redacted',
    });
  });

  it('an assignment keeps the key name and drops the value', () => {
    expect(scan(FAKE.assignment).text).toBe('password: [secret removed]');
    expect(scan(FAKE.apiKeyAssign, { onSecret: 'redact' }).text).toBe(
      'API_KEY=[secret removed]',
    );
  });

  it('prose that merely mentions passwords or tokens is not a credential', () => {
    for (const t of [
      'password: required',
      'The token: expires soon',
      'secret: none',
      'Reset the password for the admin account',
      'api key: ask Dana',
      'token = refresh',
    ]) {
      expect(scan(t).blocked).toBe(false);
      expect(scan(t).text).toBe(t);
    }
  });

  it('several credentials in one text are all removed', () => {
    const r = scan(`${FAKE.github} and ${FAKE.awsKey} and ${FAKE.stripe}`, {
      onSecret: 'redact',
    });
    expect(r.text).toBe(
      '[secret removed] and [secret removed] and [secret removed]',
    );
  });
});

describe('high-entropy tokens', () => {
  it('flags a random-looking token, but never blocks on it', () => {
    const r = scan(`use ${FAKE.random} for it`);
    expect(r.blocked).toBe(false);
    expect(r.findings).toEqual([
      expect.objectContaining({ kind: 'entropy-secret', severity: 'redacted' }),
    ]);
    expect(r.text).toBe('use [secret removed] for it');
  });
  it('leaves ordinary long words, identifiers, hashes, uuids and paths alone', () => {
    for (const t of [
      'internationalization-and-localization-support',
      'Pneumonoultramicroscopicsilicovolcanoconiosis',
      'refactorTheAuthenticationMiddlewareLayer',
      'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3', // sha1
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', // sha256
      '123e4567-e89b-12d3-a456-426614174000',
      'src/components/authentication/LoginForm/index',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    ]) {
      expect(
        scan(t).findings.filter((f) => f.kind === 'entropy-secret'),
      ).toEqual([]);
    }
  });
  it('entropy maths', () => {
    expect(shannonEntropy('aaaa')).toBe(0);
    expect(shannonEntropy('abcd')).toBeCloseTo(2, 5);
    expect(shannonEntropy(FAKE.random)).toBeGreaterThan(4);
  });
});

describe('PII', () => {
  it('emails', () => {
    const r = scan('mail dana.k+x@example.co.uk or DANA@EXAMPLE.COM now');
    expect(r.text).toBe('mail [email removed] or [email removed] now');
    expect(r.findings[0]).toMatchObject({
      kind: 'email',
      severity: 'redacted',
      count: 2,
    });
  });
  it.each([
    ['+1 (555) 123-4567', true],
    ['555-123-4567', true],
    ['+44 20 7946 0958', true],
    ['07911 123 456', true],
    ['+33123456789', true],
    ['2026-09-01', false],
    ['Version 1.2.3.4567', false],
    ['order 12345678', false],
    ['ticket 1234567890', false],
    ['10:30-11:45', false],
    ['2026-09-01 10:30', false],
    ['3.14159265358', false],
  ])('phone: %s -> %s', (t, hit) => {
    expect(kinds(`call ${t} today`).includes('phone')).toBe(hit);
  });
  it('card numbers need a valid Luhn checksum', () => {
    expect(scan('pay 4242 4242 4242 4242 now').text).toBe(
      'pay [card number removed] now',
    );
    expect(
      scan('pay 4242-4242-4242-4241 now').findings.some(
        (f) => f.kind === 'card-number',
      ),
    ).toBe(false);
    expect(
      scan('id 1234567890123456789').findings.some(
        (f) => f.kind === 'card-number',
      ),
    ).toBe(false);
  });
  it('a card or phone number NEXT TO another number is still found', () => {
    expect(scan('pay 4242 4242 4242 4242 10.1.2.3').text).toBe(
      'pay [card number removed] [ip removed]',
    );
    expect(scan('order 77 4242 4242 4242 4242').text).toBe(
      'order 77 [card number removed]',
    );
    expect(scan('4242424242424242 12').text).toBe('[card number removed] 12');
    expect(scan('call 555-123-4567 555-987-6543').text).toBe(
      'call [phone removed] [phone removed]',
    );
    expect(scan('x 555-123-4567, 555-987-6543, +1 555 000 1111').text).toBe(
      'x [phone removed], [phone removed], [phone removed]',
    );
  });
  it('SSN-shaped numbers', () => {
    expect(scan('ssn 123-45-6789.').text).toBe('ssn [id number removed].');
    expect(kinds('2026-09-01')).toEqual([]);
  });
  it('IP addresses: private ones are removed, public-looking ones only flagged', () => {
    expect(scan('db at 10.0.0.5 and 192.168.1.20 and 127.0.0.1').text).toBe(
      'db at [ip removed] and [ip removed] and [ip removed]',
    );
    const pub = scan('server 8.8.8.8 here');
    expect(pub.text).toBe('server 8.8.8.8 here');
    expect(pub.findings[0]).toMatchObject({
      kind: 'public-ip',
      severity: 'review',
    });
    expect(kinds('999.1.1.1')).toEqual([]);
  });
  it('database-id-shaped values', () => {
    expect(scan('see cmgx8d0a30000qz1ghv7k2x9p now').text).toBe(
      'see [id removed] now',
    );
    expect(kinds('constructorconstructorconst')).toEqual([]);
  });
});

describe('URLs', () => {
  it.each([
    ['javascript:alert(1)', '[unsafe link removed]'],
    ['[x](javascript:alert(1))', '[x]([unsafe link removed])'],
    ['data:text/html,<b>1</b>', '[unsafe link removed]'],
    ['vbscript:msgbox', '[unsafe link removed]'],
    ['file:///etc/passwd', '[unsafe link removed]'],
    ['http://example.com/x', '[unsafe link removed]'],
    ['ftp://example.com/x', '[unsafe link removed]'],
    ['https://localhost:3000/admin', '[internal link removed]'],
    ['https://192.168.0.7/x', '[internal link removed]'],
    ['https://intranet/wiki', '[internal link removed]'],
    ['https://wiki.corp/page', '[internal link removed]'],
    ['https://[::1]/x', '[internal link removed]'],
    ['https://acme.atlassian.net/browse/ENG-1', '[link removed]'],
    ['https://github.com/acme/app/issues/12', '[link removed]'],
    ['https://github.com/acme/app/pull/3', '[link removed]'],
    ['https://acme.slack.com/archives/C1/p1', '[link removed]'],
    ['https://www.notion.so/Page-123', '[link removed]'],
    ['https://docs.google.com/document/d/abc/edit', '[link removed]'],
    ['https://linear.app/acme/issue/ENG-1', '[link removed]'],
  ])('%s', (url, expected) => {
    expect(scan(`see ${url} please`).text).toBe(`see ${expected} please`);
  });
  it('keeps ordinary https links, listing the host for review, and keeps trailing punctuation', () => {
    const r = scan(
      'Docs: https://developer.mozilla.org/en-US/docs/Web, and https://github.com/acme/app.',
    );
    expect(r.text).toBe(
      'Docs: https://developer.mozilla.org/en-US/docs/Web, and https://github.com/acme/app.',
    );
    expect(
      r.findings.map((f) => [f.kind, f.severity, f.detail]).sort(),
    ).toEqual([
      ['url-kept', 'review', 'link kept: developer.mozilla.org'],
      ['url-kept', 'review', 'link kept: github.com'],
    ]);
    expect(scan('go to https://localhost:3000/x.').text).toBe(
      'go to [internal link removed].',
    );
  });
  it('urlValueProblem (for custom URL values)', () => {
    expect(urlValueProblem('https://example.com/brief')).toBeNull();
    for (const bad of [
      'http://example.com',
      'nope',
      'https://user:pw@example.com',
      'https://localhost/x',
      'https://acme.atlassian.net/x',
      'javascript:alert(1)',
    ]) {
      expect(urlValueProblem(bad)).not.toBeNull();
    }
  });
});

describe('advisory scans and text hygiene', () => {
  it('notes @handles and other-task references without changing the text', () => {
    const r = scan('ask @dana about ENG-123 and ENG-9');
    expect(r.text).toBe('ask @dana about ENG-123 and ENG-9');
    expect(r.findings.map((f) => [f.kind, f.severity, f.count]).sort()).toEqual(
      [
        ['handle', 'review', 1],
        ['task-reference', 'info', 2],
      ],
    );
    expect(kinds('mail a@b.co')).not.toContain('handle');
  });
  it('control characters and lone surrogates are removed', () => {
    expect(scan('a\u0000b\u0007c\ud800d').text).toBe('abcd');
    expect(kinds('a\u0000b')).toEqual(['control-chars']);
  });
  it('single-line fields lose their line breaks', () => {
    expect(scan('a\nb\r\nc\td', { singleLine: true }).text).toBe('a b c d');
    expect(scan('a\nb').text).toBe('a\nb');
  });
  it('"{{" is escaped where placeholders exist and neutralised where they do not', () => {
    expect(scan('use {{x}} here', { templated: true }).text).toBe(
      'use \\{{x}} here',
    );
    expect(scan('use {{x}} here', { templated: false }).text).toBe(
      'use { {x}} here',
    );
    expect(kinds('{{x}}')).toEqual(['braces']);
  });
});

describe('robustness', () => {
  it('never throws and is idempotent: scanning clean output changes nothing (4000 random texts)', () => {
    let seed = 41;
    const next = (n: number) =>
      (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
    const bits = [
      FAKE.github,
      FAKE.random,
      FAKE.awsKey,
      'a@b.co',
      '10.0.0.1',
      'https://x.io/a',
      'http://x.io',
      ' ',
      '\n',
      '{{',
      '}}',
      '\\',
      'javascript:x',
      '4242 4242 4242 4242',
      '+1 555 123 4567',
      'word',
      '2026-09-01',
      '@dana',
      'ENG-12',
      '\u0000',
      'é',
      '😀',
      'password: abc12345',
      FAKE.pem,
    ];
    for (let i = 0; i < 4000; i++) {
      let t = '';
      for (let j = next(12); j > 0; j--)
        t += bits[next(bits.length)] + (next(2) ? ' ' : '');
      for (const templated of [true, false]) {
        const opts = {
          onSecret: 'redact' as const,
          templated,
          singleLine: false,
        };
        const once = scanText(t, opts);
        const twice = scanText(once.text, opts);
        if (templated) continue; // escaping "\{{" is intentionally not a fixed point
        expect(twice.text).toBe(once.text);
        expect(
          twice.findings.filter(
            (f) => f.severity === 'redacted' || f.severity === 'blocked',
          ),
        ).toEqual([]);
      }
    }
  });

  it('is linear on hostile input (100k characters, every shape)', () => {
    const shapes = [
      'a'.repeat(100_000),
      'a.'.repeat(50_000),
      'a@'.repeat(50_000),
      `a@${'a.'.repeat(50_000)}`,
      '1 '.repeat(50_000),
      '1-'.repeat(50_000),
      'a:'.repeat(50_000),
      'https://'.repeat(12_000),
      'http://a:b'.repeat(10_000),
      `-----BEGIN PRIVATE KEY-----${'x'.repeat(100_000)}`,
      '{{'.repeat(50_000),
      '\\'.repeat(100_000),
      '@'.repeat(100_000),
      'A-1 '.repeat(25_000),
      `+${'1'.repeat(100_000)}`,
      '1.'.repeat(50_000),
      'password='.repeat(10_000),
      'Bearer '.repeat(14_000),
      'xoxb-'.repeat(20_000),
      '\u0000'.repeat(100_000),
    ];
    const t0 = Date.now();
    for (const s of shapes) scan(s, { onSecret: 'redact' });
    expect(Date.now() - t0).toBeLessThan(4000);
  });
});
