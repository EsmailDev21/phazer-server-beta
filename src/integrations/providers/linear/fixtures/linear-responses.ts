import type { LinearComment, LinearHistoryNode, LinearLinkAttachment, LinearCycle, LinearIssue, LinearOrganization, LinearProject, LinearState, LinearTeam, LinearUser, LinearLabel } from '../linear.types';

/**
 * Step 4.5 fixtures. SYNTHETIC, like the 4.3 ones: modelled on Linear's documented GraphQL schema (field names, state types,
 * priority numbers, Relay connections), NOT recorded from a live workspace - the sandbox cannot reach Linear and no test
 * credentials were available. The first recording of real responses will replace or join these; `fakeLinear` serves any
 * dataset of this shape, so the specs run against recorded data unchanged.
 *
 * What the data is built to exercise: states with the SAME names in two teams but different ids; a disabled user, a bot
 * (`app`), a user with no e-mail; a cycle with no name; two Linear projects with names differing only by case; a sub-issue; an
 * archived issue; an issue with more labels than the first page of labels holds; `blocks` / `related` / `duplicate`
 * relations, one of them pointing at a team that is not selected; priorities 0..4.
 */

export const ORG: LinearOrganization = { id: 'org-1', name: 'Acme', urlKey: 'acme' };

export const USERS: LinearUser[] = [
  { id: 'u-ana', name: 'Ana Lima', displayName: 'ana', email: 'ana@example.com', active: true, app: false, avatarUrl: 'https://cdn.example/ana.png' },
  { id: 'u-ben', name: 'Ben Ortiz', displayName: 'ben', email: 'ben@example.com', active: true, app: false },
  { id: 'u-cy', name: 'Cy Old', displayName: 'cy', email: 'cy@example.com', active: false, app: false },
  { id: 'u-hidden', name: 'Hidden Mail', displayName: 'hm', email: null, active: true, app: false },
  { id: 'u-bot', name: 'Deploy Bot', displayName: 'deploybot', email: 'bot@example.com', active: true, app: true },
];

export const LABELS: LinearLabel[] = [
  { id: 'l-bug', name: 'Bug', color: '#eb5757' },
  { id: 'l-front', name: 'Frontend', color: '#4ea7fc' },
  { id: 'l-q3', name: 'Q3', color: '#bec2c8' },
];

export const TEAMS: LinearTeam[] = [
  { id: 'team-eng', key: 'ENG', name: 'Engineering', description: 'Product engineering' },
  { id: 'team-ops', key: 'OPS', name: 'Operations', description: null },
  { id: 'team-other', key: 'OTH', name: 'Other', description: null },
];

export const STATES: Record<string, LinearState[]> = {
  'team-eng': [
    { id: 's-eng-triage', name: 'Triage', type: 'triage', color: '#bec2c8', position: 0 },
    { id: 's-eng-backlog', name: 'Backlog', type: 'backlog', color: '#bec2c8', position: 1 },
    { id: 's-eng-todo', name: 'Todo', type: 'unstarted', color: '#e2e2e2', position: 2 },
    { id: 's-eng-prog', name: 'In Progress', type: 'started', color: '#f2c94c', position: 3 },
    { id: 's-eng-review', name: 'In Review', type: 'started', color: '#0f783c', position: 4 },
    { id: 's-eng-done', name: 'Done', type: 'completed', color: '#5e6ad2', position: 5 },
    { id: 's-eng-canceled', name: 'Canceled', type: 'canceled', color: '#95a2b3', position: 6 },
    { id: 's-eng-dup', name: 'Duplicate', type: 'canceled', color: '#95a2b3', position: 7 },
  ],
  // same names as Engineering, different ids: Linear scopes states per team
  'team-ops': [
    { id: 's-ops-backlog', name: 'Backlog', type: 'backlog', color: '#bec2c8', position: 0 },
    { id: 's-ops-todo', name: 'Todo', type: 'unstarted', color: '#e2e2e2', position: 1 },
    { id: 's-ops-prog', name: 'In Progress', type: 'started', color: '#f2c94c', position: 2 },
    { id: 's-ops-done', name: 'Done', type: 'completed', color: '#5e6ad2', position: 3 },
  ],
  'team-other': [{ id: 's-oth-todo', name: 'Todo', type: 'unstarted', color: '#e2e2e2', position: 0 }],
};

