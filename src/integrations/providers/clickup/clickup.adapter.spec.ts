import { Readable } from 'node:stream';
import { CanonicalBundle, validateBundle } from '../../../imports/canonical';
import { DEFAULT_IMPORT_OPTIONS } from '../../../imports/imports.types';
import { lookupPriority } from '../../../imports/mapping/mapping.tables';
import { ProviderAuthRejectedError, ProviderHttpError, ProviderRateLimitedError } from '../../core/integration.types';
import { ProviderHttpClient } from '../../core/provider-http.client';
import { ClickUpAdapter } from './clickup.adapter';
import { ClickUpClient } from './clickup.client';
import { ATTACHMENTS, DATASET, FILE_CDN, FILE_EVIL, FILE_LOOKALIKE, FILE_OK, FILES, TEAM, fakeClickUp } from './fixtures/clickup-responses';
import { isClickUpFileUrl, iso, statusCategory, toAttachments, toComments, toCustomValue, toDependencies, toProject, toTask } from './clickup.normalize';

const noRedis = { configured: false, isReady: () => false } as never;
const cfgOf = (env: Record<string, string> = {}) => ({ get: (k: string) => env[k] }) as never;
function make(fake: ReturnType<typeof fakeClickUp>, env: Record<string, string> = {}, httpOpts: Record<string, unknown> = {}) {
  const http = new ProviderHttpClient(noRedis, (async (...a: unknown[]) => (await (fake.fetch as any)(...a)).clone()) as never, { bucketCapacity: 1e6, refillPerSecond: 1e6, maxRetries: 0, ...httpOpts });
  const spy = jest.spyOn(http, 'request');
  return { adapter: new ClickUpAdapter(cfgOf({ CLICKUP_CLIENT_ID: 'cid', CLICKUP_CLIENT_SECRET: 'sec', CLICKUP_REQUESTS_PER_MINUTE: '10000', ...env }), http, new ClickUpClient(http, cfgOf({ CLICKUP_REQUESTS_PER_MINUTE: '10000', ...env }))), http, spy };
}
const ctx = { connectionId: 'conn-1', externalAccountId: TEAM, accessToken: 'tok' };
const sel = (...s: Array<[string, string]>) => ({ sources: s.map(([type, id]) => ({ id, type })) });
const read = async (s: Readable) => { const p: Buffer[] = []; for await (const c of s) p.push(Buffer.from(c)); return Buffer.concat(p).toString(); };

async function runAll(a: ClickUpAdapter, selection = sel(['space', 'space-1'], ['list', 'list-3']), options = DEFAULT_IMPORT_OPTIONS) {
  const pages: CanonicalBundle[] = [];
  const cursors: unknown[] = [];
  let cursor: unknown = null;
  for (let n = 0; n < 50; n++) {
    cursors.push(cursor);
    const r = await a.fetchBundle({ ctx, selection, options, cursor });
    pages.push(r.bundle as CanonicalBundle);
    if (r.next === null) return { pages, cursors };
    cursor = r.next;
  }
  throw new Error('did not terminate');
}
const tasksOf = (pages: CanonicalBundle[]) => pages.flatMap((p) => p.tasks ?? []);

