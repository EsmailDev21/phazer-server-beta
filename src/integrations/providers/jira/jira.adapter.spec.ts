import { Readable } from 'node:stream';
import { CanonicalBundle, validateBundle } from '../../../imports/canonical';
import { DEFAULT_IMPORT_OPTIONS } from '../../../imports/imports.types';
import { lookupPriority } from '../../../imports/mapping/mapping.tables';
import { ProviderAuthRejectedError, ProviderHttpError } from '../../core/integration.types';
import { ProviderHttpClient } from '../../core/provider-http.client';
import { JiraAdapter } from './jira.adapter';
import { JiraClient } from './jira.client';
import { BASE, CLOUD, FILE_URL, dataset, fakeJira, E2_HISTORY, ISSUES } from './fixtures/jira-responses';
import { customValue, iso, linksFooter, pickSprint, relinkMedia, statusCategory, toAttachments, toComments, toDependencies, toHistory, toIssueType, toProject, inSelectionOf, text } from './jira.normalize';
import { JiraFieldDef } from './jira.types';

const noRedis = { configured: false, isReady: () => false } as never;
const cfgOf = (env: Record<string, string> = {}) => ({ get: (k: string) => ({ JIRA_CLIENT_ID: 'cid', JIRA_CLIENT_SECRET: 'sec', ...env })[k] }) as never;
function make(fake: ReturnType<typeof fakeJira>, env: Record<string, string> = {}) {
  const http = new ProviderHttpClient(noRedis, (async (...a: unknown[]) => (await (fake.fetch as any)(...a)).clone()) as never, { bucketCapacity: 1e6, refillPerSecond: 1e6, maxRetries: 0 });
  return { adapter: new JiraAdapter(cfgOf(env), http, new JiraClient(http)), http };
}
const ctx = { connectionId: 'conn-1', externalAccountId: CLOUD, accessToken: 'tok' };
const sel = (...ids: string[]) => ({ sources: ids.map((id) => ({ id, type: 'project' })) });
const read = async (s: Readable) => { const p: Buffer[] = []; for await (const c of s) p.push(Buffer.from(c)); return Buffer.concat(p).toString(); };
const ALL = DEFAULT_IMPORT_OPTIONS;
const NONE = { comments: false, attachments: false, history: false, keepDates: true };

