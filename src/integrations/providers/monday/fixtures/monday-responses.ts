/**
 * SYNTHETIC monday.com GraphQL responses (no live account was called; shapes follow monday's public docs, ADR-0041). The person is Ana (1).
 *   Workspace "Product" (w1): board b1 "Sprint" (a status column, a Priority status column, groups Backlog / This sprint, every column type
 *   the importer cares about, subitems, a dependency column), board b3 "Groups only" (NO status column: the groups are the workflow).
 *   The main workspace (id null): b2 "Big" (230 items: three pages), b6 "Heavy" (12 items x 150 subitems: a page must be split).
 *   Not projects: b4 (a subitems board) and b5 (a doc).
 */
import type { MnAsset, MnBoard, MnColumn, MnColumnValue, MnGroup, MnItem, MnItemExtras, MnSubitem, MnUser } from '../monday.types';

export const ME = '1';
export const ACCOUNT = { id: '555', name: 'Acme' };
export const DL_OK = 'https://files.monday.com/a/7001.png';
export const DL_S3 = 'https://monday-files.s3.amazonaws.com/b/spec.pdf?X-Amz-Signature=abc';
export const DL_EVIL = 'https://evil.example/x.png';
export const DL_HTTP = 'http://files.monday.com/x.png';
export const DL_IP = 'https://169.254.169.254/latest/x';
export const DL_LOOKALIKE = 'https://files.monday.com.evil.example/x.png';
export const DL_EXTRA = 'https://cdn.example-files.test/x.png';

export const USERS: MnUser[] = [
  { id: 1, name: 'Ana Lima', email: 'ana@example.com', is_guest: false, enabled: true },
  { id: 2, name: 'Ben Ortiz', email: 'ben@example.com', is_guest: false, enabled: true },
  { id: 3, name: 'Cy Guest', email: null, is_guest: true, enabled: true },
];

const statusSettings = (labels: Record<string, string>, pos?: Record<string, number>): string => JSON.stringify({ labels, labels_positions_v2: pos ?? {}, done_colors: [1] });
const col = (id: string, title: string, type: string, settings?: unknown): MnColumn => ({ id, title, type, archived: false, ...(settings !== undefined ? { settings_str: typeof settings === 'string' ? settings : JSON.stringify(settings) } : {}) });

export const SPRINT_COLUMNS: MnColumn[] = [
  col('name', 'Name', 'name'),
  col('status', 'Status', 'status', statusSettings({ '0': 'Working on it', '1': 'Done', '2': 'Stuck', '5': '' }, { '5': 0, '0': 1, '2': 2, '1': 3 })),
  col('priority', 'Priority', 'status', statusSettings({ '0': 'Low', '1': 'Medium', '2': 'High' })),
  col('owner', 'Owner', 'people'),
  col('due', 'Due date', 'date'),
  col('tl', 'Timeline', 'timeline'),
  col('labels', 'Labels', 'dropdown', { labels: [{ id: 1, name: 'ui' }, { id: 2, name: 'api' }] }),
  col('budget', 'Budget', 'numbers'),
  col('notes', 'Notes', 'text'),
  col('spec', 'Spec', 'link'),
  col('rev', 'Reviewed', 'checkbox'),
  col('blocked', 'Blocked by', 'dependency'),
  col('subitems', 'Subitems', 'subtasks'),
  col('files', 'Files', 'file'),
  col('calc', 'Calc', 'formula'),
  col('mirror', 'Mirror', 'mirror'),
  { ...col('old', 'Archived col', 'text'), archived: true },
];
export const SPRINT_GROUPS: MnGroup[] = [{ id: 'g1', title: 'Backlog', archived: false, position: '1' }, { id: 'g2', title: 'This sprint', archived: false, position: '2' }];