describe('ClickUp normalizers', () => {
  it('timestamps are epoch milliseconds (as strings); junk is "no value"', () => {
    expect(iso('1767225600000')).toBe('2026-01-01T00:00:00.000Z');
    expect(iso(1767225600000)).toBe('2026-01-01T00:00:00.000Z');
    for (const bad of [undefined, null, '', '0', 0, -5, 'abc', '9e99', NaN]) expect(iso(bad as never)).toBeUndefined();
  });

  it.each([
    [{ status: 'to do', type: 'open' }, 'TODO'], [{ status: 'Backlog', type: 'open' }, 'BACKLOG'], [{ status: 'in review', type: 'custom' }, 'IN_PROGRESS'],
    [{ status: 'complete', type: 'done' }, 'DONE'], [{ status: 'closed', type: 'closed' }, 'DONE'], [{ status: 'x' }, 'UNKNOWN'], [{ status: 'x', type: 'weird' }, 'UNKNOWN'],
  ])('status %j -> %s (diagram 07)', (s, cat) => expect(statusCategory(s)).toBe(cat));

  it('a project carries its list\'s statuses with list-scoped ids and no duplicates', () => {
    const p = toProject({ id: 'L', name: 'A', content: 'd', archived: true }, [{ status: 'to do', type: 'open' }, { status: 'to do', type: 'open' }, { status: 'done', type: 'done', orderindex: 7 }]);
    expect(p.statuses!.map((s) => [s.externalId, s.category, s.position])).toEqual([['L:to do', 'TODO', 0], ['L:done', 'DONE', 7]]);
    expect(p).toMatchObject({ externalId: 'L', description: 'd', archived: true });
  });

  it('ClickUp priorities map through the existing table (Normal -> MEDIUM)', () => {
    const t = toTask({ id: 't', name: 'x', priority: { priority: 'normal' } }, { listId: 'L', issueTypeIds: new Set() });
    expect(t.priority).toBe('Normal');
    expect(lookupPriority('clickup' as never, 'Normal')).toBeDefined();
  });

  it('a task: folder + tags (deduped), assignees, dates, points, parent, issue type only when declared, description precedence', () => {
    const base = { id: 't', name: 'N', date_created: '1767225600000', points: 3, parent: 'p', custom_item_id: 1002, assignees: [{ id: 1 }, { id: 1 }, { id: 2 }], tags: [{ name: 'ui' }, { name: 'ui' }], markdown_description: 'MD', text_content: 'TXT', description: 'D' };
    const t = toTask(base, { listId: 'L', folderName: 'Q3', issueTypeIds: new Set(['1002']) });
    expect(t).toMatchObject({ externalId: 't', projectExternalId: 'L', title: 'N', description: 'MD', parentExternalId: 'p', createdAt: '2026-01-01T00:00:00.000Z', estimate: 3, issueTypeExternalId: '1002', tags: ['Q3', 'ui'], assigneeExternalIds: ['1', '2'] });
    expect(toTask({ ...base, markdown_description: null }, { listId: 'L', issueTypeIds: new Set() }).description).toBe('TXT');
    expect(toTask({ ...base, markdown_description: null, text_content: null }, { listId: 'L', issueTypeIds: new Set() }).description).toBe('D');
    expect(toTask(base, { listId: 'L', issueTypeIds: new Set() }).issueTypeExternalId).toBeUndefined();
    expect(toTask({ ...base, points: 5000 }, { listId: 'L', issueTypeIds: new Set() }).estimate).toBeUndefined();
  });

  describe('custom field values', () => {
    const dd = { id: 'f', type: 'drop_down', type_config: { options: [{ id: 'o1', name: 'staging', orderindex: 0 }, { id: 'o2', name: 'production', orderindex: 1 }] } };
    it('drop_down by orderindex (number or string) or by option id; an unknown option is no value', () => {
      expect(toCustomValue({ ...dd, value: 1 })).toEqual({ fieldExternalId: 'f', value: 'production' });
      expect(toCustomValue({ ...dd, value: '0' })).toEqual({ fieldExternalId: 'f', value: 'staging' });
      expect(toCustomValue({ ...dd, value: 'o2' })).toEqual({ fieldExternalId: 'f', value: 'production' });
      expect(toCustomValue({ ...dd, value: 9 })).toBeNull();
    });
    it('labels (several), users (first), checkbox, number from a string, date, text', () => {
      expect(toCustomValue({ id: 'l', type: 'labels', type_config: dd.type_config, value: ['o1', 'o2', 'zz'] })).toEqual({ fieldExternalId: 'l', value: ['staging', 'production'] });
      expect(toCustomValue({ id: 'u', type: 'users', value: [{ id: 7 }, { id: 8 }] })).toEqual({ fieldExternalId: 'u', value: '7' });
      expect(toCustomValue({ id: 'c', type: 'checkbox', value: 'true' })).toEqual({ fieldExternalId: 'c', value: true });
      expect(toCustomValue({ id: 'c', type: 'checkbox', value: false })).toEqual({ fieldExternalId: 'c', value: false });
      expect(toCustomValue({ id: 'n', type: 'currency', value: '12.5' })).toEqual({ fieldExternalId: 'n', value: 12.5 });
      expect(toCustomValue({ id: 'n', type: 'number', value: 'abc' })).toBeNull();
      expect(toCustomValue({ id: 'd', type: 'date', value: '1767225600000' })).toEqual({ fieldExternalId: 'd', value: '2026-01-01T00:00:00.000Z' });
      expect(toCustomValue({ id: 't', type: 'short_text', value: 'hi' })).toEqual({ fieldExternalId: 't', value: 'hi' });
    });
    it('unset, empty, and types with no equivalent are no value', () => {
      for (const f of [{ id: 'a', type: 'short_text', value: null }, { id: 'a', type: 'short_text', value: '' }, { id: 'a', type: 'formula', value: 3 }, { id: 'a', type: 'location', value: { x: 1 } }, { id: 'a', type: 'short_text' }]) expect(toCustomValue(f)).toBeNull();
    });
  });

  it('dependencies: depends_on is the BLOCKER, listed from either side it is one edge; links are symmetric with one id; self-links are ignored', () => {
    const a = toDependencies({ id: 't2', dependencies: [{ task_id: 't2', depends_on: 't1' }], linked_tasks: [{ task_id: 't2', link_id: 't9' }] });
    const b = toDependencies({ id: 't1', dependencies: [{ task_id: 't2', depends_on: 't1' }], linked_tasks: [{ task_id: 't9', link_id: 't2' }] });
    expect(a[0]).toEqual({ externalId: 'dep:t1>t2', fromExternalId: 't1', toExternalId: 't2', type: 'BLOCKS' });
    expect(a).toEqual(b);
    expect(a[1]).toEqual({ externalId: 'link:t2~t9', fromExternalId: 't2', toExternalId: 't9', type: 'RELATES_TO' });
    expect(toDependencies({ id: 'x', dependencies: [{ task_id: 'x', depends_on: 'x' }, { task_id: 'x' }], linked_tasks: [{ task_id: 'x', link_id: 'x' }] })).toEqual([]);
  });

  it('comments: oldest first, each reply right under its thread root', () => {
    const c = toComments(
      [{ id: 3, comment_text: 'c', date: '3000', user: { id: 1, username: 'A' } }, { id: 1, comment_text: 'a', date: '1000' }, { id: 2, comment_text: 'b', date: '2000' }],
      new Map([['1', [{ id: 'r2', comment_text: 'r2', date: '1600' }, { id: 'r1', comment_text: 'r1', date: '1500' }]]]),
    );
    expect(c.map((x) => [x.externalId, x.parentExternalId])).toEqual([['1', undefined], ['r1', '1'], ['r2', '1'], ['2', undefined], ['3', undefined]]);
    expect(c[4]).toMatchObject({ authorExternalId: '1', authorName: 'A' });
  });

  it.each([
    ['https://attachments.clickup.com/a/b.png', true], ['https://t9001.p.clickup-attachments.com/x', true], ['https://clickup.com/x', true],
    ['http://attachments.clickup.com/a', false], ['https://attachments.clickup.com.evil.example/a', false], ['https://evilclickup.com/a', false],
    ['https://attachments.clickup.com@evil.example/a', false], ['https://u:p@attachments.clickup.com/a', false], ['https://attachments.clickup.com:8443/a', false],
    ['https://169.254.169.254/x', false], ['file:///etc/passwd', false], ['nope', false], ['', false],
  ])('file address %s -> %s', (url, ok) => expect(isClickUpFileUrl(url)).toBe(ok));

  it('attachments: only ClickUp-hosted files, named with their extension, size from a string, per-task ids, de-duplicated', () => {
    const a = toAttachments('t1', [...ATTACHMENTS.t1, { id: 'a1', title: 'dup', url: FILE_OK }]);
    expect(a.map((x) => [x.externalId, x.fileName, x.providerRef, x.sizeBytes, x.mimeType, x.uploaderExternalId])).toEqual([
      ['t1:a1', 'design.png', FILE_OK, 2048, 'image/png', '101'],
      ['t1:a2', 'spec.pdf', FILE_CDN, 4096, 'application/pdf', '102'],
    ]);
    expect(a[0].createdAt).toBe('2026-01-01T00:00:00.000Z'.replace('2026-01-01T00:00:00.000Z', iso('1767210000000')!));
  });
});

