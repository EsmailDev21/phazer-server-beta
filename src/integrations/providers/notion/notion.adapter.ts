import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IntegrationProvider } from '@prisma/client';
import { CANONICAL_LIMITS as L, CanonicalBundle, CanonicalCustomField, CanonicalDependency, CanonicalTask, validateBundle } from '../../../imports/canonical';
import { guessedRolesWarning, missingRolesWarning, resolveFieldRoles, suggestFieldRoles } from '../../../imports/field-roles';
import { FetchAttachmentInput, FetchBundleInput, FetchBundleResult, FetchedAttachment, ImportAdapterContext, ImportCapableAdapter } from '../../../imports/import-adapter';
import { ImportEstimate, ImportOptions, ImportSelection, SourceTree } from '../../../imports/imports.types';
import { buildInventory } from '../../../imports/mapping/mapping.inventory';
import { AuthorizeContext, CallbackParams, Capability, ExchangeContext, ExternalAccount, ProviderAuthRejectedError, ProviderHttpError, TokenSet } from '../../core/integration.types';
import { ProviderHttpClient } from '../../core/provider-http.client';
import { NOTION_API, NotionCallContext, NotionClient, PAGE_SIZE } from './notion.client';
import {
  FoundFile,
  NOTION_SYSTEM,
  NtPlan,
  buildSource,
  convertMarkdown,
  emptyPage,
  fieldsOfDataSource,
  isAllowedFileUrl,
  isTrashed,
  parseFileRef,
  plain,
  propertyFiles,
  toAttachments,
  toComments,
  toDependencies,
  toTask,
  toUser,
} from './notion.normalize';
import { NtComment, NtDataSource, NtList, NtMarkdown, NtPage, NtTokenResponse, NtUser } from './notion.types';

const AUTHORIZE_URL = `${NOTION_API}/v1/oauth/authorize`;
const TOKEN_URL = `${NOTION_API}/v1/oauth/token`;
const REVOKE_URL = `${NOTION_API}/v1/oauth/revoke`;

const MAX_SOURCES = L.maxProjects;
const MAX_USERS = L.maxUsers;
const MAX_DISCOVER = 2000;
/** Each row costs a markdown call (+ a comments call): 25 rows keep one bundle page at about twenty seconds at Notion's 3 requests a second. */
const ROWS_PER_PAGE = 25;
const COUNT_CAP = 20_000;
/** A truncated page tells which blocks it did not load; each is one more call. */
const MAX_UNKNOWN_FOLLOWUPS = 5;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EMPTY_HINT = 'Nothing is shared with this connection yet. In Notion, open the database you want to import, use the ••• menu → Connections, add this connection, then reload this list.';

/** Where the next call continues. Plain JSON (the job's checkpoint). The roles of every source are decided ONCE, on the structure page. */
interface NotionCursor {
  v: 1;
  plans: NtPlan[];
  /** Index into `plans` (the data source being read). */
  i: number;
  /** The Notion `start_cursor` USED to fetch the current page (null = the first). Re-sending it re-fetches the same page. */
  cur: string | null;
}

/**
 * Notion (step 4.12, ADR-0042): OAuth (a public connection) and the import capability, on API version 2026-03-11.
 *
 * A DATA SOURCE (the table inside a database; since 2025-09-03 it is what has properties and is queried) is a project and each row (a
 * page) a task. The status / assignee / dates / priority come from the properties the person chose (ADR-0040): Notion's `status` groups
 * give CERTAIN categories (To-do / In progress / Complete), a `select`'s option names are judged like any other name. The page body is read
 * with `GET /pages/:id/markdown` (no block tree to walk), converted to our markdown; its signed file URLs (they expire in about an hour) are
 * replaced by the attachment's `providerRef`, which the file copier re-points to our own copy. Comments keep their discussion threads.
 * Self-relations named like "Parent item", "Blocked by", "Blocking" become parents and dependencies.
 * NOT imported: history, formulas / rollups / other relations, views, templates, page content of nested child pages, comments' own files,
 * external (link) files, buttons.
 *
 * Written against Notion's public documentation; tested against SYNTHETIC responses. No live Notion workspace was called.
 */
