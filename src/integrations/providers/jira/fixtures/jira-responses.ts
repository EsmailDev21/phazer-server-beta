/**
 * SYNTHETIC Jira Cloud responses (no live site was called; shapes follow Atlassian's public docs, ADR-0037). One site (cloudId
 * "cloud-1", https://acme.atlassian.net) with projects ENG (10000) and OPS (10001). ENG-2 is the rich one: epic parent, sprints (closed +
 * active), two releases, labels / components, story points, time tracking, custom fields of every mapped kind, three kinds of link,
 * two attachments (one embedded in the description as ADF media), MORE comments and history than the first page carries.
 */
import type { JiraComment, JiraFieldDef, JiraHistory, JiraIssue, JiraSprint, JiraStatus } from '../jira.types';

export const CLOUD = 'cloud-1';
export const BASE = 'https://acme.atlassian.net';
export const GATEWAY = `https://api.atlassian.com/ex/jira/${CLOUD}`;
export const FILE_URL = (id: string) => `${GATEWAY}/rest/api/3/attachment/content/${id}`;

export const adf = (t: string) => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] });
const adfWithMedia = (t: string, name: string) => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }, { type: 'mediaSingle', attrs: { layout: 'center' }, content: [{ type: 'media', attrs: { id: 'media-uuid-1', type: 'file', collection: '', alt: name } }] }] });

const ana = { accountId: 'acc-ana', displayName: 'Ana Lima', emailAddress: 'ana@example.com', accountType: 'atlassian', active: true };
const ben = { accountId: 'acc-ben', displayName: 'Ben Ortiz', emailAddress: 'ben@example.com', accountType: 'atlassian', active: true };
export const USERS = [ana, ben, { accountId: 'acc-bot', displayName: 'Automation', accountType: 'app', active: true }, { accountId: 'acc-gone', displayName: 'Left Co', accountType: 'atlassian', active: false }];

export const ISSUE_TYPES = [
  { id: '10', name: 'Epic', hierarchyLevel: 1, subtask: false }, { id: '11', name: 'Story', hierarchyLevel: 0, subtask: false },
  { id: '12', name: 'Bug', hierarchyLevel: 0, subtask: false }, { id: '13', name: 'Sub-task', hierarchyLevel: -1, subtask: true },
];

const st = (id: string, name: string, key: string): JiraStatus => ({ id, name, statusCategory: { key, name: key } });
export const STATUSES = { todo: st('1', 'To Do', 'new'), progress: st('2', 'In Progress', 'indeterminate'), blocked: st('3', 'Blocked', 'indeterminate'), done: st('4', 'Done', 'done'), backlog: st('5', 'Backlog', 'new') };

export const PROJECTS = [{ id: '10000', key: 'ENG', name: 'Engineering', description: 'Product engineering' }, { id: '10001', key: 'OPS', name: 'Operations' }];
export const PROJECT_STATUSES: Record<string, Array<{ id: string; name: string; statuses: JiraStatus[] }>> = {
  '10000': [{ id: '11', name: 'Story', statuses: [STATUSES.backlog, STATUSES.todo, STATUSES.progress, STATUSES.blocked, STATUSES.done] }, { id: '13', name: 'Sub-task', statuses: [STATUSES.todo, STATUSES.done] }],
  '10001': [{ id: '11', name: 'Task', statuses: [STATUSES.todo, STATUSES.done] }],
};
export const VERSIONS: Record<string, Array<{ id: string; name: string; released?: boolean; releaseDate?: string }>> = { '10000': [{ id: '100', name: '1.0', released: true, releaseDate: '2026-02-01' }, { id: '101', name: '1.1' }], '10001': [] };
export const BOARDS: Record<string, Array<{ id: number; type: string }>> = { '10000': [{ id: 7, type: 'scrum' }], '10001': [{ id: 8, type: 'kanban' }] };
export const SPRINTS: Record<number, JiraSprint[]> = {
  7: [{ id: 71, name: 'Sprint 1', state: 'closed', startDate: '2026-01-05T09:00:00.000Z', endDate: '2026-01-19T09:00:00.000Z', completeDate: '2026-01-19T10:00:00.000Z', goal: 'Ship login' }, { id: 72, name: 'Sprint 2', state: 'active', startDate: '2026-01-19T09:00:00.000Z', endDate: '2026-02-02T09:00:00.000Z' }],
};

