import { Readable } from 'node:stream';
import { CanonicalBundle, validateBundle } from '../../../imports/canonical';
import { DEFAULT_IMPORT_OPTIONS } from '../../../imports/imports.types';
import { suggestStatus } from '../../../imports/mapping/mapping.suggest';
import { lookupPriority } from '../../../imports/mapping/mapping.tables';
import { ProviderAuthRejectedError, ProviderHttpError, ProviderRateLimitedError } from '../../core/integration.types';
import { ProviderHttpClient } from '../../core/provider-http.client';
import { AsanaAdapter } from './asana.adapter';
import { AsanaClient } from './asana.client';
import { ATTACHMENT_META, DATASET, DL_ASANA, DL_BAD_BUCKET, DL_EVIL, DL_LOOKALIKE, DL_STORAGE, FILES, ME, fakeAsana } from './fixtures/asana-responses';
import {
  attachmentRef, completedStatusId, downloadTarget, instantOrDate, isoDate, isoInstant, isPriorityField, parseAttachmentRef, priorityOf, safeFileName,
  sectionStatusId, todoStatusId, toAttachments, toComments, toCustomField, toCustomValue, toDependencies, toProject, toTask, toUser,
} from './asana.normalize';
import { AsStory } from './asana.types';

const noRedis = { configured: false, isReady: () => false } as never;
const cfgOf = (env: Record<string, string> = {}) => ({ get: (k: string) => env[k] }) as never;
function make(fake: ReturnType<typeof fakeAsana>, env: Record<string, string> = {}, httpOpts: Record<string, unknown> = {}) {
  const http = new ProviderHttpClient(noRedis, (async (...a: unknown[]) => (await (fake.fetch as any)(...a)).clone()) as never, { bucketCapacity: 1e6, refillPerSecond: 1e6, maxRetries: 0, ...httpOpts });
  const e = { ASANA_CLIENT_ID: 'cid', ASANA_CLIENT_SECRET: 'sec', ASANA_REQUESTS_PER_MINUTE: '10000', ...env };
  return { adapter: new AsanaAdapter(cfgOf(e), http, new AsanaClient(http, cfgOf(e))), http };
}
const ctx = { connectionId: 'conn-1', externalAccountId: ME, accessToken: 'tok' };
const sel = (...s: Array<[string, string]>) => ({ sources: s.map(([type, id]) => ({ id, type })) });
const read = async (s: Readable) => { const p: Buffer[] = []; for await (const c of s) p.push(Buffer.from(c)); return Buffer.concat(p).toString(); };

async function runAll(a: AsanaAdapter, selection = sel(['team', 't1'], ['project', 'p3']), options = DEFAULT_IMPORT_OPTIONS) {
  const pages: CanonicalBundle[] = [];
  const cursors: unknown[] = [];
  let cursor: unknown = null;
  for (let n = 0; n < 80; n++) {
    cursors.push(cursor);
    const r = await a.fetchBundle({ ctx, selection, options, cursor });
    pages.push(r.bundle as CanonicalBundle);
    if (r.next === null) return { pages, cursors };
    cursor = r.next;
  }
  throw new Error('did not terminate');
}
const tasksOf = (pages: CanonicalBundle[]) => pages.flatMap((p) => p.tasks ?? []);
const byId = (pages: CanonicalBundle[]) => new Map(tasksOf(pages).map((t) => [t.externalId, t]));