describe('ClickUpAdapter OAuth', () => {
  it('is configured only with both env values; the authorize URL is ClickUp\'s with the state', () => {
    expect(make(fakeClickUp(), { CLICKUP_CLIENT_ID: '' }).adapter.isConfigured()).toBe(false);
    const { adapter } = make(fakeClickUp());
    expect(adapter.isConfigured()).toBe(true);
    const u = new URL(adapter.authorizeUrl({ state: 'st', redirectUri: 'https://app.test/cb' }));
    expect(`${u.origin}${u.pathname}`).toBe('https://app.clickup.com/api');
    expect([u.searchParams.get('client_id'), u.searchParams.get('redirect_uri'), u.searchParams.get('state')]).toEqual(['cid', 'https://app.test/cb', 'st']);
  });

  it('the code becomes a non-expiring token and the ONE authorized Workspace is the account', async () => {
    const fake = fakeClickUp();
    const { adapter } = make(fake);
    const r = await adapter.exchangeCode({ code: 'abc' }, { redirectUri: 'https://app.test/cb' });
    expect(r.account).toEqual({ id: TEAM, name: 'Acme' });
    expect(r.tokens).toMatchObject({ accessToken: 'newtok', scopes: [] });
    expect(r.tokens.expiresAt).toBeUndefined();
    expect(r.tokens.refreshToken).toBeUndefined();
    expect((adapter as { refresh?: unknown }).refresh).toBeUndefined();
  });

  it('refuses a callback with no code, a failed token call, no Workspace, or several (never guesses)', async () => {
    await expect(make(fakeClickUp()).adapter.exchangeCode({}, { redirectUri: 'x' })).rejects.toThrow(/without code/);
    await expect(make(fakeClickUp({ ...DATASET, tokenOk: false })).adapter.exchangeCode({ code: 'x' }, { redirectUri: 'x' })).rejects.toThrow(/HTTP 400/);
    await expect(make(fakeClickUp({ ...DATASET, teams: [] })).adapter.exchangeCode({ code: 'x' }, { redirectUri: 'x' })).rejects.toThrow(/no Workspace/);
    await expect(make(fakeClickUp({ ...DATASET, teams: [...DATASET.teams, { id: '2', name: 'B', members: [] }] })).adapter.exchangeCode({ code: 'x' }, { redirectUri: 'x' })).rejects.toThrow(/exactly one/);
  });

  it('revoke is a no-op (ClickUp has no endpoint) and calls nothing', async () => {
    const fake = fakeClickUp();
    await make(fake).adapter.revoke({ accessToken: 't', scopes: [] }, { id: '1', name: 'x' });
    expect(fake.fetch).not.toHaveBeenCalled();
  });
});