export const CYCLES: Record<string, LinearCycle[]> = {
  'team-eng': [
    { id: 'c-1', number: 1, name: 'Spring push', description: 'Ship the beta', startsAt: '2026-03-02T00:00:00.000Z', endsAt: '2026-03-16T00:00:00.000Z' },
    { id: 'c-2', number: 2, name: null, description: null, startsAt: '2026-03-16T00:00:00.000Z', endsAt: '2026-03-30T00:00:00.000Z' },
  ],
  'team-ops': [],
  'team-other': [],
};

export const PROJECTS: Record<string, LinearProject[]> = {
  'team-eng': [{ id: 'p-web', name: 'Web app' }, { id: 'p-api', name: 'Public API' }],
  'team-ops': [{ id: 'p-web2', name: 'web APP' }], // same name as ENG's, different case: one option
  'team-other': [],
};

const issue = (n: number, o: Partial<LinearIssue> & { teamId: string }): LinearIssue => {
  const { teamId, ...rest } = o;
  return {
    id: `i-${teamId.replace('team-', '')}-${n}`,
    identifier: `${teamId.replace('team-', '').toUpperCase()}-${n}`,
    url: `https://linear.app/acme/issue/${teamId.replace('team-', '').toUpperCase()}-${n}`,
    title: `Issue ${n}`,
    description: null,
    priority: 0,
    priorityLabel: 'No priority',
    estimate: null,
    dueDate: null,
    createdAt: '2026-02-01T10:00:00.000Z',
    updatedAt: '2026-02-02T10:00:00.000Z',
    archivedAt: null,
    state: { id: 's-eng-todo' },
    assignee: null,
    creator: null,
    parent: null,
    cycle: null,
    project: null,
    labels: { nodes: [], pageInfo: { hasNextPage: false } },
    relations: { nodes: [], pageInfo: { hasNextPage: false } },
    ...rest,
  };
};

const noMore = { hasNextPage: false };

export const ISSUES: Record<string, LinearIssue[]> = {
  'team-eng': [
    issue(1, {
      teamId: 'team-eng', title: 'Login fails on Safari', description: '## Steps\n\n1. Open **Safari**\n2. Sign in', priority: 1, priorityLabel: 'Urgent',
      state: { id: 's-eng-prog' }, assignee: { id: 'u-ana' }, creator: { id: 'u-ben' }, cycle: { id: 'c-1' }, project: { id: 'p-web', name: 'Web app' },
      estimate: 3, dueDate: '2026-03-10',
      labels: { nodes: [{ name: 'Bug' }, { name: 'Frontend' }], pageInfo: noMore },
      relations: {
        nodes: [
          { id: 'r-1', type: 'blocks', relatedIssue: { id: 'i-eng-2', team: { id: 'team-eng' } } },
          { id: 'r-2', type: 'related', relatedIssue: { id: 'i-eng-3', team: { id: 'team-eng' } } },
          { id: 'r-3', type: 'blocks', relatedIssue: { id: 'i-other-1', identifier: 'OTH-9', title: 'Other [team] thing', team: { id: 'team-other' } } }, // outside the selection
          { id: 'r-4', type: 'duplicate', relatedIssue: { id: 'i-eng-4', identifier: 'ENG-4', title: 'Duplicate of login bug', team: { id: 'team-eng' } } },
        ],
        pageInfo: noMore,
      },
    }),
    issue(2, { teamId: 'team-eng', title: 'Fix session cookie', priority: 2, priorityLabel: 'High', state: { id: 's-eng-review' }, parent: { id: 'i-eng-1' }, assignee: { id: 'u-ben' }, project: { id: 'p-web', name: 'Web app' } }),
    issue(3, { teamId: 'team-eng', title: 'Old design spike', priority: 4, priorityLabel: 'Low', state: { id: 's-eng-done' }, archivedAt: '2026-01-15T00:00:00.000Z', assignee: { id: 'u-cy' }, creator: { id: 'u-cy' } }),
    issue(4, { teamId: 'team-eng', title: 'Duplicate of login bug', state: { id: 's-eng-dup' } }),
    issue(5, { teamId: 'team-eng', title: 'Add pagination to /v1/items', priority: 3, priorityLabel: 'Medium', state: { id: 's-eng-backlog' }, project: { id: 'p-api', name: 'Public API' }, cycle: { id: 'c-2' }, estimate: 0.5 }),
    issue(6, {
      teamId: 'team-eng', title: 'Triage: odd crash report', state: { id: 's-eng-triage' }, assignee: { id: 'u-bot' },
      // 12 labels: 10 arrive with the issue, the rest through the follow-up query
      labels: { nodes: Array.from({ length: 10 }, (_, k) => ({ name: `tag-${k + 1}` })), pageInfo: { hasNextPage: true, endCursor: 'lbl-10' } },
    }),
    issue(7, { teamId: 'team-eng', title: '   ', state: { id: 's-eng-todo' } }), // blank title: the validator repairs it, the adapter must not
  ],
  'team-ops': [
    issue(1, { teamId: 'team-ops', title: 'Rotate certificates', state: { id: 's-ops-todo' }, priority: 2, priorityLabel: 'High', project: { id: 'p-web2', name: 'web APP' }, assignee: { id: 'u-hidden' } }),
    issue(2, {
      teamId: 'team-ops', title: 'Renew domain', state: { id: 's-ops-done' },
      relations: { nodes: [{ id: 'r-5', type: 'blocks', relatedIssue: { id: 'i-ops-1', team: { id: 'team-ops' } } }], pageInfo: noMore },
    }),
  ],
  'team-other': [issue(1, { teamId: 'team-other', title: 'Not selected', state: { id: 's-oth-todo' } })],
};