describe('Asana normalizers', () => {
  it('datetimes are ISO strings, dates are YYYY-MM-DD at 00:00 UTC, junk is "no value"', () => {
    expect(isoInstant('2026-01-01T10:00:00Z')).toBe('2026-01-01T10:00:00.000Z');
    expect(isoDate('2026-03-01')).toBe('2026-03-01T00:00:00.000Z');
    for (const bad of [undefined, null, '', 'abc', 5 as never]) expect(isoInstant(bad as never)).toBeUndefined();
    for (const bad of [undefined, null, '', '2026-3-1', '2026-03-01T00:00:00Z']) expect(isoDate(bad as never)).toBeUndefined();
    expect(instantOrDate('2026-02-01T09:00:00.000Z', '2026-02-01')).toBe('2026-02-01T09:00:00.000Z'); // the precise instant wins
    expect(instantOrDate(null, '2026-02-01')).toBe('2026-02-01T00:00:00.000Z');
  });

  it('a user falls back from name to e-mail to gid', () => {
    expect(toUser({ gid: '1', name: 'A', email: 'a@x.y' })).toEqual({ externalId: '1', name: 'A', email: 'a@x.y' });
    expect(toUser({ gid: '2', email: 'b@x.y' }).name).toBe('b@x.y');
    expect(toUser({ gid: '3' }).name).toBe('3');
  });

  it('sections become statuses with UNKNOWN category (the mapping step judges the name) + a synthetic Completed (diagram 07)', () => {
    const p = toProject({ gid: 'P', name: 'A', archived: true, notes: 'n' }, [{ gid: 's1', name: 'Backlog' }, { gid: 's2', name: '' }]);
    expect(p.statuses!.map((s) => [s.externalId, s.name, s.category, s.position])).toEqual([
      ['P:s1', 'Backlog', 'UNKNOWN', 0], ['P:s2', 'Untitled section', 'UNKNOWN', 1], ['P:__completed', 'Completed', 'DONE', 2],
    ]);
    expect(p).toMatchObject({ externalId: 'P', description: 'n', archived: true });
  });

  it('a project WITHOUT sections gets a synthetic To do so open tasks have a status', () => {
    const p = toProject({ gid: 'P', name: 'A' }, []);
    expect(p.statuses!.map((s) => [s.externalId, s.category])).toEqual([['P:__todo', 'TODO'], ['P:__completed', 'DONE']]);
  });

  it('only an enum field called exactly "Priority" is the priority; it is NOT also a custom field', () => {
    const prio = { gid: 'f', name: ' priority ', resource_subtype: 'enum', enum_value: { name: 'High' } };
    expect(isPriorityField(prio)).toBe(true);
    expect(isPriorityField({ ...prio, name: 'Priority level' })).toBe(false);
    expect(isPriorityField({ ...prio, resource_subtype: 'text' })).toBe(false);
    expect(priorityOf([{ gid: 'x', name: 'Env', resource_subtype: 'enum', enum_value: { name: 'prod' } }, prio])).toBe('High');
    expect(priorityOf([{ ...prio, enum_value: null }])).toBeUndefined();
    expect(toCustomField(prio)).toBeNull();
    expect(toCustomValue(prio)).toBeNull();
    // no Asana table is needed: the generic one understands the usual words (MEDIUM confidence = shown to the person as a suggestion)
    expect(lookupPriority('asana', 'High')).toEqual({ priority: 'HIGH', confidence: 'MEDIUM', reason: 'GENERIC_TABLE' });
    expect([lookupPriority('asana', 'P0').priority, lookupPriority('asana', 'P1').priority]).toEqual(['URGENT', 'HIGH']);
    expect(lookupPriority('asana', 'Sev-weird')).toEqual({ priority: null, confidence: 'LOW', reason: 'NONE' });
  });

  it('custom field definitions and values: enum, multi-enum, number, text, date, people; formulas and references are not mapped', () => {
    expect(toCustomField({ gid: 'e', name: 'Env', resource_subtype: 'enum', enum_options: [{ gid: '1', name: 'a', enabled: true }, { gid: '2', name: 'off', enabled: false }] })).toMatchObject({ dataType: 'SELECT', options: [{ label: 'a' }] });
    expect(toCustomField({ gid: 'm', name: 'M', resource_subtype: 'multi_enum' })).toMatchObject({ dataType: 'MULTI_SELECT' });
    expect(toCustomField({ gid: 'f', name: 'F', resource_subtype: 'number', is_formula_field: true })).toBeNull();
    expect(toCustomField({ gid: 'r', name: 'R', resource_subtype: 'reference' })).toBeNull();
    expect(toCustomValue({ gid: 'n', resource_subtype: 'number', number_value: 0 })).toEqual({ fieldExternalId: 'n', value: 0 });
    expect(toCustomValue({ gid: 't', resource_subtype: 'text', text_value: '' })).toBeNull();
    expect(toCustomValue({ gid: 'd', resource_subtype: 'date', date_value: { date: '2026-05-01' } })).toEqual({ fieldExternalId: 'd', value: '2026-05-01T00:00:00.000Z' });
    expect(toCustomValue({ gid: 'm', resource_subtype: 'multi_enum', multi_enum_values: [{ name: 'a' }, { name: '' }, { name: 'b' }] })).toEqual({ fieldExternalId: 'm', value: ['a', 'b'] });
    expect(toCustomValue({ gid: 'p', resource_subtype: 'people', people_value: [{ gid: 'u9' }] })).toEqual({ fieldExternalId: 'p', value: 'u9' });
    expect(toCustomValue({ gid: 'e', resource_subtype: 'enum', enum_value: null })).toBeNull();
  });

  it('section names go through the REAL suggestion engine: judged by name and flagged as guesses; the synthetic statuses are certain', () => {
    const rows = toProject({ gid: 'P', name: 'A' }, ['Backlog', 'Ideas', 'In progress', 'In review', 'Waiting on client', 'Done', "Won't do", ''].map((name, i) => ({ gid: `s${i}`, name }))).statuses!
      .map((st) => { const g = suggestStatus('P', st); return [st.name, g.category, g.excludeFromProgress, g.confidence, g.reason]; });
    expect(rows).toEqual([
      ['Backlog', 'TODO', false, 'LOW', 'DEFAULT'], ['Ideas', 'TODO', false, 'LOW', 'DEFAULT'], ['In progress', 'IN_PROGRESS', false, 'MEDIUM', 'NAME_IN_PROGRESS'],
      ['In review', 'IN_PROGRESS', false, 'MEDIUM', 'NAME_IN_PROGRESS'], ['Waiting on client', 'BLOCKED', false, 'LOW', 'NAME_BLOCKED'], ['Done', 'DONE', false, 'MEDIUM', 'NAME_DONE'],
      ["Won't do", 'DONE', true, 'MEDIUM', 'NAME_CANCELED'], ['Untitled section', 'TODO', false, 'LOW', 'DEFAULT'], ['Completed', 'DONE', false, 'HIGH', 'SOURCE_CATEGORY'],
    ]);
    const bare = toProject({ gid: 'P', name: 'A' }, []).statuses!.map((st) => suggestStatus('P', st).confidence);
    expect(bare).toEqual(['HIGH', 'HIGH']); // "To do" and "Completed" are never a guess
  });

  describe('tasks', () => {
    const cx = { projectId: 'P', fallbackStatusId: todoStatusId('P') };
    it('an open task takes its SECTION in that project; no section -> the fallback; completed -> Completed whatever the section', () => {
      const m = (id: string, section: string | null) => ({ project: { gid: id }, section: section ? { gid: section } : null });
      expect(toTask({ gid: 't', name: 'x', memberships: [m('OTHER', 'sx'), m('P', 's2')] }, cx).statusExternalId).toBe(sectionStatusId('P', 's2'));
      expect(toTask({ gid: 't', name: 'x', memberships: [m('P', null)] }, cx).statusExternalId).toBe(todoStatusId('P'));
      expect(toTask({ gid: 't', name: 'x' }, cx).statusExternalId).toBe(todoStatusId('P'));
      expect(toTask({ gid: 't', name: 'x', completed: true, memberships: [m('P', 's2')] }, cx).statusExternalId).toBe(completedStatusId('P'));
    });

    it('a task copy is identified by project AND task (the same task in two projects is two tasks)', () => {
      expect(toTask({ gid: 't', name: 'x' }, cx).externalId).toBe('P:t');
      expect(toTask({ gid: 't', name: 'x' }, { ...cx, projectId: 'Q' }).externalId).toBe('Q:t');
    });

    it('a subtask has its parent, inherits the parent\'s section status while open, and is Completed when done', () => {
      const parent = { id: 'P:1', statusId: sectionStatusId('P', 's2') };
      expect(toTask({ gid: 'c', name: 'x' }, { ...cx, parent })).toMatchObject({ parentExternalId: 'P:1', statusExternalId: 'P:s2' });
      expect(toTask({ gid: 'c', name: 'x', completed: true }, { ...cx, parent }).statusExternalId).toBe('P:__completed');
    });

    it('milestones and approvals become issue types; the priority field becomes priority; one assignee; dates', () => {
      const t = toTask({
        gid: 't', name: 'n', resource_subtype: 'milestone', assignee: { gid: 'u2' }, created_by: { gid: 'u1' }, due_on: '2026-03-01', start_at: '2026-02-01T09:00:00Z', start_on: '2026-02-01',
        custom_fields: [{ gid: 'p', name: 'Priority', resource_subtype: 'enum', enum_value: { name: 'Urgent' } }],
      }, cx);
      expect(t).toMatchObject({ issueTypeExternalId: 'milestone', assigneeExternalIds: ['u2'], creatorExternalId: 'u1', priority: 'Urgent', dueDate: '2026-03-01T00:00:00.000Z', startDate: '2026-02-01T09:00:00.000Z' });
      expect(toTask({ gid: 't', name: 'n', resource_subtype: 'approval' }, cx).issueTypeExternalId).toBe('approval');
      expect(toTask({ gid: 't', name: 'n', resource_subtype: 'default_task' }, cx).issueTypeExternalId).toBeUndefined();
    });

    it('html_notes -> markdown, falling back to plain notes; section names travel as tags only when sections were unreadable', () => {
      expect(toTask({ gid: 't', name: 'n', html_notes: '<body><strong>Hi</strong> there</body>', notes: 'Hi there' }, cx).description).toBe('**Hi** there');
      expect(toTask({ gid: 't', name: 'n', html_notes: '', notes: 'plain' }, cx).description).toBe('plain');
      const withSection = { gid: 't', name: 'n', memberships: [{ project: { gid: 'P' }, section: { gid: 's', name: 'Doing' } }], tags: [{ name: 'x' }, { name: 'x' }] };
      expect(toTask(withSection, cx).tags).toEqual(['x']);
      expect(toTask(withSection, { ...cx, sectionsAsTags: true }).tags).toEqual(['Doing', 'x']);
    });
  });

  it('dependencies: the listed tasks are BLOCKERS of this one (blocker -> this), one stable id per edge, no self edges, same project copy', () => {
    const d = toDependencies({ gid: 'T', dependencies: [{ gid: 'B' }, { gid: 'T' }, { gid: '' as never }] }, 'P');
    expect(d).toEqual([{ externalId: 'dep:P:B>T', fromExternalId: 'P:B', toExternalId: 'P:T', type: 'BLOCKS' }]);
  });

  it('comments: only real comments (not system stories), oldest first, html preferred, author name kept', () => {
    const s = (gid: string, over: Partial<AsStory>): AsStory => ({ gid, type: 'comment', resource_subtype: 'comment_added', text: gid, created_at: '2026-01-01T00:00:00.000Z', ...over });
    const out = toComments([
      s('b', { created_at: '2026-01-03T00:00:00.000Z', created_by: { gid: 'u', name: 'Ben' }, html_text: '<body><em>hey</em></body>' }),
      s('sys', { type: 'system', resource_subtype: 'assigned' }),
      s('a', { created_at: '2026-01-02T00:00:00.000Z' }),
      s('a', { created_at: '2026-01-02T00:00:00.000Z' }), // an exact duplicate (same story twice)
    ]);
    expect(out.map((c) => [c.externalId, c.body])).toEqual([['a', 'a'], ['b', '*hey*']]);
    expect(out[1]).toMatchObject({ authorExternalId: 'u', authorName: 'Ben' });
  });

  it('attachments: only Asana-hosted files; the ref is opaque (never an address); file names cannot carry a path', () => {
    const out = toAttachments('P:T', [
      { gid: '1', name: 'a.png', host: 'asana', size: 10 }, { gid: '2', name: 'Doc', host: 'gdrive' }, { gid: '3', name: '../../etc/passwd', host: 'asana' },
      { gid: '1', name: 'dup', host: 'asana' }, { gid: 'x/../y', name: 'bad', host: 'asana' }, { gid: '5', host: 'asana', resource_subtype: 'asana' },
    ]);
    expect(out.map((a) => [a.externalId, a.fileName, a.providerRef])).toEqual([
      ['P:T:1', 'a.png', 'asana-attachment:1'], ['P:T:3', 'passwd', 'asana-attachment:3'], ['P:T:5', 'attachment-5', 'asana-attachment:5'],
    ]);
    expect(out[0].sizeBytes).toBe(10);
    expect(safeFileName('a\u0000b\\c.txt', 'x')).toBe('c.txt');
    expect(safeFileName('   ', 'fallback')).toBe('fallback');
  });

  it.each([
    [attachmentRef('123'), '123'], ['asana-attachment:', null], ['asana-attachment:12a', null], ['asana-attachment:1/../2', null],
    ['https://app.asana.com/x', null], ['', null], [undefined as never, null],
  ])('attachment ref %j -> %j', (ref, gid) => expect(parseAttachmentRef(ref)).toBe(gid));

  it.each([
    ['https://app.asana.com/app/asana/-/get_asset?asset_id=1', 'asana'], ['https://assets.asana.com/x', 'asana'],
    ['https://asana-user-private-us-east-1.s3.amazonaws.com/x?sig=1', 'storage'], ['https://asana-attachments.s3.eu-west-1.amazonaws.com/x', 'storage'],
    ['https://asana-user-private.s3-us-west-2.amazonaws.com/x', 'storage'],
    ['http://app.asana.com/x', null], ['https://app.asana.com:8443/x', null], ['https://user:pw@app.asana.com/x', null],
    ['https://app.asana.com.evil.example/x', null], ['https://evilasana.com/x', null], ['https://169.254.169.254/x', null],
    ['https://evil-bucket.s3.amazonaws.com/x', null], ['https://asana.s3.amazonaws.com.evil.example/x', null], ['not a url', null],
  ])('download target %s -> %s', (url, kind) => expect(downloadTarget(url)).toBe(kind));
});