@Injectable()
export class NotionAdapter implements ImportCapableAdapter {
  readonly provider = IntegrationProvider.NOTION;
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>(['IMPORT']);
  /** Notion's public-connection flow documents no PKCE. */
  readonly usesPkce = false;

  constructor(
    private readonly config: ConfigService,
    private readonly http: ProviderHttpClient,
    private readonly api: NotionClient,
  ) {}

  // ------------------------------------------------------------------------------------------------ OAuth

  isConfigured(): boolean {
    return !!this.config.get('NOTION_CLIENT_ID') && !!this.config.get('NOTION_CLIENT_SECRET');
  }

  authorizeUrl(ctx: AuthorizeContext): string {
    const u = new URL(AUTHORIZE_URL);
    u.searchParams.set('client_id', this.config.get<string>('NOTION_CLIENT_ID')!);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('owner', 'user');
    u.searchParams.set('redirect_uri', ctx.redirectUri);
    u.searchParams.set('state', ctx.state);
    return u.toString();
  }

  private async tokenCall(url: string, body: Record<string, string>): Promise<NtTokenResponse & { status: number }> {
    const basic = Buffer.from(`${this.config.get<string>('NOTION_CLIENT_ID')}:${this.config.get<string>('NOTION_CLIENT_SECRET')}`).toString('base64');
    const res = await this.http.request({
      rateKey: 'oauth:NOTION',
      url,
      method: 'POST',
      headers: { authorization: `Basic ${basic}`, 'content-type': 'application/json', accept: 'application/json', 'notion-version': this.api.apiVersion },
      body: JSON.stringify(body),
    });
    let parsed: NtTokenResponse = {};
    try {
      parsed = res.json<NtTokenResponse>();
    } catch {
      /* the status decides */
    }
    return { ...parsed, status: res.status };
  }

  /** Seconds an access token is assumed to live when Notion does not say (it never sends `expires_in`). 0 = never refresh. */
  private get tokenTtlSeconds(): number {
    const raw = this.config.get<string>('NOTION_TOKEN_TTL_SECONDS');
    const n = raw === undefined || raw === null || String(raw).trim() === '' ? 3600 : Number(raw);
    return Number.isFinite(n) && n >= 0 && n <= 30 * 86400 ? n : 3600;
  }

  /**
   * Notion documents neither the lifetime of an access token nor an `expires_in`; it DOES issue a (nullable) refresh token that rotates.
   * When there is a refresh token the access token is treated as expiring after NOTION_TOKEN_TTL_SECONDS (default one hour): refreshing a
   * token that did not need it costs one call, while not refreshing one that did would break the connection.
   */
  private toTokenSet(r: NtTokenResponse, previousRefresh?: string): TokenSet {
    const refreshToken = r.refresh_token ?? previousRefresh;
    const ttl = this.tokenTtlSeconds;
    return {
      accessToken: r.access_token!,
      refreshToken: refreshToken || undefined,
      expiresAt: refreshToken && ttl > 0 ? new Date(Date.now() + ttl * 1000) : undefined,
      scopes: [],
      tokenType: r.token_type ?? 'bearer',
    };
  }

  /** The connection is the Notion WORKSPACE the person authorized (one token per workspace). */
  async exchangeCode(params: CallbackParams, ctx: ExchangeContext): Promise<{ tokens: TokenSet; account: ExternalAccount }> {
    if (!params.code) throw new Error('Notion callback without code');
    const r = await this.tokenCall(TOKEN_URL, { grant_type: 'authorization_code', code: params.code, redirect_uri: ctx.redirectUri });
    if (r.status < 200 || r.status >= 300 || !r.access_token) throw new Error(`Notion token endpoint: HTTP ${r.status}${r.code ? ` ${r.code}` : ''}`);
    if (!r.workspace_id) throw new Error('Notion did not say which workspace this is');
    return { tokens: this.toTokenSet(r), account: { id: r.workspace_id, name: (r.workspace_name ?? '').toString().trim() || 'Notion workspace' } };
  }

