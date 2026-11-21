/**
 * SYNTHETIC Notion API responses (version 2026-03-11; no live workspace was called; shapes follow Notion's public docs, ADR-0042).
 * Workspace "Acme" (id W). Shared with the connection:
 *   "Tasks"        a status property with GROUPS, a Priority select, people, a date RANGE, tags, number, text, url, a checkbox, files,
 *                  self-relations Parent item / Blocked by / Blocking, a relation to another data source, a formula, a rollup, a unique id.
 *   "Checklist"    no status property: a "Done" checkbox is the workflow.
 *   "Stages"       a select called Stage (no status property).
 *   "Big"          60 plain rows (three pages of 25, 25, 10).
 * File URLs are SIGNED and the signature changes on every read, as in Notion: the path is the file's identity.
 */
import type { NtComment, NtDataSource, NtMarkdown, NtPage, NtPropertySchema, NtPropertyValue, NtUser } from '../notion.types';

export const WORKSPACE = { id: '9a9a9a9a-0000-4000-8000-000000000001', name: 'Acme' };
export const DS = {
  tasks: '11111111-1111-4111-8111-111111111111',
  checklist: '22222222-2222-4222-8222-222222222222',
  stages: '33333333-3333-4333-8333-333333333333',
  big: '44444444-4444-4444-8444-444444444444',
  other: '55555555-5555-4555-8555-555555555555',
};
export const P = {
  design: 'aaaaaaaa-0000-4000-8000-000000000001',
  ship: 'aaaaaaaa-0000-4000-8000-000000000002',
  sub: 'aaaaaaaa-0000-4000-8000-000000000003',
  plain: 'aaaaaaaa-0000-4000-8000-000000000004',
  trashed: 'aaaaaaaa-0000-4000-8000-000000000005',
  parked: 'aaaaaaaa-0000-4000-8000-000000000006',
  archived: 'aaaaaaaa-0000-4000-8000-000000000007',
  hidden: 'aaaaaaaa-0000-4000-8000-000000000008',
};
export const BLOCK = 'bbbbbbbb-0000-4000-8000-000000000001';
export const U = { ana: 'cccccccc-0000-4000-8000-000000000001', ben: 'cccccccc-0000-4000-8000-000000000002', bot: 'cccccccc-0000-4000-8000-000000000003' };

const S3 = 'https://prod-files-secure.s3.us-west-2.amazonaws.com';
export const PATH_DESIGN = `${S3}/ws/abc/design.png`;
export const PATH_SPEC = `${S3}/ws/abc/spec.pdf`;
export const PATH_DOC = 'https://file.notion.so/f/ws/abc/doc.txt';
export const URL_EVIL = 'https://evil.example/x.png';
export const URL_EXTRA = 'https://cdn.example-files.test/x.png';
/** Served by PATH (origin + pathname): the signature in the query changes on every read. */
export const FILES: Record<string, { body: string; contentType?: string }> = {};
FILES[PATH_DESIGN] = { body: 'PNGDATA', contentType: 'image/png' };
FILES[PATH_SPEC] = { body: 'PDFDATA', contentType: 'application/pdf' };
FILES[PATH_DOC] = { body: 'DOCDATA' };
FILES[URL_EVIL] = { body: 'SECRET' };
FILES[URL_EXTRA] = { body: 'EXTRA' };

const prop = (id: string, name: string, type: string, extra: Partial<NtPropertySchema> = {}): NtPropertySchema => ({ id, name, type, ...extra });
const opt = (id: string, name: string) => ({ id, name, color: 'default' });