export const FIELDS: JiraFieldDef[] = [
  { id: 'summary', name: 'Summary', custom: false, schema: { type: 'string', system: 'summary' } },
  { id: 'customfield_10020', name: 'Sprint', custom: true, schema: { type: 'array', items: 'json', custom: 'com.pyxis.greenhopper.jira:gh-sprint' } },
  { id: 'customfield_10016', name: 'Story point estimate', custom: true, schema: { type: 'number', custom: 'com.pyxis.greenhopper.jira:jsw-story-points' } },
  { id: 'customfield_10050', name: 'Environment type', custom: true, schema: { type: 'option', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:select' } },
  { id: 'customfield_10051', name: 'Platforms', custom: true, schema: { type: 'array', items: 'option', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:multicheckboxes' } },
  { id: 'customfield_10052', name: 'Customer', custom: true, schema: { type: 'string', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:textfield' } },
  { id: 'customfield_10053', name: 'Owner', custom: true, schema: { type: 'user', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:userpicker' } },
  { id: 'customfield_10054', name: 'Go-live', custom: true, schema: { type: 'date', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:datepicker' } },
  { id: 'customfield_10055', name: 'Budget', custom: true, schema: { type: 'number', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:float' } },
  { id: 'customfield_10056', name: 'Squads', custom: true, schema: { type: 'array', items: 'string', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:labels' } },
  { id: 'customfield_10060', name: 'Rank', custom: true, schema: { type: 'any', custom: 'com.pyxis.greenhopper.jira:gh-lexo-rank' } },
  { id: 'customfield_10070', name: 'Weird thing', custom: true, schema: { type: 'any', custom: 'com.acme.plugin:weird' } },
];

const hist = (id: string, created: string, author: typeof ana, items: JiraHistory['items']): JiraHistory => ({ id, created, author, items });
export const E2_HISTORY: JiraHistory[] = [
  hist('h1', '2026-01-05T09:10:00.000+0000', ben, [{ field: 'status', fieldId: 'status', fromString: 'Backlog', toString: 'To Do' }]),
  hist('h2', '2026-01-06T10:00:00.000+0000', ana, [{ field: 'assignee', fieldId: 'assignee', fromString: null, toString: 'Ana Lima' }, { field: 'Story Points', fieldId: 'customfield_10016', fromString: '3', toString: '5' }]),
  hist('h3', '2026-01-07T11:00:00.000+0000', ana, [{ field: 'Sprint', fieldId: 'customfield_10020', fromString: 'Sprint 1', toString: 'Sprint 1, Sprint 2' }]),
];
export const E2_COMMENTS: JiraComment[] = [
  { id: 'c1', author: ana, body: adf('First note'), created: '2026-01-06T08:00:00.000+0000', updated: '2026-01-06T08:00:00.000+0000' },
  { id: 'c2', author: ben, body: adf('Second note'), created: '2026-01-06T09:00:00.000+0000', updated: '2026-01-06T09:30:00.000+0000' },
  { id: 'c3', author: { accountId: 'acc-stranger', displayName: 'Stranger' }, body: adf('Third note, by someone not in the list'), created: '2026-01-06T10:00:00.000+0000', updated: '2026-01-06T10:00:00.000+0000' },
  { id: 'c4', author: ana, body: adfWithMedia('See the screenshot', 'shot.png'), created: '2026-01-07T08:00:00.000+0000', updated: '2026-01-07T08:00:00.000+0000' },
  { id: 'c5', author: ben, body: adf('Fifth note'), created: '2026-01-08T08:00:00.000+0000', updated: '2026-01-08T08:00:00.000+0000' },
];

const base = (id: string, key: string, summary: string, typeId: string, status: JiraStatus, extra: Record<string, unknown> = {}): JiraIssue => ({
  id, key,
  fields: { summary, issuetype: ISSUE_TYPES.find((t) => t.id === typeId), status, priority: { id: '3', name: 'Medium' }, created: '2026-01-05T09:00:00.000+0000', updated: '2026-01-09T09:00:00.000+0000', reporter: ben, labels: [], components: [], fixVersions: [], issuelinks: [], attachment: [], ...extra },
} as JiraIssue);

const E1 = base('20001', 'ENG-1', 'Login revamp', '10', STATUSES.progress, { priority: { id: '1', name: 'Highest' }, description: adf('The epic.') });
const E2 = base('20002', 'ENG-2', 'Login form', '11', STATUSES.todo, {
  priority: { id: '2', name: 'High' }, parent: { id: '20001' }, assignee: ana,
  description: adfWithMedia('Build the form.', 'shot.png'), environment: adf('Safari 17'),
  labels: ['frontend', 'a11y'], components: [{ name: 'Web' }], fixVersions: [{ id: '100', name: '1.0' }, { id: '101', name: '1.1' }], duedate: '2026-03-01',
  customfield_10020: [{ id: 71, state: 'closed', name: 'Sprint 1' }, { id: 72, state: 'active', name: 'Sprint 2' }], customfield_10016: 5,
  customfield_10050: { value: 'staging' }, customfield_10051: [{ value: 'iOS' }, { value: 'Web' }], customfield_10052: 'Acme Corp', customfield_10053: { accountId: 'acc-ben' },
  customfield_10054: '2026-04-01', customfield_10055: 1250.5, customfield_10056: ['alpha', 'beta'], customfield_10060: '0|i0001:', customfield_10070: { whatever: 1 },
  timeoriginalestimate: 7200, timespent: 3600,
  issuelinks: [
    { id: '9001', type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }, outwardIssue: { id: '20003', key: 'ENG-3', fields: { summary: 'Form validation' } } },
    { id: '9002', type: { name: 'Relates', inward: 'relates to', outward: 'relates to' }, outwardIssue: { id: '20101', key: 'OPS-1', fields: { summary: 'Rotate keys [urgent]' } } },
    { id: '9003', type: { name: 'Duplicate', inward: 'is duplicated by', outward: 'duplicates' }, outwardIssue: { id: '20004', key: 'ENG-4', fields: { summary: 'Same bug' } } },
  ],
  attachment: [
    { id: '501', filename: 'shot.png', size: 11, mimeType: 'image/png', created: '2026-01-05T10:00:00.000+0000', author: ana },
    { id: '502', filename: 'notes.pdf', size: 9, mimeType: 'application/pdf', created: '2026-01-05T11:00:00.000+0000', author: { accountId: 'acc-stranger' } },
  ],
  comment: { comments: E2_COMMENTS.slice(0, 3), total: 5 },
});
E2.changelog = { histories: E2_HISTORY.slice(0, 2), total: 3 };
const E3 = base('20003', 'ENG-3', 'Form validation', '13', STATUSES.done, { parent: { id: '20002' }, assignee: ben, issuelinks: [{ id: '9001', type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }, inwardIssue: { id: '20002', key: 'ENG-2', fields: { summary: 'Login form' } } }] });
const E4 = base('20004', 'ENG-4', 'Same bug', '12', STATUSES.blocked, { description: null, issuelinks: [{ id: '9003', type: { name: 'Duplicate', inward: 'is duplicated by', outward: 'duplicates' }, inwardIssue: { id: '20002', key: 'ENG-2' } }] });
const O1 = base('20101', 'OPS-1', 'Rotate keys [urgent]', '11', STATUSES.todo, { issuelinks: [{ id: '9002', type: { name: 'Relates', inward: 'relates to', outward: 'relates to' }, inwardIssue: { id: '20002', key: 'ENG-2' } }] });

export const ISSUES: Record<string, JiraIssue[]> = { '10000': [E1, E2, E3, E4], '10001': [O1] };
export const ATTACHMENT_BYTES: Record<string, string> = { '501': 'PNG-bytes-11', '502': 'PDF-bytes' };

export interface JiraDataset {
  /** Which accessible resources the grant covers. */
  resources: Array<{ id: string; name: string; url: string; scopes: string[] }>;
  /** Refresh tokens that are still valid (rotating: each is single-use). */
  validRefresh: Set<string>;
  comments: Record<string, JiraComment[]>;
  history: Record<string, JiraHistory[]>;
  files: Record<string, { body: string; status?: number; contentType?: string }>;
  failUsers?: boolean;
  failAgile?: boolean;
}

export const dataset = (): JiraDataset => ({
  resources: [{ id: CLOUD, name: 'Acme', url: BASE, scopes: ['read:jira-work', 'read:jira-user'] }],
  validRefresh: new Set(['rt-1']),
  comments: { '20002': E2_COMMENTS },
  history: { '20002': E2_HISTORY },
  files: Object.fromEntries(Object.entries(ATTACHMENT_BYTES).map(([id, body]) => [FILE_URL(id), { body, contentType: id === '501' ? 'image/png' : 'application/pdf' }])),
});

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** A fake of auth.atlassian.com + api.atlassian.com (Jira platform + Agile) behind the global fetch signature. */
export function fakeJira(data: JiraDataset = dataset(), opts: { pageSize?: number; intercept?: (path: string, method: string) => Response | undefined } = {}) {
  const calls: string[] = [];
  const bodies: Array<{ path: string; body: Record<string, unknown> }> = [];
  const fileCalls: Array<{ url: string; auth: string | null }> = [];
  let refreshCount = 0;
  const fn = jest.fn(async (url: unknown, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = init?.method ?? 'GET';
    const auth = ((init?.headers ?? {}) as Record<string, string>).authorization ?? null;
    if (u.host === 'auth.atlassian.com') {
      const b = JSON.parse(String(init?.body ?? '{}')) as Record<string, string>;
      calls.push(`${method} ${u.pathname} ${b.grant_type}`);
      if (b.grant_type === 'authorization_code') return b.code === 'good' ? json({ access_token: 'tok', refresh_token: 'rt-1', expires_in: 3600, scope: 'read:jira-work read:jira-user offline_access', token_type: 'Bearer' }) : json({ error: 'invalid_grant' }, 403);
      if (b.grant_type === 'refresh_token') {
        if (!data.validRefresh.has(b.refresh_token)) return json({ error: 'invalid_grant', error_description: 'Unknown or invalid refresh token.' }, 403);
        data.validRefresh.delete(b.refresh_token); // single use
        refreshCount += 1;
        const next = `rt-${refreshCount + 1}`;
        data.validRefresh.add(next);
        return json({ access_token: `tok-${refreshCount + 1}`, refresh_token: next, expires_in: 3600, scope: 'read:jira-work offline_access' });
      }
      return json({ error: 'unsupported_grant_type' }, 400);
    }
    if (u.host !== 'api.atlassian.com') return new Response('nope', { status: 404 });
    if (u.pathname === '/oauth/token/accessible-resources') {
      calls.push(`${method} /accessible-resources`);
      return auth === 'Bearer tok' ? json(data.resources) : json({ message: 'bad token' }, 401);
    }
    const prefix = `/ex/jira/${CLOUD}`;
    if (!u.pathname.startsWith(`${prefix}/`)) return json({ message: 'unknown site' }, 404);
    const path = u.pathname.slice(prefix.length);
    if (path.startsWith('/rest/api/3/attachment/content/')) {
      fileCalls.push({ url: String(url), auth });
      const f = data.files[String(url)];
      if (!f) return new Response('gone', { status: 404 });
      return new Response(f.body, { status: f.status ?? 200, headers: { ...(f.contentType ? { 'content-type': f.contentType } : {}), 'content-length': String(Buffer.byteLength(f.body)) } });
    }
    const q = u.searchParams;
    calls.push(`${method} ${path}${u.search}`);
    let body: Record<string, unknown> = {};
    if (init?.body) { body = JSON.parse(String(init.body)); bodies.push({ path, body }); }
    const hijack = opts.intercept?.(path, method);
    if (hijack) return hijack;
    if (auth !== 'Bearer tok' && auth !== 'Bearer tok-2') return json({ message: 'Unauthorized' }, 401);

    if (path === '/rest/api/3/serverInfo') return json({ baseUrl: BASE });
    if (path === '/rest/api/3/project/search') return json({ values: PROJECTS, isLast: true, startAt: 0 });
    if (path === '/rest/api/3/users/search') return data.failUsers ? json({ message: 'forbidden' }, 403) : json(USERS.slice(Number(q.get('startAt') ?? 0), Number(q.get('startAt') ?? 0) + Number(q.get('maxResults') ?? 50)));
    if (path === '/rest/api/3/issuetype') return json(ISSUE_TYPES);
    if (path === '/rest/api/3/priority') return json([{ name: 'Highest' }, { name: 'High' }, { name: 'Medium' }, { name: 'Low' }, { name: 'Lowest' }]);
    if (path === '/rest/api/3/field') return json(FIELDS);
    let m = /^\/rest\/api\/3\/project\/(\d+)$/.exec(path);
    if (m) { const p = PROJECTS.find((x) => x.id === m![1]); return p ? json(p) : json({ errorMessages: ['No project could be found'] }, 404); }
    m = /^\/rest\/api\/3\/project\/(\d+)\/statuses$/.exec(path);
    if (m) return json(PROJECT_STATUSES[m[1]] ?? []);
    m = /^\/rest\/api\/3\/project\/(\d+)\/versions$/.exec(path);
    if (m) return json(VERSIONS[m[1]] ?? []);
    if (path === '/rest/agile/1.0/board') return data.failAgile ? json({ message: 'no software' }, 403) : json({ values: BOARDS[q.get('projectKeyOrId') ?? ''] ?? [], isLast: true });
    m = /^\/rest\/agile\/1\.0\/board\/(\d+)\/sprint$/.exec(path);
    if (m) return json({ values: SPRINTS[Number(m[1])] ?? [], isLast: true });
    if (path === '/rest/api/3/search/approximate-count') { const pid = /project = (\d+)/.exec(String(body.jql))?.[1] ?? ''; return json({ count: (ISSUES[pid] ?? []).length }); }
    if (path === '/rest/api/3/search/jql') {
      const pid = /project = (\d+)/.exec(String(body.jql))?.[1] ?? '';
      const all = ISSUES[pid] ?? [];
      const size = Math.min(Number(body.maxResults ?? 50), opts.pageSize ?? 1000);
      const from = body.nextPageToken ? Number(String(body.nextPageToken).replace('tok:', '')) : 0;
      const slice = all.slice(from, from + size).map((i) => (body.expand === 'changelog' ? i : { ...i, changelog: undefined }));
      const more = from + size < all.length;
      return json({ issues: slice, ...(more ? { nextPageToken: `tok:${from + size}` } : { isLast: true }) });
    }
    m = /^\/rest\/api\/3\/issue\/(\d+)\/comment$/.exec(path);
    if (m) { const all = data.comments[m[1]] ?? []; const s = Number(q.get('startAt') ?? 0); return json({ comments: all.slice(s, s + Number(q.get('maxResults') ?? 50)), total: all.length, startAt: s }); }
    m = /^\/rest\/api\/3\/issue\/(\d+)\/changelog$/.exec(path);
    if (m) { const all = data.history[m[1]] ?? []; const s = Number(q.get('startAt') ?? 0); const max = Number(q.get('maxResults') ?? 100); return json({ values: all.slice(s, s + max), startAt: s, total: all.length, isLast: s + max >= all.length }); }
    return json({ message: `not found: ${path}` }, 404);
  });
  return { fetch: fn, calls, bodies, fileCalls, json, data };
}