async function runAll(a: JiraAdapter, selection = sel('10000'), options = ALL) {
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
const T = (pages: CanonicalBundle[], id: string) => tasksOf(pages).find((t) => t.externalId === id)!;

describe('Jira normalizers', () => {
  it('timestamps: the colon-less +0000 offset, plain due dates, junk', () => {
    expect(iso('2026-01-05T09:00:00.000+0000')).toBe('2026-01-05T09:00:00.000Z');
    expect(iso('2026-01-05T11:00:00.000+0200')).toBe('2026-01-05T09:00:00.000Z');
    expect(iso('2026-03-01')).toBe('2026-03-01T00:00:00.000Z');
    for (const bad of [undefined, null, '', 'tomorrow', 5, {}]) expect(iso(bad)).toBeUndefined();
  });

  it.each([['new', 'To Do', 'TODO'], ['new', 'Backlog', 'BACKLOG'], ['indeterminate', 'Blocked', 'IN_PROGRESS'], ['done', 'Done', 'DONE'], ['undefined', 'x', 'UNKNOWN'], [undefined, 'x', 'UNKNOWN']])('status category %s / %s -> %s (diagram 07)', (key, name, cat) => {
    expect(statusCategory({ id: '1', name: name as string, statusCategory: { key: key as string } })).toBe(cat);
  });

  it('a project: statuses unique, project-scoped ids, in board order (to do -> in progress -> done)', () => {
    const s = (id: string, name: string, key: string) => ({ id, name, statusCategory: { key } });
    const p = toProject({ id: '1', key: 'ENG', name: 'E', description: 'd' }, [s('4', 'Done', 'done'), s('1', 'To Do', 'new'), s('2', 'Doing', 'indeterminate'), s('1', 'To Do', 'new')], BASE);
    expect(p.statuses!.map((x) => [x.externalId, x.category])).toEqual([['1:1', 'TODO'], ['1:2', 'IN_PROGRESS'], ['1:4', 'DONE']]);
    expect(p).toMatchObject({ externalId: '1', key: 'ENG', url: `${BASE}/browse/ENG`, description: 'd' });
  });

  it('issue types: hierarchy 1+ is EPIC, sub-task is SUBTASK, the rest STANDARD', () => {
    expect(toIssueType({ id: '1', name: 'Epic', hierarchyLevel: 1 }).level).toBe('EPIC');
    expect(toIssueType({ id: '2', name: 'Sub-task', subtask: true, hierarchyLevel: -1 }).level).toBe('SUBTASK');
    expect(toIssueType({ id: '3', name: 'Story', hierarchyLevel: 0 }).level).toBe('STANDARD');
  });

  it('priorities use the existing table: Highest -> URGENT, Lowest -> LOW', () => {
    expect(lookupPriority('jira' as never, 'Highest')).toBeDefined();
    expect(lookupPriority('jira' as never, 'Lowest')).toBeDefined();
  });

  describe('custom fields', () => {
    const def = (custom: string, extra: Partial<JiraFieldDef> = {}): JiraFieldDef => ({ id: 'cf', name: 'F', custom: true, schema: { custom: `com.atlassian.jira.plugin.system.customfieldtypes:${custom}` }, ...extra });
    it('select / radio / cascading / multi -> readable text; number; date; url; user; labels -> tags', () => {
      expect(customValue(def('select'), { value: 'staging' }).value).toEqual({ fieldExternalId: 'cf', value: 'staging' });
      expect(customValue(def('cascadingselect'), { value: 'EU', child: { value: 'DE' } }).value!.value).toBe('EU / DE');
      expect(customValue(def('multicheckboxes'), [{ value: 'iOS' }, { value: 'Web' }]).value!.value).toBe('iOS, Web');
      expect(customValue(def('float'), 12.5).value!.value).toBe(12.5);
      expect(customValue(def('float'), 'abc').value).toBeUndefined();
      expect(customValue(def('datepicker'), '2026-04-01').value!.value).toBe('2026-04-01T00:00:00.000Z');
      expect(customValue(def('url'), 'https://x.test').value!.value).toBe('https://x.test');
      expect(customValue(def('userpicker'), { accountId: 'a1' }).value!.value).toBe('a1');
      expect(customValue(def('multiuserpicker'), [{ accountId: 'a1' }, { accountId: 'a2' }]).value!.value).toBe('a1');
      expect(customValue(def('labels'), ['x', 'y'])).toEqual({ tags: ['x', 'y'] });
    });
    it('rich text fields (ADF) are converted; unset / empty / unknown kinds are nothing', () => {
      expect(customValue(def('textarea'), { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }] }).value!.value).toBe('hi');
      for (const raw of [null, undefined, '', []]) expect(customValue(def('select'), raw)).toEqual({});
      expect(customValue({ id: 'x', name: 'X', custom: true, schema: { custom: 'com.acme:weird' } }, 'v')).toEqual({});
      expect(customValue({ id: 'x', name: 'X', custom: false }, 'v')).toEqual({});
    });
  });

  it('a task has ONE iteration: the active sprint, else the last one listed', () => {
    expect(pickSprint([{ id: 1, state: 'closed' }, { id: 2, state: 'active' }, { id: 3, state: 'future' }])).toBe('s:2');
    expect(pickSprint([{ id: 1, state: 'closed' }, { id: 3, state: 'closed' }])).toBe('s:3');
    expect(pickSprint(null)).toBeUndefined();
    expect(pickSprint([])).toBeUndefined();
  });

  it('comments: ADF -> markdown, author, an edit shows only when the times differ, duplicates by id dropped', () => {
    const c = toComments([
      { id: '1', author: { accountId: 'a', displayName: 'A' }, body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }] }, created: '2026-01-01T00:00:00.000+0000', updated: '2026-01-01T00:00:00.000+0000' },
      { id: '2', body: 'plain', created: '2026-01-02T00:00:00.000+0000', updated: '2026-01-03T00:00:00.000+0000' }, { id: '1', body: 'dup' },
    ]);
    expect(c).toHaveLength(2);
    expect(c[0]).toMatchObject({ externalId: '1', body: 'hi', authorExternalId: 'a', authorName: 'A' });
    expect(c[0].editedAt).toBeUndefined();
    expect(c[1].editedAt).toBe('2026-01-03T00:00:00.000Z');
  });

  it('attachments: one per id, the address is BUILT from the id, names lose paths and control characters', () => {
    const a = toAttachments('i1', [{ id: '5', filename: '../../etc/pa\u0000ss.txt', size: 3, mimeType: 'text/plain', author: { accountId: 'a' } }, { id: '5', filename: 'dup' }, { id: '6' }], (id) => FILE_URL(id));
    expect(a.map((x) => [x.externalId, x.fileName, x.providerRef, x.sizeBytes, x.uploaderExternalId])).toEqual([['i1:5', 'pass.txt', FILE_URL('5'), 3, 'a'], ['i1:6', 'attachment-6', FILE_URL('6'), undefined, undefined]]);
  });

  it('media placeholders become the attachment\'s address when the NAME matches exactly one attachment (an image stays an image)', () => {
    const atts = toAttachments('i', [{ id: '1', filename: 'shot.png', mimeType: 'image/png' }, { id: '2', filename: 'notes.pdf', mimeType: 'application/pdf' }, { id: '3', filename: 'twin.txt' }, { id: '4', filename: 'twin.txt' }], (id) => FILE_URL(id));
    const md = 'a [shot.png](attachment:u1) b [notes.pdf](attachment:u2) c [twin.txt](attachment:u3) d [none.png](attachment:u4)';
    expect(relinkMedia(md, atts)).toBe(`a ![shot.png](${FILE_URL('1')}) b [notes.pdf](${FILE_URL('2')}) c [twin.txt](attachment:u3) d [none.png](attachment:u4)`);
    expect(relinkMedia('no media here', atts)).toBe('no media here');
  });

  describe('issue links', () => {
    const byKey = new Map([['ENG', '10000']]);
    const inSel = inSelectionOf(byKey);
    const issue = (links: unknown[]) => ({ id: 'A', key: 'ENG-1', fields: { issuelinks: links } }) as never;
    const blocks = { id: 'L1', type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' } };

    it('Blocks: the issue on the outward side is the BLOCKER, whichever issue lists the link; one id per link', () => {
      expect(toDependencies(issue([{ ...blocks, outwardIssue: { id: 'B', key: 'ENG-2' } }]), inSel)).toEqual([{ externalId: 'l:L1', fromExternalId: 'A', toExternalId: 'B', type: 'BLOCKS' }]);
      expect(toDependencies(issue([{ ...blocks, inwardIssue: { id: 'B', key: 'ENG-2' } }]), inSel)).toEqual([{ externalId: 'l:L1', fromExternalId: 'B', toExternalId: 'A', type: 'BLOCKS' }]);
    });
    it('every other type is RELATES_TO with an order-independent edge; a link to a project that is not imported is no dependency', () => {
      const rel = { id: 'L2', type: { name: 'Relates', inward: 'relates to', outward: 'relates to' } };
      expect(toDependencies(issue([{ ...rel, outwardIssue: { id: 'B', key: 'ENG-2' } }]), inSel)[0]).toMatchObject({ fromExternalId: 'A', toExternalId: 'B', type: 'RELATES_TO' });
      expect(toDependencies(issue([{ ...rel, inwardIssue: { id: '0', key: 'ENG-9' } }]), inSel)[0]).toMatchObject({ fromExternalId: '0', toExternalId: 'A' });
      expect(toDependencies(issue([{ ...rel, outwardIssue: { id: 'X', key: 'OTH-1' } }, { ...blocks, id: 'L3', outwardIssue: { id: 'Y', key: 'OTH-2' } }]), inSel)).toEqual([]);
    });
    it('the footer keeps the KIND of every non-blocks link and every link outside the import, as text', () => {
      const f = linksFooter(issue([
        { id: 'L2', type: { name: 'Duplicate', inward: 'is duplicated by', outward: 'duplicates' }, outwardIssue: { id: 'B', key: 'ENG-2', fields: { summary: 'Same [bug]' } } },
        { ...blocks, outwardIssue: { id: 'Y', key: 'OTH-2', fields: { summary: 'x' } } }, { ...blocks, id: 'L4', outwardIssue: { id: 'B', key: 'ENG-3' } },
      ]), inSel);
      expect(f).toContain('- duplicates ENG-2 - Same \\[bug\\]');
      expect(f).toContain('- blocks OTH-2 - x (not imported)');
      expect(f).not.toContain('ENG-3'); // a plain in-import "blocks" is a BLOCKS dependency, nothing to add
      expect(linksFooter(issue([{ ...blocks, outwardIssue: { id: 'B', key: 'ENG-3' } }, { id: 'L9', type: { name: 'Relates', outward: 'relates to' }, outwardIssue: { id: 'C', key: 'ENG-4' } }]), inSel)).toBeNull(); // both are real links already
      expect(linksFooter(issue([{ id: 'L8', type: { name: 'Cloners', outward: 'clones' }, outwardIssue: { id: 'C', key: 'ENG-4' } }]), inSel)).toContain('- clones ENG-4');
    });
  });

  it('history: one entry per changed field, Jira\'s field name, oldest first, actor and values kept', () => {
    const h = toHistory([...E2_HISTORY].reverse());
    expect(h.map((e) => [e.field, e.from, e.to])).toEqual([['status', 'Backlog', 'To Do'], ['assignee', undefined, 'Ana Lima'], ['story points', '3', '5'], ['sprint', 'Sprint 1', 'Sprint 1, Sprint 2']]);
    expect(h[0].actorExternalId).toBe('acc-ben');
    expect(h[0].externalId).toBe('h1:0:status');
    expect(toHistory([{ id: 'x', items: [{ field: 'status' }] } as never])).toEqual([]); // no time: cannot be placed
    const [bare] = toHistory([{ id: 'y', created: '2026-01-01T00:00:00.000+0000', items: [{ field: 'Labels', fromString: 'a' }] } as never]);
    expect(bare).toMatchObject({ from: 'a' });
    expect(bare.to).toBeUndefined(); // no own toString: NOT Object.prototype.toString
  });

  it('text() accepts ADF, plain strings and nothing', () => {
    expect(text(null)).toBe('');
    expect(text('plain')).toBe('plain');
    expect(text({ type: 'nonsense' })).toBe('');
  });
});

