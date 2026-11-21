/**
 * SYNTHETIC ClickUp API v2 responses (no live workspace was called; shapes follow ClickUp's public docs, ADR-0036). One Workspace
 * ("Acme", id 9001) with two Spaces:
 *   Engineering (space-1): Folder "Q3 Roadmap" (folder-1) holding list "Sprint Board" (list-1), and a folderless list "Bugs" (list-2)
 *   Marketing   (space-2): list "Campaigns" (list-3)
 * Sprint Board has 3 tasks (one subtask, one with a dependency, one closed) + 1 archived; Bugs has 101 tasks (so a 2nd page is
 * served); Campaigns is empty. Ana (101) matches a member by e-mail; Ben (102) and Cy (103) are workspace members.
 */
import type { CuAttachment, CuComment, CuCustomField, CuList, CuTask } from '../clickup.types';

export const TEAM = '9001';
export const FILE_OK = 'https://attachments.clickup.com/aaa/design.png';
export const FILE_CDN = 'https://t9001.p.clickup-attachments.com/t9001/bbb/spec.pdf';
export const FILE_EVIL = 'https://169.254.169.254/latest/meta-data/x.png';
export const FILE_LOOKALIKE = 'https://attachments.clickup.com.evil.example/x.png';

const U = {
  ana: { id: 101, username: 'Ana Lima', email: 'ana@example.com' },
  ben: { id: 102, username: 'Ben Ortiz', email: 'ben@example.com' },
  cy: { id: 103, username: 'Cy Old', email: 'cy@example.com' },
};

const status = (name: string, type: string, i: number) => ({ id: `st-${name}`, status: name, type, color: '#888', orderindex: i });
export const LIST_STATUSES = [status('to do', 'open', 0), status('in progress', 'custom', 1), status('blocked', 'custom', 2), status('complete', 'done', 3), status('closed', 'closed', 4)];

export const LISTS: Record<string, CuList> = {
  'list-1': { id: 'list-1', name: 'Sprint Board', content: 'The board for Q3.', archived: false, statuses: LIST_STATUSES, folder: { id: 'folder-1', name: 'Q3 Roadmap', hidden: false }, space: { id: 'space-1' } },
  'list-2': { id: 'list-2', name: 'Bugs', archived: false, statuses: [status('open', 'open', 0), status('fixing', 'custom', 1), status('fixed', 'done', 2)], folder: { id: 'folder-x', name: 'hidden', hidden: true }, space: { id: 'space-1' } },
  'list-3': { id: 'list-3', name: 'Campaigns', archived: false, statuses: [status('backlog', 'open', 0), status('done', 'closed', 1)], folder: { id: 'f3', name: 'hidden', hidden: true }, space: { id: 'space-2' } },
};

export const FIELDS: Record<string, CuCustomField[]> = {
  'list-1': [
    { id: 'cf-env', name: 'Environment', type: 'drop_down', type_config: { options: [{ id: 'o1', name: 'staging', orderindex: 0 }, { id: 'o2', name: 'production', orderindex: 1 }] } },
    { id: 'cf-cost', name: 'Cost', type: 'currency' },
    { id: 'cf-owner', name: 'Owner', type: 'users' },
    { id: 'cf-formula', name: 'Calc', type: 'formula' },
    { id: 'cf-loc', name: 'Where', type: 'location' },
  ],
  'list-2': [{ id: 'cf-env', name: 'Environment', type: 'drop_down', type_config: { options: [{ id: 'o1', name: 'staging', orderindex: 0 }, { id: 'o3', name: 'qa', orderindex: 2 }] } }],
};

const mk = (id: string, name: string, extra: Partial<CuTask> = {}): CuTask => ({
  id, name, url: `https://app.clickup.com/t/${id}`, status: { status: 'to do', type: 'open' }, priority: null, tags: [], assignees: [], creator: U.ana,
  date_created: '1767225600000', date_updated: '1767312000000', ...extra,
});