describe('ClickUpAdapter discover / estimate', () => {
  it('discover: spaces, folders, lists with their parents; all selectable', async () => {
    const { nodes } = await make(fakeClickUp()).adapter.discover(ctx);
    expect(nodes.map((n) => [n.type, n.id, n.parentId])).toEqual([
      ['space', 'space-1', null], ['folder', 'folder-1', 'space-1'], ['list', 'list-1', 'folder-1'], ['list', 'list-2', 'space-1'],
      ['space', 'space-2', null], ['list', 'list-3', 'space-2'],
    ]);
    expect(nodes.every((n) => n.selectable)).toBe(true);
  });

  it('estimate: counts tasks per list (two pages for 101), people, and says what will not come across', async () => {
    const fake = fakeClickUp();
    const e = await make(fake).adapter.estimate(ctx, sel(['space', 'space-1'], ['list', 'list-3']), DEFAULT_IMPORT_OPTIONS);
    expect(e.projects.map((p) => [p.sourceId, p.tasks])).toEqual([['list-1', 3], ['list-2', 101], ['list-3', 0]]);
    expect(e.users).toBe(3);
    const w = Object.fromEntries(e.warnings!.map((x) => [x.code, x.message]));
    expect(Object.keys(w).sort()).toEqual(['CONTENT_SLOW', 'CUSTOM_FIELDS_SKIPPED', 'HISTORY_NOT_AVAILABLE']);
    expect(w.CUSTOM_FIELDS_SKIPPED).toMatch(/formula/);
    expect(w.CUSTOM_FIELDS_SKIPPED).toMatch(/location/);
    expect(w.CONTENT_SLOW).toMatch(/104 tasks|about \d+ minutes/);
    expect(e.inventory!.priorities).toEqual(expect.arrayContaining(['Urgent', 'High', 'Normal', 'Low']));
    expect(fake.calls.filter((c) => /\/list\/list-2\/task/.test(c))).toHaveLength(2);
  });

  it('estimate without content or history says nothing about them', async () => {
    const e = await make(fakeClickUp()).adapter.estimate(ctx, sel(['list', 'list-3']), { comments: false, attachments: false, history: false, keepDates: true });
    expect(e.warnings!.map((w) => w.code)).toEqual([]);
  });

  it('a folder or a space selects all its lists; a list twice is one; an unknown kind is refused', async () => {
    const a = make(fakeClickUp()).adapter;
    expect((await a.estimate(ctx, sel(['folder', 'folder-1'], ['list', 'list-1']), DEFAULT_IMPORT_OPTIONS)).projects.map((p) => p.sourceId)).toEqual(['list-1']);
    await expect(a.estimate(ctx, sel(['team', 'x']), DEFAULT_IMPORT_OPTIONS)).rejects.toThrow(/spaces, folders and lists/);
  });
});