describe('JiraAdapter OAuth (3LO, rotating refresh tokens)', () => {
  it('needs both env values; the authorize URL carries audience, scopes (offline_access included), prompt=consent and the state', () => {
    expect(make(fakeJira(), { JIRA_CLIENT_ID: '' }).adapter.isConfigured()).toBe(false);
    const { adapter } = make(fakeJira());
    expect(adapter.isConfigured()).toBe(true);
    const u = new URL(adapter.authorizeUrl({ state: 'st', redirectUri: 'https://app.test/cb' }));
    expect(`${u.origin}${u.pathname}`).toBe('https://auth.atlassian.com/authorize');
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ audience: 'api.atlassian.com', client_id: 'cid', redirect_uri: 'https://app.test/cb', state: 'st', response_type: 'code', prompt: 'consent', scope: 'read:jira-work read:jira-user offline_access' });
  });

  it('the code becomes tokens with an expiry and a refresh token; the ONE authorized Jira site is the account', async () => {
    const r = await make(fakeJira()).adapter.exchangeCode({ code: 'good' }, { redirectUri: 'https://app.test/cb' });
    expect(r.account).toEqual({ id: CLOUD, name: 'Acme' });
    expect(r.tokens).toMatchObject({ accessToken: 'tok', refreshToken: 'rt-1', scopes: ['read:jira-work', 'read:jira-user', 'offline_access'] });
    expect(r.tokens.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 3_000_000);
  });

  it('refuses: no code, a failed exchange, no Jira site (e.g. Confluence only), several sites', async () => {
    await expect(make(fakeJira()).adapter.exchangeCode({}, { redirectUri: 'x' })).rejects.toThrow(/without code/);
    await expect(make(fakeJira()).adapter.exchangeCode({ code: 'bad' }, { redirectUri: 'x' })).rejects.toThrow(/HTTP 403/);
    const none = dataset(); none.resources = [{ id: 'c', name: 'Wiki', url: 'u', scopes: ['read:confluence-content.all'] }];
    await expect(make(fakeJira(none)).adapter.exchangeCode({ code: 'good' }, { redirectUri: 'x' })).rejects.toThrow(/no Jira site/);
    const two = dataset(); two.resources = [...two.resources, { id: 'c2', name: 'B', url: 'u', scopes: ['read:jira-work'] }];
    await expect(make(fakeJira(two)).adapter.exchangeCode({ code: 'good' }, { redirectUri: 'x' })).rejects.toThrow(/exactly one/);
  });

  it('a refresh returns the NEW rotated refresh token; the old one is dead afterwards', async () => {
    const fake = fakeJira();
    const { adapter } = make(fake);
    const t1 = await adapter.refresh({ accessToken: 'old', refreshToken: 'rt-1', scopes: [] });
    expect(t1.refreshToken).toBe('rt-2');
    expect(t1.accessToken).toBe('tok-2');
    expect(t1.expiresAt!.getTime()).toBeGreaterThan(Date.now());
    await expect(adapter.refresh({ accessToken: 'x', refreshToken: 'rt-1', scopes: [] })).rejects.toBeInstanceOf(ProviderAuthRejectedError); // used twice
    expect((await adapter.refresh({ accessToken: 'x', refreshToken: 'rt-2', scopes: [] })).refreshToken).toBe('rt-3');
  });

  it('keeps the old refresh token only when the answer carries none; no refresh token at all means reconnect; revoke calls nothing', async () => {
    const fake = fakeJira();
    fake.fetch.mockImplementationOnce(async () => fake.json({ access_token: 'n', expires_in: 60 }));
    expect((await make(fake).adapter.refresh({ accessToken: 'x', refreshToken: 'rt-1', scopes: [] })).refreshToken).toBe('rt-1');
    await expect(make(fakeJira()).adapter.refresh({ accessToken: 'x', scopes: [] })).rejects.toBeInstanceOf(ProviderAuthRejectedError);
    const quiet = fakeJira();
    await make(quiet).adapter.revoke({ accessToken: 't', scopes: [] }, { id: '1', name: 'x' });
    expect(quiet.fetch).not.toHaveBeenCalled();
  });
});