export const BOARDS: Record<string, MnBoard & { workspace_id: string | null }> = {
  b1: { id: '1001000', name: 'Sprint', type: 'board', state: 'active', workspace_id: 'w1', url: 'https://acme.monday.com/boards/1001000', description: 'Q3 board', items_count: 4, columns: SPRINT_COLUMNS, groups: SPRINT_GROUPS },
  b2: { id: '1002000', name: 'Big', type: 'board', state: 'active', workspace_id: null, url: 'https://acme.monday.com/boards/1002000', items_count: 230, columns: [col('name', 'Name', 'name'), col('status', 'Status', 'status', statusSettings({ '0': 'Todo', '1': 'Done' }))], groups: [{ id: 'topics', title: 'Items', position: '1' }] },
  b3: { id: '1003000', name: 'Groups only', type: 'board', state: 'active', workspace_id: 'w1', items_count: 3, columns: [col('name', 'Name', 'name'), col('who', 'Who', 'people'), col('when', 'Deadline', 'date')], groups: [{ id: 'todo', title: 'Todo', position: '1' }, { id: 'doing', title: 'Doing', position: '2' }, { id: 'done', title: 'Done', position: '3' }] },
  b4: { id: '1004000', name: 'Subitems of Sprint', type: 'sub_items_board', state: 'active', workspace_id: 'w1', columns: [], groups: [] },
  b5: { id: '1005000', name: 'A doc', type: 'document', state: 'active', workspace_id: 'w1', columns: [], groups: [] },
  b6: { id: '1006000', name: 'Heavy', type: 'board', state: 'active', workspace_id: null, items_count: 12, columns: [col('name', 'Name', 'name'), col('status', 'Status', 'status', statusSettings({ '0': 'Working on it', '1': 'Done' })), col('subitems', 'Subitems', 'subtasks')], groups: [{ id: 'topics', title: 'Items', position: '1' }] },
};
export const BID = { sprint: '1001000', big: '1002000', groups: '1003000', sub: '1004000', doc: '1005000', heavy: '1006000' };

const v = (id: string, type: string, text: string | null, value: unknown): MnColumnValue => ({ id, type, text, value: value === null ? null : JSON.stringify(value) });
const sub = (id: number, name: string, cols: MnColumnValue[]): MnSubitem => ({ id, name, created_at: '2026-01-05T10:00:00Z', updated_at: '2026-01-06T10:00:00Z', creator: { id: 1 }, column_values: cols });

const SPRINT_ITEMS: MnItem[] = [
  {
    id: 1001, name: 'Design the login page', state: 'active', created_at: '2026-01-02T10:00:00Z', updated_at: '2026-01-03T10:00:00Z', url: 'https://acme.monday.com/boards/1001000/pulses/1001', creator: { id: 1 }, group: { id: 'g2', title: 'This sprint' },
    column_values: [
      v('status', 'status', 'Working on it', { index: 0 }), v('priority', 'status', 'High', { index: 2 }),
      v('owner', 'people', 'Ben Ortiz, Team X', { personsAndTeams: [{ id: 2, kind: 'person' }, { id: 99, kind: 'team' }] }),
      v('due', 'date', '2026-03-01 13:30', { date: '2026-03-01', time: '13:30:00' }), v('tl', 'timeline', '2026-02-01 - 2026-02-20', { from: '2026-02-01', to: '2026-02-20' }),
      v('labels', 'dropdown', 'ui, api', { ids: [1, 2] }), v('budget', 'numbers', '1,250.5', '1250.5'), v('notes', 'text', 'Remember SSO', 'Remember SSO'),
      v('spec', 'link', 'Spec - https://example.com/spec', { url: 'https://example.com/spec', text: 'Spec' }), v('rev', 'checkbox', 'v', { checked: 'true' }),
      v('blocked', 'dependency', 'Ship it, Ghost', { linkedPulseIds: [{ linkedPulseId: 1002 }, { linkedPulseId: 5555 }] }), v('calc', 'formula', '7', null),
    ],
    subitems: [
      sub(2001, 'Wireframe', [v('subitem_status', 'status', 'Done', { index: 1 }), v('subitem_owner', 'people', 'Ana', { personsAndTeams: [{ id: 1, kind: 'person' }] }), v('subitem_date', 'date', '2026-02-10', { date: '2026-02-10' })]),
      sub(2002, 'Review', [v('subitem_status', 'status', 'Working on it', { index: 0 }), v('subitem_tl', 'timeline', '', { from: '2026-02-11', to: '2026-02-12' })]),
    ],
  },
  { id: 1002, name: 'Ship the login page', state: 'active', created_at: '2026-01-02T11:00:00Z', creator: { id: 2 }, group: { id: 'g1', title: 'Backlog' }, column_values: [v('status', 'status', 'Done', { index: 1 })], subitems: [] },
  { id: 1003, name: 'Deleted label', state: 'active', creator: { id: 2 }, group: { id: 'g1', title: 'Backlog' }, column_values: [v('status', 'status', 'Gone', { index: 9 })], subitems: [] },
  { id: 1004, name: 'Label by text only', state: 'active', group: { id: 'zzz', title: 'Unknown group' }, column_values: [v('status', 'status', 'Stuck', null), v('priority', 'status', null, null)], subitems: [] },
];