describe('AsanaAdapter OAuth', () => {
  it('declares PKCE and the authorize URL carries state, scopes and the S256 challenge, never the secret', () => {
    const { adapter } = make(fakeAsana());
    expect(adapter.usesPkce).toBe(true);
    const u = new URL(adapter.authorizeUrl({ state: 'st', redirectUri: 'https://app/cb', pkceChallenge: 'chal' }));
    expect(u.origin + u.pathname).toBe('https://app.asana.com/-/oauth_authorize');
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ client_id: 'cid', redirect_uri: 'https://app/cb', response_type: 'code', state: 'st', code_challenge: 'chal', code_challenge_method: 'S256' });
    expect(u.searchParams.get('scope')).toContain('tasks:read');
    expect(u.toString()).not.toContain('sec');
  });

  it('ASANA_SCOPES overrides the scopes (a Full-permissions app must send "default")', () => {
    const { adapter } = make(fakeAsana(), { ASANA_SCOPES: 'default' });
    expect(new URL(adapter.authorizeUrl({ state: 's', redirectUri: 'r' })).searchParams.get('scope')).toBe('default');
  });

  it('isConfigured needs both id and secret', () => {
    expect(make(fakeAsana()).adapter.isConfigured()).toBe(true);
    expect(make(fakeAsana(), { ASANA_CLIENT_SECRET: '' }).adapter.isConfigured()).toBe(false);
  });

  it('exchangeCode: form-encoded body with the PKCE verifier; the account is the PERSON (one connection covers all their workspaces)', async () => {
    const fake = fakeAsana();
    const { adapter } = make(fake);
    const { tokens, account } = await adapter.exchangeCode({ code: 'c0de' }, { redirectUri: 'https://app/cb', pkceVerifier: 'ver' });
    expect(account).toEqual({ id: 'u1', name: 'Ana Lima' });
    expect(tokens).toMatchObject({ accessToken: 'newtok', refreshToken: 'rt-1', tokenType: 'bearer' });
    expect(tokens.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 3500_000);
    const init = fake.fetch.mock.calls[0][1] as RequestInit;
    expect(String(init.headers && (init.headers as Record<string, string>)['content-type'])).toContain('application/x-www-form-urlencoded');
    const body = new URLSearchParams(String(init.body));
    expect(Object.fromEntries(body)).toMatchObject({ grant_type: 'authorization_code', code: 'c0de', redirect_uri: 'https://app/cb', code_verifier: 'ver', client_id: 'cid', client_secret: 'sec' });
  });

  it('exchangeCode refuses a callback without a code and a rejected code', async () => {
    await expect(make(fakeAsana()).adapter.exchangeCode({}, { redirectUri: 'r' })).rejects.toThrow('without code');
    await expect(make(fakeAsana({ ...DATASET, tokenOk: false })).adapter.exchangeCode({ code: 'x' }, { redirectUri: 'r' })).rejects.toThrow('HTTP 400 invalid_grant');
  });

  it('refresh: a new access token, the SAME refresh token kept (Asana does not rotate it); a dead grant -> ProviderAuthRejectedError', async () => {
    const { adapter } = make(fakeAsana());
    const t = await adapter.refresh({ accessToken: 'old', refreshToken: 'rt-ok', scopes: ['tasks:read'] });
    expect(t).toMatchObject({ accessToken: 'newtok', refreshToken: 'rt-ok', scopes: ['tasks:read'] });
    expect(t.expiresAt).toBeInstanceOf(Date);
    await expect(adapter.refresh({ accessToken: 'old', refreshToken: 'rt-dead', scopes: [] })).rejects.toBeInstanceOf(ProviderAuthRejectedError);
    await expect(adapter.refresh({ accessToken: 'old', scopes: [] })).rejects.toBeInstanceOf(ProviderAuthRejectedError);
  });

  it('revoke sends the REFRESH token (Asana rejects an access token there) and never throws on nothing to revoke', async () => {
    const fake = fakeAsana();
    const { adapter } = make(fake);
    await adapter.revoke({ accessToken: 'a', refreshToken: 'rt-1', scopes: [] }, { id: 'u1', name: 'x' });
    const call = fake.fetch.mock.calls.find((c) => String(c[0]).endsWith('/-/oauth_revoke'))!;
    expect(new URLSearchParams(String((call[1] as RequestInit).body)).get('token')).toBe('rt-1');
    const before = fake.fetch.mock.calls.length;
    await adapter.revoke({ accessToken: 'a', scopes: [] }, { id: 'u1', name: 'x' });
    expect(fake.fetch.mock.calls.length).toBe(before);
  });
});