const TASK_PROPS: NtPropertySchema[] = [
  prop('title', 'Name', 'title'),
  prop('stat', 'Status', 'status', {
    status: {
      options: [opt('o-todo', 'Not started'), opt('o-prog', 'In progress'), opt('o-done', 'Done'), opt('o-park', 'Parked')],
      groups: [{ id: 'g1', name: 'To-do', option_ids: ['o-todo'] }, { id: 'g2', name: 'In progress', option_ids: ['o-prog'] }, { id: 'g3', name: 'Complete', option_ids: ['o-done'] }],
    },
  }),
  prop('prio', 'Priority', 'select', { select: { options: [opt('p-h', 'High'), opt('p-m', 'Medium'), opt('p-l', 'Low')] } }),
  prop('asg', 'Assignee', 'people'),
  prop('due', 'Due', 'date'),
  prop('tags', 'Tags', 'multi_select', { multi_select: { options: [opt('t-a', 'a'), opt('t-b', 'b')] } }),
  prop('est', 'Estimate', 'number'),
  prop('notes', 'Notes', 'rich_text'),
  prop('lnk', 'Link', 'url'),
  prop('rev', 'Reviewed', 'checkbox'),
  prop('files', 'Files', 'files'),
  prop('par', 'Parent item', 'relation', { relation: { data_source_id: DS.tasks } }),
  prop('blk', 'Blocked by', 'relation', { relation: { data_source_id: DS.tasks } }),
  prop('blg', 'Blocking', 'relation', { relation: { data_source_id: DS.tasks } }),
  prop('rel', 'Related', 'relation', { relation: { data_source_id: DS.other } }),
  prop('frm', 'Calc', 'formula'),
  prop('rol', 'Total', 'rollup'),
  prop('uid', 'ID', 'unique_id'),
  prop('ct', 'Created', 'created_time'),
];
const mkProps = (list: NtPropertySchema[]): Record<string, NtPropertySchema> => Object.fromEntries(list.map((p) => [p.name as string, p]));
const rt = (text: string, ann: Record<string, boolean> = {}, href?: string) => ({ type: 'text', plain_text: text, href: href ?? null, annotations: ann, text: { content: text, link: href ? { url: href } : null } });

export const DATA_SOURCES: Record<string, NtDataSource> = {
  [DS.tasks]: { object: 'data_source', id: DS.tasks, title: [rt('Tasks')], properties: mkProps(TASK_PROPS), parent: { type: 'database_id', database_id: 'db-1' } },
  [DS.checklist]: { object: 'data_source', id: DS.checklist, title: [rt('Checklist')], properties: mkProps([prop('title', 'Item', 'title'), prop('done', 'Done', 'checkbox'), prop('who', 'Owner', 'people'), prop('dl', 'Deadline', 'date')]) },
  [DS.stages]: { object: 'data_source', id: DS.stages, title: [rt('Stages')], properties: mkProps([prop('title', 'Name', 'title'), prop('stage', 'Stage', 'select', { select: { options: [opt('s1', 'Backlog'), opt('s2', 'Doing'), opt('s3', 'Done')] } })]) },
  [DS.big]: { object: 'data_source', id: DS.big, title: [rt('Big')], properties: mkProps([prop('title', 'Name', 'title')]) },
  [DS.other]: { object: 'data_source', id: DS.other, title: [], properties: mkProps([prop('title', 'Name', 'title')]) },
};

const v = (id: string, type: string, body: Partial<NtPropertyValue>): NtPropertyValue => ({ id, type, ...body });
const person = (id: string) => ({ object: 'user' as const, id, type: 'person' });
const signed = (path: string, n: number) => `${path}?X-Amz-Signature=sig-${n}`;
export let signatureCounter = 0;
export const nextSig = () => ++signatureCounter;

export function taskRow(over: { id: string; created: string; title: string; status?: string | null; prio?: string | null; extra?: Record<string, NtPropertyValue>; flags?: Partial<NtPage> }): NtPage {
  const statusName = over.status;
  const statusId = statusName ? ({ 'Not started': 'o-todo', 'In progress': 'o-prog', Done: 'o-done', Parked: 'o-park', Deleted: 'o-gone' } as Record<string, string>)[statusName] : undefined;
  return {
    object: 'page', id: over.id, created_time: over.created, last_edited_time: '2026-02-01T10:00:00.000Z', created_by: { id: U.ana }, url: `https://www.notion.so/${over.id.replace(/-/g, '')}`,
    properties: {
      Name: v('title', 'title', { title: [rt(over.title)] }),
      Status: v('stat', 'status', { status: statusName ? { id: statusId ?? 'o-x', name: statusName } : null }),
      Priority: v('prio', 'select', { select: over.prio ? { id: 'p-x', name: over.prio } : null }),
      ...(over.extra ?? {}),
    },
    ...(over.flags ?? {}),
  };
}