const GROUPS_ITEMS: MnItem[] = [
  { id: 3001, name: 'Plan', group: { id: 'todo', title: 'Todo' }, column_values: [v('who', 'people', 'Ana', { personsAndTeams: [{ id: 1, kind: 'person' }] }), v('when', 'date', '2026-04-01', { date: '2026-04-01' })], subitems: [] },
  { id: 3002, name: 'Build', group: { id: 'doing', title: 'Doing' }, column_values: [], subitems: [] },
  { id: 3003, name: 'Ship', group: { id: 'done', title: 'Done' }, column_values: [], subitems: [] },
];
const BIG_ITEMS: MnItem[] = Array.from({ length: 230 }, (_, i) => ({ id: 20000 + i, name: `Item ${i}`, group: { id: 'topics', title: 'Items' }, column_values: [v('status', 'status', i % 2 ? 'Done' : 'Todo', { index: i % 2 })], subitems: [] }));
const HEAVY_ITEMS: MnItem[] = Array.from({ length: 12 }, (_, i) => ({
  id: 30000 + i, name: `Parent ${i}`, group: { id: 'topics', title: 'Items' }, column_values: [v('status', 'status', 'Working on it', { index: 0 })],
  subitems: Array.from({ length: 150 }, (_, j) => sub(400000 + i * 1000 + j, `Sub ${i}.${j}`, [v('subitem_status', 'status', 'Done', { index: 1 })])),
}));
export const ITEMS: Record<string, MnItem[]> = { [BID.sprint]: SPRINT_ITEMS, [BID.big]: BIG_ITEMS, [BID.groups]: GROUPS_ITEMS, [BID.heavy]: HEAVY_ITEMS };

const asset = (id: number, name: string, ext: string, size: number): MnAsset => ({ id, name, file_extension: ext, file_size: size, created_at: '2026-01-04T00:00:00Z', uploaded_by: { id: 1 } });
export const EXTRAS: Record<string, MnItemExtras> = {
  '1001': {
    id: 1001,
    assets: [asset(7001, 'design.png', '.png', 2048), asset(7002, 'spec', 'pdf', 4096), asset(7009, '../../etc/passwd', '', 10)],
    updates: [
      { id: 9002, text_body: 'Second update', body: null, created_at: '2026-01-06T00:00:00Z', creator: { id: 1, name: 'Ana Lima' }, replies: [], assets: [] },
      {
        id: 9001, body: '<p>Hello <strong>team</strong></p>', text_body: 'Hello team', created_at: '2026-01-05T00:00:00Z', creator: { id: 2, name: 'Ben Ortiz' },
        replies: [
          { id: 9102, text_body: 'Later reply', created_at: '2026-01-05T12:00:00Z', creator_id: 1 },
          { id: 9101, body: '<p>First reply</p>', created_at: '2026-01-05T06:00:00Z', creator: { id: 1, name: 'Ana Lima' } },
          { id: 9103, body: '', text_body: '', created_at: '2026-01-05T13:00:00Z' },
        ],
        assets: [asset(7001, 'design.png', '.png', 2048)],
      },
      { id: 9003, body: '', text_body: '', created_at: '2026-01-07T00:00:00Z' },
    ],
  },
};

