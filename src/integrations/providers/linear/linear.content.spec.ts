import { Readable } from 'node:stream';
import { ProviderHttpClient } from '../../core/provider-http.client';
import { ProviderAuthRejectedError, ProviderHttpError } from '../../core/integration.types';
import { CanonicalBundle, validateBundle } from '../../../imports/canonical';
import { DEFAULT_IMPORT_OPTIONS } from '../../../imports/imports.types';
import { LinearAdapter } from './linear.adapter';
import { LinearClient } from './linear.client';
import { CONTENT_DATASET, DATASET, FILE_A, FILE_B, FILE_EVIL, fakeLinear } from './fixtures/linear-responses';
import { fileAttachments, isLinearFileUrl, linksFooter, toComments, toHistory, uploadsIn } from './linear.normalize';

const noRedis = { configured: false, isReady: () => false } as never;
const cfg = { get: () => undefined } as never;
const make = (fake: ReturnType<typeof fakeLinear>) => {
  const http = new ProviderHttpClient(noRedis, (async (...a: unknown[]) => (await (fake.fetch as any)(...a)).clone()) as never, { bucketCapacity: 1e6, refillPerSecond: 1e6, maxRetries: 0 });
  return new LinearAdapter(cfg, http, new LinearClient(http));
};
const ctx = { connectionId: 'conn-1', externalAccountId: 'org-1', accessToken: 'tok' };
const sel = (...ids: string[]) => ({ sources: ids.map((id) => ({ id, type: 'team' })) });
const read = async (s: Readable) => { const parts: Buffer[] = []; for await (const c of s) parts.push(Buffer.from(c)); return Buffer.concat(parts).toString(); };

async function runAll(a: LinearAdapter, options = DEFAULT_IMPORT_OPTIONS, teams = ['team-eng']) {
  const pages: CanonicalBundle[] = [];
  const cursors: unknown[] = [];
  let cursor: unknown = null;
  for (let n = 0; n < 100; n++) {
    cursors.push(cursor);
    const r = await a.fetchBundle({ ctx, selection: sel(...teams), options, cursor });
    pages.push(r.bundle as CanonicalBundle);
    if (r.next === null) return { pages, cursors };
    cursor = r.next;
  }
  throw new Error('did not terminate');
}
const task = (pages: CanonicalBundle[], id: string) => pages.flatMap((p) => p.tasks ?? []).find((t) => t.externalId === id)!;

describe('Linear history -> generic field diffs (step 4.6)', () => {
  const at = '2026-02-01T10:00:00.000Z';
  it('one record that changes state AND assignee is two entries with their own external ids', () => {
    const h = toHistory([{ id: 'h1', createdAt: at, actor: { id: 'u1' }, fromState: { name: 'Todo' }, toState: { name: 'Done' }, fromAssignee: null, toAssignee: { name: 'Ana' } }]);
    expect(h).toEqual([
      { externalId: 'h1:status', at, field: 'status', actorExternalId: 'u1', from: 'Todo', to: 'Done' },
      { externalId: 'h1:assignee', at, field: 'assignee', actorExternalId: 'u1', from: null, to: 'Ana' },
    ]);
  });
  it('priorities become their labels, 0 is "No priority" (a real change), an untouched pair is no entry', () => {
    const [p] = toHistory([{ id: 'h', createdAt: at, fromPriority: 0, toPriority: 1 }]);
    expect([p.from, p.to]).toEqual(['No priority', 'Urgent']);
    expect(toHistory([{ id: 'h', createdAt: at, fromPriority: null, toPriority: null, fromState: null, toState: null }])).toEqual([]);
  });
  it('labels, estimate, cycle, archive, description, due date, title, parent, project', () => {
    const h = toHistory([{ id: 'h', createdAt: at, addedLabels: [{ name: 'Bug' }, { name: 'UI' }], removedLabels: [{ name: 'Old' }], toEstimate: 5, toCycle: { number: 3, name: null }, archived: true, updatedDescription: true, toDueDate: '2026-03-01', fromTitle: 'a', toTitle: 'b', toParent: { identifier: 'ENG-1' }, toProject: { name: 'Web' } }]);
    const by = Object.fromEntries(h.map((e) => [e.field, e]));
    expect(by['label added'].to).toBe('Bug, UI');
    expect(by['label removed'].from).toBe('Old');
    expect(by.estimate).toMatchObject({ to: '5' });
    expect(by.cycle).toMatchObject({ to: 'Cycle 3' });
    expect(by.archived).toMatchObject({ from: 'no', to: 'yes' });
    expect(by.description).toMatchObject({ to: 'edited' });
    expect(by['due date'].to).toBe('2026-03-01');
    expect(by.title).toMatchObject({ from: 'a', to: 'b' });
    expect(by.parent.to).toBe('ENG-1');
    expect(by.project.to).toBe('Web');
  });
  it('a record with no timestamp cannot be placed in time and is skipped', () => {
    expect(toHistory([{ id: 'h', toState: { name: 'Done' } }])).toEqual([]);
  });
  it('the output passes the canonical validator without a single issue', () => {
    const entries = toHistory([{ id: 'h', createdAt: at, actor: { id: 'u1' }, fromState: { name: 'Todo' }, toState: { name: 'Done' }, addedLabels: [{ name: 'Bug' }] }]);
    const v = validateBundle({ schemaVersion: 1, source: { system: 'linear', displayName: 'Linear' }, tasks: [{ externalId: 't', title: 'T', history: entries }] });
    expect('fatal' in v).toBe(false);
    if (!('fatal' in v)) { expect(v.issues).toEqual([]); expect(v.bundle.tasks![0].history).toHaveLength(2); }
  });
});