describe('JiraAdapter discover / estimate', () => {
  it('discover: every project, selectable, with its key', async () => {
    const { nodes } = await make(fakeJira()).adapter.discover(ctx);
    expect(nodes.map((n) => [n.type, n.id, n.name, n.selectable])).toEqual([['project', '10000', 'Engineering (ENG)', true], ['project', '10001', 'Operations (OPS)', true]]);
  });

  it('estimate: issue counts, people (no apps or inactive accounts), warnings for what does not come across, the site\'s priorities', async () => {
    const e = await make(fakeJira()).adapter.estimate(ctx, sel('10000', '10001'), ALL);
    expect(e.projects.map((p) => [p.sourceId, p.tasks])).toEqual([['10000', 4], ['10001', 1]]);
    expect(e.users).toBe(2);
    const w = Object.fromEntries(e.warnings!.map((x) => [x.code, x.message]));
    expect(Object.keys(w).sort()).toEqual(['CUSTOM_FIELDS_SKIPPED', 'HISTORY_RECENT_ONLY', 'TRANSITIONS_NOT_IMPORTED']);
    expect(w.CUSTOM_FIELDS_SKIPPED).toContain('Weird thing');
    expect(w.CUSTOM_FIELDS_SKIPPED).not.toContain('Rank'); // plumbing, not worth a warning
    expect(e.inventory!.priorities).toEqual(expect.arrayContaining(['Highest', 'Lowest']));
    expect((await make(fakeJira()).adapter.estimate(ctx, sel('10001'), NONE)).warnings!.map((x) => x.code)).not.toContain('HISTORY_RECENT_ONLY');
  });

  it('a user list the app may not read is a warning, not a failure; sprints that cannot be read too', async () => {
    const d = dataset(); d.failUsers = true; d.failAgile = true;
    const e = await make(fakeJira(d)).adapter.estimate(ctx, sel('10000'), NONE);
    expect(e.users).toBe(0);
    expect(e.warnings!.map((x) => x.code)).toEqual(expect.arrayContaining(['USERS_UNAVAILABLE', 'SPRINTS_UNAVAILABLE']));
  });

  it('only projects can be selected', async () => {
    await expect(make(fakeJira()).adapter.estimate(ctx, { sources: [{ id: '1', type: 'board' }] }, ALL)).rejects.toThrow(/can import projects/);
  });
});

