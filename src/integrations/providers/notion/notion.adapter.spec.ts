import { Readable } from 'node:stream';
import { FieldType } from '@prisma/client';
import { CanonicalBundle, validateBundle } from '../../../imports/canonical';
import { resolveFieldRoles, suggestFieldRoles } from '../../../imports/field-roles';
import { DEFAULT_IMPORT_OPTIONS } from '../../../imports/imports.types';
import { suggestStatus } from '../../../imports/mapping/mapping.suggest';
import { ProviderAuthRejectedError, ProviderHttpError, ProviderRateLimitedError } from '../../core/integration.types';
import { ProviderHttpClient } from '../../core/provider-http.client';
import { NotionAdapter } from './notion.adapter';
import { NotionClient } from './notion.client';
import { BIG_IDS, BLOCK, CHECK_IDS, DATASET, DATA_SOURCES, DS, P, PATH_DESIGN, PATH_DOC, PATH_SPEC, STAGE_IDS, URL_EVIL, URL_EXTRA, U, WORKSPACE, fakeNotion } from './fixtures/notion-responses';
import {
  buildSource, convertMarkdown, customValueOf, dateInstant, fieldTypeOf, fieldsOfDataSource, fileHash, fileRef, isAllowedFileUrl, isTrashed, isoInstant, parseFileRef, pathKey, plain,
  propertyFiles, richTextToMarkdown, safeFileName, toAttachments, toComments, toDependencies, toTask, toUser, endFieldId, splitEndId,
} from './notion.normalize';
import type { NtPlan } from './notion.normalize';
import { NtDataSource, NtPage } from './notion.types';

const noRedis = { configured: false, isReady: () => false } as never;
const cfgOf = (env: Record<string, string> = {}) => ({ get: (k: string) => env[k] }) as never;
function make(fake: ReturnType<typeof fakeNotion>, env: Record<string, string> = {}, httpOpts: Record<string, unknown> = {}) {
  const http = new ProviderHttpClient(noRedis, (async (...a: unknown[]) => (await (fake.fetch as any)(...a)).clone()) as never, { bucketCapacity: 1e6, refillPerSecond: 1e6, maxRetries: 0, ...httpOpts });
  const e = { NOTION_CLIENT_ID: 'cid', NOTION_CLIENT_SECRET: 'sec', NOTION_REQUESTS_PER_SECOND: '3', ...env };
  const client = new NotionClient(http, cfgOf(e));
  // the real bucket (3 requests a second) would make the suite wait minutes: only the PACING is replaced, everything else is the real client
  (client as any).rate = () => ({ capacity: 1e6, refillPerSecond: 1e6 });
  return { adapter: new NotionAdapter(cfgOf(e), http, client), http, client };
}
const ctx = { connectionId: 'conn-1', externalAccountId: WORKSPACE.id, accessToken: 'tok' };
const sel = (...s: Array<[string, string, Record<string, string | null>?]>) => ({ sources: s.map(([type, id, fieldRoles]) => ({ id, type, ...(fieldRoles ? { fieldRoles } : {}) })) });
const read = async (s: Readable) => { const p: Buffer[] = []; for await (const c of s) p.push(Buffer.from(c)); return Buffer.concat(p).toString(); };
const OPTS = { ...DEFAULT_IMPORT_OPTIONS };
const QUIET = { ...DEFAULT_IMPORT_OPTIONS, comments: false, attachments: false };
const ds = (id: string): NtDataSource => DATA_SOURCES[id];
const rolesOf = (d: NtDataSource, chosen?: Record<string, string | null>) => resolveFieldRoles(suggestFieldRoles(fieldsOfDataSource(d)), chosen as never);
const planOf = (d: NtDataSource, chosen?: Record<string, string | null>): NtPlan => buildSource(d, rolesOf(d, chosen)).plan;

