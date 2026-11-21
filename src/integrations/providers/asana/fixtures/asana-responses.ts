/**
 * SYNTHETIC Asana API 1.0 responses (no live workspace was called; shapes follow Asana's public docs, ADR-0039). The person is Ana (u1).
 *   Workspace w1 "Acme" (organization): team t1 "Engineering" with project "Sprint Board" (p1: sections Backlog / In progress / Done) and
 *     "Bugs" (p2: one section, 101 tasks so a 2nd page is served); a team-less project "Loose" (p3: NO sections).
 *   Workspace w2 "Personal": project "Home" (p4, archived projects are not listed).
 * Sprint Board has: 1001 (assigned, tagged, High priority, 2 subtasks, depends on 1002), 1002 (a milestone), 1003 (completed, sits in
 * "In progress"), 1004 (ALSO in Bugs: the multi-project case). Subtask 2002 is completed and has a sub-subtask 3001.
 */
import type { AsAttachment, AsCustomField, AsProject, AsSection, AsStory, AsTask } from '../asana.types';

export const ME = 'u1';
export const DL_ASANA = 'https://app.asana.com/app/asana/-/get_asset?asset_id=111';
export const DL_STORAGE = 'https://asana-user-private-us-east-1.s3.amazonaws.com/x/design.png?X-Amz-Signature=abc';
export const DL_EVIL = 'https://169.254.169.254/latest/meta-data/x.png';
export const DL_LOOKALIKE = 'https://app.asana.com.evil.example/x.png';
export const DL_BAD_BUCKET = 'https://evil-bucket.s3.amazonaws.com/x.png';

const U = {
  ana: { gid: 'u1', name: 'Ana Lima', email: 'ana@example.com' },
  ben: { gid: 'u2', name: 'Ben Ortiz', email: 'ben@example.com' },
  cy: { gid: 'u3', name: 'Cy Old' },
};

export const WORKSPACES = [{ gid: 'w1', name: 'Acme' }, { gid: 'w2', name: 'Personal' }];

export const PROJECTS: Record<string, AsProject & { workspace: { gid: string } }> = {
  p1: { gid: 'p1', name: 'Sprint Board', archived: false, notes: 'The board for Q3.', permalink_url: 'https://app.asana.com/0/p1', created_at: '2026-01-01T00:00:00.000Z', team: { gid: 't1', name: 'Engineering' }, workspace: { gid: 'w1' } },
  p2: { gid: 'p2', name: 'Bugs', archived: false, permalink_url: 'https://app.asana.com/0/p2', team: { gid: 't1', name: 'Engineering' }, workspace: { gid: 'w1' } },
  p3: { gid: 'p3', name: 'Loose', archived: true, permalink_url: 'https://app.asana.com/0/p3', workspace: { gid: 'w1' } },
  p4: { gid: 'p4', name: 'Home', archived: false, workspace: { gid: 'w2' } },
};

export const SECTIONS: Record<string, AsSection[]> = {
  p1: [{ gid: 's1', name: 'Backlog' }, { gid: 's2', name: 'In progress' }, { gid: 's3', name: 'Done' }],
  p2: [{ gid: 's4', name: 'Open' }],
  p3: [],
  p4: [{ gid: 's5', name: '' }],
};

const PRIORITY: AsCustomField = { gid: 'cf-prio', name: 'Priority', resource_subtype: 'enum', enum_options: [{ gid: 'o1', name: 'Low', enabled: true }, { gid: 'o2', name: 'Medium', enabled: true }, { gid: 'o3', name: 'High', enabled: true }, { gid: 'o4', name: 'Old', enabled: false }] };
const ENV: AsCustomField = { gid: 'cf-env', name: 'Environment', resource_subtype: 'enum', enum_options: [{ gid: 'e1', name: 'staging', enabled: true }, { gid: 'e2', name: 'production', enabled: true }] };
const EFFORT: AsCustomField = { gid: 'cf-effort', name: 'Effort', resource_subtype: 'number' };
const OWNER: AsCustomField = { gid: 'cf-owner', name: 'Owner', resource_subtype: 'people' };
const CALC: AsCustomField = { gid: 'cf-calc', name: 'Calc', resource_subtype: 'number', is_formula_field: true };
const REF: AsCustomField = { gid: 'cf-ref', name: 'Related', resource_subtype: 'reference' };