describe('AsanaAdapter discover / estimate', () => {
  it('the tree is workspace (not selectable) -> team -> project; team-less projects hang off the workspace; archived ones are not offered', async () => {
    const { adapter } = make(fakeAsana());
    const { nodes } = await adapter.discover(ctx);
    expect(nodes.find((n) => n.id === 'w1')).toMatchObject({ type: 'workspace', selectable: false, parentId: null });
    expect(nodes.find((n) => n.id === 't1')).toMatchObject({ type: 'team', name: 'Engineering', parentId: 'w1', selectable: true });
    expect(nodes.find((n) => n.id === 'p1')).toMatchObject({ type: 'project', parentId: 't1', selectable: true });
    expect(nodes.find((n) => n.id === 'p4')).toMatchObject({ parentId: 'w2' });
    expect(nodes.find((n) => n.id === 'p3')).toBeUndefined(); // archived
    expect(new Set(nodes.map((n) => n.id)).size).toBe(nodes.length);
  });

  it('a workspace the token cannot list is skipped, not fatal', async () => {
    const fake = fakeAsana(DATASET, { intercept: (p) => (p === '/workspaces/w2/projects' ? fake.json({ errors: [{ message: 'forbidden' }] }, 403) : undefined) });
    const { nodes } = await make(fake).adapter.discover(ctx);
    expect(nodes.some((n) => n.id === 'w2')).toBe(true);
    expect(nodes.some((n) => n.id === 'p4')).toBe(false);
  });

  it('estimate: counts per project, a structure page that validates, priorities from the field options, honest warnings', async () => {
    const { adapter } = make(fakeAsana());
    const e = await adapter.estimate(ctx, sel(['team', 't1']), DEFAULT_IMPORT_OPTIONS);
    expect(e.projects).toEqual([{ sourceId: 'p1', name: 'Sprint Board', tasks: 4 }, { sourceId: 'p2', name: 'Bugs', tasks: 101 }]);
    expect(e.users).toBe(3);
    expect(e.inventory!.priorities).toEqual(expect.arrayContaining(['Low', 'Medium', 'High']));
    expect(e.inventory!.priorities).not.toContain('Old'); // a disabled option
    const codes = e.warnings!.map((w) => w.code);
    expect(codes).toEqual(expect.arrayContaining(['MULTI_PROJECT_DUPLICATED', 'CONTENT_SLOW', 'HISTORY_NOT_AVAILABLE', 'CUSTOM_FIELDS_SKIPPED']));
    expect(e.warnings!.find((w) => w.code === 'CUSTOM_FIELDS_SKIPPED')!.message).toMatch(/formula/);
    expect(e.warnings!.find((w) => w.code === 'CUSTOM_FIELDS_SKIPPED')!.message).toMatch(/reference/);
  });

  it('estimate has no duplicate / content warnings when they do not apply', async () => {
    const e = await make(fakeAsana()).adapter.estimate(ctx, sel(['project', 'p4']), { ...DEFAULT_IMPORT_OPTIONS, comments: false, attachments: false, history: false });
    expect(e.warnings!.map((w) => w.code)).toEqual([]);
  });

  it('estimate: an unreadable count is a warning, not a failure', async () => {
    const fake = fakeAsana(DATASET, { intercept: (p) => (p === '/projects/p1/task_counts' ? fake.json({ errors: [] }, 403) : undefined) });
    const e = await make(fake).adapter.estimate(ctx, sel(['project', 'p1']), DEFAULT_IMPORT_OPTIONS);
    expect(e.projects[0].tasks).toBe(0);
    expect(e.warnings!.map((w) => w.code)).toContain('COUNT_UNAVAILABLE');
  });

  it('a selection node type Asana does not have is refused', async () => {
    await expect(make(fakeAsana()).adapter.estimate(ctx, sel(['folder', 'x']), DEFAULT_IMPORT_OPTIONS)).rejects.toThrow('teams and projects');
  });

  it('a selected project that is gone is a 404 (the job reports it), not a silent skip', async () => {
    await expect(make(fakeAsana()).adapter.estimate(ctx, sel(['project', 'nope']), DEFAULT_IMPORT_OPTIONS)).rejects.toMatchObject({ status: 404 });
  });
});

