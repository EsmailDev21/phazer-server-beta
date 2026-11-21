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
import { MondayCallContext, MondayClient, MondayCursorExpiredError } from './monday.client';
import {
  BoardPlan,
  MONDAY_SYSTEM,
  buildBoard,
  emptyPage,
  fieldsOfBoard,
  isAllowedDownloadUrl,
  parseAssetRef,
  toAttachments,
  toComments,
  toDependencies,
  toSubitem,
  toTask,
  toUser,
} from './monday.normalize';
import { MnAsset, MnBoard, MnItem, MnItemExtras, MnUser, MnWorkspace } from './monday.types';

const AUTHORIZE_URL = 'https://auth.monday.com/oauth2/authorize';
/** The legacy flow (non-expiring token, no refresh) and the OAuth 2.1 flow (PKCE, expiring token, rotating refresh token) use DIFFERENT token endpoints. */
const TOKEN_URL = { legacy: 'https://auth.monday.com/oauth2/token', '2.1': 'https://auth.monday.com/oauth_ms/oauth/token' } as const;
const REVOKE_URL = 'https://auth.monday.com/oauth_ms/oauth/revoke';

/** Read-only scopes. `MONDAY_SCOPES` overrides (empty = send none and let the app version's declared scopes apply). */
const DEFAULT_SCOPES = 'me:read account:read boards:read workspaces:read users:read updates:read assets:read';

const MAX_BOARDS = L.maxProjects;
const MAX_USERS = L.maxUsers;
const MAX_DISCOVER_BOARDS = 2000;
const BOARDS_PER_CALL = 25;
/** items_page allows 500; 100 keeps the nested column values (and subitems) of one call well under the complexity limit. */
const ITEMS_LIMIT = 100;
/** A page may carry 1000 tasks (parents + subitems). */
const TASK_BUDGET = L.maxTasks;
const MAX_SUBITEMS = 900;
/** `items(ids:)` answers for at most 100 ids per call. */
const EXTRAS_IDS = 100;

/** Daily call limit by plan tier (developer.monday.com rate limits). Unknown tier -> no warning. */
const DAILY_LIMIT: Record<string, number> = { free: 200, basic: 1000, standard: 1000, pro: 10000, enterprise: 25000 };

/** Where the next call continues. Plain JSON (the job's checkpoint). The roles of every board are decided ONCE, on the structure page. */
interface MondayCursor {
  v: 1;
  plans: BoardPlan[];
  /** Index into `plans` (the board being read). */
  i: number;
  /** The monday cursor USED to fetch the current page (null = the first page). Re-sending it re-fetches the same page (valid for 60 minutes). */
  cur: string | null;
  /** How many items of the board come BEFORE the current page: lets a dead cursor be rebuilt by an id-only walk. */
  pos: number;
  /** Items of the current page already emitted (a page is split when parents + subitems would exceed a page's task limit). */
  skip: number;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number | string;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

const ITEM_FIELDS = 'id name state created_at updated_at url creator { id } group { id title } column_values { id type text value } subitems { id name created_at updated_at creator { id } column_values { id type text value } }';
const ASSET_FIELDS = 'id name file_extension file_size created_at uploaded_by { id }';

const jwtExpiry = (jwt: string): Date | undefined => {
  const part = jwt.split('.')[1];
  if (!part) return undefined;
  try {
    const exp = (JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as { exp?: unknown }).exp;
    return typeof exp === 'number' && Number.isFinite(exp) && exp > 0 ? new Date(exp * 1000) : undefined;
  } catch {
    return undefined;
  }
};

/**
 * monday.com (step 4.11, ADR-0041): OAuth (the legacy non-expiring flow AND OAuth 2.1) and the import capability.
 *
 * A BOARD is a project. Its STATUS comes from the column or group the person chose (the field-role picker, ADR-0040); labels / groups
 * arrive as UNKNOWN-category statuses so the mapping step judges the names. Items are tasks, SUBITEMS their children (read by column
 * type from the hidden subitems board), UPDATES are comments with their REPLIES one level deep, FILES are fetched with a fresh
 * one-hour `public_url`. Dependency columns -> BLOCKS; a timeline is a start and an end; other columns -> custom fields (shared by title+type).
 * NOT imported: folders, docs, dashboards, automations, activity logs (history), formula / mirror / connect-boards columns, subitems' own
 * comments and files, multi-level board hierarchies, item descriptions (monday has none: a long-text column is a custom field).
 *
 * Written against monday's public documentation; tested against SYNTHETIC responses. No live monday account was called.
 */
@Injectable()
export class MondayAdapter implements ImportCapableAdapter {
  readonly provider = IntegrationProvider.MONDAY;
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>(['IMPORT']);
  /** PKCE belongs to the OAuth 2.1 flow only (the legacy flow has none). */
  readonly usesPkce: boolean;
  private readonly flow: 'legacy' | '2.1';