export const FIELD_SETTINGS: Record<string, Array<{ custom_field: AsCustomField }>> = {
  p1: [PRIORITY, ENV, EFFORT, OWNER, CALC, REF].map((custom_field) => ({ custom_field })),
  p2: [ENV].map((custom_field) => ({ custom_field })),
};

const mk = (gid: string, name: string, extra: Partial<AsTask> = {}): AsTask => ({
  gid, name, resource_subtype: 'default_task', completed: false, created_at: '2026-01-01T10:00:00.000Z', modified_at: '2026-01-02T10:00:00.000Z',
  permalink_url: `https://app.asana.com/0/p1/${gid}`, created_by: { gid: 'u1' }, tags: [], num_subtasks: 0, ...extra,
});
const inSection = (project: string, section: string, sectionName: string) => ({ project: { gid: project }, section: { gid: section, name: sectionName } });

const T1001 = mk('1001', 'Design the login page', {
  html_notes: '<body><strong>Goal</strong>: ship it.<ul><li>fast</li></ul></body>', notes: 'Goal: ship it.', assignee: { gid: 'u2' }, due_on: '2026-03-01', start_at: '2026-02-01T09:00:00.000Z',
  tags: [{ gid: 'g1', name: 'frontend', color: 'red' }, { gid: 'g2', name: 'ui' }], num_subtasks: 2, dependencies: [{ gid: '1002' }, { gid: 'gone' }],
  memberships: [inSection('p1', 's2', 'In progress')],
  custom_fields: [
    { ...PRIORITY, enum_value: { gid: 'o3', name: 'High' } },
    { ...ENV, enum_value: { gid: 'e2', name: 'production' } },
    { ...EFFORT, number_value: 5 },
    { ...OWNER, people_value: [{ gid: 'u3' }] },
    { ...CALC, number_value: 7 },
    { gid: 'cf-empty', name: 'Unset', resource_subtype: 'text', text_value: null },
  ],
});
const T1002 = mk('1002', 'Ship the login page', { resource_subtype: 'milestone', memberships: [inSection('p1', 's1', 'Backlog')], due_on: '2026-04-01' });
const T1003 = mk('1003', 'Old finished thing', { completed: true, completed_at: '2026-02-02T00:00:00.000Z', memberships: [inSection('p1', 's2', 'In progress')] });
const T1004 = mk('1004', 'Shared between boards', { memberships: [inSection('p1', 's1', 'Backlog'), inSection('p2', 's4', 'Open')], dependencies: [{ gid: '1002' }] });

export const SPRINT_TASKS: AsTask[] = [T1001, T1002, T1003, T1004];
export const BUG_TASKS: AsTask[] = [T1004, ...Array.from({ length: 100 }, (_, i) => mk(`b${i}`, `Bug ${i}`, { memberships: [inSection('p2', 's4', 'Open')] }))];
export const LOOSE_TASKS: AsTask[] = [mk('l1', 'No section here', { memberships: [{ project: { gid: 'p3' } }] })];

export const SUBTASKS: Record<string, AsTask[]> = {
  '1001': [mk('2001', 'Wireframe', { parent: { gid: '1001' }, assignee: { gid: 'u1' } }), mk('2002', 'Review', { parent: { gid: '1001' }, completed: true, num_subtasks: 1 })],
  '2002': [mk('3001', 'Nitpicks', { parent: { gid: '2002' } })],
  '1004': [mk('2004', 'Subtask of the shared one', { parent: { gid: '1004' } })],
};
SPRINT_TASKS[3].num_subtasks = 1;

const story = (gid: string, subtype: string, text: string, at: string, by = U.ben): AsStory => ({ gid, type: subtype === 'comment_added' ? 'comment' : 'system', resource_subtype: subtype, text, created_at: at, created_by: { gid: by.gid, name: by.name } });
export const STORIES: Record<string, AsStory[]> = {
  '1001': [
    story('c2', 'comment_added', 'Second comment', '2026-01-04T00:00:00.000Z', U.ana),
    story('sys1', 'assigned', 'Ben assigned to Ben', '2026-01-02T00:00:00.000Z'),
    { ...story('c1', 'comment_added', 'plain', '2026-01-03T00:00:00.000Z'), html_text: '<body>See <a href="https://example.com/x">the spec</a></body>' },
    story('sys2', 'marked_complete', 'Ben marked this complete', '2026-01-05T00:00:00.000Z'),
  ],
};