export const ASSET_ANSWERS: Record<string, MnAsset> = {
  '7001': { id: 7001, name: 'design.png', public_url: DL_OK }, '7002': { id: 7002, name: 'spec.pdf', public_url: DL_S3 },
  '7003': { id: 7003, name: 'x', public_url: DL_EVIL }, '7004': { id: 7004, name: 'x', public_url: DL_HTTP }, '7005': { id: 7005, name: 'x', public_url: DL_IP },
  '7006': { id: 7006, name: 'x', public_url: DL_LOOKALIKE }, '7007': { id: 7007, name: 'x', public_url: null }, '7008': { id: 7008, name: 'x', public_url: DL_EXTRA },
};
export const FILES: Record<string, { body: string; contentType?: string }> = {
  [DL_OK]: { body: 'PNGDATA', contentType: 'image/png' }, [DL_S3]: { body: 'PDFDATA', contentType: 'application/pdf' }, [DL_EXTRA]: { body: 'EXTRA' },
  [DL_EVIL]: { body: 'SECRET' }, [DL_HTTP]: { body: 'HTTP' }, [DL_IP]: { body: 'IP' }, [DL_LOOKALIKE]: { body: 'LOOK' },
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const ok = (data: unknown, complexity?: unknown) => json({ data: { ...(data as object), ...(complexity ? { complexity } : {}) } });
const err = (message: string, extensions: Record<string, unknown> = {}) => json({ errors: [{ message, extensions }] });

export interface MondayDataset {
  tier: string | null;
  failUsers: boolean;
  /** The complexity left after each call (drives the client's pacing). */
  complexityAfter: number;
}
export const DATASET: MondayDataset = { tier: 'enterprise', failUsers: false, complexityAfter: 4_000_000 };

export function fakeMonday(data: MondayDataset = DATASET, opts: { intercept?: (query: string, variables: Record<string, any>) => Response | undefined } = {}) {
  const calls: Array<{ query: string; variables: Record<string, any>; headers: Record<string, string> }> = [];
  const fileCalls: Array<{ url: string; auth: string | null }> = [];
  let pageCalls = 0;
  /** Every first-page request starts a new cursor "epoch" (a new 60-minute life); a test expires an epoch to kill the cursors born in it. */
  let epochs = 0;
  const expired = new Set<number>();

  const slice = (items: MnItem[], offset: number, limit: number, light: boolean) => {
    const chunk = items.slice(offset, offset + limit).map((i) => (light ? { id: i.id } : i));
    return { chunk, more: offset + limit < items.length };
  };
  const cursorOf = (boardId: string, offset: number, epoch: number) => `cur:${boardId}:${offset}:${epoch}`;

  const fn = jest.fn(async (url: unknown, init?: RequestInit) => {
    const u = new URL(String(url));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (u.hostname !== 'api.monday.com') {
      if (u.hostname === 'auth.monday.com') {
        calls.push({ query: `AUTH ${u.pathname}`, variables: {}, headers });
        const raw = String(init?.body ?? '');
        const asJson = (headers['content-type'] ?? '').includes('json');
        const body = asJson ? (JSON.parse(raw) as Record<string, string>) : Object.fromEntries(new URLSearchParams(raw));
        (fn as any).lastAuthBody = { asJson, body, path: u.pathname };
        if (body.grant_type === 'refresh_token') return body.refresh_token === 'rt-ok' ? json({ access_token: 'new-access', refresh_token: 'rt-rotated', token_type: 'Bearer', scope: 'boards:read users:read' }) : json({ error: 'invalid_grant' }, 400);
        if (u.pathname.endsWith('/revoke')) return json({ success: true });
        if (u.pathname === '/oauth2/token') return json({ access_token: 'legacy-token', token_type: 'Bearer', scope: 'boards:write,boards:read' });
        const exp = Math.floor(Date.now() / 1000) + 86400;
        const jwt = `h.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.s`;
        return json({ access_token: jwt, refresh_token: 'rt-1', token_type: 'Bearer', scope: 'me:read boards:read' });
      }
      fileCalls.push({ url: String(url), auth: headers.authorization ?? null });
      const f = FILES[String(url)];
      if (!f) return new Response('gone', { status: 404 });
      return new Response(f.body, { status: 200, headers: { ...(f.contentType ? { 'content-type': f.contentType } : {}), 'content-length': String(Buffer.byteLength(f.body)) } });
    }

    const { query, variables = {} } = JSON.parse(String(init?.body ?? '{}')) as { query: string; variables?: Record<string, any> };
    calls.push({ query, variables, headers });
    const hijack = opts.intercept?.(query, variables);
    if (hijack) return hijack;
    if (!(headers.authorization === 'tok' || headers.authorization === 'legacy-token' || String(headers.authorization).startsWith('h.'))) return json({ errors: [{ message: 'Not Authenticated' }] }, 401);
    const cx = query.includes('complexity {') ? { query: 1000, before: data.complexityAfter + 1000, after: data.complexityAfter, reset_in_x_seconds: 42 } : undefined;

    if (/\bme \{/.test(query)) return ok({ me: { id: 1, name: 'Ana Lima', account: ACCOUNT } }, cx);
    if (/account \{ plan/.test(query)) return ok({ account: { plan: data.tier ? { tier: data.tier } : null } }, cx);
    if (/workspaces\(/.test(query)) return ok({ workspaces: Number(/page: (\d+)/.exec(query)![1]) === 1 ? [{ id: 'w1', name: 'Product' }, { id: null, name: 'Main workspace' }] : [] }, cx);
    if (/users\(/.test(query)) {
      if (data.failUsers) return err('forbidden', { status_code: 403, code: 'USER_UNAUTHORIZED' });
      return ok({ users: Number(/page: (\d+)/.exec(query)![1]) === 1 ? USERS : [] }, cx);
    }
    if (/boards\(limit: \d+, page: \d+/.test(query)) return ok({ boards: Number(/page: (\d+)/.exec(query)![1]) === 1 ? Object.values(BOARDS).map(({ items_count, description, url, ...b }) => ({ ...b, groups: (b.groups ?? []).map((g) => ({ id: g.id, title: g.title })) })) : [] }, cx);
    if (/boards\(ids: \$ids/.test(query)) {
      const all = Object.values(BOARDS);
      return ok({ boards: (variables.ids as string[]).map((id) => all.find((b) => String(b.id) === id)).filter(Boolean) }, cx);
    }
    if (/items_page\(/.test(query) || /next_items_page\(/.test(query)) {
      pageCalls++;
      const light = !/column_values/.test(query);
      const limit = Number(variables.limit ?? 100);
      let boardId: string;
      let offset: number;
      let epoch: number;
      if (/next_items_page\(/.test(query)) {
        const m = /^cur:(\d+):(\d+):(\d+)$/.exec(String(variables.cursor));
        if (!m) return err('Invalid cursor', { code: 'InvalidCursorException' });
        [boardId, offset, epoch] = [m[1], Number(m[2]), Number(m[3])];
        if (expired.has(epoch)) return err('The cursor is expired or invalid', { code: 'CursorExpiredError' });
      } else {
        boardId = String(variables.id?.[0]);
        offset = 0;
        epoch = ++epochs;
        if (!ITEMS[boardId] && !Object.values(BOARDS).some((b) => String(b.id) === boardId)) return ok({ boards: [] }, cx);
      }
      const { chunk, more } = slice(ITEMS[boardId] ?? [], offset, limit, light);
      const page = { cursor: more ? cursorOf(boardId, offset + limit, epoch) : null, items: chunk };
      return /next_items_page\(/.test(query) ? ok({ next_items_page: page }, cx) : ok({ boards: [{ items_page: page }] }, cx);
    }
    if (/items\(ids: \$ids/.test(query)) return ok({ items: (variables.ids as string[]).map((id) => EXTRAS[id] ?? { id, assets: [], updates: [] }) }, cx);
    if (/assets\(ids/.test(query)) return ok({ assets: (variables.ids as string[]).map((id) => ASSET_ANSWERS[id]).filter(Boolean) }, cx);
    return err(`unhandled query: ${query.slice(0, 80)}`, { status_code: 400 });
  });
  return { fetch: fn, calls, fileCalls, json, err, ok, expireEpoch: (n: number) => expired.add(n), get pageCalls() { return pageCalls; }, get epochs() { return epochs; } };
}