  /** The refresh token ROTATES: the caller serializes refreshes under the per-connection lock; a null answer keeps the stored one. */
  async refresh(tokens: TokenSet): Promise<TokenSet> {
    if (!tokens.refreshToken) throw new ProviderAuthRejectedError('This Notion connection has no refresh token; reconnect it');
    const r = await this.tokenCall(TOKEN_URL, { grant_type: 'refresh_token', refresh_token: tokens.refreshToken });
    if (r.status === 400 || r.status === 401 || r.status === 403) throw new ProviderAuthRejectedError(`Notion rejected the refresh token (${r.code ?? r.status})`);
    if (r.status < 200 || r.status >= 300 || !r.access_token) throw new ProviderHttpError(r.status, TOKEN_URL, r.message ?? r.code ?? '');
    return this.toTokenSet(r, tokens.refreshToken);
  }

  /** Best effort. */
  async revoke(tokens: TokenSet, _account: ExternalAccount): Promise<void> {
    const token = tokens.refreshToken ?? tokens.accessToken;
    if (!token) return;
    await this.tokenCall(REVOKE_URL, { token });
  }

  // ------------------------------------------------------------------------------------------------ import: discover / estimate

  private call(ctx: ImportAdapterContext): NotionCallContext {
    return { connectionId: ctx.connectionId, accessToken: ctx.accessToken };
  }

  /**
   * Only what was SHARED with the connection is visible (Notion's design): search is the only way to list it. Each data source is one
   * node under a single non-selectable "Shared" node; an empty answer comes with a hint that says how to share something.
   */
  async discover(ctx: ImportAdapterContext): Promise<SourceTree & { hint?: string }> {
    const c = this.call(ctx);
    const found = await this.api.all<NtDataSource>(c, { method: 'POST', path: '/v1/search', body: { filter: { property: 'object', value: 'data_source' }, sort: { direction: 'descending', timestamp: 'last_edited_time' } } }, MAX_DISCOVER);
    const nodes: SourceTree['nodes'] = [];
    const seen = new Set<string>();
    for (const ds of found.items) {
      if (!ds?.id || ds.object === ('page' as never) || ds.in_trash === true || ds.archived === true || seen.has(ds.id)) continue;
      seen.add(ds.id);
      const fields = suggestFieldRoles(fieldsOfDataSource(ds));
      nodes.push({ id: ds.id, type: 'data_source', name: plain(ds.title).trim() || 'Untitled', parentId: 'shared', selectable: true, ...(fields.length ? { fields } : {}) });
    }
    if (nodes.length === 0) return { nodes: [], hint: EMPTY_HINT };
    return { nodes: [{ id: 'shared', type: 'workspace', name: 'Shared with this connection', parentId: null, selectable: false }, ...nodes] };
  }