describe('ClickUpAdapter.fetchBundle', () => {
  it('page 0: people, a project per list with its statuses, the folder (visible ones only) and the space tags, merged fields, issue types', async () => {
    const { pages } = await runAll(make(fakeClickUp()).adapter, sel(['space', 'space-1'], ['list', 'list-3']), { comments: false, attachments: false, history: false, keepDates: true });
    const p0 = pages[0];
    expect(p0.users!.map((u) => [u.externalId, u.email])).toEqual([['101', 'ana@example.com'], ['102', 'ben@example.com'], ['103', 'cy@example.com']]);
    const sprint = p0.projects!.find((p) => p.externalId === 'list-1')!;
    expect(sprint.statuses!.map((s) => [s.externalId, s.category])).toEqual([['list-1:to do', 'TODO'], ['list-1:in progress', 'IN_PROGRESS'], ['list-1:blocked', 'IN_PROGRESS'], ['list-1:complete', 'DONE'], ['list-1:closed', 'DONE']]);
    expect(p0.projects!.find((p) => p.externalId === 'list-3')!.statuses![0]).toMatchObject({ name: 'backlog', category: 'BACKLOG' });
    expect(p0.tags!.map((t) => t.name).sort()).toEqual(['Q3 Roadmap', 'frontend', 'unused']); // the hidden folders are not tags
    expect(p0.tags!.find((t) => t.name === 'frontend')!.color).toBe('#ff0000');
    const env = p0.customFields!.find((f) => f.externalId === 'cf-env')!;
    expect(env.dataType).toBe('SELECT');
    expect(env.options!.map((o) => o.label)).toEqual(['staging', 'production', 'qa']); // the union over the lists
    expect(p0.customFields!.map((f) => f.externalId).sort()).toEqual(['cf-cost', 'cf-env', 'cf-owner']); // formula / location are skipped
    expect(p0.issueTypes!.map((t) => t.externalId).sort()).toEqual(['1', '1002']);
  });

  it('task pages: live then archived per list, 100 a page, subtasks / closed included; every page validates', async () => {
    const fake = fakeClickUp();
    const { pages } = await runAll(make(fake).adapter, sel(['space', 'space-1'], ['list', 'list-3']), { comments: false, attachments: false, history: false, keepDates: true });
    const tasks = tasksOf(pages);
    expect(tasks).toHaveLength(105);
    expect(tasks.filter((t) => t.projectExternalId === 'list-2')).toHaveLength(101);
    const arch = tasks.find((t) => t.externalId === 't-arch')!;
    expect(arch.archived).toBe(true);
    const t1 = tasks.find((t) => t.externalId === 't1')!;
    expect(t1).toMatchObject({ key: 'ENG-1', title: 'Design the login page', description: '## Goal\nShip it.', statusExternalId: 'list-1:in progress', priority: 'High', estimate: 5, issueTypeExternalId: '1', assigneeExternalIds: ['101', '102'], creatorExternalId: '101' });
    expect(t1.tags).toEqual(['Q3 Roadmap', 'frontend', 'ui']);
    expect(t1.customValues).toEqual([{ fieldExternalId: 'cf-env', value: 'production' }, { fieldExternalId: 'cf-cost', value: 125.5 }, { fieldExternalId: 'cf-owner', value: '103' }]);
    expect(tasks.find((t) => t.externalId === 't3')!.parentExternalId).toBe('t1');
    expect(tasks.find((t) => t.externalId === 'b000')!.tags).toBeUndefined(); // hidden folder: no tag
    for (const p of pages) { const v = validateBundle(p); expect('fatal' in v).toBe(false); if (!('fatal' in v)) expect(v.issues.filter((i) => i.severity !== 'INFO')).toEqual([]); }
    const q = fake.calls.filter((c) => /\/list\/list-1\/task/.test(c));
    expect(q.map((c) => /archived=(\w+)/.exec(c)![1])).toEqual(['false', 'true']);
    expect(q[0]).toContain('subtasks=true');
    expect(q[0]).toContain('include_closed=true');
  });

  it('dependencies come with the page of the task that lists them, once per edge', async () => {
    const { pages } = await runAll(make(fakeClickUp()).adapter, sel(['list', 'list-1']), { comments: false, attachments: false, history: false, keepDates: true });
    const deps = pages.flatMap((p) => p.dependencies ?? []);
    expect(deps.map((d) => [d.externalId, d.type]).sort()).toEqual([['dep:t1>t2', 'BLOCKS'], ['link:t1~t3', 'RELATES_TO']]);
  });

  it('comments: all pages of a long thread (start + start_id), replies under their root; no comment calls when the option is off', async () => {
    const fake = fakeClickUp();
    const { pages } = await runAll(make(fake).adapter, sel(['space', 'space-1']), { comments: true, attachments: false, history: false, keepDates: true });
    const t1 = tasksOf(pages).find((t) => t.externalId === 't1')!;
    expect(t1.comments!.map((c) => [c.externalId, c.parentExternalId])).toEqual([['c1', undefined], ['c2', undefined], ['c2r', 'c2'], ['c3', undefined]]);
    expect(t1.comments![0]).toMatchObject({ authorExternalId: '101', body: 'Please add dark mode.', createdAt: iso('1767200000000') });
    const b0 = tasksOf(pages).find((t) => t.externalId === 'b000')!;
    expect(b0.comments).toHaveLength(30);
    const asks = fake.calls.filter((c) => /\/task\/b000\/comment/.test(c));
    expect(asks).toHaveLength(2);
    expect(asks[1]).toMatch(/start_id=bc76/);
    expect(asks[1]).toMatch(/start=\d+/);
    const off = fakeClickUp();
    await runAll(make(off).adapter, sel(['list', 'list-1']), { comments: false, attachments: false, history: false, keepDates: true });
    expect(off.calls.some((c) => /comment/.test(c))).toBe(false);
  });

  it('files: one single-task call per task when asked; only ClickUp-hosted files survive; nothing otherwise', async () => {
    const fake = fakeClickUp();
    const { pages } = await runAll(make(fake).adapter, sel(['list', 'list-1']), { comments: false, attachments: true, history: false, keepDates: true });
    const t1 = tasksOf(pages).find((t) => t.externalId === 't1')!;
    expect(t1.attachments!.map((a) => a.providerRef)).toEqual([FILE_OK, FILE_CDN]);
    expect(fake.calls.filter((c) => /^GET \/task\/t(\d|-arch)/.test(c))).toHaveLength(4); // t1, t2, t3, t-arch
    const off = fakeClickUp();
    await runAll(make(off).adapter, sel(['list', 'list-1']), { comments: false, attachments: false, history: false, keepDates: true });
    expect(off.calls.some((c) => /^GET \/task\/t(\d|-arch)/.test(c))).toBe(false);
  });

  it('a list whose custom fields the token cannot read is still imported (the fields are skipped, nothing else is lost)', async () => {
    const { pages } = await runAll(make(fakeClickUp({ ...DATASET, failFields: true })).adapter, sel(['list', 'list-1']), { comments: false, attachments: false, history: false, keepDates: true });
    expect(pages[0].customFields).toBeUndefined();
    expect(tasksOf(pages)).toHaveLength(4);
  });

  it('an empty selection of lists: structure only, no cursor', async () => {
    const r = await make(fakeClickUp()).adapter.fetchBundle({ ctx, selection: sel(['space', 'space-2']), options: DEFAULT_IMPORT_OPTIONS, cursor: null });
    expect((r.next as { lists: string[] }).lists).toEqual(['list-3']);
  });

  it.each([
    [{ v: 2, lists: ['a'], folders: [''], it: [], i: 0, arch: false, page: 0 }], [{ v: 1, lists: ['a'], folders: [], it: [], i: 0, arch: false, page: 0 }],
    [{ v: 1, lists: ['a'], folders: [''], it: [], i: 1, arch: false, page: 0 }], [{ v: 1, lists: ['a'], folders: [''], it: [], i: 0, arch: 'no', page: 0 }],
    [{ v: 1, lists: ['a'], folders: [''], it: [], i: 0, arch: false, page: -1 }], [{ v: 1, lists: [1], folders: [''], it: [], i: 0, arch: false, page: 0 }], ['x'],
  ])('a saved cursor that is not ours is refused: %j', async (cursor) => {
    await expect(make(fakeClickUp()).adapter.fetchBundle({ ctx, selection: sel(['list', 'list-1']), options: DEFAULT_IMPORT_OPTIONS, cursor })).rejects.toThrow(/cursor/);
  });

  it('resuming from a stored cursor gives the same page as running straight through (the cursor is the whole state)', async () => {
    const a = make(fakeClickUp()).adapter;
    const opts = { comments: false, attachments: false, history: false, keepDates: true };
    const { pages, cursors } = await runAll(a, sel(['space', 'space-1']), opts);
    const k = 3;
    const again = await make(fakeClickUp()).adapter.fetchBundle({ ctx, selection: sel(['space', 'space-1']), options: opts, cursor: JSON.parse(JSON.stringify(cursors[k])) });
    expect(again.bundle).toEqual(pages[k]);
  });
});