async function runAll(a: NotionAdapter, selection = sel(['data_source', DS.tasks]), options = OPTS) {
  const pages: CanonicalBundle[] = [];
  const cursors: unknown[] = [];
  let cursor: unknown = null;
  for (let n = 0; n < 60; n++) {
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
const rt = (text: string, annotations: Record<string, boolean> = {}, href?: string) => ({ type: 'text', plain_text: text, href: href ?? null, annotations, text: { content: text, link: href ? { url: href } : null } });

describe('notion normalizers: text and time', () => {
  it('instants and dates: a day is 00:00 UTC, a datetime keeps its instant (offsets resolved), junk is nothing', () => {
    expect(dateInstant('2026-03-01')).toBe('2026-03-01T00:00:00.000Z');
    expect(dateInstant('2026-04-01T09:30:00.000+02:00')).toBe('2026-04-01T07:30:00.000Z');
    for (const bad of [undefined, null, '', 'soon', 5]) expect(dateInstant(bad as never)).toBeUndefined();
    expect(isoInstant('2026-01-01T00:00:00Z')).toBe('2026-01-01T00:00:00.000Z');
  });

  it('rich text -> markdown: annotations nest, code is not escaped, links are http(s) only, source text never becomes formatting', () => {
    expect(richTextToMarkdown([rt('a', { bold: true }), rt(' b', { italic: true }), rt(' c', { strikethrough: true }), rt(' d', { bold: true, italic: true })])).toBe('**a***  b*~~ c~~***\\ d***'.replace('***\\ d***', '***' + ' d' + '***').replace('*  b*', '* b*'));
    expect(richTextToMarkdown([rt('x', { code: true })])).toBe('`x`');
    expect(richTextToMarkdown([rt('a`b', { code: true })])).toBe("`a'b`");
    expect(richTextToMarkdown([rt('see'), rt(' docs', {}, 'https://example.com/d')])).toContain('[ docs](https://example.com/d)');
    expect(richTextToMarkdown([rt('bad', {}, 'javascript:alert(1)')])).not.toContain('javascript');
    expect(richTextToMarkdown([rt('1 * 2 * 3')])).not.toContain('1 * 2 * 3');
    expect(richTextToMarkdown([rt('')])).toBe('');
    expect(richTextToMarkdown(null)).toBe('');
    expect(richTextToMarkdown([{ type: 'text', text: { content: 'fallback' } }])).toBe('fallback');
    expect(plain([rt('a'), rt('b')])).toBe('ab');
    expect(plain(undefined)).toBe('');
  });

  it('people: persons only (bots are not people), name falls back to e-mail then id', () => {
    expect(toUser({ id: 'u', type: 'person', name: 'A', person: { email: 'a@x.y' } })).toEqual({ externalId: 'u', name: 'A', email: 'a@x.y' });
    expect(toUser({ id: 'b', type: 'bot', name: 'Bot' })).toBeNull();
    expect(toUser({ id: 'u2', type: 'person', person: { email: 'b@x.y' } })!.name).toBe('b@x.y');
    expect(toUser({ id: 'u3' })!.name).toBe('u3');
  });
});

describe('notion normalizers: fields and statuses', () => {
  it('fields offered to the picker: right roles by type, ids are PROPERTY ids (names can be edited), a date range\'s end offered apart, the checkbox last', () => {
    const f = fieldsOfDataSource(ds(DS.tasks));
    expect(f.map((x) => [x.id, x.roles])).toEqual([
      ['stat', ['status', 'priority']], ['prio', ['status', 'priority']], ['tags', ['priority']], ['asg', ['assignee']], ['due', ['due', 'start']], ['due:end', ['due']], ['rev', ['status']],
    ]);
    expect(f.find((x) => x.id === 'due:end')!.name).toBe('Due (end)');
    expect(splitEndId(endFieldId('x'))).toBe('x');
    expect(splitEndId('x')).toBeNull();
    expect(fieldsOfDataSource({ id: 'x', properties: {} })).toEqual([]);
  });

  it('the suggestions: the Status property, the Priority select, the Assignee, the Due date; a checkbox is the workflow only when nothing better exists', () => {
    const r = rolesOf(ds(DS.tasks));
    expect(Object.fromEntries(Object.entries(r.byRole).map(([k, x]) => [k, x.id]))).toEqual({ status: 'stat', priority: 'prio', assignee: 'asg', due: 'due' });
    const c = rolesOf(ds(DS.checklist));
    expect(Object.fromEntries(Object.entries(c.byRole).map(([k, x]) => [k, x.id]))).toEqual({ status: 'done', assignee: 'who', due: 'dl' });
    expect(rolesOf(ds(DS.stages)).byRole.status!.id).toBe('stage');
  });

  it('a STATUS property\'s groups give CERTAIN categories (To-do / In progress / Complete); an option outside every group is a guess; plus "No status"', () => {
    const b = buildSource(ds(DS.tasks), rolesOf(ds(DS.tasks)));
    expect(b.project.statuses!.map((s) => [s.externalId, s.name, s.category])).toEqual([
      [`${DS.tasks}:s:o-todo`, 'Not started', 'TODO'], [`${DS.tasks}:s:o-prog`, 'In progress', 'IN_PROGRESS'], [`${DS.tasks}:s:o-done`, 'Done', 'DONE'], [`${DS.tasks}:s:o-park`, 'Parked', 'UNKNOWN'], [`${DS.tasks}:__none`, 'No status', 'TODO'],
    ]);
    expect(b.project.statuses!.map((s) => suggestStatus('p', s).confidence)).toEqual(['HIGH', 'HIGH', 'HIGH', 'LOW', 'HIGH']);
    expect(b.plan).toMatchObject({ kind: 'status', titleId: 'title', roles: { status: 'stat', priority: 'prio', assignee: 'asg', due: 'due' } });
  });

  it('a SELECT\'s options are UNKNOWN (judged by name, shown as guesses); a checkbox is To do / Done; no status is one To do', () => {
    const s = buildSource(ds(DS.stages), rolesOf(ds(DS.stages)));
    expect(s.project.statuses!.map((x) => [x.name, x.category])).toEqual([['Backlog', 'UNKNOWN'], ['Doing', 'UNKNOWN'], ['Done', 'UNKNOWN'], ['No status', 'TODO']]);
    expect(s.project.statuses!.map((x) => suggestStatus('p', x).category)).toEqual(['TODO', 'IN_PROGRESS', 'DONE', 'TODO']);
    const c = buildSource(ds(DS.checklist), rolesOf(ds(DS.checklist)));
    expect(c.plan.kind).toBe('checkbox');
    expect(c.project.statuses!.map((x) => [x.externalId, x.name, x.category])).toEqual([[`${DS.checklist}:c:0`, 'To do', 'TODO'], [`${DS.checklist}:c:1`, 'Done', 'DONE']]);
    const none = buildSource(ds(DS.tasks), rolesOf(ds(DS.tasks), { status: null }));
    expect(none.plan.kind).toBe('none');
    expect(none.project.statuses!.map((x) => [x.name, x.category])).toEqual([['To do', 'TODO']]);
  });

  it('custom fields: the properties that play no role; structural, timestamp and file properties are silent; formula / rollup / foreign relations are reported', () => {
    const b = buildSource(ds(DS.tasks), rolesOf(ds(DS.tasks)));
    expect(b.customFields.map((f) => [f.name, f.dataType]).sort()).toEqual([['Estimate', 'NUMBER'], ['ID', 'TEXT'], ['Link', 'URL'], ['Notes', 'TEXT'], ['Reviewed', 'CHECKBOX'], ['Tags', 'MULTI_SELECT']]);
    expect(b.customFields.find((f) => f.name === 'Tags')!.options).toEqual([{ label: 'a' }, { label: 'b' }]);
    expect(b.skipped.map((s) => s.type).sort()).toEqual(['formula', 'relation', 'rollup']);
    expect(b.plan.rel).toEqual({ parent: 'par', blockedBy: 'blk', blocking: 'blg' });
    expect(fieldTypeOf(b.customFields[0].externalId)).not.toBeNull();
  });

  it('a property used as the status / priority is not also a custom field; a status property that is NOT the workflow becomes a select field', () => {
    const asPrio = buildSource(ds(DS.tasks), rolesOf(ds(DS.tasks), { status: 'prio', priority: 'stat' }));
    expect(asPrio.plan.kind).toBe('select');
    expect(asPrio.customFields.some((f) => f.name === 'Priority' || f.name === 'Status')).toBe(false);
    const none = buildSource(ds(DS.tasks), rolesOf(ds(DS.tasks), { status: null, priority: null }));
    expect(none.customFields.find((f) => f.name === 'Status')).toMatchObject({ dataType: 'SELECT', options: [{ label: 'Not started' }, { label: 'In progress' }, { label: 'Done' }, { label: 'Parked' }] });
    expect(none.customFields.some((f) => f.name === 'Priority')).toBe(true);
  });

  it('only SELF relations named like parent / blocked by / blocking are structural; a relation to another data source is not', () => {
    const d: NtDataSource = { id: 'x', properties: { A: { id: 'a', name: 'Parent item', type: 'relation', relation: { data_source_id: 'other' } }, B: { id: 'b', name: 'Blocked by', type: 'relation', relation: { data_source_id: 'x' } }, T: { id: 't', name: 'N', type: 'title' } } };
    expect(buildSource(d, rolesOf(d)).plan.rel).toEqual({ blockedBy: 'b' });
  });

  it('a project carries its name (or a fallback) and the trash flag under both of its names', () => {
    expect(buildSource(ds(DS.other), rolesOf(ds(DS.other))).project.name).toBe(`Data source ${DS.other}`);
    expect(buildSource({ ...ds(DS.big), in_trash: true }, rolesOf(ds(DS.big))).project.archived).toBe(true);
    expect(buildSource({ ...ds(DS.big), archived: true }, rolesOf(ds(DS.big))).project.archived).toBe(true);
    expect(isTrashed({ id: 'p', in_trash: true })).toBe(true);
    expect(isTrashed({ id: 'p', archived: true })).toBe(true);
    expect(isTrashed({ id: 'p' })).toBe(false);
  });
});

describe('notion normalizers: tasks', () => {
  const plan = planOf(ds(DS.tasks));
  const page = (over: Partial<NtPage['properties'] & object> = {}, top: Partial<NtPage> = {}): NtPage => ({ id: 'pg', created_time: '2026-01-01T00:00:00.000Z', properties: { Name: { id: 'title', type: 'title', title: [rt('T')] }, ...over }, ...top });

  it('the status is the option ID; a renamed / recreated option still finds its status by name; null or unknown -> No status', () => {
    const s = (st: { id?: string; name: string } | null) => toTask(page({ Status: { id: 'stat', type: 'status', status: st } }), plan, '').statusExternalId;
    expect(s({ id: 'o-prog', name: 'whatever' })).toBe(`${DS.tasks}:s:o-prog`);
    expect(s({ id: 'o-new', name: 'DONE' })).toBe(`${DS.tasks}:s:o-done`);
    expect(s({ id: 'o-new', name: 'Nope' })).toBe(`${DS.tasks}:__none`);
    expect(s(null)).toBe(`${DS.tasks}:__none`);
  });

  it('priority is the select\'s name; assignees are PEOPLE (no bots); dates: the end is the due date, the start the start', () => {
    const t = toTask(page({
      Priority: { id: 'prio', type: 'select', select: { id: 'p', name: 'High' } }, Assignee: { id: 'asg', type: 'people', people: [{ id: 'u1', type: 'person' } as never, { id: 'b', type: 'bot' } as never, { id: 'u1', type: 'person' } as never] },
      Due: { id: 'due', type: 'date', date: { start: '2026-03-01', end: '2026-03-05' } },
    }), plan, 'hello');
    expect(t).toMatchObject({ priority: 'High', assigneeExternalIds: ['u1'], dueDate: '2026-03-05T00:00:00.000Z', description: 'hello', projectExternalId: DS.tasks });
    expect(t.startDate).toBeUndefined();
    const single = toTask(page({ Due: { id: 'due', type: 'date', date: { start: '2026-03-01' } } }), plan, '');
    expect(single.dueDate).toBe('2026-03-01T00:00:00.000Z');
    expect(single.description).toBeUndefined();
  });

  it('a range split in two: start = the range start, due = ONLY the range end', () => {
    const p = planOf(ds(DS.tasks), { start: 'due', due: 'due:end' });
    const range = page({ Due: { id: 'due', type: 'date', date: { start: '2026-03-01', end: '2026-03-05' } } });
    expect(toTask(range, p, '')).toMatchObject({ startDate: '2026-03-01T00:00:00.000Z', dueDate: '2026-03-05T00:00:00.000Z' });
    const day = page({ Due: { id: 'due', type: 'date', date: { start: '2026-03-01' } } });
    expect(toTask(day, p, '').dueDate).toBeUndefined(); // "end only": a single day has no end
  });

  it('the parent comes from the Parent item relation (never itself); custom values per type', () => {
    expect(toTask(page({ 'Parent item': { id: 'par', type: 'relation', relation: [{ id: 'other' }] } }), plan, '').parentExternalId).toBe('other');
    expect(toTask(page({ 'Parent item': { id: 'par', type: 'relation', relation: [{ id: 'pg' }] } }), plan, '').parentExternalId).toBeUndefined();
    const t = toTask(page({
      Estimate: { id: 'est', type: 'number', number: 0 }, Notes: { id: 'notes', type: 'rich_text', rich_text: [rt('hi')] }, Link: { id: 'lnk', type: 'url', url: 'https://x.test' },
      Reviewed: { id: 'rev', type: 'checkbox', checkbox: true }, Tags: { id: 'tags', type: 'multi_select', multi_select: [{ name: 'a' }, { name: ' ' }, { name: 'b' }] }, ID: { id: 'uid', type: 'unique_id', unique_id: { prefix: 'T', number: 3 } },
    }), plan, '');
    expect(t.customValues!.map((c) => c.value).sort((a, b) => String(a).localeCompare(String(b)))).toEqual([0, 'T-3', 'hi', 'https://x.test', true, ['a', 'b']].sort((a, b) => String(a).localeCompare(String(b))));
    expect(customValueOf({ id: 'x', type: 'url', url: 'javascript:alert(1)' }, 'cf:a:URL')).toBeNull();
    expect(customValueOf({ id: 'x', type: 'checkbox', checkbox: false }, 'cf:a:CHECKBOX')).toBeNull();
    expect(customValueOf({ id: 'x', type: 'number', number: NaN }, 'cf:a:NUMBER')).toBeNull();
    expect(customValueOf({ id: 'x', type: 'rich_text', rich_text: [] }, 'cf:a:TEXT')).toBeNull();
    expect(customValueOf({ id: 'x', type: 'text' }, 'not-a-field')).toBeNull();
  });

  it('checkbox workflow: checked is Done, anything else To do', () => {
    const p = planOf(ds(DS.checklist));
    const row = (c: boolean) => toTask({ id: 'r', properties: { Item: { id: 'title', type: 'title', title: [rt('x')] }, Done: { id: 'done', type: 'checkbox', checkbox: c } } }, p, '').statusExternalId;
    expect([row(true), row(false)]).toEqual([`${DS.checklist}:c:1`, `${DS.checklist}:c:0`]);
  });

  it('dependencies: "Blocked by" are blockers (blocker -> this), "Blocking" the reverse; no self edges; one id per edge', () => {
    const d = toDependencies(page({ 'Blocked by': { id: 'blk', type: 'relation', relation: [{ id: 'a' }, { id: 'pg' }, { id: 'a' }] }, Blocking: { id: 'blg', type: 'relation', relation: [{ id: 'z' }] } }), plan);
    expect(d).toEqual([{ externalId: 'dep:a>pg', fromExternalId: 'a', toExternalId: 'pg', type: 'BLOCKS' }, { externalId: 'dep:pg>z', fromExternalId: 'pg', toExternalId: 'z', type: 'BLOCKS' }]);
    expect(toDependencies(page(), planOf(ds(DS.stages)))).toEqual([]);
  });
});

describe('notion normalizers: comments and files', () => {
  it('a discussion is a thread: the first comment is the comment, later ones reply to it; oldest first; empty ones dropped', () => {
    const out = toComments([
      { id: 'c2', discussion_id: 'd1', created_time: '2026-01-03T00:00:00Z', created_by: { id: 'u2' }, rich_text: [rt('reply')] },
      { id: 'c1', discussion_id: 'd1', created_time: '2026-01-02T00:00:00Z', created_by: { id: 'u1' }, rich_text: [rt('first')] },
      { id: 'c3', discussion_id: 'd2', created_time: '2026-01-04T00:00:00Z', rich_text: [rt('other')] }, { id: 'c4', discussion_id: 'd3', rich_text: [] },
      { id: 'c1', discussion_id: 'd1', created_time: '2026-01-02T00:00:00Z', rich_text: [rt('dup')] }, { id: 'c5', rich_text: [rt('no discussion')], created_time: '2026-01-05T00:00:00Z' },
    ]);
    expect(out.map((c) => [c.externalId, c.body, c.parentExternalId])).toEqual([['c1', 'first', undefined], ['c2', 'reply', 'c1'], ['c3', 'other', undefined], ['c5', 'no discussion', undefined]]);
    expect(out[0]).toMatchObject({ authorExternalId: 'u1', createdAt: '2026-01-02T00:00:00.000Z' });
  });

  it('a file\'s identity is its PATH: the signature in the query changes on every read, the hash does not', () => {
    const a = `${PATH_DESIGN}?X-Amz-Signature=1`;
    const b = `${PATH_DESIGN}?X-Amz-Signature=2&X-Amz-Expires=3600`;
    expect(fileHash(a)).toBe(fileHash(b));
    expect(fileHash(a)).not.toBe(fileHash(`${PATH_SPEC}?X-Amz-Signature=1`));
    expect(pathKey(a)).toBe(PATH_DESIGN);
    expect(pathKey('not a url')).toBeNull();
    expect(fileHash('not a url')).toBeNull();
  });

  it('the file ref is opaque and strictly shaped', () => {
    const ref = fileRef(P.design, 'm', 'abcdef0123456789');
    expect(parseFileRef(ref)).toEqual({ pageId: P.design, source: 'm', hash: 'abcdef0123456789' });
    for (const bad of ['', 'notion-file:', `notion-file:${P.design}:x:abcdef0123456789`, `notion-file:${P.design}:m:short`, `notion-file:not-a-uuid:m:abcdef0123456789`, `${ref}/..`, `https://file.notion.so/x`, undefined as never]) expect(parseFileRef(bad)).toBeNull();
  });

  it.each([
    ['https://prod-files-secure.s3.us-west-2.amazonaws.com/ws/a/b.png?X=1', true], ['https://file.notion.so/f/x', true], ['https://www.notion.so/image/x', true], ['https://x.notion-static.com/y', true],
    ['https://s3.us-west-2.amazonaws.com/secure.notion-static.com/x/y.png', true], ['https://files.notionusercontent.com/x', true],
    ['http://file.notion.so/x', false], ['https://file.notion.so:8443/x', false], ['https://u:p@file.notion.so/x', false], ['https://file.notion.so.evil.example/x', false], ['https://evilnotion.so/x', false],
    ['https://s3.us-west-2.amazonaws.com/other-bucket/x', false], ['https://evil-bucket.s3.amazonaws.com/x', false], ['https://169.254.169.254/x', false], ['https://[::1]/x', false], ['https://cdn.example-files.test/x', false], ['x', false],
  ])('file host %s -> %s', (url, allowed) => expect(isAllowedFileUrl(url)).toBe(allowed));

  it('an operator can add a host after a refusal; a look-alike still fails', () => {
    expect(isAllowedFileUrl(URL_EXTRA, ['.example-files.test'])).toBe(true);
    expect(isAllowedFileUrl('https://example-files.test/x', ['.example-files.test'])).toBe(false);
    expect(isAllowedFileUrl('https://cdn.example-files.test.evil.example/x', ['.example-files.test'])).toBe(false);
  });

  it('files properties: Notion-hosted files are files, links are not; names cannot carry a path; duplicates collapse', () => {
    const files = propertyFiles({ id: 'p', properties: { F: { id: 'f', type: 'files', files: [
      { name: 'a.png', type: 'file', file: { url: `${PATH_DESIGN}?s=1` } }, { name: 'Link', type: 'external', external: { url: 'https://figma.com/x' } }, { name: '../../etc/passwd', type: 'file', file: { url: `${PATH_SPEC}?s=1` } }, { type: 'file', file: { url: '' } },
    ] } } });
    expect(files.map((f) => f.name)).toEqual(['a.png', 'passwd']);
    const att = toAttachments(P.design, [...files.map((f) => ({ ...f, source: 'p' as const })), { ...files[0], source: 'm' as const }]);
    expect(att.map((a) => [a.fileName, a.providerRef.endsWith(files[0].hash) || a.providerRef.endsWith(files[1].hash)])).toEqual([['a.png', true], ['passwd', true]]);
    expect(att[0].externalId).toBe(`${P.design}:${files[0].hash}`);
    expect(safeFileName('a\u0000b\\c.txt', 'x')).toBe('c.txt');
    expect(safeFileName('  ', 'fallback')).toBe('fallback');
  });
});

describe('notion normalizers: enhanced markdown -> our markdown', () => {
  const conv = (md: string, extra: string[] = []) => convertMarkdown(md, P.design, extra);

  it('file blocks and links to Notion hosts become `[name](providerRef)` (the signed URL would be dead in an hour); the file is registered by its own name', () => {
    const r = conv(`<image src="${PATH_DESIGN}?X-Amz-Signature=9">Design mock</image>\n\n<file src="${PATH_DOC}?s=1">the doc</file>\n\n[spec](${PATH_SPEC}?s=2)\n\n![inline](${PATH_DESIGN}?s=3)`);
    const h = (u: string) => fileHash(u)!;
    expect(r.markdown).toBe(`![Design mock](${fileRef(P.design, 'm', h(PATH_DESIGN))})\n\n[the doc](${fileRef(P.design, 'm', h(PATH_DOC))})\n\n[spec](${fileRef(P.design, 'm', h(PATH_SPEC))})\n\n![inline](${fileRef(P.design, 'm', h(PATH_DESIGN))})`);
    expect(r.files.map((f) => f.name)).toEqual(['design.png', 'doc.txt', 'spec.pdf']);
    expect(r.markdown).not.toContain('X-Amz');
  });

  it('a file on a host that is not Notion\'s is NOT registered or fetched: only its label stays; ordinary links are untouched', () => {
    const r = conv(`<image src="${URL_EVIL}">evil</image> and [other](https://example.com/p?x=1) and <pdf src="http://file.notion.so/x.pdf">plain http</pdf>`);
    expect(r.files).toEqual([]);
    expect(r.markdown).toBe('[evil] and [other](https://example.com/p?x=1) and [plain http]');
    expect(conv(`<image src="${URL_EXTRA}">x</image>`, ['.example-files.test']).files).toHaveLength(1);
  });

  it('callouts become quotes, toggles bold + body, columns and mentions lose their tags, tables become GFM (pipes escaped), unknown blocks are counted', () => {
    const r = conv('<callout icon="x">line one\nline two</callout>\n\n<details>\n<summary>Why</summary>\nBecause.\n</details>\n\n<columns><column>L</column><column>R</column></columns> <mention-user url="u">@Ana</mention-user>\n\n<table header-row="true">\n<tr><td>A</td><td>B</td></tr>\n<tr><td>1 | 2</td><td></td></tr>\n</table>\n\n<unknown url="x"/>\n\nend<br>next');
    expect(r.markdown).toBe('> line one\n> line two\n\n**Why**\n\nBecause.\n\nLR @Ana\n\n| A | B |\n| --- | --- |\n| 1 \\| 2 |  |\n\nend\nnext');
    expect(r.unknown).toBe(1);
    expect(conv('<table>\n<tr><td>a</td></tr>\n</table>').markdown).toBe('|  |\n| --- |\n| a |');
  });

  it('fenced code is never touched (tags, URLs and all); the text around it still is', () => {
    const r = conv(`<callout>x</callout>\n\n\`\`\`html\n<image src="${PATH_DESIGN}?s=1">kept</image> <unknown url="q"/>\n\`\`\`\n\n~~~\n<callout>kept too</callout>\n~~~\n\n<unknown/>`);
    expect(r.markdown).toContain(`<image src="${PATH_DESIGN}?s=1">kept</image> <unknown url="q"/>`);
    expect(r.markdown).toContain('<callout>kept too</callout>');
    expect(r.markdown.startsWith('> x')).toBe(true);
    expect(r.files).toEqual([]);
    expect(r.unknown).toBe(1); // only the one outside the fence
  });

  it('whitespace is normalised; CRLF is handled; empty input is empty', () => {
    expect(conv('a\r\n\r\n\r\n\r\nb  \r\n').markdown).toBe('a\n\nb');
    expect(conv('').markdown).toBe('');
    expect(conv('<empty-block/>\n<table_of_contents/>').markdown).toBe('');
  });
});

describe('NotionAdapter OAuth', () => {
  it('the authorize URL carries owner=user, the redirect, the state, no PKCE and no secret', () => {
    const { adapter } = make(fakeNotion());
    expect(adapter.usesPkce).toBe(false);
    const u = new URL(adapter.authorizeUrl({ state: 'st', redirectUri: 'https://app/cb', pkceChallenge: 'ignored' }));
    expect(u.origin + u.pathname).toBe('https://api.notion.com/v1/oauth/authorize');
    expect(Object.fromEntries(u.searchParams)).toEqual({ client_id: 'cid', response_type: 'code', owner: 'user', redirect_uri: 'https://app/cb', state: 'st' });
    expect(u.toString()).not.toContain('sec');
  });

  it('isConfigured needs both id and secret', () => {
    expect(make(fakeNotion()).adapter.isConfigured()).toBe(true);
    expect(make(fakeNotion(), { NOTION_CLIENT_SECRET: '' }).adapter.isConfigured()).toBe(false);
  });

  it('exchange: Basic auth, JSON body with the redirect, the pinned version; the connection is the WORKSPACE; the access token is treated as expiring (Notion sends no expires_in)', async () => {
    const fake = fakeNotion();
    const { tokens, account } = await make(fake).adapter.exchangeCode({ code: 'c0de' }, { redirectUri: 'https://app/cb' });
    const sent = (fake.fetch as any).lastOauth;
    expect(sent.path).toBe('/v1/oauth/token');
    expect(sent.auth).toBe(`Basic ${Buffer.from('cid:sec').toString('base64')}`);
    expect(sent.body).toEqual({ grant_type: 'authorization_code', code: 'c0de', redirect_uri: 'https://app/cb' });
    expect(sent.version).toBe('2026-03-11');
    expect(account).toEqual({ id: WORKSPACE.id, name: 'Acme' });
    expect(tokens).toMatchObject({ accessToken: 'tok', refreshToken: 'rt-1', tokenType: 'bearer' });
    expect(tokens.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 3_500_000);
    expect(tokens.expiresAt!.getTime()).toBeLessThan(Date.now() + 3_700_000);
  });

  it('NOTION_TOKEN_TTL_SECONDS sets (or, at 0, removes) the assumed lifetime; a null refresh token means no expiry to schedule', async () => {
    expect((await make(fakeNotion(), { NOTION_TOKEN_TTL_SECONDS: '0' }).adapter.exchangeCode({ code: 'x' }, { redirectUri: 'r' })).tokens.expiresAt).toBeUndefined();
    const short = (await make(fakeNotion(), { NOTION_TOKEN_TTL_SECONDS: '600' }).adapter.exchangeCode({ code: 'x' }, { redirectUri: 'r' })).tokens.expiresAt!.getTime();
    expect(short).toBeLessThan(Date.now() + 700_000);
    expect((await make(fakeNotion(), { NOTION_TOKEN_TTL_SECONDS: 'garbage' }).adapter.exchangeCode({ code: 'x' }, { redirectUri: 'r' })).tokens.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 3_500_000);
    const nullRefresh = fakeNotion();
    (nullRefresh.fetch as any).mockImplementationOnce(async () => new Response(JSON.stringify({ access_token: 'tok', token_type: 'bearer', refresh_token: null, workspace_id: WORKSPACE.id, workspace_name: null }), { status: 200 }));
    const r = await make(nullRefresh).adapter.exchangeCode({ code: 'x' }, { redirectUri: 'r' });
    expect(r.tokens.refreshToken).toBeUndefined();
    expect(r.tokens.expiresAt).toBeUndefined();
    expect(r.account.name).toBe('Notion workspace');
  });

  it('exchange refuses a missing code, a rejected code, and an answer without a workspace', async () => {
    await expect(make(fakeNotion()).adapter.exchangeCode({}, { redirectUri: 'r' })).rejects.toThrow('without code');
    await expect(make(fakeNotion()).adapter.exchangeCode({ code: 'bad' }, { redirectUri: 'r' })).rejects.toThrow('HTTP 400 invalid_grant');
    const f = fakeNotion();
    (f.fetch as any).mockImplementationOnce(async () => new Response(JSON.stringify({ access_token: 'tok', token_type: 'bearer' }), { status: 200 }));
    await expect(make(f).adapter.exchangeCode({ code: 'x' }, { redirectUri: 'r' })).rejects.toThrow('which workspace');
  });

  it('refresh ROTATES the refresh token (the new one is kept); a null answer keeps the stored one; a dead grant or none at all -> ProviderAuthRejectedError', async () => {
    const { adapter } = make(fakeNotion());
    expect(await adapter.refresh({ accessToken: 'old', refreshToken: 'rt-ok', scopes: [] })).toMatchObject({ accessToken: 'new-access', refreshToken: 'rt-rotated' });
    expect(await adapter.refresh({ accessToken: 'old', refreshToken: 'rt-null', scopes: [] })).toMatchObject({ accessToken: 'new-access', refreshToken: 'rt-null' });
    await expect(adapter.refresh({ accessToken: 'old', refreshToken: 'rt-dead', scopes: [] })).rejects.toBeInstanceOf(ProviderAuthRejectedError);
    await expect(adapter.refresh({ accessToken: 'old', scopes: [] })).rejects.toBeInstanceOf(ProviderAuthRejectedError);
  });

  it('revoke sends the refresh token when there is one, else the access token', async () => {
    const fake = fakeNotion();
    await make(fake).adapter.revoke({ accessToken: 'a', refreshToken: 'rt-1', scopes: [] }, { id: 'w', name: 'x' });
    expect((fake.fetch as any).lastOauth).toMatchObject({ path: '/v1/oauth/revoke', body: { token: 'rt-1' } });
    await make(fake).adapter.revoke({ accessToken: 'a-only', scopes: [] }, { id: 'w', name: 'x' });
    expect((fake.fetch as any).lastOauth.body).toEqual({ token: 'a-only' });
  });
});

describe('NotionAdapter discover / estimate', () => {
  it('only what was SHARED is listed: one node per data source under a single non-selectable node, with the fields and their suggestions', async () => {
    const tree = await make(fakeNotion()).adapter.discover(ctx);
    expect(tree.hint).toBeUndefined();
    expect(tree.nodes[0]).toMatchObject({ id: 'shared', type: 'workspace', selectable: false, parentId: null });
    expect(tree.nodes.filter((n) => n.type === 'data_source').map((n) => [n.id, n.name, n.parentId, n.selectable])).toEqual([
      [DS.tasks, 'Tasks', 'shared', true], [DS.checklist, 'Checklist', 'shared', true], [DS.stages, 'Stages', 'shared', true], [DS.big, 'Big', 'shared', true],
    ]);
    const tasks = tree.nodes.find((n) => n.id === DS.tasks)!;
    expect(tasks.fields!.find((f) => f.id === 'stat')!.suggested).toEqual(['status']);
    expect(tasks.fields!.find((f) => f.id === 'prio')!.suggested).toEqual(['priority']);
    expect(tree.nodes.find((n) => n.id === DS.big)!.fields).toBeUndefined(); // a title-only source offers nothing to choose
  });

  it('nothing shared: an empty tree WITH a hint that says how to share something', async () => {
    const tree = await make(fakeNotion({ ...DATASET, shared: [] })).adapter.discover(ctx);
    expect(tree.nodes).toEqual([]);
    expect(tree.hint).toMatch(/Nothing is shared with this connection yet.*Connections/);
  });

  it('trashed data sources are not offered; the search asks for data sources, newest first', async () => {
    const fake = fakeNotion(DATASET, { intercept: (m, p, body) => (p === '/v1/search' ? fake.json({ object: 'list', results: [{ ...DATA_SOURCES[DS.tasks], in_trash: true }, DATA_SOURCES[DS.big]], has_more: false, next_cursor: null }) : undefined) });
    const tree = await make(fake).adapter.discover(ctx);
    expect(tree.nodes.filter((n) => n.type === 'data_source').map((n) => n.id)).toEqual([DS.big]);
    const search = fakeNotion();
    await make(search).adapter.discover(ctx);
    expect(search.calls.find((c) => c.path === '/v1/search')!.body).toMatchObject({ filter: { property: 'object', value: 'data_source' }, sort: { direction: 'descending', timestamp: 'last_edited_time' }, page_size: 100 });
  });

  it('estimate: rows without the trashed ones, a structure page that validates, the time it will take (3 requests a second), honest warnings', async () => {
    const fake = fakeNotion();
    const e = await make(fake).adapter.estimate(ctx, sel(['data_source', DS.tasks], ['data_source', DS.checklist]), OPTS);
    expect(e.projects).toEqual([{ sourceId: DS.tasks, name: 'Tasks', tasks: 6 }, { sourceId: DS.checklist, name: 'Checklist', tasks: 3 }]);
    expect(e.users).toBe(2);
    const codes = e.warnings!.map((w) => w.code);
    expect(codes).toEqual(expect.arrayContaining(['FIELD_ROLES_GUESSED', 'PROPERTIES_SKIPPED', 'CONTENT_SLOW', 'HISTORY_NOT_AVAILABLE']));
    expect(e.warnings!.find((w) => w.code === 'CONTENT_SLOW')!.message).toContain('9 pages takes about 1 minute');
    expect(e.warnings!.find((w) => w.code === 'PROPERTIES_SKIPPED')!.message).toMatch(/formula.*relation.*rollup|rollup/);
    expect(fake.calls.find((c) => /query$/.test(c.path))!.query).toContain('filter_properties=title');
    expect(codes).not.toContain('USERS_NO_EMAIL');
  });

  it('the time estimate counts a comments call per row only when comments are asked for', async () => {
    const big = await make(fakeNotion()).adapter.estimate(ctx, sel(['data_source', DS.big]), OPTS);
    expect(big.warnings!.find((w) => w.code === 'CONTENT_SLOW')!.message).toContain('(its text and its comments): reading 60 pages');
    const noComments = await make(fakeNotion()).adapter.estimate(ctx, sel(['data_source', DS.big]), { ...OPTS, comments: false, history: false });
    expect(noComments.warnings!.find((w) => w.code === 'CONTENT_SLOW')!.message).toContain('(its text)');
    expect(noComments.warnings!.map((w) => w.code)).not.toContain('HISTORY_NOT_AVAILABLE');
  });

  it('a property filter Notion refuses must not fail the preview: the count falls back to a plain query', async () => {
    const fake = fakeNotion({ ...DATASET, rejectFilterProperties: true });
    const e = await make(fake).adapter.estimate(ctx, sel(['data_source', DS.checklist]), OPTS);
    expect(e.projects[0].tasks).toBe(3);
    expect(fake.calls.filter((c) => /query$/.test(c.path)).length).toBe(2);
  });

  it('people without e-mail addresses (no "user information" capability) are warned about, since they can only be matched by name; unreadable people degrade to a warning', async () => {
    const e = await make(fakeNotion({ ...DATASET, noEmail: true })).adapter.estimate(ctx, sel(['data_source', DS.checklist]), OPTS);
    expect(e.warnings!.map((w) => w.code)).toContain('USERS_NO_EMAIL');
    const f = await make(fakeNotion({ ...DATASET, failUsers: true })).adapter.estimate(ctx, sel(['data_source', DS.checklist]), OPTS);
    expect(f.warnings!.map((w) => w.code)).toContain('USERS_UNAVAILABLE');
    expect(f.users).toBe(0);
  });

  it('chosen fields are not "guessed"; a chosen property that vanished is reported, not replaced', async () => {
    const all = { status: 'stat', priority: 'prio', assignee: 'asg', due: 'due', start: null };
    const e = await make(fakeNotion()).adapter.estimate(ctx, sel(['data_source', DS.tasks, all]), QUIET);
    expect(e.warnings!.map((w) => w.code)).not.toContain('FIELD_ROLES_GUESSED');
    const gone = await make(fakeNotion()).adapter.estimate(ctx, sel(['data_source', DS.tasks, { ...all, due: 'deleted' }]), QUIET);
    expect(gone.warnings!.map((w) => w.code)).toContain('FIELD_ROLES_MISSING');
  });

  it('a selection that is not a data source, an id that is not an id, a source that is not shared or is gone are refused', async () => {
    const { adapter } = make(fakeNotion());
    await expect(adapter.estimate(ctx, sel(['workspace', 'shared']), OPTS)).rejects.toThrow('can import data sources');
    await expect(adapter.estimate(ctx, sel(['data_source', 'abc']), OPTS)).rejects.toThrow('not valid');
    await expect(adapter.estimate(ctx, sel(['data_source', '99999999-9999-4999-8999-999999999999']), OPTS)).rejects.toMatchObject({ status: 404 });
    const trashed = fakeNotion(DATASET, { intercept: (m, p) => (p === `/v1/data_sources/${DS.big}` ? fakeResp({ ...DATA_SOURCES[DS.big], in_trash: true }) : undefined) });
    await expect(make(trashed).adapter.estimate(ctx, sel(['data_source', DS.big]), OPTS)).rejects.toMatchObject({ status: 404 });
  });
});
const fakeResp = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('NotionAdapter fetchBundle', () => {
  it('the first page is the structure: people (no bots), the project with its status groups, the shared custom fields; no tasks yet', async () => {
    const r = await make(fakeNotion()).adapter.fetchBundle({ ctx, selection: sel(['data_source', DS.tasks], ['data_source', DS.checklist]), options: OPTS, cursor: null });
    const page = r.bundle as CanonicalBundle;
    expect(page.source).toEqual({ system: 'notion', displayName: 'Notion' });
    expect(page.tasks).toBeUndefined();
    expect(page.users!.map((u) => u.externalId)).toEqual([U.ana, U.ben]);
    expect(page.projects!.map((p) => p.externalId)).toEqual([DS.tasks, DS.checklist]);
    expect(page.customFields!.map((f) => f.name).sort()).toEqual(['Estimate', 'ID', 'Link', 'Notes', 'Reviewed', 'Tags']);
    expect(r.next).toMatchObject({ v: 1, i: 0, cur: null });
    expect((r.next as any).plans.map((p: NtPlan) => p.kind)).toEqual(['status', 'checkbox']);
    expect(validateBundle(page)).not.toHaveProperty('fatal');
  });

  it('an empty selection ends at the structure page', async () => {
    expect((await make(fakeNotion()).adapter.fetchBundle({ ctx, selection: sel(), options: OPTS, cursor: null })).next).toBeNull();
  });

  it('reads everything: every page validates, ends, and the cursors are plain JSON that survive a round trip', async () => {
    const { pages, cursors } = await runAll(make(fakeNotion()).adapter, sel(['data_source', DS.tasks], ['data_source', DS.checklist], ['data_source', DS.stages]));
    for (const p of pages) {
      const checked = validateBundle(p);
      expect(checked).not.toHaveProperty('fatal');
      expect((checked as { issues?: Array<{ severity: string }> }).issues?.filter((i) => i.severity === 'ERROR') ?? []).toEqual([]);
    }
    for (const c of cursors) expect(JSON.parse(JSON.stringify(c))).toEqual(c);
  });

  it('rows become tasks: statuses (groups), priority, people, dates, custom values; trashed rows (either flag) are not rows; a deleted option falls back', async () => {
    const t = byId((await runAll(make(fakeNotion()).adapter, sel(['data_source', DS.tasks]), QUIET)).pages);
    expect([...t.keys()]).toEqual([P.design, P.ship, P.sub, P.plain, P.parked, P.hidden]);
    expect(t.get(P.design)).toMatchObject({ title: 'Design the login page', statusExternalId: `${DS.tasks}:s:o-prog`, priority: 'High', assigneeExternalIds: [U.ana], creatorExternalId: U.ana, dueDate: '2026-03-05T00:00:00.000Z', projectExternalId: DS.tasks });
    expect(t.get(P.design)!.customValues!.map((c) => c.value)).toEqual(expect.arrayContaining([5, 'Remember SSO', 'https://example.com/spec', true, ['a', 'b'], 'TASK-7']));
    expect(t.get(P.ship)).toMatchObject({ statusExternalId: `${DS.tasks}:s:o-done`, priority: 'Medium', dueDate: '2026-04-01T07:30:00.000Z' });
    expect(t.get(P.sub)).toMatchObject({ statusExternalId: `${DS.tasks}:s:o-todo`, parentExternalId: P.design });
    expect(t.get(P.plain)).toMatchObject({ statusExternalId: `${DS.tasks}:__none` });
    expect(t.get(P.plain)!.priority).toBeUndefined();
    expect(t.get(P.parked)!.statusExternalId).toBe(`${DS.tasks}:s:o-park`);
    expect(t.get(P.hidden)!.statusExternalId).toBe(`${DS.tasks}:__none`);
  });

  it('every task points at a status that exists on the structure page', async () => {
    const { pages } = await runAll(make(fakeNotion()).adapter, sel(['data_source', DS.tasks], ['data_source', DS.checklist], ['data_source', DS.stages]), QUIET);
    const known = new Set(pages[0].projects!.flatMap((p) => p.statuses!.map((s) => s.externalId)));
    for (const x of tasksOf(pages)) expect(known.has(x.statusExternalId!)).toBe(true);
  });

  it('the page body arrives as markdown: callouts, toggles and tables converted, files turned into attachment references, a truncated page completed from the block it names', async () => {
    const fake = fakeNotion();
    const t = byId((await runAll(make(fake).adapter)).pages).get(P.design)!;
    const d = t.description!;
    const parts = d.split('```'); // text, code, text, ...
    const outside = parts.filter((_, i) => i % 2 === 0).join('');
    const fenced = parts[1];
    expect(d).toContain('# Goal');
    expect(d).toContain('Ship **login**.');
    expect(d).toContain('> Remember SSO');
    expect(d).toContain('**More**\n\nHidden text');
    expect(d).toContain('| A | B |\n| --- | --- |\n| 1 | 2 \\| 3 |');
    expect(d).toContain('[other site](https://example.com/page?x=1)');
    expect(d).toContain('left');
    expect(outside).not.toMatch(/<\/?(callout|details|summary|table|tr|td|columns|column|unknown)\b/);
    expect(d).toContain(`![Design mock](${fileRef(P.design, 'm', fileHash(PATH_DESIGN)!)})`);
    expect(d).toContain(`[the spec](${fileRef(P.design, 'm', fileHash(PATH_SPEC)!)})`);
    expect(d).toContain(`More content [doc](${fileRef(P.design, 'm', fileHash(PATH_DOC)!)})`); // the truncated block, fetched by its id
    expect(outside).not.toContain('X-Amz-Signature'); // no dead signed URL outside code
    expect(fenced).toContain(`<image src="${PATH_DESIGN}?X-Amz-Signature=`); // inside the code fence: untouched
    expect(d).not.toContain('could not be imported'); // the one unknown block WAS fetched
    expect(fake.calls.filter((c) => c.path === `/v1/pages/${BLOCK}/markdown`)).toHaveLength(1);
  });

  it('files: from the text AND from `files` properties, deduplicated by path; links are not copied; refs are opaque', async () => {
    const t = byId((await runAll(make(fakeNotion()).adapter)).pages).get(P.design)!;
    expect(t.attachments!.map((a) => a.fileName).sort()).toEqual(['design.png', 'doc.txt', 'spec.pdf']);
    expect(t.attachments!.every((a) => parseFileRef(a.providerRef) !== null)).toBe(true);
    expect(t.attachments!.find((a) => a.fileName === 'design.png')!.providerRef).toBe(fileRef(P.design, 'm', fileHash(PATH_DESIGN)!)); // the text got there first
  });

  it('comments keep their discussions as threads; empty ones are dropped', async () => {
    const t = byId((await runAll(make(fakeNotion()).adapter)).pages).get(P.design)!;
    expect(t.comments!.map((c) => [c.externalId, c.parentExternalId])).toEqual([['c1', undefined], ['c2', 'c1'], ['c3', undefined]]);
    expect(t.comments![0].body).toContain('see [docs](https://example.com/docs)');
    expect(t.comments![1].body).toBe('A **reply**');
    expect(t.comments![2].body).toBe('`Another thread`');
    expect(t.comments![0]).toMatchObject({ authorExternalId: U.ana });
  });

  it('dependencies and parents from the self-relations: blocker -> blocked, an unknown blocker is a pending edge', async () => {
    const { pages } = await runAll(make(fakeNotion()).adapter, sel(['data_source', DS.tasks]), QUIET);
    const deps = pages.flatMap((p) => p.dependencies ?? []);
    expect(deps).toEqual(expect.arrayContaining([
      { externalId: `dep:${P.ship}>${P.design}`, fromExternalId: P.ship, toExternalId: P.design, type: 'BLOCKS' },
      { externalId: `dep:${P.design}>${P.plain}`, fromExternalId: P.design, toExternalId: P.plain, type: 'BLOCKS' },
      { externalId: 'dep:ffffffff-0000-4000-8000-00000000ffff>' + P.design, fromExternalId: 'ffffffff-0000-4000-8000-00000000ffff', toExternalId: P.design, type: 'BLOCKS' },
    ]));
  });

  it('the checkbox workflow and a select workflow arrive with the right statuses, people and dates', async () => {
    const { pages } = await runAll(make(fakeNotion()).adapter, sel(['data_source', DS.checklist], ['data_source', DS.stages]), QUIET);
    const t = byId(pages);
    expect(t.get(CHECK_IDS[0])).toMatchObject({ statusExternalId: `${DS.checklist}:c:0`, assigneeExternalIds: [U.ana], dueDate: '2026-05-01T00:00:00.000Z' });
    expect(t.get(CHECK_IDS[1])).toMatchObject({ statusExternalId: `${DS.checklist}:c:1` });
    expect(t.get(CHECK_IDS[2])).toMatchObject({ dueDate: '2026-05-09T15:00:00.000Z' });
    expect(t.get(STAGE_IDS[0])!.statusExternalId).toBe(`${DS.stages}:s:s2`);
    expect(t.get(STAGE_IDS[1])!.statusExternalId).toBe(`${DS.stages}:__none`);
  });

  it('the chosen properties drive the import: the Priority select as the status, none for the status, the range split in two', async () => {
    const asPrio = byId((await runAll(make(fakeNotion()).adapter, sel(['data_source', DS.tasks, { status: 'prio' }]), QUIET)).pages);
    expect(asPrio.get(P.design)).toMatchObject({ statusExternalId: `${DS.tasks}:s:p-h` });
    expect(asPrio.get(P.design)!.priority).toBeUndefined(); // that property was spent on the status
    const none = byId((await runAll(make(fakeNotion()).adapter, sel(['data_source', DS.tasks, { status: null, due: null }]), QUIET)).pages);
    expect(none.get(P.design)).toMatchObject({ statusExternalId: `${DS.tasks}:__none` });
    expect(none.get(P.design)!.dueDate).toBeUndefined();
    const split = byId((await runAll(make(fakeNotion()).adapter, sel(['data_source', DS.tasks, { start: 'due', due: 'due:end' }]), QUIET)).pages);
    expect(split.get(P.design)).toMatchObject({ startDate: '2026-03-01T00:00:00.000Z', dueDate: '2026-03-05T00:00:00.000Z' });
  });

  it('a big source is read 25 rows at a time through the cursor (60 rows = 25 + 25 + 10) and ends; the query is sorted by creation time', async () => {
    const fake = fakeNotion();
    const { pages } = await runAll(make(fake).adapter, sel(['data_source', DS.big]), QUIET);
    expect(pages.filter((p) => p.tasks).map((p) => p.tasks!.length)).toEqual([25, 25, 10]);
    const q = fake.calls.filter((c) => /query$/.test(c.path));
    expect(q).toHaveLength(3);
    expect(q[0].body).toMatchObject({ page_size: 25, sorts: [{ timestamp: 'created_time', direction: 'ascending' }] });
    expect(q[1].body.start_cursor).toBe('c:25');
    expect(tasksOf(pages).map((x) => x.externalId)).toEqual(BIG_IDS);
  });

  it('re-fetching a page with a cursor already used gives the same page (at-least-once)', async () => {
    const adapter = make(fakeNotion()).adapter;
    const { cursors } = await runAll(adapter, sel(['data_source', DS.big]), QUIET);
    const a = await adapter.fetchBundle({ ctx, selection: sel(['data_source', DS.big]), options: QUIET, cursor: cursors[2] });
    const b = await adapter.fetchBundle({ ctx, selection: sel(['data_source', DS.big]), options: QUIET, cursor: cursors[2] });
    expect(a).toEqual(b);
  });

  it('without file copying the references would dangle: only the file\'s label stays; without comments no comment is requested', async () => {
    const fake = fakeNotion();
    const t = byId((await runAll(make(fake).adapter, sel(['data_source', DS.tasks]), { ...OPTS, attachments: false, comments: false })).pages).get(P.design)!;
    expect(t.attachments).toBeUndefined();
    expect(t.comments).toBeUndefined();
    expect(t.description).not.toContain('notion-file:');
    expect(t.description).toContain('Design mock');
    expect(fake.calls.some((c) => c.path === '/v1/comments')).toBe(false);
  });

  it('a page that cannot be read still arrives (without text); comments the connection may not read are simply absent', async () => {
    const f = fakeNotion({ ...DATASET, failComments: true });
    const { pages } = await runAll(make(f).adapter, sel(['data_source', DS.tasks]), OPTS);
    const t = byId(pages);
    expect(t.get(P.hidden)!.description).toBeUndefined(); // its markdown answered 404
    expect(t.get(P.design)!.comments).toBeUndefined(); // 403 on comments
    expect(t.get(P.design)!.description).toContain('# Goal');
  });

  it('a truncated page names more blocks than we follow: the first few are read and the page says part of it was not imported', async () => {
    const many = Array.from({ length: 8 }, (_, i) => `ffffffff-2222-4222-8222-${String(i).padStart(12, '0')}`);
    const fake = fakeNotion(DATASET, { intercept: (m, p) => (p === `/v1/pages/${P.ship}/markdown` ? fakeResp({ object: 'page_markdown', id: P.ship, markdown: 'start', truncated: true, unknown_block_ids: many }) : many.some((id) => p === `/v1/pages/${id}/markdown`) ? fakeResp({ object: 'page_markdown', id: p, markdown: 'more', truncated: false, unknown_block_ids: [] }) : undefined) });
    const t = byId((await runAll(make(fake).adapter, sel(['data_source', DS.tasks]), QUIET)).pages).get(P.ship)!;
    expect(fake.calls.filter((c) => many.some((id) => c.path === `/v1/pages/${id}/markdown`))).toHaveLength(5);
    expect(t.description).toBe('start\n\nmore\n\nmore\n\nmore\n\nmore\n\nmore\n\n_(Part of this page could not be imported.)_');
  });

  it('a block that was not readable (403 / 404) leaves the note; the import goes on', async () => {
    const fake = fakeNotion(DATASET, { intercept: (m, p) => (p === `/v1/pages/${P.ship}/markdown` ? fakeResp({ object: 'page_markdown', id: P.ship, markdown: 'start <unknown url="x"/>', truncated: true, unknown_block_ids: [BLOCK] }) : p === `/v1/pages/${BLOCK}/markdown` ? fakeResp({ object: 'error', status: 404, code: 'object_not_found', message: 'x' }, 404) : undefined) });
    const t = byId((await runAll(make(fake).adapter, sel(['data_source', DS.tasks]), QUIET)).pages).get(P.ship)!;
    expect(t.description).toBe('start\n\n_(Part of this page could not be imported.)_');
  });

  it('rejects a cursor that is not ours', async () => {
    const { adapter } = make(fakeNotion());
    const good = (await adapter.fetchBundle({ ctx, selection: sel(['data_source', DS.big]), options: OPTS, cursor: null })).next as any;
    const bads = [{}, { ...good, v: 2 }, { ...good, i: 5 }, { ...good, cur: 7 }, { ...good, plans: [{ ...good.plans[0], kind: 'x' }] }, { ...good, plans: [{ ...good.plans[0], sv: [1] }] }, { ...good, plans: [{ ...good.plans[0], rel: { a: 1 } }] }, 'x'];
    for (const bad of bads) await expect(adapter.fetchBundle({ ctx, selection: sel(['data_source', DS.big]), options: OPTS, cursor: bad })).rejects.toThrow('cursor is not valid');
  });
});

describe('NotionClient: version, errors, pacing', () => {
  it('every call carries the PINNED version and the Bearer token; the version is configurable and a malformed value is ignored', async () => {
    const f = fakeNotion();
    await make(f).adapter.discover(ctx);
    expect(f.calls.every((c) => c.headers['notion-version'] === '2026-03-11' && c.headers.authorization === 'Bearer tok')).toBe(true);
    const f2 = fakeNotion();
    await make(f2, { NOTION_API_VERSION: '2025-09-03' }).adapter.discover(ctx);
    expect(f2.calls.every((c) => c.headers['notion-version'] === '2025-09-03')).toBe(true);
    const f3 = fakeNotion();
    await make(f3, { NOTION_API_VERSION: 'latest' }).adapter.discover(ctx);
    expect(f3.calls.every((c) => c.headers['notion-version'] === '2026-03-11')).toBe(true);
  });

  it('401 -> ProviderAuthRejectedError (the job pauses); 429 -> ProviderRateLimitedError; 403 / 404 keep their status and Notion\'s code; junk is a 502', async () => {
    await expect(make(fakeNotion()).adapter.discover({ ...ctx, accessToken: 'old' })).rejects.toBeInstanceOf(ProviderAuthRejectedError);
    const limited = fakeNotion(DATASET, { intercept: () => new Response('{}', { status: 429, headers: { 'retry-after': '30' } }) });
    expect(await make(limited, {}, { maxInlineWaitMs: 1 }).adapter.discover(ctx).catch((e) => e)).toBeInstanceOf(ProviderRateLimitedError);
    const forbidden = fakeNotion(DATASET, { intercept: () => fakeResp({ object: 'error', status: 403, code: 'restricted_resource', message: 'Insufficient permissions' }, 403) });
    const e = await make(forbidden).adapter.discover(ctx).catch((x) => x);
    expect(e).toMatchObject({ status: 403 });
    expect(e.bodySnippet).toContain('restricted_resource');
    const junk = fakeNotion(DATASET, { intercept: () => new Response('<html>', { status: 200 }) });
    expect(await make(junk).adapter.discover(ctx).catch((x) => x)).toMatchObject({ status: 502 });
    const boom = fakeNotion(DATASET, { intercept: () => new Response('boom', { status: 500 }) });
    expect(await make(boom).adapter.discover(ctx).catch((x) => x)).toBeInstanceOf(ProviderHttpError);
  });

  it('pacing settings are bounded', () => {
    const rps = (v?: string) => new NotionClient({} as never, cfgOf(v === undefined ? {} : { NOTION_REQUESTS_PER_SECOND: v })).requestsPerSecond;
    expect([rps(), rps('1'), rps('0.05'), rps('x'), rps('9')]).toEqual([2.5, 1, 2.5, 2.5, 2.5]);
  });
});

describe('NotionAdapter fetchAttachment', () => {
  const mref = (hash: string) => ({ ctx, providerRef: fileRef(P.design, 'm', hash) });

  it('re-reads the page NOW for a fresh signed URL (the one in the saved text is long dead) and streams it WITHOUT the token', async () => {
    const fake = fakeNotion();
    const f = await make(fake).adapter.fetchAttachment(mref(fileHash(PATH_SPEC)!));
    expect(await read(f.stream)).toBe('PDFDATA');
    expect(f).toMatchObject({ sizeBytes: 7, mimeType: 'application/pdf' });
    expect(fake.calls.some((c) => c.path === `/v1/pages/${P.design}/markdown`)).toBe(true);
    expect(fake.fileCalls).toHaveLength(1);
    expect(fake.fileCalls[0].auth).toBeNull();
    expect(pathKey(fake.fileCalls[0].url)).toBe(PATH_SPEC);
    expect(fake.fileCalls[0].url).toMatch(/X-Amz-Signature=sig-\d+$/);
  });

  it('a file of a `files` property is re-read from the page properties', async () => {
    const fake = fakeNotion();
    const f = await make(fake).adapter.fetchAttachment({ ctx, providerRef: fileRef(P.design, 'p', fileHash(PATH_DESIGN)!) });
    expect(await read(f.stream)).toBe('PNGDATA');
    expect(fake.calls.some((c) => c.path === `/v1/pages/${P.design}` && !c.path.endsWith('markdown'))).toBe(true);
    expect(fake.fileCalls[0].auth).toBeNull();
  });

  it('a file that is no longer on the page is a 404 for THAT file; a page that is gone too', async () => {
    await expect(make(fakeNotion()).adapter.fetchAttachment(mref('0123456789abcdef'))).rejects.toMatchObject({ status: 404 });
    await expect(make(fakeNotion()).adapter.fetchAttachment({ ctx, providerRef: fileRef(P.hidden, 'm', '0123456789abcdef') })).rejects.toMatchObject({ status: 404 });
  });

  it('refuses an address that is not a Notion file host with a 400 and makes NO file request; an operator-added host works', async () => {
    const evilPage = { ...pagesWithFile(P.ship, URL_EVIL) };
    const fake = fakeNotion(DATASET, { intercept: (m, p) => (p === `/v1/pages/${P.ship}` ? fakeResp(evilPage) : undefined) });
    await expect(make(fake).adapter.fetchAttachment({ ctx, providerRef: fileRef(P.ship, 'p', fileHash(URL_EVIL)!) })).rejects.toMatchObject({ status: 400 });
    expect(fake.fileCalls).toEqual([]);
    const extra = fakeNotion(DATASET, { intercept: (m, p) => (p === `/v1/pages/${P.ship}` ? fakeResp(pagesWithFile(P.ship, URL_EXTRA)) : undefined) });
    const f = await make(extra, { NOTION_FILE_HOSTS: '.example-files.test' }).adapter.fetchAttachment({ ctx, providerRef: fileRef(P.ship, 'p', fileHash(URL_EXTRA)!) });
    expect(await read(f.stream)).toBe('EXTRA');
  });

  it.each(['https://file.notion.so/f/x', 'notion-file:', `notion-file:${P.design}:x:0123456789abcdef`, '', 'monday-asset:1'])('refuses the ref %j before any request', async (providerRef) => {
    const fake = fakeNotion();
    await expect(make(fake).adapter.fetchAttachment({ ctx, providerRef })).rejects.toMatchObject({ status: 400 });
    expect(fake.fetch).not.toHaveBeenCalled();
  });

  it('an expired token is ProviderAuthRejectedError', async () => {
    await expect(make(fakeNotion()).adapter.fetchAttachment({ ctx: { ...ctx, accessToken: 'old' }, providerRef: fileRef(P.design, 'm', fileHash(PATH_SPEC)!) })).rejects.toBeInstanceOf(ProviderAuthRejectedError);
  });

  it('guards the fixtures themselves', () => {
    expect(FieldType.TEXT).toBe('TEXT');
    expect(PATH_DOC).toContain('notion.so');
  });
});
function pagesWithFile(id: string, url: string) {
  return { object: 'page', id, properties: { Files: { id: 'files', type: 'files', files: [{ name: 'x.png', type: 'file', file: { url: `${url}?sig=1` } }] } } };
}