  async estimate(ctx: ImportAdapterContext, selection: ImportSelection, options: ImportOptions): Promise<ImportEstimate> {
    const c = this.call(ctx);
    const warnings: NonNullable<ImportEstimate['warnings']> = [];
    const s = await this.structure(c, selection, warnings);
    const checked = validateBundle(s.page);
    if ('fatal' in checked) throw new Error(`Notion structure page rejected: ${checked.fatal.code} ${checked.fatal.message}`);

    const projects: ImportEstimate['projects'] = [];
    let total = 0;
    let anyCapped = false;
    for (const ds of s.sources) {
      const { n, capped } = await this.countRows(c, ds, s.plans.find((p) => p.id === ds.id)!);
      anyCapped = anyCapped || capped;
      total += n;
      projects.push({ sourceId: ds.id, name: plain(ds.title).trim() || 'Untitled', tasks: n });
    }
    if (anyCapped) warnings.push({ code: 'COUNT_CAPPED', message: `The preview counted at most ${COUNT_CAP.toLocaleString('en-US')} pages per data source; there are more.` });

    const inventory = buildInventory([checked.bundle]);
    warnings.push(...s.warnings);
    // every page needs a markdown call, and a comments call when asked; Notion allows about 3 requests a second per token
    const perRow = 1 + (options.comments ? 1 : 0);
    if (total > 0) {
      const minutes = Math.ceil((total * perRow) / (this.api.requestsPerSecond * 60));
      warnings.push({
        code: 'CONTENT_SLOW',
        message: `Notion allows about ${this.api.requestsPerSecond} requests a second and each page is read one at a time (its text${options.comments ? ' and its comments' : ''}): reading ${total.toLocaleString('en-US')} pages takes about ${minutes >= 120 ? `${Math.round(minutes / 60)} hours` : `${minutes} minute${minutes === 1 ? '' : 's'}`}.`,
      });
    }
    if (options.history) warnings.push({ code: 'HISTORY_NOT_AVAILABLE', message: 'Notion does not keep a field-by-field history of a page, so the activity history is not imported.' });
    return { projects, users: checked.bundle.users?.length ?? 0, warnings, inventory };
  }

  /** Rows of a data source by paging the query with only the title (cheap), up to a cap. */
  private async countRows(c: NotionCallContext, ds: NtDataSource, plan: NtPlan): Promise<{ n: number; capped: boolean }> {
    const run = async (query?: Record<string, string[]>) => {
      let n = 0;
      let cursor: string | undefined;
      for (let i = 0; i < COUNT_CAP / PAGE_SIZE + 2; i++) {
        const r = await this.api.post<NtList<NtPage>>(c, `/v1/data_sources/${ds.id}/query`, { page_size: PAGE_SIZE, ...(cursor ? { start_cursor: cursor } : {}) }, query);
        n += (r.results ?? []).filter((p) => !isTrashed(p)).length;
        cursor = r.has_more && r.next_cursor ? r.next_cursor : undefined;
        if (!cursor) return { n, capped: false };
        if (n >= COUNT_CAP) return { n, capped: true };
      }
      return { n, capped: true };
    };
    if (!plan.titleId) return run();
    try {
      return await run({ filter_properties: [plan.titleId] });
    } catch (e) {
      if (e instanceof ProviderHttpError && e.status === 400) return run(); // the property filter was refused: count without it
      throw e;
    }
  }

  // ------------------------------------------------------------------------------------------------ import: fetchBundle

  async fetchBundle(input: FetchBundleInput): Promise<FetchBundleResult> {
    const c = this.call(input.ctx);
    if (input.cursor === null || input.cursor === undefined) {
      const s = await this.structure(c, input.selection, []);
      const next: NotionCursor | null = s.plans.length ? { v: 1, plans: s.plans, i: 0, cur: null } : null;
      return { bundle: s.page, next };
    }
    return this.rowsStep(c, this.parseCursor(input.cursor), input.options);
  }