describe('AsanaAdapter fetchBundle', () => {
  it('the first page is the structure: people, projects with section statuses, fields, built-in issue types; no tasks yet', async () => {
    const { adapter } = make(fakeAsana());
    const r = await adapter.fetchBundle({ ctx, selection: sel(['team', 't1'], ['project', 'p3']), options: DEFAULT_IMPORT_OPTIONS, cursor: null });
    const page = r.bundle as CanonicalBundle;
    expect(page.source).toEqual({ system: 'asana', displayName: 'Asana' });
    expect(page.tasks).toBeUndefined();
    expect(page.projects!.map((p) => p.externalId)).toEqual(['p1', 'p2', 'p3']);
    expect(page.projects![0].statuses!.map((s) => s.name)).toEqual(['Backlog', 'In progress', 'Done', 'Completed']);
    expect(page.projects![2].statuses!.map((s) => s.name)).toEqual(['To do', 'Completed']);
    expect(page.users!.map((u) => u.externalId).sort()).toEqual(['u1', 'u2', 'u3']);
    expect(page.issueTypes!.map((t) => t.externalId)).toEqual(['milestone', 'approval']);
    expect(page.customFields!.map((f) => f.externalId).sort()).toEqual(['cf-effort', 'cf-env', 'cf-owner']); // no priority, formula or reference
    expect(page.customFields!.find((f) => f.externalId === 'cf-env')!.options).toEqual([{ label: 'staging' }, { label: 'production' }]);
    expect(r.next).toMatchObject({ v: 1, projects: ['p1', 'p2', 'p3'], first: ['s1', 's4', ''], fb: false, i: 0, off: null, subs: [] });
    expect(validateBundle(page)).not.toHaveProperty('fatal');
  });

  it('the structure page never exceeds a page limit: more custom fields than a page holds are capped with a warning (a page over the limit is FATAL)', async () => {
    const many = Array.from({ length: 520 }, (_, i) => ({ custom_field: { gid: `f${i}`, name: `Field ${i}`, resource_subtype: 'text' } }));
    const fake = fakeAsana(DATASET, { intercept: (p) => (p === '/projects/p1/custom_field_settings' ? new Response(JSON.stringify({ data: many, next_page: null }), { status: 200, headers: { 'content-type': 'application/json' } }) : undefined) });
    const { adapter } = make(fake);
    const r = await adapter.fetchBundle({ ctx, selection: sel(['project', 'p1']), options: DEFAULT_IMPORT_OPTIONS, cursor: null });
    expect((r.bundle as CanonicalBundle).customFields).toHaveLength(500);
    expect(validateBundle(r.bundle)).not.toHaveProperty('fatal');
    const e = await make(fake).adapter.estimate(ctx, sel(['project', 'p1']), DEFAULT_IMPORT_OPTIONS);
    expect(e.warnings!.map((w) => w.code)).toContain('CUSTOM_FIELDS_CAPPED');
  });

  it('an empty selection ends at the structure page', async () => {
    const r = await make(fakeAsana()).adapter.fetchBundle({ ctx, selection: sel(), options: DEFAULT_IMPORT_OPTIONS, cursor: null });
    expect(r.next).toBeNull();
  });

  it('reads everything: every page validates, ends, and the cursors are plain JSON that survive a round trip', async () => {
    const { adapter } = make(fakeAsana());
    const { pages, cursors } = await runAll(adapter);
    for (const p of pages) {
      const checked = validateBundle(p);
      expect(checked).not.toHaveProperty('fatal');
      expect((checked as { issues?: Array<{ severity: string }> }).issues?.filter((i) => i.severity === 'ERROR') ?? []).toEqual([]);
    }
    for (const c of cursors) expect(JSON.parse(JSON.stringify(c))).toEqual(c);
    expect(pages.length).toBeGreaterThan(4);
  });

  it('the project\'s tasks come in pages of 100 via the offset token (Bugs has 101 + the shared one)', async () => {
    const fake = fakeAsana();
    const { adapter } = make(fake);
    const { pages } = await runAll(adapter, sel(['project', 'p2']), { ...DEFAULT_IMPORT_OPTIONS, comments: false, attachments: false });
    const taskPages = pages.filter((p) => p.tasks).map((p) => p.tasks!.filter((t) => !t.parentExternalId).length);
    expect(taskPages[0]).toBe(100);
    expect(tasksOf(pages).filter((t) => !t.parentExternalId)).toHaveLength(101);
    expect(fake.calls.filter((c) => c.startsWith('GET /projects/p2/tasks'))).toHaveLength(2);
    expect(fake.calls.find((c) => c.includes('offset=off-100'))).toBeDefined();
  });

  it('re-fetching a page with a cursor already used gives the same page (at-least-once)', async () => {
    const { adapter } = make(fakeAsana());
    const { cursors } = await runAll(adapter, sel(['project', 'p1']));
    const mid = cursors[2];
    const a = await adapter.fetchBundle({ ctx, selection: sel(['project', 'p1']), options: DEFAULT_IMPORT_OPTIONS, cursor: mid });
    const b = await adapter.fetchBundle({ ctx, selection: sel(['project', 'p1']), options: DEFAULT_IMPORT_OPTIONS, cursor: mid });
    expect(a).toEqual(b);
  });

  it('sections become each task\'s status; completed -> Completed; no section -> the project fallback; priority and fields mapped', async () => {
    const { adapter } = make(fakeAsana());
    const t = byId((await runAll(adapter)).pages);
    expect(t.get('p1:1001')).toMatchObject({ statusExternalId: 'p1:s2', priority: 'High', assigneeExternalIds: ['u2'], tags: ['frontend', 'ui'], projectExternalId: 'p1', title: 'Design the login page' });
    expect(t.get('p1:1001')!.customValues).toEqual([{ fieldExternalId: 'cf-env', value: 'production' }, { fieldExternalId: 'cf-effort', value: 5 }, { fieldExternalId: 'cf-owner', value: 'u3' }]);
    expect(t.get('p1:1001')!.description).toContain('**Goal**');
    expect(t.get('p1:1002')).toMatchObject({ statusExternalId: 'p1:s1', issueTypeExternalId: 'milestone' });
    expect(t.get('p1:1003')!.statusExternalId).toBe('p1:__completed');
    expect(t.get('p3:l1')!.statusExternalId).toBe('p3:__todo');
  });

  it('a task in two selected projects is imported into BOTH, as separate copies with their own section (the owner\'s decision)', async () => {
    const { adapter } = make(fakeAsana());
    const t = byId((await runAll(adapter)).pages);
    expect(t.get('p1:1004')).toMatchObject({ projectExternalId: 'p1', statusExternalId: 'p1:s1' });
    expect(t.get('p2:1004')).toMatchObject({ projectExternalId: 'p2', statusExternalId: 'p2:s4' });
    expect(t.get('p1:2004')!.parentExternalId).toBe('p1:1004');
    expect(t.get('p2:2004')!.parentExternalId).toBe('p2:1004'); // each copy brings its own subtasks
    const ids = tasksOf((await runAll(adapter)).pages).map((x) => x.externalId);
    expect(new Set(ids).size).toBe(ids.length); // no DUPLICATE_ID inside one run
  });

  it('subtasks (and sub-subtasks) arrive after their parent\'s page, under the right parent; completed ones are Completed, open ones inherit the section', async () => {
    const { adapter } = make(fakeAsana());
    const { pages } = await runAll(adapter, sel(['project', 'p1']));
    const t = byId(pages);
    expect(t.get('p1:2001')).toMatchObject({ parentExternalId: 'p1:1001', statusExternalId: 'p1:s2', assigneeExternalIds: ['u1'] });
    expect(t.get('p1:2002')).toMatchObject({ parentExternalId: 'p1:1001', statusExternalId: 'p1:__completed' });
    expect(t.get('p1:3001')).toMatchObject({ parentExternalId: 'p1:2002', statusExternalId: 'p1:s2' });
    const where = (id: string) => pages.findIndex((p) => p.tasks?.some((x) => x.externalId === id));
    expect(where('p1:2001')).toBeGreaterThan(where('p1:1001'));
    expect(where('p1:3001')).toBeGreaterThanOrEqual(where('p1:2002'));
  });

  it('dependencies: blocker -> blocked inside the project copy; an unknown blocker is just a pending edge', async () => {
    const { adapter } = make(fakeAsana());
    const deps = (await runAll(adapter)).pages.flatMap((p) => p.dependencies ?? []);
    expect(deps).toContainEqual({ externalId: 'dep:p1:1002>1001', fromExternalId: 'p1:1002', toExternalId: 'p1:1001', type: 'BLOCKS' });
    expect(deps).toContainEqual({ externalId: 'dep:p2:1002>1004', fromExternalId: 'p2:1002', toExternalId: 'p2:1004', type: 'BLOCKS' });
    expect(new Set(deps.map((d) => d.externalId)).size).toBe(deps.length);
  });

  it('comments are real comments only; files are Asana-hosted only; both only when asked for', async () => {
    const fake = fakeAsana();
    const { adapter } = make(fake);
    const t = byId((await runAll(adapter, sel(['project', 'p1']))).pages).get('p1:1001')!;
    expect(t.comments!.map((c) => [c.externalId, c.body])).toEqual([['c1', 'See [the spec](https://example.com/x)'], ['c2', 'Second comment']]);
    expect(t.attachments!.map((a) => [a.fileName, a.providerRef])).toEqual([['design.png', 'asana-attachment:9001'], ['passwd', 'asana-attachment:9003']]);

    const quiet = fakeAsana();
    const q = byId((await runAll(make(quiet).adapter, sel(['project', 'p1']), { ...DEFAULT_IMPORT_OPTIONS, comments: false, attachments: false })).pages).get('p1:1001')!;
    expect(q.comments).toBeUndefined();
    expect(q.attachments).toBeUndefined();
    expect(quiet.calls.some((c) => c.includes('/stories') || c.startsWith('GET /attachments'))).toBe(false);
  });

  it('tags of a page carry their colour', async () => {
    const { adapter } = make(fakeAsana());
    const tags = (await runAll(adapter, sel(['project', 'p1']))).pages.flatMap((p) => p.tags ?? []);
    expect(tags).toContainEqual({ name: 'frontend', color: 'red' });
    expect(tags).toContainEqual({ name: 'ui' });
  });

  it('SECTIONS UNREADABLE (the scope gap): the import still works, tasks are To do / Completed, the section name is a tag, and the preview says so', async () => {
    const data = { ...DATASET, failSections: true };
    const { adapter } = make(fakeAsana(data));
    const { pages } = await runAll(adapter, sel(['project', 'p1']));
    expect(pages[0].projects![0].statuses!.map((s) => s.name)).toEqual(['To do', 'Completed']);
    const t = byId(pages);
    expect(t.get('p1:1001')).toMatchObject({ statusExternalId: 'p1:__todo', tags: ['In progress', 'frontend', 'ui'] });
    expect(t.get('p1:1003')!.statusExternalId).toBe('p1:__completed');
    expect(t.get('p1:2001')!.statusExternalId).toBe('p1:__todo'); // subtasks too: no dangling section status anywhere
    const known = new Set(pages[0].projects![0].statuses!.map((x) => x.externalId));
    for (const x of tasksOf(pages)) expect(known.has(x.statusExternalId!)).toBe(true);
    const e = await make(fakeAsana(data)).adapter.estimate(ctx, sel(['project', 'p1']), DEFAULT_IMPORT_OPTIONS);
    expect(e.warnings!.map((w) => w.code)).toContain('SECTIONS_UNAVAILABLE');
  });

  it('unreadable custom fields / people degrade to nothing + a warning instead of failing the import', async () => {
    const data = { ...DATASET, failFields: true, failUsers: true };
    const e = await make(fakeAsana(data)).adapter.estimate(ctx, sel(['project', 'p1']), DEFAULT_IMPORT_OPTIONS);
    expect(e.warnings!.map((w) => w.code)).toContain('USERS_UNAVAILABLE');
    const r = await make(fakeAsana(data)).adapter.fetchBundle({ ctx, selection: sel(['project', 'p1']), options: DEFAULT_IMPORT_OPTIONS, cursor: null });
    expect((r.bundle as CanonicalBundle).customFields).toBeUndefined();
  });

  it('a subtask parent that vanished (404) is skipped; a comment list that is forbidden is just no comments', async () => {
    const fake = fakeAsana(DATASET, { intercept: (p) => (p === '/tasks/1001/subtasks' || p === '/tasks/1001/stories' ? fake.json({ errors: [] }, 404) : undefined) });
    const t = byId((await runAll(make(fake).adapter, sel(['project', 'p1']))).pages);
    expect(t.has('p1:2001')).toBe(false);
    expect(t.get('p1:1001')!.comments).toBeUndefined();
    expect(t.has('p1:2004')).toBe(true);
  });

  it('rejects a cursor that is not ours', async () => {
    const { adapter } = make(fakeAsana());
    for (const bad of [{}, { v: 2 }, { v: 1, projects: ['a'], first: [], fb: false, i: 0, off: null, subs: [] }, { v: 1, projects: ['a'], first: [''], fb: false, i: 5, off: null, subs: [] }, { v: 1, projects: ['a'], first: [''], fb: false, i: 0, off: 7, subs: [] }, { v: 1, projects: ['a'], first: [''], fb: false, i: 0, off: null, subs: [{ p: 1 }] }, 'x']) {
      await expect(adapter.fetchBundle({ ctx, selection: sel(['project', 'p1']), options: DEFAULT_IMPORT_OPTIONS, cursor: bad })).rejects.toThrow('cursor is not valid');
    }
  });

  it('errors keep their class: 401 -> ProviderAuthRejectedError (the job pauses), 429 -> ProviderRateLimitedError with Retry-After', async () => {
    await expect(make(fakeAsana()).adapter.discover({ ...ctx, accessToken: 'expired' })).rejects.toBeInstanceOf(ProviderAuthRejectedError);
    const fake = fakeAsana(DATASET, { intercept: (p) => (p === '/workspaces' ? new Response('{}', { status: 429, headers: { 'retry-after': '30' } }) : undefined) });
    const err = await make(fake, {}, { maxInlineWaitMs: 1 }).adapter.discover(ctx).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderRateLimitedError);
  });

  it('a 5xx is a ProviderHttpError; a body that is not the expected JSON is a 502', async () => {
    const boom = fakeAsana(DATASET, { intercept: (p) => (p === '/workspaces' ? new Response('boom', { status: 500 }) : undefined) });
    await expect(make(boom).adapter.discover(ctx)).rejects.toBeInstanceOf(ProviderHttpError);
    const junk = fakeAsana(DATASET, { intercept: (p) => (p === '/workspaces' ? new Response('<html>', { status: 200 }) : undefined) });
    await expect(make(junk).adapter.discover(ctx)).rejects.toMatchObject({ status: 502 });
  });

  it('the pacing bucket follows ASANA_REQUESTS_PER_MINUTE (bounded)', () => {
    const rpm = (v?: string) => new AsanaClient({} as never, cfgOf(v === undefined ? {} : { ASANA_REQUESTS_PER_MINUTE: v })).requestsPerMinute;
    expect([rpm(), rpm('1500'), rpm('5'), rpm('x'), rpm('99999')]).toEqual([120, 1500, 120, 120, 120]);
  });
});