/** The extra labels / relations the follow-up queries return, keyed by issue id. */
export const EXTRA_LABELS: Record<string, LinearLabel[]> = { 'i-eng-6': [{ name: 'tag-11' }, { name: 'tag-12' }] };

/**
 * Step 4.6 content (SYNTHETIC, like everything here). Issue ENG-1 has: a comment with a reply, a comment by a bot, a comment by
 * a person with no account, MORE comments than the first page (so the follow-up query runs), a history record that changes state
 * AND assignee at once, two uploaded files (one in the description, one in a comment; the same file is pasted twice), and two
 * of Linear's own link attachments. ENG-2 has a comment written by a person who is matched to a member.
 */
export const FILE_A = 'https://uploads.linear.app/org-1/up-1/file-a';
export const FILE_B = 'https://uploads.linear.app/org-1/up-2/file-b';
export const FILE_EVIL = 'http://169.254.169.254/latest/meta-data/';

export const COMMENTS: Record<string, LinearComment[]> = {
  'i-eng-1': [
    { id: 'cm-1', body: 'I can reproduce this on Safari 17.', createdAt: '2026-02-01T11:00:00.000Z', updatedAt: '2026-02-01T11:00:00.000Z', editedAt: null, user: { id: 'u-ana', name: 'Ana Lima' }, parent: null },
    { id: 'cm-2', body: 'Same here.\n\n![screenshot.png](' + FILE_B + ')', createdAt: '2026-02-01T12:00:00.000Z', updatedAt: '2026-02-01T12:30:00.000Z', editedAt: '2026-02-01T12:30:00.000Z', user: { id: 'u-ben', name: 'Ben Ortiz' }, parent: { id: 'cm-1' } },
    { id: 'cm-3', body: 'Deployed a fix to staging.', createdAt: '2026-02-01T13:00:00.000Z', updatedAt: '2026-02-01T13:00:00.000Z', user: null, botActor: { name: 'Deploy Bot' }, parent: null },
    { id: 'cm-4', body: 'Customer says it started last week.', createdAt: '2026-02-01T14:00:00.000Z', updatedAt: '2026-02-01T14:00:00.000Z', user: { id: 'u-cy', name: 'Cy Old' }, parent: null },
    { id: 'cm-5', body: 'Following up.', createdAt: '2026-02-02T09:00:00.000Z', updatedAt: '2026-02-02T09:00:00.000Z', user: { id: 'u-ana', name: 'Ana Lima' }, parent: null },
  ],
  'i-eng-2': [{ id: 'cm-6', body: 'Cookie path looks wrong.', createdAt: '2026-02-01T10:30:00.000Z', updatedAt: '2026-02-01T10:30:00.000Z', user: { id: 'u-ben', name: 'Ben Ortiz' }, parent: null }],
};