  constructor(
    private readonly config: ConfigService,
    private readonly http: ProviderHttpClient,
    private readonly api: MondayClient,
  ) {
    this.flow = String(this.config.get('MONDAY_OAUTH_FLOW') ?? '2.1').trim().toLowerCase() === 'legacy' ? 'legacy' : '2.1';
    this.usesPkce = this.flow === '2.1';
  }

  // ------------------------------------------------------------------------------------------------ OAuth

  isConfigured(): boolean {
    return !!this.config.get('MONDAY_CLIENT_ID') && !!this.config.get('MONDAY_CLIENT_SECRET');
  }

  private get scopes(): string {
    const raw = this.config.get<string>('MONDAY_SCOPES');
    return raw === undefined || raw === null ? DEFAULT_SCOPES : String(raw).trim();
  }

  authorizeUrl(ctx: AuthorizeContext): string {
    const u = new URL(AUTHORIZE_URL);
    u.searchParams.set('client_id', this.config.get<string>('MONDAY_CLIENT_ID')!);
    u.searchParams.set('redirect_uri', ctx.redirectUri);
    u.searchParams.set('state', ctx.state);
    if (this.scopes) u.searchParams.set('scope', this.scopes);
    if (this.usesPkce && ctx.pkceChallenge) {
      u.searchParams.set('code_challenge_method', 'S256');
      u.searchParams.set('code_challenge', ctx.pkceChallenge);
    }
    return u.toString();
  }

