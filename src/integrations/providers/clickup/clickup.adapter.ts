import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IntegrationProvider } from '@prisma/client';
import { CanonicalBundle, CanonicalCustomField, CanonicalIssueType, CanonicalTag, validateBundle } from '../../../imports/canonical';
import { FetchAttachmentInput, FetchBundleInput, FetchBundleResult, FetchedAttachment, ImportAdapterContext, ImportCapableAdapter } from '../../../imports/import-adapter';
import { ImportEstimate, ImportOptions, ImportSelection, SourceTree } from '../../../imports/imports.types';
import { buildInventory } from '../../../imports/mapping/mapping.inventory';
import { priorityKey } from '../../../imports/mapping/mapping.tables';
import { AuthorizeContext, CallbackParams, Capability, ExchangeContext, ExternalAccount, ProviderAuthRejectedError, ProviderHttpError, TokenSet } from '../../core/integration.types';
import { ProviderHttpClient } from '../../core/provider-http.client';
import { CLICKUP_API, ClickUpCallContext, ClickUpClient } from './clickup.client';
import {
  CLICKUP_SYSTEM,
  emptyPage,
  isClickUpFileUrl,
  isSupportedField,
  toAttachments,
  toComments,
  toCustomField,
  toDependencies,
  toProject,
  toTask,
  toUser,
} from './clickup.normalize';
import { CuComment, CuCustomField, CuFolder, CuList, CuSpace, CuTag, CuTask, CuTeam } from './clickup.types';

const AUTHORIZE_URL = 'https://app.clickup.com/api';
const TOKEN_URL = `${CLICKUP_API}/oauth/token`;

/** ClickUp pages are fixed at 100 tasks; comments at 25. */
const TASK_PAGE = 100;
const COMMENT_PAGE = 25;
const MAX_LISTS = 500;
const MAX_USERS = 2000;
const MAX_COUNT_PAGES = 100;
const MAX_COMMENT_PAGES = 40;

/** Where the next call continues. Plain JSON (it lives in the job's checkpoint): the lists are resolved ONCE, on the structure page. */
interface ClickUpCursor {
  v: 1;
  /** The sorted list ids of this import. */
  lists: string[];
  /** Folder name of each list ('' = none), parallel to `lists`: it becomes a tag on that list's tasks. */
  folders: string[];
  /** custom_item_id values declared as issue types. */
  it: string[];
  /** Index into `lists`. */
  i: number;
  /** false = the live tasks of the list, then true = its archived ones. */
  arch: boolean;
  /** ClickUp's page number (0-based). */
  page: number;
}

interface TokenResponse {
  access_token?: string;
  token_type?: string;
  err?: string;
  error?: string;
}

/**
 * ClickUp (step 4.7, ADR-0036): OAuth 2 + the import capability.
 *
 * What maps to what (diagrams 06 and 07): a LIST is one of our projects (ClickUp statuses belong to the list); the FOLDER it lives
 * in is kept as a tag on its tasks; tags -> tags; subtasks -> parent; custom task types -> issue types; custom fields -> project
 * fields (best match, the rest reported); assignees (several) -> assignees; dependencies -> BLOCKS, links -> RELATES_TO; comments
 * (+ replies), files -> files. NOT imported: history (ClickUp's public API has no change history), sprints, views, automations.
 *
 * Written against ClickUp's public documentation; tested against SYNTHETIC responses. No live ClickUp workspace was called.
 */
@Injectable()
export class ClickUpAdapter implements ImportCapableAdapter {
  readonly provider = IntegrationProvider.CLICKUP;
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>(['IMPORT']);
  readonly usesPkce = false;
  /** A ClickUp Space is one of our workspaces (diagram 06). */
  readonly workspaceNodeType = 'space';

  constructor(
    private readonly config: ConfigService,
    private readonly http: ProviderHttpClient,
    private readonly api: ClickUpClient,
  ) {}