const T1 = mk('t1', 'Design the login page', {
  custom_id: 'ENG-1', markdown_description: '## Goal\nShip it.', status: { status: 'in progress', type: 'custom' }, priority: { id: '2', priority: 'high' },
  assignees: [U.ana, U.ben], tags: [{ name: 'frontend', tag_bg: '#ff0000' }, { name: 'ui' }], points: 5, due_date: '1770000000000', start_date: '1769000000000',
  custom_item_id: 1,
  custom_fields: [
    { id: 'cf-env', name: 'Environment', type: 'drop_down', type_config: { options: [{ id: 'o1', name: 'staging', orderindex: 0 }, { id: 'o2', name: 'production', orderindex: 1 }] }, value: 1 },
    { id: 'cf-cost', name: 'Cost', type: 'currency', value: '125.5' },
    { id: 'cf-owner', name: 'Owner', type: 'users', value: [{ id: 103, username: 'Cy Old' }] },
    { id: 'cf-formula', name: 'Calc', type: 'formula', value: 7 },
    { id: 'cf-empty', name: 'Unset', type: 'short_text', value: null },
  ],
  dependencies: [{ task_id: 't2', depends_on: 't1' }],
  linked_tasks: [{ task_id: 't1', link_id: 't3' }],
});
const T2 = mk('t2', 'Build the login API', { parent: undefined, assignees: [U.cy], dependencies: [{ task_id: 't2', depends_on: 't1' }], priority: { id: '3', priority: 'normal' }, status: { status: 'blocked', type: 'custom' } });
const T3 = mk('t3', 'Login copy', { parent: 't1', text_content: 'plain text body', status: { status: 'complete', type: 'done' }, linked_tasks: [{ task_id: 't3', link_id: 't1' }], archived: false });
const T_ARCH = mk('t-arch', 'Old idea', { status: { status: 'closed', type: 'closed' }, archived: true });

export const SPRINT_TASKS = [T1, T2, T3];
export const SPRINT_ARCHIVED = [T_ARCH];
export const BUG_TASKS: CuTask[] = Array.from({ length: 101 }, (_, i) => mk(`b${String(i).padStart(3, '0')}`, `Bug ${i}`, { status: { status: i % 2 ? 'open' : 'fixing', type: i % 2 ? 'open' : 'custom' } }));

export const COMMENTS: Record<string, CuComment[]> = {
  t1: [
    { id: 'c3', comment_text: 'Shipped to staging.', user: U.cy, date: '1767400000000', reply_count: 0 },
    { id: 'c2', comment_text: 'Looks good.', user: U.ben, date: '1767300000000', reply_count: 1 },
    { id: 'c1', comment_text: 'Please add dark mode.', user: U.ana, date: '1767200000000', reply_count: 0 },
  ],
  b000: Array.from({ length: 30 }, (_, i) => ({ id: `bc${String(100 - i)}`, comment_text: `note ${100 - i}`, user: U.ana, date: String(1767500000000 - i * 1000), reply_count: 0 })),
};
export const REPLIES: Record<string, CuComment[]> = { c2: [{ id: 'c2r', comment_text: 'Agreed.', user: U.ana, date: '1767310000000' }] };

export const ATTACHMENTS: Record<string, CuAttachment[]> = {
  t1: [
    { id: 'a1', title: 'design', extension: 'png', url: FILE_OK, size: '2048', mimetype: 'image/png', date: '1767210000000', user: U.ana },
    { id: 'a2', title: 'spec.pdf', extension: 'pdf', url: FILE_CDN, size: 4096, mimetype: 'application/pdf', date: '1767220000000', user: U.ben },
    { id: 'a3', title: 'evil', extension: 'png', url: FILE_EVIL },
    { id: 'a4', title: 'lookalike', extension: 'png', url: FILE_LOOKALIKE },
    { id: 'a5', title: 'nolink' },
  ],
};

export const FILES: Record<string, { body: string; contentType?: string; status?: number }> = {
  [FILE_OK]: { body: 'PNG-bytes-1234', contentType: 'image/png' },
  [FILE_CDN]: { body: 'PDF-bytes-5678', contentType: 'application/pdf' },
};

export interface ClickUpDataset {
  tokenOk: boolean;
  teams: Array<{ id: string; name: string; members: Array<{ user: typeof U.ana }> }>;
  failFields?: boolean;
}