export function pages(sig: () => number = nextSig): Record<string, NtPage> {
  const n = sig();
  const design = taskRow({
    id: P.design, created: '2026-01-01T09:00:00.000Z', title: 'Design the login page', status: 'In progress', prio: 'High',
    extra: {
      Assignee: v('asg', 'people', { people: [person(U.ana), { object: 'user', id: U.bot, type: 'bot' }] }),
      Due: v('due', 'date', { date: { start: '2026-03-01', end: '2026-03-05', time_zone: null } }),
      Tags: v('tags', 'multi_select', { multi_select: [opt('t-a', 'a'), opt('t-b', 'b')] }),
      Estimate: v('est', 'number', { number: 5 }),
      Notes: v('notes', 'rich_text', { rich_text: [rt('Remember SSO')] }),
      Link: v('lnk', 'url', { url: 'https://example.com/spec' }),
      Reviewed: v('rev', 'checkbox', { checkbox: true }),
      Files: v('files', 'files', { files: [{ name: 'design.png', type: 'file', file: { url: signed(PATH_DESIGN, n), expiry_time: '2026-01-01T10:00:00.000Z' } }, { name: 'Figma', type: 'external', external: { url: 'https://figma.com/x' } }] }),
      'Blocked by': v('blk', 'relation', { relation: [{ id: P.ship }, { id: 'ffffffff-0000-4000-8000-00000000ffff' }] }),
      Blocking: v('blg', 'relation', { relation: [{ id: P.plain }] }),
      Related: v('rel', 'relation', { relation: [{ id: P.ship }] }),
      Calc: v('frm', 'formula', {}),
      ID: v('uid', 'unique_id', { unique_id: { prefix: 'TASK', number: 7 } }),
    },
  });
  return {
    [P.design]: design,
    [P.ship]: taskRow({ id: P.ship, created: '2026-01-02T09:00:00.000Z', title: 'Ship the login page', status: 'Done', prio: 'Medium', extra: { Due: v('due', 'date', { date: { start: '2026-04-01T09:30:00.000+02:00', end: null } }) } }),
    [P.sub]: taskRow({ id: P.sub, created: '2026-01-03T09:00:00.000Z', title: 'Subtask', status: 'Not started', extra: { 'Parent item': v('par', 'relation', { relation: [{ id: P.design }] }) } }),
    [P.plain]: taskRow({ id: P.plain, created: '2026-01-04T09:00:00.000Z', title: 'No status here', status: null }),
    [P.trashed]: taskRow({ id: P.trashed, created: '2026-01-05T09:00:00.000Z', title: 'In the trash', status: 'Done', flags: { in_trash: true } }),
    [P.parked]: taskRow({ id: P.parked, created: '2026-01-06T09:00:00.000Z', title: 'Parked one', status: 'Parked' }),
    [P.archived]: taskRow({ id: P.archived, created: '2026-01-07T09:00:00.000Z', title: 'Old-style archived', status: 'Done', flags: { archived: true } }),
    [P.hidden]: taskRow({ id: P.hidden, created: '2026-01-08T09:00:00.000Z', title: 'Deleted option', status: 'Deleted' }),
  };
}

export const TASK_ORDER = [P.design, P.ship, P.sub, P.plain, P.trashed, P.parked, P.archived, P.hidden];
const checkRow = (id: string, title: string, done: boolean, who: string | null, deadline: string | null): NtPage => ({ object: 'page', id, created_time: '2026-02-01T00:00:00.000Z', properties: { Item: v('title', 'title', { title: [rt(title)] }), Done: v('done', 'checkbox', { checkbox: done }), Owner: v('who', 'people', { people: who ? [person(who)] : [] }), Deadline: v('dl', 'date', { date: deadline ? { start: deadline } : null }) } });
const stageRow = (id: string, title: string, stage: string | null): NtPage => ({ object: 'page', id, created_time: '2026-02-01T00:00:00.000Z', properties: { Name: v('title', 'title', { title: [rt(title)] }), Stage: v('stage', 'select', { select: stage ? { id: ({ Backlog: 's1', Doing: 's2', Done: 's3' } as Record<string, string>)[stage], name: stage } : null }) } });
export const CHECK_IDS = ['dddddddd-0000-4000-8000-000000000001', 'dddddddd-0000-4000-8000-000000000002', 'dddddddd-0000-4000-8000-000000000003'];
export const STAGE_IDS = ['eeeeeeee-0000-4000-8000-000000000001', 'eeeeeeee-0000-4000-8000-000000000002'];
export const BIG_IDS = Array.from({ length: 60 }, (_, i) => `ffffffff-1111-4111-8111-${String(i).padStart(12, '0')}`);

const MARKDOWN_DESIGN = (n: number) => `# Goal

Ship **login**.

<callout icon="💡" color="gray_bg">
Remember SSO
</callout>

<image src="${signed(PATH_DESIGN, n)}">Design mock</image>

<details>
<summary>More</summary>
Hidden text
</details>

<table header-row="true">
<tr><td>A</td><td>B</td></tr>
<tr><td>1</td><td>2 | 3</td></tr>
</table>

[the spec](${signed(PATH_SPEC, n)})

[other site](https://example.com/page?x=1)

<columns><column>left</column><column>right</column></columns>

<unknown url="https://notion.so/p#b1"/>



\`\`\`
<image src="${signed(PATH_DESIGN, n)}">kept</image> and <unknown url="x"/>
\`\`\`
`;