describe('Linear comments (step 4.6)', () => {
  it('author id, bot / external name, reply parent, dates; duplicates by id dropped', () => {
    const c = toComments([
      { id: 'a', body: 'x', user: { id: 'u1', name: 'Ana' }, createdAt: '2026-01-01T00:00:00.000Z', editedAt: '2026-01-02T00:00:00.000Z', parent: { id: 'p' } },
      { id: 'b', body: 'y', user: null, botActor: { name: 'Bot' } },
      { id: 'c', body: 'z', externalUser: { name: 'Slack Sam' } },
      { id: 'a', body: 'dup' },
    ]);
    expect(c.map((x) => x.externalId)).toEqual(['a', 'b', 'c']);
    expect(c[0]).toMatchObject({ authorExternalId: 'u1', authorName: 'Ana', parentExternalId: 'p', editedAt: '2026-01-02T00:00:00.000Z' });
    expect(c[1]).toMatchObject({ authorName: 'Bot' });
    expect(c[1].authorExternalId).toBeUndefined();
    expect(c[2].authorName).toBe('Slack Sam');
  });
});

describe('Linear files: only Linear\'s own file host, ever (step 4.6)', () => {
  it.each([
    ['https://uploads.linear.app/o/a/b', true],
    ['http://uploads.linear.app/o/a/b', false],
    ['https://uploads.linear.app.evil.com/o/a/b', false],
    ['https://evil.com/uploads.linear.app/o', false],
    ['https://uploads.linear.app@evil.com/x', false],
    ['https://user:pw@uploads.linear.app/x', false],
    ['https://uploads.linear.app:8443/x', false],
    ['https://linear.app/x', false],
    ['http://169.254.169.254/latest/meta-data/', false],
    ['file:///etc/passwd', false],
    ['not a url', false],
    ['', false],
  ])('%s -> %s', (url, ok) => expect(isLinearFileUrl(url)).toBe(ok));

  it('finds markdown images and links with their names, bare addresses, once each; ignores other hosts', () => {
    const md = `![shot.png](${FILE_A}) and [spec.pdf](${FILE_B} "title") and ${FILE_A} again, also ![x](${FILE_EVIL}) and https://uploads.linear.app/o/c/d.`;
    expect(uploadsIn(md)).toEqual([{ url: FILE_A, name: 'shot.png' }, { url: FILE_B, name: 'spec.pdf' }, { url: 'https://uploads.linear.app/o/c/d' }]);
  });

  it('attachments are per ISSUE, one per distinct upload, credited to the commenter, with a mime type from the extension', () => {
    const a = fileAttachments({ id: 'i1', createdAt: '2026-01-01T00:00:00.000Z', description: `![a.png](${FILE_A})` } as never, [{ id: 'c1', body: `[b.pdf](${FILE_B}) ${FILE_A}`, user: { id: 'u9' }, createdAt: '2026-01-02T00:00:00.000Z' }]);
    expect(a.map((x) => [x.fileName, x.providerRef, x.mimeType, x.uploaderExternalId])).toEqual([['a.png', FILE_A, 'image/png', undefined], ['b.pdf', FILE_B, 'application/pdf', 'u9']]);
    expect(a[0].externalId).toMatch(/^i1:[0-9a-f]{20}$/);
    const other = fileAttachments({ id: 'i2', description: `![a.png](${FILE_A})` } as never, []);
    expect(other[0].externalId).not.toBe(a[0].externalId); // same upload, another issue: another attachment
  });

  it('a hostile file name loses its path and control characters', () => {
    const [a] = fileAttachments({ id: 'i', description: `![../../etc/pass\u0000wd](${FILE_A})` } as never, []);
    expect(a.fileName).toBe('passwd');
  });

  it('link attachments: http(s) only, escaped, de-duplicated; nothing usable -> no footer', () => {
    const f = linksFooter([{ id: '1', title: 'Fix [WIP]', subtitle: 'acme/web#1', url: 'https://github.com/a/b/pull/1' }, { id: '2', title: 'x', url: 'javascript:alert(1)' }, { id: '3', title: 'dup', url: 'https://github.com/a/b/pull/1' }, { id: '4', title: 'no scheme', url: 'github.com/x' }]);
    expect(f).toBe('---\n\n**Linked in Linear**\n\n- [Fix \\[WIP\\]](https://github.com/a/b/pull/1) - acme/web#1');
    expect(linksFooter([{ id: '1', url: 'javascript:1' }])).toBeNull();
  });
});

