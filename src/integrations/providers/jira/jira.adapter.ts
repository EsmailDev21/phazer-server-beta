import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FieldType, IntegrationProvider } from '@prisma/client';
import { CanonicalBundle, CanonicalCustomField, CanonicalIteration, CanonicalUser, validateBundle } from '../../../imports/canonical';
import { FetchAttachmentInput, FetchBundleInput, FetchBundleResult, FetchedAttachment, ImportAdapterContext, ImportCapableAdapter } from '../../../imports/import-adapter';
import { ImportEstimate, ImportOptions, ImportSelection, SourceTree } from '../../../imports/imports.types';
import { buildInventory } from '../../../imports/mapping/mapping.inventory';
import { priorityKey } from '../../../imports/mapping/mapping.tables';
import { AuthorizeContext, CallbackParams, Capability, ExchangeContext, ExternalAccount, ProviderAuthRejectedError, ProviderHttpError, TokenSet } from '../../core/integration.types';
import { ProviderHttpClient } from '../../core/provider-http.client';
import { ATLASSIAN_API, JiraCallContext, JiraClient } from './jira.client';
import {
  emptyPage, fieldKind, inSelectionOf, JIRA_SYSTEM, toCustomField, toIssueType, toProject, toSprint, toTask, toUser, toVersion, toDependencies, TIME_FIELDS,
} from './jira.normalize';
import { JiraComment, JiraFieldDef, JiraHistory, JiraIssue, JiraIssueType, JiraProject, JiraResource, JiraSprint, JiraStatus, JiraUser, JiraVersion } from './jira.types';

const AUTHORIZE_URL = 'https://auth.atlassian.com/authorize';
const TOKEN_URL = 'https://auth.atlassian.com/oauth/token';
const RESOURCES_URL = `${ATLASSIAN_API}/oauth/token/accessible-resources`;
/** Classic scopes: Atlassian's recommendation for Jira; read-only. `offline_access` yields the (rotating) refresh token. */
const SCOPES = 'read:jira-work read:jira-user offline_access';

const PAGE = 50;
const PAGE_WITH_HISTORY = 25;
const MAX_USERS = 2000;
const MAX_SPRINTS = 200;
const MAX_NESTED_PAGES = 100;
const MAX_FIELDS = 100;

interface JiraCursor {
  v: 1;
  /** Selected project ids, sorted, and their keys (parallel): a link to any other key is outside the import. */
  projects: string[];
  keys: string[];
  i: number;
  /** Jira's nextPageToken within the current project; null = first page. */
  token: string | null;
  /** The site's base URL (for issue links), read once on the structure page. */
  base: string;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

/**
 * Jira Cloud (step 4.8, ADR-0037): OAuth 2.0 (3LO) with rotating refresh tokens + the import capability.
 *
 * Mapping (diagrams 06 / 07): project -> project; issue -> task; sub-task and epic child -> parent; issue type -> issue type (EPIC /
 * STANDARD / SUBTASK by hierarchy); status + status category -> workflow status per project; priority -> priority; sprint -> sprint
 * iteration, fix version -> milestone iteration (a task has one iteration: its sprint, else its first release); labels and components
 * -> tags; custom fields -> best-match fields (selects arrive as text); story points -> estimate; time tracking -> two number
 * fields; assignee / reporter -> assignee / creator; issue links -> BLOCKS / RELATES_TO (+ text for what a link cannot say); ADF
 * comments and descriptions -> markdown; attachments -> files; the changelog -> history.
 * NOT imported: workflow transitions and post-functions, worklogs, boards / filters / dashboards, automation rules, watchers, votes.
 *
 * Written against Atlassian's public documentation; tested against SYNTHETIC responses. No live Jira site was called.
 */
@Injectable()
export class JiraAdapter implements ImportCapableAdapter {
  readonly provider = IntegrationProvider.JIRA;
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>(['IMPORT']);
  readonly usesPkce = false;

  constructor(private readonly config: ConfigService, private readonly http: ProviderHttpClient, private readonly api: JiraClient) {}

  // ------------------------------------------------------------------------------------------------ OAuth

  isConfigured(): boolean {
    return !!this.config.get('JIRA_CLIENT_ID') && !!this.config.get('JIRA_CLIENT_SECRET');
  }