  private async tokenCall(url: string, form: Record<string, string>, asJson: boolean): Promise<TokenResponse & { status: number }> {
    const all = { ...form, client_id: this.config.get<string>('MONDAY_CLIENT_ID')!, client_secret: this.config.get<string>('MONDAY_CLIENT_SECRET')! };
    const res = await this.http.request({
      rateKey: 'oauth:MONDAY',
      url,
      method: 'POST',
      headers: { 'content-type': asJson ? 'application/json' : 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: asJson ? JSON.stringify(all) : new URLSearchParams(all),
    });
    let parsed: TokenResponse = {};
    try {
      parsed = res.json<TokenResponse>();
    } catch {
      /* the status decides */
    }
    return { ...parsed, status: res.status };
  }

  /**
   * monday sends `scope` comma-separated (legacy) or space-separated (2.1) and, in the legacy flow, NO expiry at all (the token lives until
   * the app is uninstalled). The 2.1 access token is a JWT: its `exp` is the expiry when `expires_in` is absent.
   */
  private toTokenSet(r: TokenResponse, previousRefresh?: string): TokenSet {
    let expiresAt: Date | undefined;
    const n = typeof r.expires_in === 'string' ? Number(r.expires_in) : r.expires_in;
    if (typeof n === 'number' && Number.isFinite(n) && n > 0) expiresAt = new Date(Date.now() + n * 1000);
    else if (r.access_token) expiresAt = jwtExpiry(r.access_token);
    return {
      accessToken: r.access_token!,
      refreshToken: r.refresh_token ?? previousRefresh,
      expiresAt,
      scopes: (r.scope ?? this.scopes).split(/[\s,]+/).filter(Boolean),
      tokenType: r.token_type ?? 'Bearer',
    };
  }

  /** The connection is the monday ACCOUNT (a person can belong to several and picks one on the consent screen). */
  async exchangeCode(params: CallbackParams, ctx: ExchangeContext): Promise<{ tokens: TokenSet; account: ExternalAccount }> {
    if (!params.code) throw new Error('monday callback without code');
    const form: Record<string, string> = { grant_type: 'authorization_code', code: params.code, redirect_uri: ctx.redirectUri };
    if (this.usesPkce && ctx.pkceVerifier) form.code_verifier = ctx.pkceVerifier;
    const r = await this.tokenCall(TOKEN_URL[this.flow], form, this.flow === 'legacy');
    if (r.status < 200 || r.status >= 300 || !r.access_token) throw new Error(`monday token endpoint: HTTP ${r.status}${r.error ? ` ${r.error}` : ''}`);
    const me = await this.api.query<{ me?: { id?: string | number; name?: string; account?: { id?: string | number; name?: string } } }>(
      { accessToken: r.access_token },
      'query { me { id name account { id name } } }',
    );
    const account = me.me?.account;
    if (account?.id === undefined || account.id === null || String(account.id) === '') throw new Error('monday did not say which account this is');
    return { tokens: this.toTokenSet(r), account: { id: String(account.id), name: (account.name ?? '').toString() || `monday account ${account.id}` } };
  }

  /** 2.1 only. The refresh token ROTATES (each answer carries a new one and kills the old): the caller serializes refreshes under the per-connection lock. */
  async refresh(tokens: TokenSet): Promise<TokenSet> {
    if (!tokens.refreshToken) throw new ProviderAuthRejectedError('This monday.com connection has no refresh token; reconnect it');
    const r = await this.tokenCall(TOKEN_URL['2.1'], { grant_type: 'refresh_token', refresh_token: tokens.refreshToken }, false);
    if (r.status === 400 || r.status === 401 || r.status === 403) throw new ProviderAuthRejectedError(`monday.com rejected the refresh token (${r.error ?? r.status})`);
    if (r.status < 200 || r.status >= 300 || !r.access_token) throw new ProviderHttpError(r.status, TOKEN_URL['2.1'], r.error_description ?? r.error ?? '');
    const next = this.toTokenSet(r, tokens.refreshToken);
    return { ...next, scopes: r.scope ? next.scopes : tokens.scopes };
  }

  /** 2.1 has a revocation endpoint; the legacy flow has none (the person uninstalls the app in monday). */
  async revoke(tokens: TokenSet, _account: ExternalAccount): Promise<void> {
    if (this.flow !== '2.1') return;
    const token = tokens.refreshToken ?? tokens.accessToken;
    if (!token) return;
    await this.tokenCall(REVOKE_URL, { token, token_type_hint: tokens.refreshToken ? 'refresh_token' : 'access_token' }, false);
  }

  // ------------------------------------------------------------------------------------------------ import: discover / estimate

  private call(ctx: ImportAdapterContext): MondayCallContext {
    return { connectionId: ctx.connectionId, accessToken: ctx.accessToken };
  }

  async discover(ctx: ImportAdapterContext): Promise<SourceTree> {
    const c = this.call(ctx);
    const workspaces = (await this.api.pages<{ workspaces?: MnWorkspace[] }, MnWorkspace>(c, (p, l) => `query { workspaces(limit: ${l}, page: ${p}) { id name } }`, (r) => r.workspaces, 100, 500)).items;
    const boards = (
      await this.api.pages<{ boards?: MnBoard[] }, MnBoard>(
        c,
        (p, l) => `query { boards(limit: ${l}, page: ${p}, state: active, order_by: created_at) { id name type workspace_id columns { id title type archived } groups { id title } } }`,
        (r) => r.boards,
        50,
        MAX_DISCOVER_BOARDS,
      )
    ).items;

    const nodes: SourceTree['nodes'] = [];
    const wsIds = new Set<string>();
    const wsId = (b: MnBoard): string => (b.workspace_id === null || b.workspace_id === undefined || String(b.workspace_id) === '' ? 'main' : String(b.workspace_id));
    for (const w of workspaces) {
      const id = w.id === null || w.id === undefined ? 'main' : String(w.id);
      if (wsIds.has(id)) continue;
      wsIds.add(id);
      nodes.push({ id, type: 'workspace', name: (w.name ?? '').toString() || (id === 'main' ? 'Main workspace' : `Workspace ${id}`), parentId: null, selectable: false });
    }
    const seen = new Set<string>();
    for (const b of boards) {
      if (!b?.id || (b.type && b.type !== 'board')) continue; // subitem boards, docs ... are not projects
      const id = String(b.id);
      if (seen.has(id)) continue;
      seen.add(id);
      const parent = wsId(b);
      if (!wsIds.has(parent)) {
        wsIds.add(parent);
        nodes.push({ id: parent, type: 'workspace', name: parent === 'main' ? 'Main workspace' : `Workspace ${parent}`, parentId: null, selectable: false });
      }
      const fields = suggestFieldRoles(fieldsOfBoard(b));
      nodes.push({ id, type: 'board', name: (b.name ?? '').toString() || `Board ${id}`, parentId: parent, selectable: true, ...(fields.length ? { fields } : {}) });
    }
    return { nodes };
  }

  async estimate(ctx: ImportAdapterContext, selection: ImportSelection, options: ImportOptions): Promise<ImportEstimate> {
    const c = this.call(ctx);
    const warnings: NonNullable<ImportEstimate['warnings']> = [];
    const s = await this.structure(c, selection, warnings);
    const checked = validateBundle(s.page);
    if ('fatal' in checked) throw new Error(`monday structure page rejected: ${checked.fatal.code} ${checked.fatal.message}`);

    const projects: ImportEstimate['projects'] = [];
    let total = 0;
    let calls = Math.ceil(s.boards.length / BOARDS_PER_CALL) + Math.ceil((checked.bundle.users?.length ?? 0) / 100) + 2;
    for (const b of s.boards) {
      const n = typeof b.items_count === 'number' && b.items_count >= 0 ? b.items_count : 0;
      if (typeof b.items_count !== 'number') warnings.push({ code: 'COUNT_UNAVAILABLE', message: `The number of items of ${b.name ?? b.id} could not be read.` });
      total += n;
      const pages = Math.max(1, Math.ceil(n / ITEMS_LIMIT));
      calls += pages * (1 + (options.comments || options.attachments ? 1 : 0));
      projects.push({ sourceId: String(b.id), name: (b.name ?? '').toString() || `Board ${b.id}`, tasks: n });
    }

    const inventory = buildInventory([checked.bundle]);
    warnings.push(...s.warnings);
    const limit = await this.dailyLimit(c);
    if (limit !== null && calls > limit * 0.8) {
      warnings.push({
        code: 'DAILY_LIMIT',
        message: `This import needs about ${calls.toLocaleString('en-US')} monday.com API calls and your plan allows ${limit.toLocaleString('en-US')} a day (resetting at midnight UTC)${calls > limit ? ': it will pause when the limit is reached and continue by itself after the reset' : ', which leaves little room for anything else using the API'}.`,
      });
    }
    if (options.history) warnings.push({ code: 'HISTORY_NOT_AVAILABLE', message: 'monday.com keeps activity logs apart from items and limits how far back they go, so the history is not imported.' });
    return { projects, users: checked.bundle.users?.length ?? 0, warnings, inventory };
  }

  /** The plan's daily call limit, or null when the plan is not known (a failure here never fails the preview). */
  private async dailyLimit(c: MondayCallContext): Promise<number | null> {
    try {
      const r = await this.api.query<{ account?: { plan?: { tier?: string } | null } | null }>(c, 'query { account { plan { tier } } }');
      const tier = (r.account?.plan?.tier ?? '').toString().toLowerCase();
      return DAILY_LIMIT[tier] ?? null;
    } catch (e) {
      if (e instanceof ProviderAuthRejectedError) throw e;
      return null;
    }
  }

  // ------------------------------------------------------------------------------------------------ import: fetchBundle

  async fetchBundle(input: FetchBundleInput): Promise<FetchBundleResult> {
    const c = this.call(input.ctx);
    if (input.cursor === null || input.cursor === undefined) {
      const s = await this.structure(c, input.selection, []);
      const next: MondayCursor | null = s.plans.length ? { v: 1, plans: s.plans, i: 0, cur: null, pos: 0, skip: 0 } : null;
      return { bundle: s.page, next };
    }
    return this.itemsStep(c, this.parseCursor(input.cursor), input.options);
  }

  /**
   * Opens one monday file as a stream. The ref is OURS (`monday-asset:<id>`, never an address); a fresh `public_url` is asked for NOW
   * (it is valid for one hour and different every time), checked against the host allow-list, and fetched WITHOUT the access token (it
   * is public by design, and the token must not travel to a storage host).
   */
  async fetchAttachment(input: FetchAttachmentInput): Promise<FetchedAttachment> {
    const id = parseAssetRef(input.providerRef);
    if (!id) throw new ProviderHttpError(400, 'monday:file', 'Not a monday.com file reference; it was not fetched');
    const r = await this.api.query<{ assets?: MnAsset[] | null }>(this.call(input.ctx), 'query ($ids: [ID!]!) { assets(ids: $ids) { id name public_url } }', { ids: [id] });
    const asset = (r.assets ?? []).find((a) => String(a?.id) === id);
    if (!asset) throw new ProviderHttpError(404, `monday:asset:${id}`, 'monday.com no longer has this file');
    if (!asset.public_url) throw new ProviderHttpError(422, `monday:asset:${id}`, 'monday.com gave no download address for this file');
    if (!isAllowedDownloadUrl(asset.public_url, this.extraFileHosts())) {
      throw new ProviderHttpError(400, `monday:asset:${id}`, 'monday.com pointed at an address that is not a monday file host; it was not fetched');
    }
    const res = await this.http.openStream({ rateKey: `files:${input.ctx.connectionId}`, url: asset.public_url, headers: {} });
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
    return String(this.config.get('MONDAY_FILE_HOSTS') ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter((h) => /^\.?[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(h));
  }

  private parseCursor(raw: unknown): MondayCursor {
    const c = raw as Partial<MondayCursor> | null;
    const isStr = (x: unknown): x is string => typeof x === 'string';
    const strRecord = (x: unknown): boolean => !!x && typeof x === 'object' && !Array.isArray(x) && Object.values(x as object).every(isStr);
    const plan = (p: unknown): boolean => {
      const q = p as Partial<BoardPlan> | null;
      return !!q && typeof q === 'object' && isStr(q.id) && (q.kind === 'column' || q.kind === 'group' || q.kind === 'none') && strRecord(q.roles) &&
        Array.isArray(q.sv) && q.sv.every(isStr) && strRecord(q.lbl) && strRecord(q.cm) && Array.isArray(q.dep) && q.dep.every(isStr);
    };
    const ok = !!c && typeof c === 'object' && c.v === 1 && Array.isArray(c.plans) && c.plans.every(plan) && Number.isInteger(c.i) && c.i! >= 0 && c.i! <= c.plans.length &&
      (c.cur === null || isStr(c.cur)) && Number.isInteger(c.pos) && c.pos! >= 0 && Number.isInteger(c.skip) && c.skip! >= 0;
    if (!ok) throw new Error('The saved monday.com cursor is not valid; start the import again');
    return c as MondayCursor;
  }

  /** Selected boards, in a stable order, capped at what a page holds. */
  private boardIds(selection: ImportSelection, warnings: NonNullable<ImportEstimate['warnings']>): Array<{ id: string; fieldRoles?: ImportSelection['sources'][number]['fieldRoles'] }> {
    const out = new Map<string, ImportSelection['sources'][number]['fieldRoles']>();
    for (const s of selection.sources) {
      if (s.type !== 'board') throw new Error(`monday.com can import boards (got "${s.type}")`);
      if (!/^\d{1,20}$/.test(s.id)) throw new Error('A selected monday.com board id is not valid');
      if (!out.has(s.id)) out.set(s.id, s.fieldRoles);
    }
    let list = [...out].sort(([a], [b]) => (a.length - b.length) || (a < b ? -1 : 1)).map(([id, fieldRoles]) => ({ id, fieldRoles }));
    if (list.length > MAX_BOARDS) {
      warnings.push({ code: 'BOARDS_CAPPED', message: `Only the first ${MAX_BOARDS} boards of the selection are imported; select fewer.` });
      list = list.slice(0, MAX_BOARDS);
    }
    return list;
  }

  /** Page 0: the people of the account, every board as a project (statuses from the chosen column / group), the custom fields. */
  private async structure(c: MondayCallContext, selection: ImportSelection, warnings: NonNullable<ImportEstimate['warnings']>) {
    const wanted = this.boardIds(selection, warnings);
    const boards: MnBoard[] = [];
    for (let i = 0; i < wanted.length; i += BOARDS_PER_CALL) {
      const ids = wanted.slice(i, i + BOARDS_PER_CALL).map((w) => w.id);
      const r = await this.api.query<{ boards?: MnBoard[] | null }>(
        c,
        'query ($ids: [ID!], $limit: Int) { boards(ids: $ids, limit: $limit, state: all) { id name type state workspace_id url description items_count columns { id title type archived settings_str } groups { id title archived position } } }',
        { ids, limit: BOARDS_PER_CALL },
      );
      const got = new Map((r.boards ?? []).filter((b) => b?.id !== undefined).map((b) => [String(b.id), b]));
      for (const id of ids) {
        const b = got.get(id);
        if (!b || (b.type && b.type !== 'board')) throw new ProviderHttpError(404, `monday:board:${id}`, 'A selected monday.com board no longer exists or is not a board');
        boards.push(b);
      }
    }

    const plans: BoardPlan[] = [];
    const projects = [];
    const fields = new Map<string, CanonicalCustomField>();
    const skipped = new Map<string, number>();
    for (const b of boards) {
      const chosen = wanted.find((w) => w.id === String(b.id))?.fieldRoles;
      const resolved = resolveFieldRoles(suggestFieldRoles(fieldsOfBoard(b)), chosen);
      const name = (b.name ?? '').toString() || `Board ${b.id}`;
      for (const w of [guessedRolesWarning(name, resolved), missingRolesWarning(name, resolved)]) if (w) warnings.push(w);
      const built = buildBoard(b, resolved);
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
    if (skipped.size) warnings.push({ code: 'COLUMNS_SKIPPED', message: `Some monday.com columns have no equivalent and are not imported: ${[...skipped].map(([t, n]) => `${n} x ${t}`).join(', ')}.` });
    let customFields = [...fields.values()];
    if (customFields.length > L.maxCustomFields) {
      warnings.push({ code: 'CUSTOM_FIELDS_CAPPED', message: `The selected boards use ${customFields.length} different custom columns; only the first ${L.maxCustomFields} are imported.` });
      customFields = customFields.slice(0, L.maxCustomFields);
    }

    const users = await this.api
      .pages<{ users?: MnUser[] }, MnUser>(c, (p, l) => `query { users(limit: ${l}, page: ${p}) { id name email is_guest enabled } }`, (r) => r.users, 100, MAX_USERS + 1)
      .then((r) => r.items)
      .catch((e: unknown) => {
        if (!(e instanceof ProviderHttpError) || e.status === 429) throw e;
        warnings.push({ code: 'USERS_UNAVAILABLE', message: 'monday.com did not allow reading the account\'s people: assignees can only be matched by name.' });
        return [] as MnUser[];
      });
    if (users.length > MAX_USERS) warnings.push({ code: 'USERS_CAPPED', message: `Only the first ${MAX_USERS} monday.com people are considered when matching people.` });

    const page: CanonicalBundle = { ...emptyPage(), source: { ...MONDAY_SYSTEM }, users: users.slice(0, MAX_USERS).map(toUser), projects };
    if (customFields.length) page.customFields = customFields;
    return { page, plans, boards, warnings };
  }

  private itemsQuery(first: boolean, light: boolean): string {
    const sel = light ? 'id' : ITEM_FIELDS;
    return first
      ? `query ($id: [ID!], $limit: Int) { boards(ids: $id) { items_page(limit: $limit) { cursor items { ${sel} } } } }`
      : `query ($cursor: String!, $limit: Int) { next_items_page(limit: $limit, cursor: $cursor) { cursor items { ${sel} } } }`;
  }

  private async rawItems(c: MondayCallContext, boardId: string, cursor: string | null, light: boolean): Promise<{ cursor: string | null; items: MnItem[] }> {
    if (cursor === null) {
      const r = await this.api.query<{ boards?: Array<{ items_page?: { cursor?: string | null; items?: MnItem[] | null } | null }> | null }>(c, this.itemsQuery(true, light), { id: [boardId], limit: ITEMS_LIMIT });
      const board = r.boards?.[0];
      if (!board) throw new ProviderHttpError(404, `monday:board:${boardId}`, 'A selected monday.com board no longer exists');
      return { cursor: board.items_page?.cursor ?? null, items: board.items_page?.items ?? [] };
    }
    const r = await this.api.query<{ next_items_page?: { cursor?: string | null; items?: MnItem[] | null } | null }>(c, this.itemsQuery(false, light), { cursor, limit: ITEMS_LIMIT });
    return { cursor: r.next_items_page?.cursor ?? null, items: r.next_items_page?.items ?? [] };
  }

  /**
   * One page of items. monday keeps a cursor for 60 minutes from the FIRST request and never extends it, so a big board can outlive its
   * cursor mid-import. Then the walk is rebuilt from the start with id-only pages (cheap, same page size so the boundaries line up) up
   * to the page that starts at `pos`, and the real page is read from there.
   */
  private async itemsPage(c: MondayCallContext, boardId: string, cursor: string | null, pos: number): Promise<{ used: string | null; cursor: string | null; items: MnItem[] }> {
    try {
      const r = await this.rawItems(c, boardId, cursor, false);
      return { used: cursor, ...r };
    } catch (e) {
      if (!(e instanceof MondayCursorExpiredError) || cursor === null) throw e;
    }
    let walkCursor: string | null = null;
    let walked = 0;
    while (walked < pos) {
      const step = await this.rawItems(c, boardId, walkCursor, true);
      walked += step.items.length;
      walkCursor = step.cursor;
      if (!walkCursor) return { used: null, cursor: null, items: [] }; // the board shrank below where we were: nothing left to read
      if (step.items.length === 0) break;
    }
    const r = await this.rawItems(c, boardId, walkCursor, false);
    return { used: walkCursor, ...r };
  }

  private async itemsStep(c: MondayCallContext, cur: MondayCursor, options: ImportOptions): Promise<FetchBundleResult> {
    const plan = cur.plans[cur.i];
    if (!plan) return { bundle: emptyPage(), next: null };
    const page = await this.itemsPage(c, plan.id, cur.cur, cur.pos);

    // which items fit in this bundle page (a parent + its subitems count as tasks)
    const emit: MnItem[] = [];
    let tasks = 0;
    let idx = cur.skip;
    for (; idx < page.items.length; idx++) {
      const item = page.items[idx];
      const n = 1 + Math.min((item.subitems ?? []).length, MAX_SUBITEMS);
      if (emit.length > 0 && tasks + n > TASK_BUDGET) break;
      emit.push(item);
      tasks += n;
    }

    const extras = await this.extrasOf(c, emit, options);
    const out: CanonicalTask[] = [];
    const deps = new Map<string, CanonicalDependency>();
    for (const item of emit) {
      const t = toTask(item, plan, true);
      const x = extras.get(String(item.id));
      if (x) {
        const comments = toComments(x.updates ?? []);
        if (comments.length && options.comments) t.comments = comments;
        if (options.attachments) {
          const files = toAttachments(t.externalId, [...(x.assets ?? []), ...(x.updates ?? []).flatMap((u) => u.assets ?? [])]);
          if (files.length) t.attachments = files;
        }
      }
      out.push(t);
      for (const d of toDependencies(item, plan)) if (deps.size < L.maxDependencies) deps.set(d.externalId, d);
      for (const sub of (item.subitems ?? []).slice(0, MAX_SUBITEMS)) if (sub?.id !== undefined) out.push(toSubitem(sub, t.externalId, plan));
    }

    const bundle = emptyPage();
    if (out.length) bundle.tasks = out;
    if (deps.size) bundle.dependencies = [...deps.values()];

    let next: MondayCursor | null;
    if (idx < page.items.length) next = { ...cur, cur: page.used, skip: idx };
    else if (page.cursor && page.items.length > 0) next = { ...cur, cur: page.cursor, pos: cur.pos + page.items.length, skip: 0 };
    else next = { ...cur, i: cur.i + 1, cur: null, pos: 0, skip: 0 };
    if (next.i >= next.plans.length) next = null;
    return { bundle, next };
  }

  /** Comments and files of up to 100 items in ONE call (a call per item would eat the daily limit). */
  private async extrasOf(c: MondayCallContext, items: MnItem[], options: ImportOptions): Promise<Map<string, MnItemExtras>> {
    const out = new Map<string, MnItemExtras>();
    if ((!options.comments && !options.attachments) || items.length === 0) return out;
    const parts: string[] = [];
    if (options.attachments) parts.push(`assets { ${ASSET_FIELDS} }`);
    parts.push(
      `updates(limit: 100) { id ${options.comments ? 'body text_body created_at creator { id name } replies { id body text_body created_at creator { id name } }' : ''} ${options.attachments ? `assets { ${ASSET_FIELDS} }` : ''} }`,
    );
    const query = `query ($ids: [ID!], $limit: Int) { items(ids: $ids, limit: $limit) { id ${parts.join(' ')} } }`;
    for (let i = 0; i < items.length; i += EXTRAS_IDS) {
      const ids = items.slice(i, i + EXTRAS_IDS).map((x) => String(x.id));
      const r = await this.api
        .query<{ items?: MnItemExtras[] | null }>(c, query, { ids, limit: EXTRAS_IDS })
        .catch((e: unknown) => {
          // an item that vanished or became unreadable must not fail the page: it just has no comments or files
          if (e instanceof ProviderHttpError && (e.status === 403 || e.status === 404)) return { items: [] as MnItemExtras[] };
          throw e;
        });
      for (const x of r.items ?? []) if (x?.id !== undefined) out.set(String(x.id), x);
    }
    return out;
  }
}