  /**
   * Opens one Notion file as a stream. The ref is OURS (`notion-file:<page>:<m|p>:<hash of the file's path>`, never an address); the page
   * (its markdown, or its properties for a `files` property) is read NOW to get a fresh signed URL, which is checked against the host
   * allow-list and fetched WITHOUT the access token (pre-signed URLs carry their own authority).
   */
  async fetchAttachment(input: FetchAttachmentInput): Promise<FetchedAttachment> {
    const ref = parseFileRef(input.providerRef);
    if (!ref) throw new ProviderHttpError(400, 'notion:file', 'Not a Notion file reference; it was not fetched');
    const c = this.call(input.ctx);
    let files: FoundFile[];
    if (ref.source === 'p') files = propertyFiles(await this.api.get<NtPage>(c, `/v1/pages/${ref.pageId}`));
    else {
      const md = await this.api.get<NtMarkdown>(c, `/v1/pages/${ref.pageId}/markdown`);
      files = convertMarkdown(String(md.markdown ?? ''), ref.pageId, this.extraFileHosts()).files;
    }
    const file = files.find((f) => f.hash === ref.hash);
    if (!file) throw new ProviderHttpError(404, `notion:file:${ref.pageId}`, 'This file is no longer on the Notion page');
    if (!isAllowedFileUrl(file.url, this.extraFileHosts())) throw new ProviderHttpError(400, `notion:file:${ref.pageId}`, 'Notion pointed at an address that is not a Notion file host; it was not fetched');
    const res = await this.http.openStream({ rateKey: `files:${input.ctx.connectionId}`, url: file.url, headers: {} });
    const raw = res.headers.get('content-length');
    const len = raw === null ? NaN : Number(raw);
    return {
      stream: res.body,
      ...(Number.isFinite(len) && len >= 0 ? { sizeBytes: len } : {}),
      ...(res.headers.get('content-type') ? { mimeType: res.headers.get('content-type') as string } : {}),
    };
  }

  // ------------------------------------------------------------------------------------------------ internals