  authorizeUrl(ctx: AuthorizeContext): string {
    const u = new URL(AUTHORIZE_URL);
    u.searchParams.set('audience', 'api.atlassian.com');
    u.searchParams.set('client_id', this.config.get<string>('JIRA_CLIENT_ID')!);
    u.searchParams.set('scope', SCOPES);
    u.searchParams.set('redirect_uri', ctx.redirectUri);
    u.searchParams.set('state', ctx.state);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('prompt', 'consent');
    return u.toString();
  }

  private async tokenCall(body: Record<string, string>): Promise<TokenResponse & { status: number }> {
    const res = await this.http.request({
      rateKey: 'oauth:JIRA',
      url: TOKEN_URL,
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ ...body, client_id: this.config.get<string>('JIRA_CLIENT_ID'), client_secret: this.config.get<string>('JIRA_CLIENT_SECRET') }) as never,
    });
    let parsed: TokenResponse = {};
    try {
      parsed = res.json<TokenResponse>();
    } catch {
      /* status decides */
    }
    return { ...parsed, status: res.status };
  }

  private toTokenSet(r: TokenResponse, previousRefresh?: string): TokenSet {
    return {
      accessToken: r.access_token!,
      // ROTATING: the response's refresh token replaces the stored one; the old one is dead. Keep the old only if none came.
      refreshToken: r.refresh_token ?? previousRefresh,
      expiresAt: typeof r.expires_in === 'number' ? new Date(Date.now() + r.expires_in * 1000) : undefined,
      scopes: (r.scope ?? '').split(/\s+/).filter(Boolean),
      tokenType: r.token_type ?? 'Bearer',
    };
  }

  async exchangeCode(params: CallbackParams, ctx: ExchangeContext): Promise<{ tokens: TokenSet; account: ExternalAccount }> {
    if (!params.code) throw new Error('Jira callback without code');
    const r = await this.tokenCall({ grant_type: 'authorization_code', code: params.code, redirect_uri: ctx.redirectUri });
    if (r.status < 200 || r.status >= 300 || !r.access_token) throw new Error(`Atlassian token endpoint: HTTP ${r.status}${r.error ? ` ${r.error}` : ''}`);
    const tokens = this.toTokenSet(r);

    // The grant can cover several sites (and Confluence-only ones). A connection is one Jira site: never guess between them.
    const res = await this.http.request({ rateKey: 'oauth:JIRA', url: RESOURCES_URL, headers: { authorization: `Bearer ${tokens.accessToken}`, accept: 'application/json' } });
    if (!res.ok) throw new Error(`Atlassian accessible-resources: HTTP ${res.status}`);
    const sites = (res.json<JiraResource[]>() ?? []).filter((s) => !s.scopes || s.scopes.length === 0 || s.scopes.some((x) => x.includes('jira')));
    if (sites.length === 0) throw new Error('Atlassian authorized no Jira site; connect again and select one on the consent screen');
    if (sites.length > 1) throw new Error('You authorized several Jira sites; connect again and select exactly one');
    return { tokens, account: { id: sites[0].id, name: (sites[0].name ?? '').toString() || sites[0].id } };
  }

  /** A rotating refresh token is single-use: the CALLER (CredentialService) serializes refreshes under the per-connection lock. */
  async refresh(tokens: TokenSet): Promise<TokenSet> {
    if (!tokens.refreshToken) throw new ProviderAuthRejectedError('This Jira connection has no refresh token; reconnect it');
    const r = await this.tokenCall({ grant_type: 'refresh_token', refresh_token: tokens.refreshToken });
    if (r.status === 400 || r.status === 401 || r.status === 403) throw new ProviderAuthRejectedError(`Atlassian rejected the refresh token (${r.error ?? r.status})`);
    if (r.status < 200 || r.status >= 300 || !r.access_token) throw new ProviderHttpError(r.status, TOKEN_URL, r.error_description ?? r.error ?? '');
    return this.toTokenSet(r, tokens.refreshToken);
  }

  /** Atlassian has no revocation endpoint for 3LO grants; the person removes the app in their Atlassian account. */
  async revoke(_tokens: TokenSet, _account: ExternalAccount): Promise<void> {
    return;
  }

  // ------------------------------------------------------------------------------------------------ import: discover / estimate

  private call(ctx: ImportAdapterContext): JiraCallContext {
    return { cloudId: ctx.externalAccountId, accessToken: ctx.accessToken, connectionId: ctx.connectionId };
  }

  async discover(ctx: ImportAdapterContext): Promise<SourceTree> {
    const c = this.call(ctx);
    const projects = await this.api.paged<JiraProject>(c, '/rest/api/3/project/search', { orderBy: 'name' }, 'values', 2000);
    return { nodes: projects.map((p) => ({ id: String(p.id), type: 'project', name: `${(p.name ?? '').toString() || p.key} (${p.key})`, parentId: null, selectable: true })) };
  }

  async estimate(ctx: ImportAdapterContext, selection: ImportSelection, options: ImportOptions): Promise<ImportEstimate> {
    const c = this.call(ctx);
    const warnings: NonNullable<ImportEstimate['warnings']> = [];
    const ids = this.projectIds(selection);
    const s = await this.structurePage(c, ids, warnings);
    const checked = validateBundle(s.page);
    if ('fatal' in checked) throw new Error(`Jira structure page rejected: ${checked.fatal.code} ${checked.fatal.message}`);

    const projects: ImportEstimate['projects'] = [];
    for (const p of s.projects) {
      const count = await this.api
        .post<{ count?: number }>(c, '/rest/api/3/search/approximate-count', { jql: `project = ${p.id}` })
        .then((r) => r.count ?? 0)
        .catch(() => {
          warnings.push({ code: 'COUNT_UNAVAILABLE', message: `The number of issues of ${p.name} could not be read.` });
          return 0;
        });
      projects.push({ sourceId: String(p.id), name: (p.name ?? '').toString() || p.key, tasks: count });
    }

    const catalog = await this.fieldCatalog(c);
    const skipped = catalog.skipped.filter((n) => !IGNORED_FIELD_NAMES.has(n.toLowerCase()));
    if (skipped.length) warnings.push({ code: 'CUSTOM_FIELDS_SKIPPED', message: `Some Jira custom fields have no equivalent and are not imported: ${skipped.slice(0, 15).join(', ')}${skipped.length > 15 ? `, and ${skipped.length - 15} more` : ''}.` });
    warnings.push({ code: 'TRANSITIONS_NOT_IMPORTED', message: 'Jira workflow transitions and post-functions are not imported (the statuses are); worklogs, boards, filters and automation rules are not either.' });
    if (options.history) warnings.push({ code: 'HISTORY_RECENT_ONLY', message: 'History comes from each issue\'s changelog; very long histories are read in extra requests, which makes the import slower.' });

    const inventory = buildInventory([checked.bundle]);
    const prios = await this.api.get<Array<{ name?: string }>>(c, '/rest/api/3/priority').catch(() => []);
    const have = new Set(inventory.priorities.map(priorityKey));
    for (const p of prios) if (p?.name && !have.has(priorityKey(p.name))) (have.add(priorityKey(p.name)), inventory.priorities.push(p.name));
    return { projects, users: checked.bundle.users?.length ?? 0, warnings, inventory };
  }

  // ------------------------------------------------------------------------------------------------ import: fetchBundle

  async fetchBundle(input: FetchBundleInput): Promise<FetchBundleResult> {
    const c = this.call(input.ctx);
    if (input.cursor === null || input.cursor === undefined) {
      const ids = this.projectIds(input.selection);
      const s = await this.structurePage(c, ids, []);
      const next: JiraCursor | null = s.projects.length
        ? { v: 1, projects: s.projects.map((p) => String(p.id)), keys: s.projects.map((p) => p.key), i: 0, token: null, base: s.baseUrl }
        : null;
      return { bundle: s.page, next };
    }
    return this.taskPage(c, this.parseCursor(input.cursor), input.options);
  }

  /**
   * Opens one Jira attachment. The address is checked against the ONE shape the importer ever builds
   * (`https://api.atlassian.com/ex/jira/<this site>/rest/api/3/attachment/content/<id>`): a ref that is anything else is refused
   * before a request is made, so the token can only ever go to Atlassian's gateway for this very site. Jira answers with a redirect
   * to its media service; the Authorization header is not forwarded across hosts (fetch's rule). 401 -> the job pauses.
   */
  async fetchAttachment(input: FetchAttachmentInput): Promise<FetchedAttachment> {
    const want = new URL(this.api.base(input.ctx.externalAccountId));
    let u: URL;
    try {
      u = new URL(input.providerRef);
    } catch {
      throw new ProviderHttpError(400, 'jira:file', 'Not a Jira file address; it was not fetched');
    }
    const prefix = `${want.pathname}/rest/api/3/attachment/content/`;
    const ok = u.protocol === 'https:' && u.host === want.host && u.username === '' && u.password === '' && u.pathname.startsWith(prefix) && u.pathname.length > prefix.length && !u.pathname.slice(prefix.length).includes('/');
    if (!ok) throw new ProviderHttpError(400, 'jira:file', 'Not a Jira file address of this site; it was not fetched');
    try {
      const res = await this.http.openStream({ rateKey: `connection:${input.ctx.connectionId}`, url: u.toString(), headers: { authorization: `Bearer ${input.ctx.accessToken}` } });
      const raw = res.headers.get('content-length');
      const len = raw === null ? NaN : Number(raw);
      return { stream: res.body, ...(Number.isFinite(len) && len >= 0 ? { sizeBytes: len } : {}), ...(res.headers.get('content-type') ? { mimeType: res.headers.get('content-type') as string } : {}) };
    } catch (e) {
      if (e instanceof ProviderHttpError && e.status === 401) throw new ProviderAuthRejectedError('Jira rejected the access token (HTTP 401)');
      throw e;
    }
  }

  // ------------------------------------------------------------------------------------------------ internals

  private projectIds(selection: ImportSelection): string[] {
    const ids = new Set<string>();
    for (const s of selection.sources) {
      if (s.type !== 'project') throw new Error(`Jira can import projects (got "${s.type}")`);
      ids.add(s.id);
    }
    return [...ids].sort();
  }

  private parseCursor(raw: unknown): JiraCursor {
    const c = raw as Partial<JiraCursor> | null;
    const strings = (a: unknown): a is string[] => Array.isArray(a) && a.every((x) => typeof x === 'string');
    const ok = !!c && typeof c === 'object' && c.v === 1 && strings(c.projects) && strings(c.keys) && c.projects.length === c.keys.length && Number.isInteger(c.i) && c.i! >= 0 && c.i! < c.projects.length && (c.token === null || typeof c.token === 'string') && typeof c.base === 'string';
    if (!ok) throw new Error('The saved Jira cursor is not valid; start the import again');
    return c as JiraCursor;
  }

  /** The site's field catalog: the supported custom fields (and the sprint / story-point ones) by id, and the names of those skipped. */
  private async fieldCatalog(c: JiraCallContext): Promise<{ fields: Map<string, JiraFieldDef>; skipped: string[] }> {
    const defs = await this.api.get<JiraFieldDef[]>(c, '/rest/api/3/field');
    const fields = new Map<string, JiraFieldDef>();
    const skipped: string[] = [];
    for (const d of defs ?? []) {
      if (!d?.id || !d.custom) continue;
      if (fieldKind(d) === 'skip') skipped.push(d.name);
      else fields.set(d.id, d);
    }
    return { fields, skipped };
  }

  private async structurePage(c: JiraCallContext, projectIds: string[], warnings: NonNullable<ImportEstimate['warnings']>) {
    const info = await this.api.get<{ baseUrl?: string }>(c, '/rest/api/3/serverInfo').catch(() => ({ baseUrl: undefined }));
    const baseUrl = (info.baseUrl ?? '').replace(/\/+$/, '');

    const users: CanonicalUser[] = [];
    try {
      for (let startAt = 0; users.length < MAX_USERS; startAt += 100) {
        const batch = await this.api.get<JiraUser[]>(c, '/rest/api/3/users/search', { startAt, maxResults: 100 });
        for (const u of batch) if ((u.accountType ?? 'atlassian') === 'atlassian' && u.active !== false) {
          const cu = toUser(u);
          if (cu) users.push(cu);
        }
        if (batch.length < 100) break;
      }
    } catch (e) {
      if (!(e instanceof ProviderHttpError) || e.status >= 500) throw e;
      warnings.push({ code: 'USERS_UNAVAILABLE', message: 'The Jira user list could not be read; people are credited to the importer.' });
    }

    const types = await this.api.get<JiraIssueType[]>(c, '/rest/api/3/issuetype').catch(() => [] as JiraIssueType[]);
    const projects: JiraProject[] = [];
    const canon = [];
    const iterations: CanonicalIteration[] = [];
    for (const id of projectIds) {
      const p = await this.api.get<JiraProject>(c, `/rest/api/3/project/${encodeURIComponent(id)}`);
      if (!p?.id) throw new ProviderHttpError(404, `jira:project:${id}`, 'A selected Jira project no longer exists');
      projects.push(p);
      const perType = await this.api.get<Array<{ statuses?: JiraStatus[] }>>(c, `/rest/api/3/project/${encodeURIComponent(id)}/statuses`);
      canon.push(toProject(p, (perType ?? []).flatMap((t) => t.statuses ?? []), baseUrl));
      const versions = await this.api.get<JiraVersion[]>(c, `/rest/api/3/project/${encodeURIComponent(id)}/versions`).catch(() => [] as JiraVersion[]);
      for (const v of versions) if (v?.id) iterations.push(toVersion(v, p.id));
      for (const sp of await this.sprintsOf(c, p, warnings)) iterations.push(toSprint(sp, p.id));
    }
    // Fields are declared HERE, on page 0, because the mapping step (and the preview's inventory) only knows what the structure page
    // declares: the person decides there which of them become fields. A field nobody maps is simply not created.
    const catalog = await this.fieldCatalog(c);
    const customFields: CanonicalCustomField[] = [...catalog.fields.values()].map(toCustomField).filter((f): f is CanonicalCustomField => !!f).slice(0, MAX_FIELDS - 2);
    customFields.push({ externalId: TIME_FIELDS.estimate.externalId, name: TIME_FIELDS.estimate.name, dataType: FieldType.NUMBER }, { externalId: TIME_FIELDS.spent.externalId, name: TIME_FIELDS.spent.name, dataType: FieldType.NUMBER });
    const seenIt = new Set<string>();
    const page: CanonicalBundle = {
      ...emptyPage(),
      source: { ...JIRA_SYSTEM },
      users,
      projects: canon,
      customFields,
      issueTypes: types.filter((t) => t?.id && t.name).map(toIssueType),
      iterations: iterations.filter((it) => (seenIt.has(it.externalId) ? false : (seenIt.add(it.externalId), true))),
    };
    return { page, projects, baseUrl };
  }

  /** Sprints of a project's boards (Jira Software). A project without boards, or a site without Jira Software, simply has none. */
  private async sprintsOf(c: JiraCallContext, p: JiraProject, warnings: NonNullable<ImportEstimate['warnings']>): Promise<JiraSprint[]> {
    const out = new Map<string, JiraSprint>();
    try {
      const boards = await this.api.paged<{ id: number | string; type?: string }>(c, '/rest/agile/1.0/board', { projectKeyOrId: p.id }, 'values', 20);
      for (const b of boards.filter((x) => (x.type ?? 'scrum') !== 'kanban')) {
        const sprints = await this.api.paged<JiraSprint>(c, `/rest/agile/1.0/board/${encodeURIComponent(String(b.id))}/sprint`, { state: 'future,active,closed' }, 'values', MAX_SPRINTS).catch((e: unknown) => {
          if (e instanceof ProviderHttpError && e.status >= 400 && e.status < 500) return [] as JiraSprint[];
          throw e;
        });
        for (const s of sprints) out.set(String(s.id), s);
      }
    } catch (e) {
      if (!(e instanceof ProviderHttpError) || e.status >= 500) throw e;
      warnings.push({ code: 'SPRINTS_UNAVAILABLE', message: `Sprints of ${p.name ?? p.key} could not be read (Jira Software may not be available); issues keep no sprint.` });
    }
    return [...out.values()].slice(0, MAX_SPRINTS);
  }

  private async taskPage(c: JiraCallContext, cur: JiraCursor, options: ImportOptions): Promise<FetchBundleResult> {
    const projectId = cur.projects[cur.i];
    const content = { comments: !!options.comments, history: !!options.history, attachments: !!options.attachments };
    const catalog = await this.fieldCatalog(c);
    const r = await this.api.post<{ issues?: JiraIssue[]; nextPageToken?: string | null; isLast?: boolean }>(c, '/rest/api/3/search/jql', {
      jql: `project = ${projectId} ORDER BY id ASC`,
      maxResults: content.history ? PAGE_WITH_HISTORY : PAGE,
      fields: ['*all'],
      ...(content.history ? { expand: 'changelog' } : {}),
      ...(cur.token ? { nextPageToken: cur.token } : {}),
    });
    const issues = r.issues ?? [];

    const extraComments = new Map<string, JiraComment[]>();
    const extraHistory = new Map<string, JiraHistory[]>();
    for (const i of issues) {
      const have = i.fields.comment?.comments?.length ?? 0;
      if (content.comments && (i.fields.comment?.total ?? 0) > have) extraComments.set(i.id, await this.moreComments(c, i.id, have));
      const haveH = i.changelog?.histories?.length ?? 0;
      if (content.history && (i.changelog?.total ?? 0) > haveH) extraHistory.set(i.id, await this.moreHistory(c, i.id, haveH));
    }

    const byKey = new Map(cur.keys.map((k, n) => [k, cur.projects[n]]));
    const page = emptyPage();
    const tasks = [];
    const deps = new Map<string, ReturnType<typeof toDependencies>[number]>();
    const inSel = inSelectionOf(byKey);
    for (const i of issues) {
      if (!i?.id) continue;
      const out = toTask(i, {
        projectId, cloudId: c.cloudId, baseUrl: cur.base || undefined, fields: catalog.fields, content, contentUrl: (id) => this.api.attachmentContentUrl(c.cloudId, id),
        extraComments, extraHistory, projectIdByKey: byKey,
      });
      tasks.push(out.task);
      for (const d of toDependencies(i, inSel)) deps.set(d.externalId, d);
    }
    if (tasks.length) page.tasks = tasks;
    if (deps.size) page.dependencies = [...deps.values()];

    let next: JiraCursor | null;
    if (r.nextPageToken && issues.length > 0 && r.isLast !== true) next = { ...cur, token: r.nextPageToken };
    else if (cur.i + 1 < cur.projects.length) next = { ...cur, i: cur.i + 1, token: null };
    else next = null;
    return { bundle: page, next };
  }

  private async moreComments(c: JiraCallContext, issueId: string, from: number): Promise<JiraComment[]> {
    const out: JiraComment[] = [];
    let startAt = from;
    for (let n = 0; n < MAX_NESTED_PAGES; n++) {
      const r = await this.api.get<{ comments?: JiraComment[]; total?: number }>(c, `/rest/api/3/issue/${encodeURIComponent(issueId)}/comment`, { startAt, maxResults: 100, orderBy: 'created' });
      const got = r.comments ?? [];
      out.push(...got);
      startAt += got.length;
      if (got.length === 0 || startAt >= (r.total ?? 0)) break;
    }
    return out;
  }

  private async moreHistory(c: JiraCallContext, issueId: string, from: number): Promise<JiraHistory[]> {
    const out: JiraHistory[] = [];
    let startAt = from;
    for (let n = 0; n < MAX_NESTED_PAGES; n++) {
      const r = await this.api.get<{ values?: JiraHistory[]; isLast?: boolean; total?: number }>(c, `/rest/api/3/issue/${encodeURIComponent(issueId)}/changelog`, { startAt, maxResults: 100 });
      const got = r.values ?? [];
      out.push(...got);
      startAt += got.length;
      if (got.length === 0 || r.isLast === true || startAt >= (r.total ?? Infinity)) break;
    }
    return out;
  }
}

/** Custom fields every Jira site has that are plumbing, not data: not worth a warning when skipped. */
const IGNORED_FIELD_NAMES = new Set(['rank', 'development', 'epic link', 'epic name', 'epic status', 'epic color', 'flagged', 'sprint', 'parent link', 'target start', 'target end', 'issue color', 'request type', 'satisfaction', 'approvals', 'organizations', 'request participants', 'team']);