export const HISTORY: Record<string, LinearHistoryNode[]> = {
  'i-eng-1': [
    { id: 'h-1', createdAt: '2026-02-01T10:05:00.000Z', actor: { id: 'u-ben' }, fromState: { name: 'Todo' }, toState: { name: 'In Progress' }, fromAssignee: null, toAssignee: { name: 'Ana Lima' } },
    { id: 'h-2', createdAt: '2026-02-01T10:10:00.000Z', actor: { id: 'u-ana' }, fromPriority: 0, toPriority: 1, addedLabels: [{ name: 'Bug' }, { name: 'Frontend' }] },
    { id: 'h-3', createdAt: '2026-02-01T10:20:00.000Z', actor: null, updatedDescription: true },
    { id: 'h-4', createdAt: '2026-02-01T10:30:00.000Z', actor: { id: 'u-cy' }, fromEstimate: null, toEstimate: 3, fromCycle: null, toCycle: { name: 'Spring push', number: 1 } },
  ],
};

export const LINKS: Record<string, LinearLinkAttachment[]> = {
  'i-eng-1': [
    { id: 'lk-1', title: 'Fix Safari cookies [WIP]', subtitle: 'acme/web#412', url: 'https://github.com/acme/web/pull/412' },
    { id: 'lk-2', title: 'Slack thread', subtitle: null, url: 'javascript:alert(1)' },
    { id: 'lk-3', title: 'Design', subtitle: null, url: 'https://www.figma.com/file/abc' },
  ],
};

/** The bytes `uploads.linear.app` serves, by URL (see fakeLinear `files`). */
export const FILES: Record<string, { body: string; contentType?: string; status?: number }> = {
  [FILE_A]: { body: 'AAAA-file-a-bytes', contentType: 'image/png' },
  [FILE_B]: { body: 'BBBB-file-b-bytes', contentType: 'application/pdf' },
};

export interface LinearDataset {
  org: LinearOrganization;
  users: LinearUser[];
  labels: LinearLabel[];
  teams: LinearTeam[];
  states: Record<string, LinearState[]>;
  cycles: Record<string, LinearCycle[]>;
  projects: Record<string, LinearProject[]>;
  issues: Record<string, LinearIssue[]>;
  extraLabels: Record<string, LinearLabel[]>;
  extraRelations: Record<string, NonNullable<NonNullable<LinearIssue['relations']>['nodes']>>;
  /** Step 4.6; absent = the dataset has none. Keyed by issue id. The issue page serves the first `nested` of each. */
  comments?: Record<string, LinearComment[]>;
  history?: Record<string, LinearHistoryNode[]>;
  links?: Record<string, LinearLinkAttachment[]>;
  files?: Record<string, { body: string; contentType?: string; status?: number }>;
}

export const DATASET: LinearDataset = {
  org: ORG, users: USERS, labels: LABELS, teams: TEAMS, states: STATES, cycles: CYCLES, projects: PROJECTS, issues: ISSUES,
  extraLabels: EXTRA_LABELS, extraRelations: {},
};

/** DATASET plus the step 4.6 content (kept apart so the 4.5 specs and their expectations stay as they were). */
export const CONTENT_DATASET: LinearDataset = {
  ...DATASET,
  issues: {
    ...DATASET.issues,
    'team-eng': DATASET.issues['team-eng'].map((i) =>
      i.id === 'i-eng-1' ? { ...i, description: `${i.description}\n\n![login.png](${FILE_A})\n\nAgain: ![login again](${FILE_A})\n\n![evil](${FILE_EVIL})` } : i,
    ),
  },
  comments: COMMENTS,
  history: HISTORY,
  links: LINKS,
  files: FILES,
};

export interface FakeOptions {
  /** Nodes per Relay page (default 2: small, so every list pages). */
  pageSize?: number;
  /** Nested comments / history / links per issue on an issue page (default 3: small, so the follow-up queries run). */
  nested?: number;
  /** Called with (operation, variables) before answering; may return a Response to replace the answer. */
  intercept?: (op: string, vars: Record<string, unknown>) => Response | undefined;
}