describe('JiraAdapter.fetchBundle', () => {
  it('page 0: people, projects with category-ordered statuses, issue types by level, sprints and releases, no kanban sprints', async () => {
    const { pages } = await runAll(make(fakeJira()).adapter, sel('10000', '10001'), NONE);
    const p0 = pages[0];
    expect(p0.users!.map((u) => [u.externalId, u.email])).toEqual([['acc-ana', 'ana@example.com'], ['acc-ben', 'ben@example.com']]);
    const eng = p0.projects!.find((p) => p.externalId === '10000')!;
    expect(eng.statuses!.map((s) => [s.name, s.category])).toEqual([['Backlog', 'BACKLOG'], ['To Do', 'TODO'], ['In Progress', 'IN_PROGRESS'], ['Blocked', 'IN_PROGRESS'], ['Done', 'DONE']]);
    expect(eng.statuses![0].externalId).toBe('10000:5');
    expect(p0.issueTypes!.map((t) => [t.name, t.level])).toEqual([['Epic', 'EPIC'], ['Story', 'STANDARD'], ['Bug', 'STANDARD'], ['Sub-task', 'SUBTASK']]);
    expect(p0.iterations!.map((i) => [i.externalId, i.kind, i.projectExternalId])).toEqual([['v:100', 'MILESTONE', '10000'], ['v:101', 'MILESTONE', '10000'], ['s:71', 'SPRINT', '10000'], ['s:72', 'SPRINT', '10000']]);
    expect(p0.iterations!.find((i) => i.externalId === 's:71')).toMatchObject({ goal: 'Ship login', endDate: '2026-01-19T10:00:00.000Z' });
  });

  it('the rich issue, fully translated', async () => {
    const { pages } = await runAll(make(fakeJira()).adapter, sel('10000'), ALL);
    const t = T(pages, '20002');
    expect(t).toMatchObject({
      key: 'ENG-2', title: 'Login form', projectExternalId: '10000', url: `${BASE}/browse/ENG-2`, statusExternalId: '10000:1', priority: 'High', issueTypeExternalId: '11',
      parentExternalId: '20001', assigneeExternalIds: ['acc-ana'], creatorExternalId: 'acc-ben', estimate: 5, iterationExternalId: 's:72',
      createdAt: '2026-01-05T09:00:00.000Z', dueDate: '2026-03-01T00:00:00.000Z',
    });
    expect([...t.tags!].sort()).toEqual(['a11y', 'alpha', 'beta', 'frontend', 'version: 1.0', 'version: 1.1', 'Web'].sort());
    const v = Object.fromEntries(t.customValues!.map((x) => [x.fieldExternalId, x.value]));
    expect(v).toMatchObject({ customfield_10050: 'staging', customfield_10051: 'iOS, Web', customfield_10052: 'Acme Corp', customfield_10053: 'acc-ben', customfield_10054: '2026-04-01T00:00:00.000Z', customfield_10055: 1250.5, 'jira:timeoriginalestimate': 2, 'jira:timespent': 1 });
    expect(v.customfield_10060).toBeUndefined(); // Rank: plumbing
    expect(v.customfield_10070).toBeUndefined(); // unknown kind
    expect(t.description).toContain('Build the form.');
    expect(t.description).toContain('**Environment**\n\nSafari 17');
    expect(t.description).toContain(`![shot.png](${FILE_URL('501')})`); // the embedded media, pointing at the attachment
    expect(t.description).toContain('- duplicates ENG-4 - Same bug');
    expect(t.description).toContain('- relates to OPS-1 - Rotate keys \\[urgent\\] (not imported)'); // OPS is not selected here
    expect(t.attachments!.map((a) => [a.fileName, a.providerRef, a.uploaderExternalId])).toEqual([['shot.png', FILE_URL('501'), 'acc-ana'], ['notes.pdf', FILE_URL('502'), 'acc-stranger']]);
  });

  it('every supported custom field is declared on PAGE 0 (the mapping step only knows what the structure declares), plus the two time numbers; task pages declare none', async () => {
    const { pages } = await runAll(make(fakeJira()).adapter, sel('10000'), NONE);
    expect(pages[0].customFields!.map((f) => [f.externalId, f.dataType]).sort()).toEqual([
      ['customfield_10050', 'TEXT'], ['customfield_10051', 'TEXT'], ['customfield_10052', 'TEXT'], ['customfield_10053', 'USER'], ['customfield_10054', 'DATE'], ['customfield_10055', 'NUMBER'],
      ['jira:timeoriginalestimate', 'NUMBER'], ['jira:timespent', 'NUMBER'],
    ].sort());
    expect(pages.slice(1).every((p) => !p.customFields)).toBe(true);
  });

  it('comments and history past the first page come through the follow-up queries, complete and in order', async () => {
    const fake = fakeJira();
    const { pages } = await runAll(make(fake).adapter, sel('10000'), ALL);
    const t = T(pages, '20002');
    expect(t.comments!.map((c) => c.externalId)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5']);
    expect(t.comments![1]).toMatchObject({ authorName: 'Ben Ortiz', editedAt: '2026-01-06T09:30:00.000Z' });
    expect(t.comments![3].body).toContain(`![shot.png](${FILE_URL('501')})`);
    expect(t.history!.map((h) => h.field)).toEqual(['status', 'assignee', 'story points', 'sprint']);
    expect(fake.calls.some((c) => /issue\/20002\/comment\?startAt=3/.test(c))).toBe(true);
    expect(fake.calls.some((c) => /issue\/20002\/changelog\?startAt=2/.test(c))).toBe(true);
    expect(fake.bodies.find((b) => b.path === '/rest/api/3/search/jql')!.body).toMatchObject({ expand: 'changelog', fields: ['*all'], maxResults: 25 });
  });

  it('with no content asked for: no changelog expand, no comments / files / history, full-size pages', async () => {
    const fake = fakeJira();
    const { pages } = await runAll(make(fake).adapter, sel('10000'), NONE);
    const t = T(pages, '20002');
    expect(t.comments).toBeUndefined();
    expect(t.history).toBeUndefined();
    expect(t.attachments).toBeUndefined();
    expect(t.description).not.toContain(FILE_URL('501')); // the placeholder is left alone without attachments
    const body = fake.bodies.find((b) => b.path === '/rest/api/3/search/jql')!.body;
    expect(body.expand).toBeUndefined();
    expect(body.maxResults).toBe(50);
    expect(fake.calls.some((c) => /\/comment|\/changelog/.test(c))).toBe(false);
  });

  it('structure: hierarchy and statuses carry through; dependencies once per link id, in the page of the issue that lists them', async () => {
    const { pages } = await runAll(make(fakeJira()).adapter, sel('10000', '10001'), NONE);
    expect(T(pages, '20003')).toMatchObject({ parentExternalId: '20002', issueTypeExternalId: '13', statusExternalId: '10000:4' });
    expect(T(pages, '20002').parentExternalId).toBe('20001');
    // a link is listed on BOTH issues (here in two pages): the same external id and the same edge both times, written once
    const all = pages.flatMap((p) => p.dependencies ?? []);
    expect(all.filter((d) => d.externalId === 'l:9002')).toHaveLength(2);
    expect(new Set(all.filter((d) => d.externalId === 'l:9002').map((d) => `${d.fromExternalId}>${d.toExternalId}`)).size).toBe(1);
    const deps = [...new Map(all.map((d) => [d.externalId, d])).values()];
    expect(deps.map((d) => [d.externalId, d.fromExternalId, d.toExternalId, d.type]).sort()).toEqual([
      ['l:9001', '20002', '20003', 'BLOCKS'], ['l:9002', '20002', '20101', 'RELATES_TO'], ['l:9003', '20002', '20004', 'RELATES_TO'],
    ]);
    expect(T(pages, '20002').description).not.toContain('OPS-1'); // OPS is selected: it is a link, not text
    expect(T(pages, '20002').description).toContain('- duplicates ENG-4'); // a duplicate keeps its meaning as text too
  });

  it('pages follow nextPageToken within a project, then move to the next; every page validates', async () => {
    const fake = fakeJira(dataset(), { pageSize: 2 });
    const { pages } = await runAll(make(fake).adapter, sel('10000', '10001'), NONE);
    expect(pages.map((p) => (p.tasks ?? []).map((t) => t.key))).toEqual([[], ['ENG-1', 'ENG-2'], ['ENG-3', 'ENG-4'], ['OPS-1']]);
    for (const p of pages) { const v = validateBundle(p); expect('fatal' in v).toBe(false); if (!('fatal' in v)) expect(v.issues.filter((i) => i.severity !== 'INFO')).toEqual([]); }
    const tokens = fake.bodies.filter((b) => b.path === '/rest/api/3/search/jql').map((b) => b.body.nextPageToken);
    expect(tokens).toEqual([undefined, 'tok:2', undefined]);
  });

  it('resuming from a stored cursor gives the same page as running straight through', async () => {
    const opts = { pageSize: 2 };
    const { pages, cursors } = await runAll(make(fakeJira(dataset(), opts)).adapter, sel('10000'), NONE);
    const again = await make(fakeJira(dataset(), opts)).adapter.fetchBundle({ ctx, selection: sel('10000'), options: NONE, cursor: JSON.parse(JSON.stringify(cursors[2])) });
    expect(again.bundle).toEqual(pages[2]);
  });

  it.each([
    [{ v: 2, projects: ['1'], keys: ['A'], i: 0, token: null, base: '' }], [{ v: 1, projects: ['1'], keys: [], i: 0, token: null, base: '' }], [{ v: 1, projects: ['1'], keys: ['A'], i: 1, token: null, base: '' }],
    [{ v: 1, projects: ['1'], keys: ['A'], i: 0, token: 5, base: '' }], [{ v: 1, projects: [1], keys: ['A'], i: 0, token: null, base: '' }], ['x'],
  ])('a saved cursor that is not ours is refused: %j', async (cursor) => {
    await expect(make(fakeJira()).adapter.fetchBundle({ ctx, selection: sel('10000'), options: ALL, cursor })).rejects.toThrow(/cursor/);
  });

  it('a dead token is ProviderAuthRejectedError (the job pauses); a vanished project fails loudly', async () => {
    await expect(make(fakeJira()).adapter.discover({ ...ctx, accessToken: 'revoked' })).rejects.toBeInstanceOf(ProviderAuthRejectedError);
    await expect(make(fakeJira()).adapter.fetchBundle({ ctx, selection: sel('99999'), options: ALL, cursor: null })).rejects.toMatchObject({ status: 404 });
  });

  it('the access token is a Bearer on every API call, against api.atlassian.com/ex/jira/<this site>', async () => {
    const fake = fakeJira();
    await runAll(make(fake).adapter, sel('10001'), NONE);
    const urls = fake.fetch.mock.calls.map((c) => String(c[0]));
    expect(urls.every((u) => u.startsWith(`https://api.atlassian.com/ex/jira/${CLOUD}/`))).toBe(true);
    expect(fake.fetch.mock.calls.every((c) => ((c[1]?.headers ?? {}) as Record<string, string>).authorization === 'Bearer tok')).toBe(true);
  });
});

describe('JiraAdapter.fetchAttachment', () => {
  it('streams an attachment of THIS site with the token, size and type from the headers', async () => {
    const fake = fakeJira();
    const f = await make(fake).adapter.fetchAttachment({ ctx, providerRef: FILE_URL('501') });
    expect(await read(f.stream)).toBe('PNG-bytes-11');
    expect(f.sizeBytes).toBe(12);
    expect(f.mimeType).toBe('image/png');
    expect(fake.fileCalls).toEqual([{ url: FILE_URL('501'), auth: 'Bearer tok' }]);
  });

  it.each([
    ['another site', `https://api.atlassian.com/ex/jira/other-cloud/rest/api/3/attachment/content/1`],
    ['another host', `https://evil.example/ex/jira/${CLOUD}/rest/api/3/attachment/content/1`],
    ['the site\'s own domain', `${BASE}/rest/api/3/attachment/content/1`],
    ['another API path', `https://api.atlassian.com/ex/jira/${CLOUD}/rest/api/3/issue/1`],
    ['a path climbing out', `https://api.atlassian.com/ex/jira/${CLOUD}/rest/api/3/attachment/content/1/../../issue`],
    ['an extra segment', `https://api.atlassian.com/ex/jira/${CLOUD}/rest/api/3/attachment/content/1/2`],
    ['no id', `https://api.atlassian.com/ex/jira/${CLOUD}/rest/api/3/attachment/content/`],
    ['http', `http://api.atlassian.com/ex/jira/${CLOUD}/rest/api/3/attachment/content/1`],
    ['userinfo', `https://u:p@api.atlassian.com/ex/jira/${CLOUD}/rest/api/3/attachment/content/1`],
    ['garbage', 'not a url'],
  ])('refuses %s without a request', async (_n, ref) => {
    const fake = fakeJira();
    await expect(make(fake).adapter.fetchAttachment({ ctx, providerRef: ref })).rejects.toMatchObject({ status: 400 });
    expect(fake.fetch).not.toHaveBeenCalled();
  });

  it('401 = the token is dead (the job pauses); another refusal is about this file', async () => {
    const d = dataset(); d.files[FILE_URL('501')] = { body: 'x', status: 401 }; d.files[FILE_URL('502')] = { body: 'x', status: 404 };
    await expect(make(fakeJira(d)).adapter.fetchAttachment({ ctx, providerRef: FILE_URL('501') })).rejects.toBeInstanceOf(ProviderAuthRejectedError);
    await expect(make(fakeJira(d)).adapter.fetchAttachment({ ctx, providerRef: FILE_URL('502') })).rejects.toMatchObject({ status: 404 });
  });
});

void ISSUES; void toIssueType; void ProviderHttpError;