export function markdownOf(id: string, n: number): NtMarkdown | null {
  if (id === P.design) return { object: 'page_markdown', id, markdown: MARKDOWN_DESIGN(n), truncated: true, unknown_block_ids: [BLOCK] };
  if (id === BLOCK) return { object: 'page_markdown', id, markdown: `More content <file src="${signed(PATH_DOC, n)}">doc</file>`, truncated: false, unknown_block_ids: [] };
  if (id === P.ship) return { object: 'page_markdown', id, markdown: 'Done and shipped.\n', truncated: false, unknown_block_ids: [] };
  if (id === P.hidden) return null; // 404: not readable
  if (BIG_IDS.includes(id) || CHECK_IDS.includes(id) || STAGE_IDS.includes(id) || id === P.sub || id === P.plain || id === P.parked) return { object: 'page_markdown', id, markdown: '', truncated: false, unknown_block_ids: [] };
  return null;
}

export const COMMENTS: Record<string, NtComment[]> = {
  [P.design]: [
    { id: 'c2', discussion_id: 'd1', created_time: '2026-01-03T00:00:00.000Z', created_by: { id: U.ben }, rich_text: [rt('A '), rt('reply', { bold: true })] },
    { id: 'c1', discussion_id: 'd1', created_time: '2026-01-02T00:00:00.000Z', created_by: { id: U.ana }, rich_text: [rt('First *comment*', {}), rt(' see '), rt('docs', {}, 'https://example.com/docs')] },
    { id: 'c3', discussion_id: 'd2', created_time: '2026-01-04T00:00:00.000Z', created_by: { id: U.ana }, rich_text: [rt('Another thread', { code: true })] },
    { id: 'c4', discussion_id: 'd3', created_time: '2026-01-05T00:00:00.000Z', rich_text: [] },
  ],
};

export const USERS: NtUser[] = [
  { object: 'user', id: U.ana, type: 'person', name: 'Ana Lima', person: { email: 'ana@example.com' } },
  { object: 'user', id: U.ben, type: 'person', name: 'Ben Ortiz', person: { email: 'ben@example.com' } },
  { object: 'user', id: U.bot, type: 'bot', name: 'A bot' },
];

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const err = (status: number, code: string, message = code) => json({ object: 'error', status, code, message }, status);

export interface NotionDataset {
  shared: string[];
  noEmail: boolean;
  failUsers: boolean;
  failComments: boolean;
  /** `filter_properties` on a query answers 400 (the count must fall back). */
  rejectFilterProperties: boolean;
}
export const DATASET: NotionDataset = { shared: [DS.tasks, DS.checklist, DS.stages, DS.big], noEmail: false, failUsers: false, failComments: false, rejectFilterProperties: false };

const rowsOf = (dsId: string, sig: () => number): NtPage[] => {
  if (dsId === DS.tasks) {
    const all = pages(sig);
    return TASK_ORDER.map((id) => all[id]);
  }
  if (dsId === DS.checklist) return [checkRow(CHECK_IDS[0], 'Buy milk', false, U.ana, '2026-05-01'), checkRow(CHECK_IDS[1], 'Call', true, null, null), checkRow(CHECK_IDS[2], 'Plan', false, U.ben, '2026-05-09T10:00:00.000-05:00')];
  if (dsId === DS.stages) return [stageRow(STAGE_IDS[0], 'One', 'Doing'), stageRow(STAGE_IDS[1], 'Two', null)];
  if (dsId === DS.big) return BIG_IDS.map((id, i) => ({ object: 'page' as const, id, created_time: `2026-03-01T00:${String(i).padStart(2, '0')}:00.000Z`, properties: { Name: v('title', 'title', { title: [rt(`Row ${i}`)] }) } }));
  return [];
};