  // ------------------------------------------------------------------------------------------------ OAuth

  isConfigured(): boolean {
    return !!this.config.get('CLICKUP_CLIENT_ID') && !!this.config.get('CLICKUP_CLIENT_SECRET');
  }

  authorizeUrl(ctx: AuthorizeContext): string {
    const u = new URL(AUTHORIZE_URL);
    u.searchParams.set('client_id', this.config.get<string>('CLICKUP_CLIENT_ID')!);
    u.searchParams.set('redirect_uri', ctx.redirectUri);
    u.searchParams.set('state', ctx.state);
    return u.toString();
  }

  async exchangeCode(params: CallbackParams, _ctx: ExchangeContext): Promise<{ tokens: TokenSet; account: ExternalAccount }> {
    if (!params.code) throw new Error('ClickUp callback without code');
    const res = await this.http.request({
      rateKey: 'oauth:CLICKUP',
      url: TOKEN_URL,
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ client_id: this.config.get<string>('CLICKUP_CLIENT_ID'), client_secret: this.config.get<string>('CLICKUP_CLIENT_SECRET'), code: params.code }) as never,
    });
    let body: TokenResponse = {};
    try {
      body = res.json<TokenResponse>();
    } catch {
      /* handled by status */
    }
    if (!res.ok || !body.access_token) throw new Error(`ClickUp token endpoint: HTTP ${res.status}${body.err || body.error ? ` ${body.err ?? body.error}` : ''}`);
    // A ClickUp token does not expire and has no refresh token (the docs: "currently does not expire; this is subject to change").
    const tokens: TokenSet = { accessToken: body.access_token, scopes: [], tokenType: body.token_type ?? 'Bearer' };

    // One token can cover several Workspaces; a connection is one. Refuse the ambiguous case instead of guessing.
    const teams = await this.api.get<{ teams?: CuTeam[] }>({ accessToken: tokens.accessToken }, '/team');
    const list = teams.teams ?? [];
    if (list.length === 0) throw new Error('ClickUp authorized no Workspace; connect again and select one on ClickUp\'s consent screen');
    if (list.length > 1) throw new Error('You authorized several ClickUp Workspaces; connect again and select exactly one');
    return { tokens, account: { id: String(list[0].id), name: (list[0].name ?? '').toString() || `Workspace ${list[0].id}` } };
  }

  /** ClickUp has no token revocation endpoint; the person removes the app in ClickUp. Nothing to call. */
  async revoke(_tokens: TokenSet, _account: ExternalAccount): Promise<void> {
    return;
  }

  // ------------------------------------------------------------------------------------------------ import: discover / estimate

  async discover(ctx: ImportAdapterContext): Promise<SourceTree> {
    const c = this.call(ctx);
    const nodes: SourceTree['nodes'] = [];
    const spaces = await this.api.get<{ spaces?: CuSpace[] }>(c, `/team/${enc(ctx.externalAccountId)}/space`, { archived: false });
    for (const s of spaces.spaces ?? []) {
      nodes.push({ id: String(s.id), type: 'space', name: (s.name ?? '').toString() || `Space ${s.id}`, parentId: null, selectable: true });
      const folders = await this.api.get<{ folders?: CuFolder[] }>(c, `/space/${enc(s.id)}/folder`, { archived: false });
      for (const f of folders.folders ?? []) {
        nodes.push({ id: String(f.id), type: 'folder', name: (f.name ?? '').toString() || `Folder ${f.id}`, parentId: String(s.id), selectable: true });
        for (const l of f.lists ?? []) nodes.push({ id: String(l.id), type: 'list', name: (l.name ?? '').toString() || `List ${l.id}`, parentId: String(f.id), selectable: true });
      }
      const lone = await this.api.get<{ lists?: CuList[] }>(c, `/space/${enc(s.id)}/list`, { archived: false });
      for (const l of lone.lists ?? []) nodes.push({ id: String(l.id), type: 'list', name: (l.name ?? '').toString() || `List ${l.id}`, parentId: String(s.id), selectable: true });
    }
    return { nodes };
  }

  async estimate(ctx: ImportAdapterContext, selection: ImportSelection, options: ImportOptions): Promise<ImportEstimate> {
    const c = this.call(ctx);
    const warnings: NonNullable<ImportEstimate['warnings']> = [];
    const listIds = await this.resolveLists(c, selection, warnings);
    const structure = await this.structurePage(c, ctx, listIds, warnings);
    const checked = validateBundle(structure.page);
    if ('fatal' in checked) throw new Error(`ClickUp structure page rejected: ${checked.fatal.code} ${checked.fatal.message}`);

    const projects: ImportEstimate['projects'] = [];
    let total = 0;
    for (const l of structure.lists) {
      const { count, capped } = await this.countTasks(c, l.id);
      total += count;
      projects.push({ sourceId: l.id, name: (l.name ?? '').toString() || `List ${l.id}`, tasks: count });
      if (capped) warnings.push({ code: 'COUNT_CAPPED', message: `${l.name} has more than ${count} tasks; the real number is higher.` });
    }

    const inventory = buildInventory([checked.bundle]);
    const have = new Set(inventory.priorities.map(priorityKey));
    for (const p of ['Urgent', 'High', 'Normal', 'Low']) if (!have.has(priorityKey(p))) inventory.priorities.push(p);

    // ClickUp's list endpoint does not carry comments or files: they cost one request per task, at 100 requests a minute per token.
    const perTask = (options.comments ? 1 : 0) + (options.attachments ? 1 : 0);
    if (perTask > 0 && total > 0) {
      const minutes = Math.ceil((total * perTask) / this.api.requestsPerMinute);
      warnings.push({
        code: 'CONTENT_SLOW',
        message: `Comments and files are fetched one task at a time and ClickUp allows about ${this.api.requestsPerMinute} requests a minute: reading them for ${total} tasks takes about ${minutes >= 120 ? `${Math.round(minutes / 60)} hours` : `${minutes} minutes`}.`,
      });
    }
    if (options.history) {
      warnings.push({ code: 'HISTORY_NOT_AVAILABLE', message: 'ClickUp\'s API has no change history for tasks, so the activity history cannot be imported.' });
    }
    return { projects, users: checked.bundle.users?.length ?? 0, warnings, inventory };
  }

  // ------------------------------------------------------------------------------------------------ import: fetchBundle

  async fetchBundle(input: FetchBundleInput): Promise<FetchBundleResult> {
    const c = this.call(input.ctx);
    if (input.cursor === null || input.cursor === undefined) {
      const listIds = await this.resolveLists(c, input.selection, []);
      const s = await this.structurePage(c, input.ctx, listIds, []);
      const next: ClickUpCursor | null = s.lists.length
        ? { v: 1, lists: s.lists.map((l) => String(l.id)), folders: s.lists.map((l) => (l.folder && !l.folder.hidden ? (l.folder.name ?? '').toString() : '')), it: s.issueTypeIds, i: 0, arch: false, page: 0 }
        : null;
      return { bundle: s.page, next };
    }
    return this.taskPage(c, this.parseCursor(input.cursor), input.options);
  }

  /**
   * Opens one ClickUp file as a stream. The ref is an address ClickUp itself returned, but it is checked again here: only https
   * on a ClickUp-owned host is requested, and the access token is sent only there. A 401 means the token is dead (the job pauses);
   * any other refusal is about this file. Whether a download needs the Authorization header depends on the Workspace's "private
   * attachment links" setting: it is sent either way (unverified live, ADR-0036).
   */
  async fetchAttachment(input: FetchAttachmentInput): Promise<FetchedAttachment> {
    if (!isClickUpFileUrl(input.providerRef)) throw new ProviderHttpError(400, 'clickup:file', 'Not a ClickUp file address; it was not fetched');
    try {
      const res = await this.http.openStream({
        rateKey: `files:${input.ctx.connectionId}`,
        url: input.providerRef,
        headers: { authorization: `Bearer ${input.ctx.accessToken}` },
      });
      const raw = res.headers.get('content-length');
      const len = raw === null ? NaN : Number(raw);
      return {
        stream: res.body,
        ...(Number.isFinite(len) && len >= 0 ? { sizeBytes: len } : {}),
        ...(res.headers.get('content-type') ? { mimeType: res.headers.get('content-type') as string } : {}),
      };
    } catch (e) {
      if (e instanceof ProviderHttpError && e.status === 401) throw new ProviderAuthRejectedError('ClickUp rejected the access token (HTTP 401)');
      throw e;
    }
  }

  // ------------------------------------------------------------------------------------------------ internals

  private call(ctx: ImportAdapterContext): ClickUpCallContext {
    return { connectionId: ctx.connectionId, accessToken: ctx.accessToken };
  }

  private parseCursor(raw: unknown): ClickUpCursor {
    const c = raw as Partial<ClickUpCursor> | null;
    const strings = (a: unknown): a is string[] => Array.isArray(a) && a.every((x) => typeof x === 'string');
    const ok =
      !!c && typeof c === 'object' && c.v === 1 && strings(c.lists) && strings(c.folders) && strings(c.it) &&
      c.lists.length === c.folders.length && Number.isInteger(c.i) && c.i! >= 0 && c.i! < c.lists.length &&
      typeof c.arch === 'boolean' && Number.isInteger(c.page) && c.page! >= 0;
    if (!ok) throw new Error('The saved ClickUp cursor is not valid; start the import again');
    return c as ClickUpCursor;
  }

  /** Selected spaces / folders / lists -> the sorted, de-duplicated list ids. */
  private async resolveLists(c: ClickUpCallContext, selection: ImportSelection, warnings: NonNullable<ImportEstimate['warnings']>): Promise<string[]> {
    const ids = new Set<string>();
    for (const s of selection.sources) {
      if (s.type === 'list') ids.add(s.id);
      else if (s.type === 'folder') {
        const f = await this.api.get<{ lists?: CuList[] }>(c, `/folder/${enc(s.id)}`);
        for (const l of f.lists ?? []) ids.add(String(l.id));
      } else if (s.type === 'space') {
        const folders = await this.api.get<{ folders?: CuFolder[] }>(c, `/space/${enc(s.id)}/folder`, { archived: false });
        for (const f of folders.folders ?? []) for (const l of f.lists ?? []) ids.add(String(l.id));
        const lone = await this.api.get<{ lists?: CuList[] }>(c, `/space/${enc(s.id)}/list`, { archived: false });
        for (const l of lone.lists ?? []) ids.add(String(l.id));
      } else throw new Error(`ClickUp can import spaces, folders and lists (got "${s.type}")`);
    }
    let sorted = [...ids].sort();
    if (sorted.length > MAX_LISTS) {
      warnings.push({ code: 'LISTS_CAPPED', message: `Only the first ${MAX_LISTS} lists of the selection are imported; select fewer spaces or folders.` });
      sorted = sorted.slice(0, MAX_LISTS);
    }
    return sorted;
  }

  /** Page 0: the workspace's people, each list as a project with its statuses and fields, the tags, the custom task types. */
  private async structurePage(c: ClickUpCallContext, ctx: ImportAdapterContext, listIds: string[], warnings: NonNullable<ImportEstimate['warnings']>) {
    const teams = await this.api.get<{ teams?: CuTeam[] }>(c, '/team');
    const team = (teams.teams ?? []).find((t) => String(t.id) === ctx.externalAccountId);
    if (!team) throw new ProviderHttpError(404, 'clickup:team', 'The ClickUp Workspace is no longer authorized for this connection');
    const members = (team.members ?? []).map((m) => m.user).filter(Boolean);
    if (members.length > MAX_USERS) warnings.push({ code: 'USERS_CAPPED', message: `Only the first ${MAX_USERS} ClickUp members are considered when matching people.` });

    const lists: CuList[] = [];
    const projects = [];
    const fields = new Map<string, CanonicalCustomField>();
    const skipped = new Map<string, number>();
    const spaces = new Set<string>();
    const tagNames = new Map<string, CanonicalTag>();
    for (const id of listIds) {
      const l = await this.api.get<CuList>(c, `/list/${enc(id)}`);
      if (!l?.id) throw new ProviderHttpError(404, `clickup:list:${id}`, 'A selected ClickUp list no longer exists');
      lists.push(l);
      projects.push(toProject(l, l.statuses ?? []));
      if (l.space?.id) spaces.add(String(l.space.id));
      if (l.folder?.name && !l.folder.hidden) tagNames.set(l.folder.name.toLowerCase(), { name: l.folder.name });
      const defs = await this.api.get<{ fields?: CuCustomField[] }>(c, `/list/${enc(id)}/field`).catch((e: unknown) => {
        if (e instanceof ProviderHttpError && e.status >= 400 && e.status < 500 && e.status !== 429) return { fields: [] as CuCustomField[] };
        throw e;
      });
      for (const f of defs.fields ?? []) {
        const mapped = toCustomField(f);
        if (mapped) {
          const have = fields.get(mapped.externalId);
          if (!have) fields.set(mapped.externalId, mapped);
          else if (mapped.options?.length) {
            // the same field in another list may offer other options: the Workspace-wide field offers all of them
            const labels = new Set((have.options ?? []).map((o) => o.label));
            have.options = [...(have.options ?? []), ...mapped.options.filter((o) => !labels.has(o.label))];
          }
        }
        else if (!isSupportedField(f.type)) skipped.set(f.type ?? 'unknown', (skipped.get(f.type ?? 'unknown') ?? 0) + 1);
      }
    }
    if (skipped.size) {
      warnings.push({ code: 'CUSTOM_FIELDS_SKIPPED', message: `Some ClickUp custom fields have no equivalent and are not imported: ${[...skipped].map(([t, n]) => `${n} x ${t}`).join(', ')}.` });
    }
    for (const sp of spaces) {
      const t = await this.api.get<{ tags?: CuTag[] }>(c, `/space/${enc(sp)}/tag`).catch(() => ({ tags: [] as CuTag[] }));
      for (const g of t.tags ?? []) if (g?.name) tagNames.set(g.name.toLowerCase(), g.tag_bg ? { name: g.name, color: g.tag_bg } : { name: g.name });
    }

    // Custom task types (a Workspace setting; some plans / tokens cannot read them: then there are none).
    const custom = await this.api.get<{ custom_items?: Array<{ id: number | string; name?: string | null }> }>(c, `/team/${enc(ctx.externalAccountId)}/custom_item`).catch(() => ({ custom_items: [] }));
    const issueTypes: CanonicalIssueType[] = (custom.custom_items ?? []).filter((t) => t?.id !== undefined && t.name).map((t) => ({ externalId: String(t.id), name: String(t.name) }));
    if (!issueTypes.some((t) => t.externalId === '1')) issueTypes.push({ externalId: '1', name: 'Milestone' });

    const page: CanonicalBundle = { ...emptyPage(), source: { ...CLICKUP_SYSTEM }, users: members.slice(0, MAX_USERS).map(toUser), projects, tags: [...tagNames.values()], issueTypes };
    if (fields.size) page.customFields = [...fields.values()];
    return { page, lists, issueTypeIds: issueTypes.map((t) => t.externalId) };
  }

  private async countTasks(c: ClickUpCallContext, listId: string): Promise<{ count: number; capped: boolean }> {
    let count = 0;
    for (let page = 0; page < MAX_COUNT_PAGES; page++) {
      const r = await this.api.get<{ tasks?: CuTask[]; last_page?: boolean }>(c, `/list/${enc(listId)}/task`, { page, subtasks: true, include_closed: true });
      const n = r.tasks?.length ?? 0;
      count += n;
      if (r.last_page === true || n < TASK_PAGE) return { count, capped: false };
    }
    return { count, capped: true };
  }

  private async taskPage(c: ClickUpCallContext, cur: ClickUpCursor, options: ImportOptions): Promise<FetchBundleResult> {
    const listId = cur.lists[cur.i];
    const r = await this.api.get<{ tasks?: CuTask[]; last_page?: boolean }>(c, `/list/${enc(listId)}/task`, {
      page: cur.page, subtasks: true, include_closed: true, archived: cur.arch, include_markdown_description: true,
    });
    const tasks = r.tasks ?? [];
    const issueTypeIds = new Set(cur.it);
    const page = emptyPage();
    const out = [];
    const deps = new Map<string, ReturnType<typeof toDependencies>[number]>();
    for (const t of tasks) {
      if (!t?.id) continue;
      const mapped = toTask(t, { listId, folderName: cur.folders[cur.i] || undefined, issueTypeIds });
      if (options.comments) {
        const comments = await this.commentsOf(c, t.id);
        if (comments.length) mapped.comments = comments;
      }
      if (options.attachments) {
        const files = await this.filesOf(c, t.id);
        if (files.length) mapped.attachments = files;
      }
      out.push(mapped);
      for (const d of toDependencies(t)) deps.set(d.externalId, d);
    }
    if (out.length) page.tasks = out;
    if (deps.size) page.dependencies = [...deps.values()];

    const last = r.last_page === true || tasks.length < TASK_PAGE;
    let next: ClickUpCursor | null;
    if (!last) next = { ...cur, page: cur.page + 1 };
    else if (!cur.arch) next = { ...cur, arch: true, page: 0 };
    else if (cur.i + 1 < cur.lists.length) next = { ...cur, i: cur.i + 1, arch: false, page: 0 };
    else next = null;
    return { bundle: page, next };
  }

  /** Newest first, 25 a page, continued with BOTH `start` (the last comment's date) and `start_id`; then the replies of each thread. */
  private async commentsOf(c: ClickUpCallContext, taskId: string): Promise<ReturnType<typeof toComments>> {
    const roots: CuComment[] = [];
    let start: { date: string; id: string } | null = null;
    for (let n = 0; n < MAX_COMMENT_PAGES; n++) {
      const r: { comments?: CuComment[] } = await this.api.get(c, `/task/${enc(taskId)}/comment`, start ? { start: start.date, start_id: start.id } : {});
      const got = r.comments ?? [];
      roots.push(...got);
      const last = got[got.length - 1];
      if (got.length < COMMENT_PAGE || !last || last.date === undefined || last.date === null) break;
      if (start && start.id === String(last.id)) break; // no progress: never loop
      start = { date: String(last.date), id: String(last.id) };
    }
    const replies = new Map<string, CuComment[]>();
    for (const root of roots) {
      if (Number(root.reply_count ?? 0) > 0) {
        const r = await this.api.get<{ comments?: CuComment[] }>(c, `/comment/${enc(root.id)}/reply`);
        replies.set(String(root.id), r.comments ?? []);
      }
    }
    return toComments(roots, replies);
  }

  /** The list endpoint only returns files attached through custom fields: all of a task's files need the single-task endpoint. */
  private async filesOf(c: ClickUpCallContext, taskId: string) {
    const t = await this.api.get<CuTask>(c, `/task/${enc(taskId)}`);
    return toAttachments(taskId, t.attachments ?? []);
  }
}

const enc = (id: string | number): string => encodeURIComponent(String(id));