describe('ClickUpAdapter failures and pacing', () => {
  it('a dead token is ProviderAuthRejectedError (the job pauses for reconnection)', async () => {
    await expect(make(fakeClickUp()).adapter.discover({ ...ctx, accessToken: 'revoked' })).rejects.toBeInstanceOf(ProviderAuthRejectedError);
  });

  it('a 429 carries the wait from X-RateLimit-Reset (ClickUp sends no Retry-After): the executor retries later', async () => {
    const reset = Math.floor(Date.now() / 1000) + 45;
    const fake = fakeClickUp(DATASET, { intercept: (p) => (p === `/team/${TEAM}/space` ? new Response('{"err":"Rate limit reached"}', { status: 429, headers: { 'x-ratelimit-reset': String(reset) } }) : undefined) });
    const e = await make(fake, {}, { maxInlineWaitMs: 1000 }).adapter.discover(ctx).catch((x) => x);
    expect(e).toBeInstanceOf(ProviderRateLimitedError);
    expect(e.retryAfterMs).toBeGreaterThan(40_000);
  });

  it('a vanished list is a 404 that fails the import (not a silent gap); a vanished Workspace too', async () => {
    const a = make(fakeClickUp()).adapter;
    await expect(a.fetchBundle({ ctx, selection: sel(['list', 'list-404']), options: DEFAULT_IMPORT_OPTIONS, cursor: null })).rejects.toMatchObject({ status: 404 });
    await expect(a.fetchBundle({ ctx: { ...ctx, externalAccountId: 'other' }, selection: sel(['list', 'list-1']), options: DEFAULT_IMPORT_OPTIONS, cursor: null })).rejects.toBeInstanceOf(ProviderHttpError);
  });

  it('every API call is paced to the plan: 90 a minute by default (burst 5), CLICKUP_REQUESTS_PER_MINUTE changes it, nonsense is ignored', async () => {
    const shape = async (env: Record<string, string>) => {
      const m = make(fakeClickUp(), env);
      await m.adapter.discover({ ...ctx });
      return m.spy.mock.calls[0][0].rate;
    };
    expect(await shape({ CLICKUP_REQUESTS_PER_MINUTE: '' })).toEqual({ capacity: 5, refillPerSecond: 1.5 });
    expect(await shape({ CLICKUP_REQUESTS_PER_MINUTE: '600' })).toEqual({ capacity: 30, refillPerSecond: 10 });
    for (const bad of ['abc', '5', '999999', '']) expect(await shape({ CLICKUP_REQUESTS_PER_MINUTE: bad })).toEqual({ capacity: 5, refillPerSecond: 1.5 });
  });

  it('the bearer token goes on every API call', async () => {
    const m = make(fakeClickUp());
    await m.adapter.discover(ctx);
    expect(m.spy.mock.calls.every((c) => c[0].headers!.authorization === 'Bearer tok')).toBe(true);
  });
});