export const DATASET: ClickUpDataset = {
  tokenOk: true,
  teams: [{ id: TEAM, name: 'Acme', members: [{ user: U.ana }, { user: U.ben }, { user: U.cy }] }],
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** A fake of api.clickup.com (+ the file hosts) behind the global fetch signature. `calls` records every API path. */
export function fakeClickUp(data: ClickUpDataset = DATASET, opts: { intercept?: (path: string) => Response | undefined; files?: typeof FILES } = {}) {
  const calls: string[] = [];
  const fileCalls: Array<{ url: string; auth: string | null }> = [];
  const files = opts.files ?? FILES;
  const fn = jest.fn(async (url: unknown, init?: RequestInit) => {
    const u = new URL(String(url));
    const auth = ((init?.headers ?? {}) as Record<string, string>).authorization ?? null;
    if (u.hostname !== 'api.clickup.com') {
      fileCalls.push({ url: String(url), auth });
      const f = files[String(url)];
      if (!f) return new Response('gone', { status: 404 });
      return new Response(f.body, { status: f.status ?? 200, headers: { ...(f.contentType ? { 'content-type': f.contentType } : {}), 'content-length': String(Buffer.byteLength(f.body)) } });
    }
    const path = u.pathname.replace(/^\/api\/v2/, '');
    const q = u.searchParams;
    calls.push(`${init?.method ?? 'GET'} ${path}${u.search}`);
    const hijack = opts.intercept?.(path);
    if (hijack) return hijack;
    if (auth !== 'Bearer tok' && path !== '/oauth/token' && !(path === '/team' && auth === 'Bearer newtok')) return json({ err: 'Token invalid', ECODE: 'OAUTH_019' }, 401);

    if (path === '/oauth/token') return data.tokenOk ? json({ access_token: 'newtok', token_type: 'Bearer' }) : json({ err: 'Code invalid', ECODE: 'OAUTH_030' }, 400);
    if (path === '/team') return json({ teams: data.teams });
    if (path === `/team/${TEAM}/space`) return json({ spaces: [{ id: 'space-1', name: 'Engineering' }, { id: 'space-2', name: 'Marketing' }] });
    if (path === '/space/space-1/folder') return json({ folders: [{ id: 'folder-1', name: 'Q3 Roadmap', lists: [{ id: 'list-1', name: 'Sprint Board' }] }] });
    if (path === '/space/space-1/list') return json({ lists: [{ id: 'list-2', name: 'Bugs' }] });
    if (path === '/space/space-2/folder') return json({ folders: [] });
    if (path === '/space/space-2/list') return json({ lists: [{ id: 'list-3', name: 'Campaigns' }] });
    if (path === '/folder/folder-1') return json({ id: 'folder-1', name: 'Q3 Roadmap', lists: [{ id: 'list-1', name: 'Sprint Board' }] });
    let m = /^\/list\/([^/]+)$/.exec(path);
    if (m) return LISTS[m[1]] ? json(LISTS[m[1]]) : json({ err: 'List not found' }, 404);
    m = /^\/list\/([^/]+)\/field$/.exec(path);
    if (m) return data.failFields ? json({ err: 'forbidden' }, 403) : json({ fields: FIELDS[m[1]] ?? [] });
    if (path === '/space/space-1/tag') return json({ tags: [{ name: 'frontend', tag_bg: '#ff0000' }, { name: 'unused' }] });
    if (path === '/space/space-2/tag') return json({ tags: [] });
    if (path === `/team/${TEAM}/custom_item`) return json({ custom_items: [{ id: 1002, name: 'Bug report' }] });
    m = /^\/list\/([^/]+)\/task$/.exec(path);
    if (m) {
      const page = Number(q.get('page') ?? 0);
      const archived = q.get('archived') === 'true';
      const all = m[1] === 'list-1' ? (archived ? SPRINT_ARCHIVED : SPRINT_TASKS) : m[1] === 'list-2' ? (archived ? [] : BUG_TASKS) : [];
      const slice = all.slice(page * 100, page * 100 + 100);
      return json({ tasks: slice, last_page: (page + 1) * 100 >= all.length });
    }
    m = /^\/task\/([^/]+)\/comment$/.exec(path);
    if (m) {
      const all = [...(COMMENTS[m[1]] ?? [])].sort((a, b) => Number(b.date) - Number(a.date));
      const startId = q.get('start_id');
      const from = startId ? all.findIndex((c) => String(c.id) === startId) + 1 : 0;
      return json({ comments: all.slice(from, from + 25) });
    }
    m = /^\/comment\/([^/]+)\/reply$/.exec(path);
    if (m) return json({ comments: REPLIES[m[1]] ?? [] });
    m = /^\/task\/([^/]+)$/.exec(path);
    if (m) return json({ id: m[1], attachments: ATTACHMENTS[m[1]] ?? [] });
    return json({ err: `not found: ${path}` }, 404);
  });
  return { fetch: fn, calls, fileCalls, json };
}