  private extraFileHosts(): string[] {
    return String(this.config.get('NOTION_FILE_HOSTS') ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter((h) => /^\.?[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(h));
  }

  private parseCursor(raw: unknown): NotionCursor {
    const c = raw as Partial<NotionCursor> | null;
    const isStr = (x: unknown): x is string => typeof x === 'string';
    const strRecord = (x: unknown): boolean => !!x && typeof x === 'object' && !Array.isArray(x) && Object.values(x as object).every(isStr);
    const plan = (p: unknown): boolean => {
      const q = p as Partial<NtPlan> | null;
      return !!q && typeof q === 'object' && isStr(q.id) && isStr(q.titleId) && ['status', 'select', 'checkbox', 'none'].includes(q.kind as string) && strRecord(q.roles) &&
        Array.isArray(q.sv) && q.sv.every(isStr) && strRecord(q.lbl) && strRecord(q.cm) && strRecord(q.rel);
    };
    const ok = !!c && typeof c === 'object' && c.v === 1 && Array.isArray(c.plans) && c.plans.every(plan) && Number.isInteger(c.i) && c.i! >= 0 && c.i! <= c.plans.length && (c.cur === null || isStr(c.cur));
    if (!ok) throw new Error('The saved Notion cursor is not valid; start the import again');
    return c as NotionCursor;
  }

  private sourceIds(selection: ImportSelection, warnings: NonNullable<ImportEstimate['warnings']>): Array<{ id: string; fieldRoles?: ImportSelection['sources'][number]['fieldRoles'] }> {
    const out = new Map<string, ImportSelection['sources'][number]['fieldRoles']>();
    for (const s of selection.sources) {
      if (s.type !== 'data_source') throw new Error(`Notion can import data sources (got "${s.type}")`);
      if (!UUID.test(s.id)) throw new Error('A selected Notion data source id is not valid');
      if (!out.has(s.id)) out.set(s.id, s.fieldRoles);
    }
    let list = [...out].sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, fieldRoles]) => ({ id, fieldRoles }));
    if (list.length > MAX_SOURCES) {
      warnings.push({ code: 'SOURCES_CAPPED', message: `Only the first ${MAX_SOURCES} data sources of the selection are imported; select fewer.` });
      list = list.slice(0, MAX_SOURCES);
    }
    return list;
  }

  /** Page 0: the people, every data source as a project (statuses from the chosen property), the shared custom fields. */
  private async structure(c: NotionCallContext, selection: ImportSelection, warnings: NonNullable<ImportEstimate['warnings']>) {
    const wanted = this.sourceIds(selection, warnings);
    const sources: NtDataSource[] = [];
    for (const w of wanted) {
      const ds = await this.api.get<NtDataSource>(c, `/v1/data_sources/${w.id}`);
      if (!ds?.id || ds.in_trash === true || ds.archived === true) throw new ProviderHttpError(404, `notion:data_source:${w.id}`, 'A selected Notion data source no longer exists or is in the trash');
      sources.push(ds);
    }

    const plans: NtPlan[] = [];
    const projects = [];
    const fields = new Map<string, CanonicalCustomField>();
    const skipped = new Map<string, number>();
    for (const ds of sources) {
      const chosen = wanted.find((w) => w.id === ds.id)?.fieldRoles;
      const resolved = resolveFieldRoles(suggestFieldRoles(fieldsOfDataSource(ds)), chosen);
      const name = plain(ds.title).trim() || 'Untitled';
      for (const w of [guessedRolesWarning(name, resolved), missingRolesWarning(name, resolved)]) if (w) warnings.push(w);
      const built = buildSource(ds, resolved);
      plans.push(built.plan);
      projects.push(built.project);
      for (const f of built.customFields) {
        const have = fields.get(f.externalId);
        if (!have) fields.set(f.externalId, f);
        else if (f.options?.length) {
          const seen = new Set((have.options ?? []).map((o) => o.label));
          have.options = [...(have.options ?? []), ...f.options.filter((o) => !seen.has(o.label))];
        }
      }
      for (const sk of built.skipped) skipped.set(sk.type, (skipped.get(sk.type) ?? 0) + 1);
    }
    if (skipped.size) warnings.push({ code: 'PROPERTIES_SKIPPED', message: `Some Notion properties have no equivalent and are not imported: ${[...skipped].map(([t, n]) => `${n} x ${t}`).join(', ')}.` });
    let customFields = [...fields.values()];
    if (customFields.length > L.maxCustomFields) {
      warnings.push({ code: 'CUSTOM_FIELDS_CAPPED', message: `The selected data sources use ${customFields.length} different properties; only the first ${L.maxCustomFields} are imported.` });
      customFields = customFields.slice(0, L.maxCustomFields);
    }

    const rawUsers = await this.api
      .all<NtUser>(c, { method: 'GET', path: '/v1/users' }, MAX_USERS + 1)
      .then((r) => r.items)
      .catch((e: unknown) => {
        if (!(e instanceof ProviderHttpError) || e.status === 429) throw e;
        warnings.push({ code: 'USERS_UNAVAILABLE', message: 'This connection may not read the workspace\'s people: assignees can only be matched by name.' });
        return [] as NtUser[];
      });
    const users = rawUsers.map(toUser).filter((u): u is NonNullable<typeof u> => !!u);
    if (users.length > 0 && users.every((u) => !u.email)) {
      warnings.push({ code: 'USERS_NO_EMAIL', message: 'This connection has no access to people\'s e-mail addresses (the "user information" capability), so people can only be matched by name.' });
    }
    if (users.length > MAX_USERS) warnings.push({ code: 'USERS_CAPPED', message: `Only the first ${MAX_USERS} Notion people are considered when matching people.` });

    const page: CanonicalBundle = { ...emptyPage(), source: { ...NOTION_SYSTEM }, users: users.slice(0, MAX_USERS), projects };
    if (customFields.length) page.customFields = customFields;
    return { page, plans, sources, warnings };
  }

  /** The text of a page as OUR markdown, plus the files in it. A truncated page is completed from the blocks it names (a few calls at most). */
  private async descriptionOf(c: NotionCallContext, pageId: string): Promise<{ markdown: string; files: Array<FoundFile & { source: 'm' }> }> {
    const extra = this.extraFileHosts();
    let md: NtMarkdown;
    try {
      md = await this.api.get<NtMarkdown>(c, `/v1/pages/${pageId}/markdown`);
    } catch (e) {
      if (e instanceof ProviderHttpError && (e.status === 403 || e.status === 404)) return { markdown: '', files: [] }; // not readable: the row still arrives
      throw e;
    }
    const first = convertMarkdown(String(md.markdown ?? ''), pageId, extra);
    let text = first.markdown;
    const files = new Map(first.files.map((f) => [f.hash, f]));
    // each `<unknown/>` left in the text stands for one block; a block fetched below is no longer unknown
    let unresolved = first.unknown;
    if (md.truncated && (md.unknown_block_ids ?? []).length > 0) {
      for (const id of (md.unknown_block_ids ?? []).slice(0, MAX_UNKNOWN_FOLLOWUPS)) {
        if (!UUID.test(id)) continue;
        try {
          const more = await this.api.get<NtMarkdown>(c, `/v1/pages/${id}/markdown`);
          const conv = convertMarkdown(String(more.markdown ?? ''), pageId, extra);
          if (conv.markdown) text = `${text}\n\n${conv.markdown}`;
          for (const f of conv.files) if (!files.has(f.hash)) files.set(f.hash, f);
          unresolved = Math.max(0, unresolved - 1) + conv.unknown;
        } catch (e) {
          if (!(e instanceof ProviderHttpError && (e.status === 403 || e.status === 404))) throw e; // blocks the connection cannot see
        }
      }
    }
    if (unresolved > 0 || (md.truncated && (md.unknown_block_ids ?? []).length > MAX_UNKNOWN_FOLLOWUPS)) text = `${text}\n\n_(Part of this page could not be imported.)_`.trim();
    return { markdown: text, files: [...files.values()] };
  }

  private async commentsOf(c: NotionCallContext, pageId: string): Promise<NtComment[]> {
    try {
      return (await this.api.all<NtComment>(c, { method: 'GET', path: '/v1/comments', query: { block_id: pageId } }, 1000)).items;
    } catch (e) {
      if (e instanceof ProviderHttpError && (e.status === 403 || e.status === 404)) return []; // no "read comments" capability, or the page vanished
      throw e;
    }
  }

  private async rowsStep(c: NotionCallContext, cur: NotionCursor, options: ImportOptions): Promise<FetchBundleResult> {
    const plan = cur.plans[cur.i];
    if (!plan) return { bundle: emptyPage(), next: null };
    const page = await this.api.post<NtList<NtPage>>(c, `/v1/data_sources/${plan.id}/query`, {
      page_size: ROWS_PER_PAGE,
      sorts: [{ timestamp: 'created_time', direction: 'ascending' }],
      ...(cur.cur ? { start_cursor: cur.cur } : {}),
    });

    const tasks: CanonicalTask[] = [];
    const deps = new Map<string, CanonicalDependency>();
    for (const row of page.results ?? []) {
      if (!row?.id || isTrashed(row)) continue;
      const d = await this.descriptionOf(c, row.id);
      const fileList: Array<FoundFile & { source: 'm' | 'p' }> = [...d.files, ...propertyFiles(row).map((f) => ({ ...f, source: 'p' as const }))];
      // without file copying the references would dangle: keep the file's NAME only
      const description = options.attachments ? d.markdown : d.markdown.replace(/!?\[([^\]]*)\]\(notion-file:[^)]*\)/g, '$1');
      const t = toTask(row, plan, description);
      if (options.attachments) {
        const files = toAttachments(row.id, fileList);
        if (files.length) t.attachments = files;
      }
      if (options.comments) {
        const comments = toComments(await this.commentsOf(c, row.id));
        if (comments.length) t.comments = comments;
      }
      tasks.push(t);
      for (const e of toDependencies(row, plan)) if (deps.size < L.maxDependencies) deps.set(e.externalId, e);
    }

    const bundle = emptyPage();
    if (tasks.length) bundle.tasks = tasks;
    if (deps.size) bundle.dependencies = [...deps.values()];
    let next: NotionCursor | null = page.has_more && page.next_cursor && (page.results ?? []).length > 0 ? { ...cur, cur: page.next_cursor } : { ...cur, i: cur.i + 1, cur: null };
    if (next.i >= next.plans.length) next = null;
    return { bundle, next };
  }
}