export function fakeNotion(data: NotionDataset = DATASET, opts: { intercept?: (method: string, path: string, body: any, query: URLSearchParams) => Response | undefined } = {}) {
  const calls: Array<{ method: string; path: string; query: string; body: any; headers: Record<string, string> }> = [];
  const fileCalls: Array<{ url: string; auth: string | null }> = [];
  const files = { ...FILES };
  const fn = jest.fn(async (url: unknown, init?: RequestInit) => {
    const u = new URL(String(url));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const method = (init?.method ?? 'GET').toUpperCase();
    if (u.hostname !== 'api.notion.com') {
      fileCalls.push({ url: String(url), auth: headers.authorization ?? null });
      const f = files[`${u.origin}${u.pathname}`];
      if (!f) return new Response('gone', { status: 404 });
      return new Response(f.body, { status: 200, headers: { ...(f.contentType ? { 'content-type': f.contentType } : {}), 'content-length': String(Buffer.byteLength(f.body)) } });
    }
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const path = u.pathname;
    calls.push({ method, path, query: u.search, body, headers });
    const hijack = opts.intercept?.(method, path, body, u.searchParams);
    if (hijack) return hijack;

    if (path.startsWith('/v1/oauth/')) {
      (fn as any).lastOauth = { path, auth: headers.authorization, body, version: headers['notion-version'] };
      if (path.endsWith('/revoke')) return json({});
      if (body?.grant_type === 'refresh_token') return body.refresh_token === 'rt-ok' ? json({ access_token: 'new-access', token_type: 'bearer', refresh_token: 'rt-rotated' }) : body.refresh_token === 'rt-null' ? json({ access_token: 'new-access', token_type: 'bearer', refresh_token: null }) : err(400, 'invalid_grant');
      return body?.code === 'bad' ? err(400, 'invalid_grant') : json({ access_token: 'tok', token_type: 'bearer', refresh_token: 'rt-1', bot_id: 'bot-1', workspace_id: WORKSPACE.id, workspace_name: WORKSPACE.name, owner: { type: 'user' }, duplicated_template_id: null });
    }
    if (headers.authorization !== 'Bearer tok' && headers.authorization !== 'Bearer new-access') return err(401, 'unauthorized', 'API token is invalid.');

    const sig = nextSig;
    const page = (items: unknown[], q: URLSearchParams | Record<string, any>, sizeKey = 'page_size') => {
      const size = Number((q instanceof URLSearchParams ? q.get(sizeKey) : q[sizeKey]) ?? 100);
      const start = String((q instanceof URLSearchParams ? q.get('start_cursor') : q.start_cursor) ?? '');
      const from = start ? Number(start.replace('c:', '')) : 0;
      const more = from + size < items.length;
      return json({ object: 'list', results: items.slice(from, from + size), has_more: more, next_cursor: more ? `c:${from + size}` : null });
    };

    if (path === '/v1/search' && method === 'POST') return page(data.shared.map((id) => DATA_SOURCES[id]), body);
    let m = /^\/v1\/data_sources\/([^/]+)$/.exec(path);
    if (m && method === 'GET') return data.shared.includes(m[1]) || m[1] === DS.other ? json(DATA_SOURCES[m[1]]) : err(404, 'object_not_found', 'Could not find data_source');
    m = /^\/v1\/data_sources\/([^/]+)\/query$/.exec(path);
    if (m && method === 'POST') {
      if (!data.shared.includes(m[1])) return err(404, 'object_not_found');
      if (data.rejectFilterProperties && u.searchParams.has('filter_properties')) return err(400, 'validation_error', 'filter_properties is not valid');
      return page(rowsOf(m[1], sig), body);
    }
    if (path === '/v1/users') return data.failUsers ? err(403, 'restricted_resource') : page(data.noEmail ? USERS.map((x) => ({ ...x, person: x.type === 'person' ? {} : undefined })) : USERS, u.searchParams);
    m = /^\/v1\/pages\/([^/]+)\/markdown$/.exec(path);
    if (m && method === 'GET') {
      const md = markdownOf(m[1], sig());
      return md ? json(md) : err(404, 'object_not_found', 'Could not find page');
    }
    m = /^\/v1\/pages\/([^/]+)$/.exec(path);
    if (m && method === 'GET') {
      const p = pages(sig)[m[1]];
      return p ? json(p) : err(404, 'object_not_found');
    }
    if (path === '/v1/comments') {
      if (data.failComments) return err(403, 'restricted_resource', 'Insufficient permissions for this endpoint.');
      return page(COMMENTS[u.searchParams.get('block_id') ?? ''] ?? [], u.searchParams);
    }
    return err(404, 'invalid_request_url', `unhandled ${method} ${path}`);
  });
  return {
    fetch: fn, calls, fileCalls, json, err, files,
    allowFile: (url: string, body: string, contentType?: string) => { files[url] = { body, contentType }; },
  };
}