const json = (o: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', ...headers } });

/** Relay-style paging over an array: cursor = "c<offset>". */
function conn<T>(all: T[], vars: Record<string, unknown>, size: number) {
  const start = typeof vars.after === 'string' ? Number(String(vars.after).slice(1)) : 0;
  const nodes = all.slice(start, start + size);
  const end = start + nodes.length;
  return { nodes, pageInfo: { hasNextPage: end < all.length, endCursor: end < all.length ? `c${end}` : null } };
}

/**
 * A fetch that behaves like Linear's /graphql for the operations the adapter sends (matched by operation name). Every list
 * is served in pages of `pageSize` so pagination is always exercised. `calls` records (op, vars) for assertions.
 */
export function fakeLinear(data: LinearDataset = DATASET, opts: FakeOptions = {}) {
  const calls: Array<{ op: string; vars: Record<string, unknown>; auth: string | null }> = [];
  const size = opts.pageSize ?? 2;
  const nested = opts.nested ?? 3;
  const fileCalls: Array<{ url: string; auth: string | null }> = [];
  const fn = jest.fn(async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith('https://uploads.linear.app/')) {
      fileCalls.push({ url: u, auth: (init?.headers as Record<string, string>)?.authorization ?? null });
      const f = data.files?.[u];
      if (!f) return new Response('gone', { status: 404 });
      return new Response(f.body, { status: f.status ?? 200, headers: { ...(f.contentType ? { 'content-type': f.contentType } : {}), 'content-length': String(Buffer.byteLength(f.body)) } });
    }
    if (!u.endsWith('/graphql')) return json({ error: 'not found' }, 404);
    const body = JSON.parse(String(init?.body));
    const op = /query\s+(\w+)/.exec(body.query)?.[1] ?? '';
    const vars: Record<string, unknown> = body.variables ?? {};
    calls.push({ op, vars, auth: (init?.headers as Record<string, string>)?.authorization ?? null });
    const hijacked = opts.intercept?.(op, vars);
    if (hijacked) return hijacked;

    const team = data.teams.find((t) => t.id === vars.id);
    const ok = (d: unknown) => json({ data: d });
    switch (op) {
      case 'LinearOrganization': return ok({ organization: data.org });
      case 'LinearTeams': return ok({ teams: conn(data.teams.map(({ id, key, name }) => ({ id, key, name })), vars, size) });
      case 'LinearTeam': return ok({ team: team ?? null });
      case 'LinearTeamStates': return ok({ team: team ? { states: conn(data.states[team.id] ?? [], vars, size) } : null });
      case 'LinearTeamCycles': return ok({ team: team ? { cycles: conn(data.cycles[team.id] ?? [], vars, size) } : null });
      case 'LinearTeamProjects': return ok({ team: team ? { projects: conn(data.projects[team.id] ?? [], vars, size) } : null });
      case 'LinearUsers': return ok({ users: conn(data.users, vars, size) });
      case 'LinearLabels': return ok({ issueLabels: conn(data.labels, vars, size) });
      case 'LinearTeamIssueIds': return ok({ team: team ? { issues: conn((data.issues[team.id] ?? []).map((i) => ({ id: i.id })), vars, 250) } : null });
      case 'LinearTeamIssues': {
        const wantsComments = /\bcomments\(first/.test(body.query);
        const wantsHistory = /\bhistory\(first/.test(body.query);
        const wantsLinks = /\battachments\(first/.test(body.query);
        const page = conn(data.issues[team?.id ?? ''] ?? [], vars, size);
        const withContent = page.nodes.map((i) => {
          const out: LinearIssue = { ...i };
          const nest = <T,>(all: T[] | undefined) => {
            const list = all ?? [];
            return { nodes: list.slice(0, nested), pageInfo: { hasNextPage: list.length > nested, endCursor: list.length > nested ? `c${nested}` : null } };
          };
          if (wantsComments) out.comments = nest(data.comments?.[i.id]);
          if (wantsHistory) out.history = nest(data.history?.[i.id]);
          if (wantsLinks) out.attachments = nest(data.links?.[i.id]);
          return out;
        });
        return ok({ team: team ? { issues: { nodes: withContent, pageInfo: page.pageInfo } } : null });
      }
      case 'LinearIssueComments': return ok({ issue: { comments: conn(data.comments?.[String(vars.id)] ?? [], vars, size) } });
      case 'LinearIssueHistory': return ok({ issue: { history: conn(data.history?.[String(vars.id)] ?? [], vars, size) } });
      case 'LinearIssueLinks': return ok({ issue: { attachments: conn(data.links?.[String(vars.id)] ?? [], vars, size) } });
      case 'LinearIssueLabels': return ok({ issue: { labels: conn(data.extraLabels[String(vars.id)] ?? [], vars, size) } });
      case 'LinearIssueRelations': return ok({ issue: { relations: conn(data.extraRelations[String(vars.id)] ?? [], vars, size) } });
      default: return json({ errors: [{ message: `unknown operation ${op}` }] }, 400);
    }
  });
  return { fetch: fn, calls, fileCalls, json };
}