export const ATTACHMENTS: Record<string, AsAttachment[]> = {
  '1001': [
    { gid: '9001', name: 'design.png', host: 'asana', resource_subtype: 'asana', size: 2048, created_at: '2026-01-03T00:00:00.000Z' },
    { gid: '9002', name: 'Spec on Drive', host: 'gdrive', resource_subtype: 'gdrive' },
    { gid: '9003', name: '../../etc/passwd', host: 'asana', size: 10 },
  ],
};
/** What `GET /attachments/{gid}` answers (download addresses are fetched per file, right before the copy). */
export const ATTACHMENT_META: Record<string, AsAttachment> = {
  '9001': { gid: '9001', host: 'asana', resource_subtype: 'asana', download_url: DL_ASANA },
  '9003': { gid: '9003', host: 'asana', download_url: DL_STORAGE },
  '9004': { gid: '9004', host: 'asana', download_url: DL_EVIL },
  '9005': { gid: '9005', host: 'asana', download_url: DL_LOOKALIKE },
  '9006': { gid: '9006', host: 'asana', download_url: DL_BAD_BUCKET },
  '9007': { gid: '9007', host: 'gdrive', resource_subtype: 'gdrive' },
  '9008': { gid: '9008', host: 'asana', download_url: 'http://app.asana.com/insecure' },
};
export const FILES: Record<string, { body: string; status?: number; contentType?: string }> = {
  [DL_ASANA]: { body: 'PNGDATA', contentType: 'image/png' },
  [DL_STORAGE]: { body: 'S3DATA', contentType: 'image/png' },
  [DL_EVIL]: { body: 'SECRET' },
  [DL_LOOKALIKE]: { body: 'LOOK' },
  [DL_BAD_BUCKET]: { body: 'BAD' },
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const page = <T>(all: T[], offset: string | null, path: string, limit = 100) => {
  const from = offset ? Number(offset.replace('off-', '')) : 0;
  const slice = all.slice(from, from + limit);
  const more = from + limit < all.length;
  return json({ data: slice, next_page: more ? { offset: `off-${from + limit}`, path, uri: `https://app.asana.com/api/1.0${path}` } : null });
};

export interface AsanaDataset {
  tokenOk: boolean;
  /** `GET /projects/{gid}/sections` answers 403 (the scope gap). */
  failSections: boolean;
  failFields: boolean;
  failUsers: boolean;
}
export const DATASET: AsanaDataset = { tokenOk: true, failSections: false, failFields: false, failUsers: false };

export function fakeAsana(data: AsanaDataset = DATASET, opts: { intercept?: (path: string) => Response | undefined; files?: typeof FILES } = {}) {
  const calls: string[] = [];
  const fileCalls: Array<{ url: string; auth: string | null }> = [];
  const files = opts.files ?? FILES;
  const fn = jest.fn(async (url: unknown, init?: RequestInit) => {
    const u = new URL(String(url));
    const auth = ((init?.headers ?? {}) as Record<string, string>).authorization ?? null;
    if (u.hostname !== 'app.asana.com' || !u.pathname.startsWith('/api/1.0')) {
      if (u.pathname.startsWith('/-/oauth')) {
        calls.push(`${init?.method ?? 'GET'} ${u.pathname}`);
        const body = new URLSearchParams(String(init?.body ?? ''));
        if (u.pathname === '/-/oauth_token' && body.get('grant_type') === 'refresh_token') return body.get('refresh_token') === 'rt-ok' ? json({ access_token: 'newtok', expires_in: 3600, token_type: 'bearer' }) : json({ error: 'invalid_grant' }, 400);
        if (u.pathname === '/-/oauth_token') return data.tokenOk ? json({ access_token: 'newtok', refresh_token: 'rt-1', expires_in: 3600, token_type: 'bearer', data: { id: 1, gid: 'u1', name: 'Ana Lima', email: 'ana@example.com' } }) : json({ error: 'invalid_grant' }, 400);
        if (u.pathname === '/-/oauth_revoke') return json({});
      }
      fileCalls.push({ url: String(url), auth });
      const f = files[String(url)];
      if (!f) return new Response('gone', { status: 404 });
      return new Response(f.body, { status: f.status ?? 200, headers: { ...(f.contentType ? { 'content-type': f.contentType } : {}), 'content-length': String(Buffer.byteLength(f.body)) } });
    }
    const path = u.pathname.replace(/^\/api\/1\.0/, '');
    const q = u.searchParams;
    calls.push(`${init?.method ?? 'GET'} ${path}${u.search}`);
    const hijack = opts.intercept?.(path);
    if (hijack) return hijack;
    if (auth !== 'Bearer tok') return json({ errors: [{ message: 'The bearer token has expired.' }] }, 401);

    if (path === '/workspaces') return page(WORKSPACES, q.get('offset'), path);
    let m = /^\/workspaces\/([^/]+)\/projects$/.exec(path);
    if (m) return page(Object.values(PROJECTS).filter((p) => p.workspace.gid === m![1] && !p.archived).map(({ gid, name, team }) => ({ gid, name, team })), q.get('offset'), path);
    m = /^\/workspaces\/([^/]+)\/users$/.exec(path);
    if (m) return data.failUsers ? json({ errors: [{ message: 'forbidden' }] }, 403) : page(m[1] === 'w1' ? [U.ana, U.ben, U.cy] : [U.ana], q.get('offset'), path);
    m = /^\/teams\/([^/]+)\/projects$/.exec(path);
    if (m) return page(Object.values(PROJECTS).filter((p) => p.team?.gid === m![1]).map(({ gid, name }) => ({ gid, name })), q.get('offset'), path);
    m = /^\/projects\/([^/]+)$/.exec(path);
    if (m) return PROJECTS[m[1]] ? json({ data: PROJECTS[m[1]] }) : json({ errors: [{ message: 'project: Not a recognized ID' }] }, 404);
    m = /^\/projects\/([^/]+)\/sections$/.exec(path);
    if (m) return data.failSections ? json({ errors: [{ message: 'forbidden' }] }, 403) : page(SECTIONS[m[1]] ?? [], q.get('offset'), path);
    m = /^\/projects\/([^/]+)\/custom_field_settings$/.exec(path);
    if (m) return data.failFields ? json({ errors: [{ message: 'forbidden' }] }, 403) : page(FIELD_SETTINGS[m[1]] ?? [], q.get('offset'), path);
    m = /^\/projects\/([^/]+)\/task_counts$/.exec(path);
    if (m) return json({ data: { num_tasks: ({ p1: 4, p2: 101, p3: 1, p4: 0 } as Record<string, number>)[m[1]] ?? 0 } });
    m = /^\/projects\/([^/]+)\/tasks$/.exec(path);
    if (m) return page(m[1] === 'p1' ? SPRINT_TASKS : m[1] === 'p2' ? BUG_TASKS : m[1] === 'p3' ? LOOSE_TASKS : [], q.get('offset'), path, Number(q.get('limit') ?? 100));
    m = /^\/tasks\/([^/]+)\/subtasks$/.exec(path);
    if (m) return page(SUBTASKS[m[1]] ?? [], q.get('offset'), path);
    m = /^\/tasks\/([^/]+)\/stories$/.exec(path);
    if (m) return page(STORIES[m[1]] ?? [], q.get('offset'), path);
    if (path === '/attachments') return page(ATTACHMENTS[q.get('parent') ?? ''] ?? [], q.get('offset'), path);
    m = /^\/attachments\/([^/]+)$/.exec(path);
    if (m) return ATTACHMENT_META[m[1]] ? json({ data: ATTACHMENT_META[m[1]] }) : json({ errors: [{ message: 'attachment: Not a recognized ID' }] }, 404);
    return json({ errors: [{ message: `not found: ${path}` }] }, 404);
  });
  return { fetch: fn, calls, fileCalls, json };
}