describe('LinearAdapter content pages (step 4.6)', () => {
  it('comments (also those past the first page), history, files and links arrive in the canonical page and validate clean', async () => {
    const fake = fakeLinear(CONTENT_DATASET);
    const { pages } = await runAll(make(fake));
    const t = task(pages, 'i-eng-1');
    expect(t.comments!.map((c) => c.externalId)).toEqual(['cm-1', 'cm-2', 'cm-3', 'cm-4', 'cm-5']); // 3 on the issue page + 2 by the follow-up
    expect(fake.calls.some((c) => c.op === 'LinearIssueComments')).toBe(true);
    expect(t.comments![1].parentExternalId).toBe('cm-1');
    expect(t.history!.map((h) => h.externalId)).toEqual(['h-1:status', 'h-1:assignee', 'h-2:priority', 'h-2:label added', 'h-3:description', 'h-4:estimate', 'h-4:cycle']);
    expect(t.attachments!.map((a) => a.providerRef)).toEqual([FILE_A, FILE_B]); // FILE_A twice in the text = once; FILE_EVIL never
    expect(t.description).toContain(`![evil](${FILE_EVIL})`); // the text itself is not rewritten ...
    expect(t.description).toContain('**Linked in Linear**'); // ... but the link list is added
    expect(t.description).toContain('[Fix Safari cookies \\[WIP\\]](https://github.com/acme/web/pull/412) - acme/web#412');
    expect(t.description).not.toContain('javascript:');
    for (const p of pages) { const v = validateBundle(p); expect('fatal' in v).toBe(false); if (!('fatal' in v)) expect(v.issues.filter((i) => i.severity !== 'INFO' && i.code !== 'TITLE_EMPTY')).toEqual([]); }
  });

  it('each option off = that content is neither asked for nor emitted', async () => {
    const fake = fakeLinear(CONTENT_DATASET);
    const { pages } = await runAll(make(fake), { comments: false, history: true, attachments: false, keepDates: true });
    const issueQueries = fake.calls.filter((c) => c.op === 'LinearTeamIssues');
    expect(issueQueries.length).toBeGreaterThan(0);
    const t = task(pages, 'i-eng-1');
    expect(t.comments).toBeUndefined();
    expect(t.attachments).toBeUndefined();
    expect(t.description).not.toContain('Linked in Linear');
    expect(t.history!.length).toBeGreaterThan(0);
    expect(fake.calls.some((c) => c.op === 'LinearIssueComments' || c.op === 'LinearIssueLinks')).toBe(false);
  });

  it('with no content the page is the old big page and carries no content selection', async () => {
    const seen: string[] = [];
    const fake = fakeLinear(CONTENT_DATASET, { intercept: (op) => { void op; return undefined; } });
    const http = new ProviderHttpClient(noRedis, (async (url: unknown, init?: RequestInit) => { const b = String(init?.body ?? ''); if (b.includes('LinearTeamIssues')) seen.push(JSON.parse(b).query); return (await (fake.fetch as any)(url, init)).clone(); }) as never, { bucketCapacity: 1e6, refillPerSecond: 1e6, maxRetries: 0 });
    const a = new LinearAdapter(cfg, http, new LinearClient(http));
    await runAll(a, { comments: false, history: false, attachments: false, keepDates: true });
    expect(seen[0]).toContain('issues(first: 50');
    expect(seen[0]).not.toMatch(/comments\(first|history\(first|attachments\(first/);
    seen.length = 0;
    await runAll(a);
    expect(seen[0]).toContain('issues(first: 10');
    expect(seen[0]).toMatch(/comments\(first/);
    expect(seen[0]).toMatch(/history\(first/);
  });

  it('"too complex": the page is halved, retried, and the smaller size is remembered in the cursor', async () => {
    const asked: number[] = [];
    const fake = fakeLinear(CONTENT_DATASET, {
      intercept: (op) => {
        if (op !== 'LinearTeamIssues') return undefined;
        asked.push(asked.length);
        return asked.length <= 2 ? new Response(JSON.stringify({ errors: [{ message: 'Query too complex (complexity 12000)' }] }), { status: 400 }) : undefined;
      },
    });
    const a = make(fake);
    const first = await a.fetchBundle({ ctx, selection: sel('team-eng'), options: DEFAULT_IMPORT_OPTIONS, cursor: null });
    const second = await a.fetchBundle({ ctx, selection: sel('team-eng'), options: DEFAULT_IMPORT_OPTIONS, cursor: first.next });
    expect(second.next).toMatchObject({ ps: 2 }); // 10 -> 5 -> 2
  });

  it('a page that is too complex even at one issue fails (nothing loops)', async () => {
    const fake = fakeLinear(CONTENT_DATASET, { intercept: (op) => (op === 'LinearTeamIssues' ? new Response(JSON.stringify({ errors: [{ message: 'too complex' }] }), { status: 400 }) : undefined) });
    const a = make(fake);
    const first = await a.fetchBundle({ ctx, selection: sel('team-eng'), options: DEFAULT_IMPORT_OPTIONS, cursor: null });
    await expect(a.fetchBundle({ ctx, selection: sel('team-eng'), options: DEFAULT_IMPORT_OPTIONS, cursor: first.next })).rejects.toBeInstanceOf(ProviderHttpError);
  });

  it.each([{ v: 1, team: 0, after: null, pf: true, ps: 0 }, { v: 1, team: 0, after: null, pf: true, ps: 51 }, { v: 1, team: 0, after: null, pf: true, ps: 'x' }])('a saved cursor with a bad page size is refused: %j', async (cursor) => {
    await expect(make(fakeLinear(DATASET)).fetchBundle({ ctx, selection: sel('team-eng'), options: DEFAULT_IMPORT_OPTIONS, cursor })).rejects.toThrow(/cursor/);
  });
});

describe('LinearAdapter.fetchAttachment (step 4.6)', () => {
  it('streams the bytes with the token, size and type from the headers', async () => {
    const fake = fakeLinear(CONTENT_DATASET);
    const f = await make(fake).fetchAttachment({ ctx, providerRef: FILE_A });
    expect(await read(f.stream)).toBe('AAAA-file-a-bytes');
    expect(f.sizeBytes).toBe(17);
    expect(f.mimeType).toBe('image/png');
    expect(fake.fileCalls).toEqual([{ url: FILE_A, auth: 'Bearer tok' }]);
  });

  it.each([FILE_EVIL, 'https://uploads.linear.app.evil.com/x', 'https://uploads.linear.app@evil.com/x', 'http://uploads.linear.app/x', 'file:///etc/passwd'])('%s is never requested, and the token never leaves', async (ref) => {
    const fake = fakeLinear(CONTENT_DATASET);
    await expect(make(fake).fetchAttachment({ ctx, providerRef: ref })).rejects.toMatchObject({ status: 400 });
    expect(fake.fileCalls).toEqual([]);
    expect(fake.fetch).not.toHaveBeenCalled();
  });

  it('401 = the token is dead (the job pauses); 404 / 410 / 403 are about this file only', async () => {
    const data = { ...CONTENT_DATASET, files: { [FILE_A]: { body: 'x', status: 401 }, [FILE_B]: { body: 'x', status: 410 } } };
    await expect(make(fakeLinear(data)).fetchAttachment({ ctx, providerRef: FILE_A })).rejects.toBeInstanceOf(ProviderAuthRejectedError);
    await expect(make(fakeLinear(data)).fetchAttachment({ ctx, providerRef: FILE_B })).rejects.toMatchObject({ status: 410 });
    await expect(make(fakeLinear(CONTENT_DATASET)).fetchAttachment({ ctx, providerRef: 'https://uploads.linear.app/none' })).rejects.toMatchObject({ status: 404 });
  });

  it('a response with no Content-Length gives no size (the copier measures it)', async () => {
    const fake = fakeLinear(CONTENT_DATASET);
    const orig = fake.fetch.getMockImplementation()!;
    fake.fetch.mockImplementation(async (u: unknown, i?: RequestInit) => (String(u).startsWith('https://uploads') ? new Response('abc', { status: 200 }) : orig(u, i)));
    const f = await make(fake).fetchAttachment({ ctx, providerRef: FILE_A });
    expect(f.sizeBytes).toBeUndefined();
    expect(await read(f.stream)).toBe('abc');
  });
});