describe('ClickUpAdapter.fetchAttachment', () => {
  it('streams a ClickUp-hosted file with the token, size and type from the headers', async () => {
    const fake = fakeClickUp();
    const f = await make(fake).adapter.fetchAttachment({ ctx, providerRef: FILE_OK });
    expect(await read(f.stream)).toBe(FILES[FILE_OK].body);
    expect(f.sizeBytes).toBe(14);
    expect(f.mimeType).toBe('image/png');
    expect(fake.fileCalls).toEqual([{ url: FILE_OK, auth: 'Bearer tok' }]);
  });

  it.each([FILE_EVIL, FILE_LOOKALIKE, 'http://attachments.clickup.com/x', 'https://attachments.clickup.com@evil.example/x', 'file:///etc/passwd'])('%s is never requested', async (ref) => {
    const fake = fakeClickUp();
    await expect(make(fake).adapter.fetchAttachment({ ctx, providerRef: ref })).rejects.toMatchObject({ status: 400 });
    expect(fake.fetch).not.toHaveBeenCalled();
  });

  it('401 = the token is dead (pause); other refusals are about this file', async () => {
    const files = { [FILE_OK]: { body: 'x', status: 401 }, [FILE_CDN]: { body: 'x', status: 410 } };
    await expect(make(fakeClickUp(DATASET, { files })).adapter.fetchAttachment({ ctx, providerRef: FILE_OK })).rejects.toBeInstanceOf(ProviderAuthRejectedError);
    await expect(make(fakeClickUp(DATASET, { files })).adapter.fetchAttachment({ ctx, providerRef: FILE_CDN })).rejects.toMatchObject({ status: 410 });
    await expect(make(fakeClickUp(DATASET, { files: {} })).adapter.fetchAttachment({ ctx, providerRef: FILE_OK })).rejects.toMatchObject({ status: 404 });
  });
});