describe('AsanaAdapter fetchAttachment', () => {
  const fileCtx = { ctx, providerRef: attachmentRef('9001') };

  it('asks for the download address NOW, sends the token to an asana.com address, streams the bytes', async () => {
    const fake = fakeAsana();
    const f = await make(fake).adapter.fetchAttachment(fileCtx);
    expect(await read(f.stream)).toBe('PNGDATA');
    expect(f).toMatchObject({ sizeBytes: 7, mimeType: 'image/png' });
    expect(fake.calls).toContain('GET /attachments/9001?opt_fields=host%2Cresource_subtype%2Cdownload_url');
    expect(fake.fileCalls).toEqual([{ url: DL_ASANA, auth: 'Bearer tok' }]);
  });

  it('a signed storage address is fetched WITHOUT the token (a signed URL carries its own authority)', async () => {
    const fake = fakeAsana();
    const f = await make(fake).adapter.fetchAttachment({ ctx, providerRef: attachmentRef('9003') });
    expect(await read(f.stream)).toBe('S3DATA');
    expect(fake.fileCalls).toEqual([{ url: DL_STORAGE, auth: null }]);
  });

  it.each([
    ['a metadata-service address', '9004', DL_EVIL], ['a look-alike host', '9005', DL_LOOKALIKE], ['a foreign bucket', '9006', DL_BAD_BUCKET], ['plain http', '9008', 'http://app.asana.com/insecure'],
  ])('refuses %s: no file request is made, the token is never sent', async (_n, gid, url) => {
    expect(ATTACHMENT_META[gid].download_url).toBe(url);
    const fake = fakeAsana();
    await expect(make(fake).adapter.fetchAttachment({ ctx, providerRef: attachmentRef(gid) })).rejects.toMatchObject({ status: 400 });
    expect(fake.fileCalls).toEqual([]);
  });

  it('a file Asana does not store (a Drive link) is reported for THIS file only (4xx), no file request', async () => {
    const fake = fakeAsana();
    await expect(make(fake).adapter.fetchAttachment({ ctx, providerRef: attachmentRef('9007') })).rejects.toMatchObject({ status: 422 });
    expect(fake.fileCalls).toEqual([]);
  });

  it.each(['https://app.asana.com/api/1.0/attachments/9001', 'asana-attachment:9001/../x', 'asana-attachment:', '', 'clickup:1'])('refuses the ref %j before any request', async (ref) => {
    const fake = fakeAsana();
    await expect(make(fake).adapter.fetchAttachment({ ctx, providerRef: ref })).rejects.toMatchObject({ status: 400 });
    expect(fake.fetch).not.toHaveBeenCalled();
  });

  it('a gone attachment is a 404 for that file; an expired token is ProviderAuthRejectedError', async () => {
    await expect(make(fakeAsana()).adapter.fetchAttachment({ ctx, providerRef: attachmentRef('777') })).rejects.toMatchObject({ status: 404 });
    await expect(make(fakeAsana()).adapter.fetchAttachment({ ctx: { ...ctx, accessToken: 'old' }, providerRef: attachmentRef('9001') })).rejects.toBeInstanceOf(ProviderAuthRejectedError);
  });

  it('the fixture files exist for every allowed address (guards the fixtures themselves)', () => {
    expect(Object.keys(FILES)).toEqual(expect.arrayContaining([DL_ASANA, DL_STORAGE]));
  });
});
