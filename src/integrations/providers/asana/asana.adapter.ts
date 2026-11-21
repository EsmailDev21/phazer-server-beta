import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IntegrationProvider } from '@prisma/client';
import { CANONICAL_LIMITS as L, CanonicalBundle, CanonicalCustomField, CanonicalTag, CanonicalTask, validateBundle } from '../../../imports/canonical';
import { FetchAttachmentInput, FetchBundleInput, FetchBundleResult, FetchedAttachment, ImportAdapterContext, ImportCapableAdapter } from '../../../imports/import-adapter';
import { ImportEstimate, ImportOptions, ImportSelection, SourceTree } from '../../../imports/imports.types';
import { buildInventory } from '../../../imports/mapping/mapping.inventory';
import { priorityKey } from '../../../imports/mapping/mapping.tables';
import { AuthorizeContext, CallbackParams, Capability, ExchangeContext, ExternalAccount, ProviderAuthRejectedError, ProviderHttpError, TokenSet } from '../../core/integration.types';
import { ProviderHttpClient } from '../../core/provider-http.client';
import { ASANA_API, AsanaCallContext, AsanaClient, PAGE_LIMIT } from './asana.client';
import {
  ASANA_SYSTEM,
  downloadTarget,
  emptyPage,
  isAsanaHosted,
  isPriorityField,
  isSupportedField,
  openStatusOf,
  parseAttachmentRef,
  sectionStatusId,
  todoStatusId,
  toAttachments,
  toComments,
  toCustomField,
  toDependencies,
  toProject,
  toTask,
  toUser,
} from './asana.normalize';
import { AsAttachment, AsCustomFieldSetting, AsProject, AsSection, AsStory, AsTask, AsUser, AsWorkspace } from './asana.types';

const AUTHORIZE_URL = 'https://app.asana.com/-/oauth_authorize';
const TOKEN_URL = 'https://app.asana.com/-/oauth_token';
const REVOKE_URL = 'https://app.asana.com/-/oauth_revoke';

/**
 * Read-only scopes (Asana's granular scopes; ADR-0039). `ASANA_SCOPES` overrides it: an app registered with "Full permissions"
 * must send `default` (or nothing), and Asana refuses a scoped request from such an app.
 */
const DEFAULT_SCOPES = 'workspaces:read teams:read projects:read tasks:read users:read stories:read attachments:read custom_fields:read tags:read';

/** The structure page carries every project, user and custom field of the import, and a page holds at most these many (more is a FATAL page error, not a truncation). */
const MAX_PROJECTS = L.maxProjects;
const MAX_USERS = L.maxUsers;
const MAX_PAGE_FIELDS = L.maxCustomFields;
const MAX_PAGE_TAGS = L.maxTags;
const MAX_PAGE_DEPS = L.maxDependencies;
const MAX_DISCOVER = 2000;
const MAX_SECTIONS = 200;
const MAX_FIELDS = 200;
const MAX_STORIES = 1000;
const MAX_SUBTASKS = 500;
/** Stop reading subtask parents once a page already holds this many tasks: a page may carry 1000. */
const SUBTASK_PAGE_BUDGET = 500;

/** Everything a task page reads. Narrow on purpose: Asana's COST limiter rates a request by how much of the graph it walks. */
const TASK_FIELDS = [
  'name', 'resource_subtype', 'completed', 'completed_at', 'created_at', 'modified_at', 'due_on', 'due_at', 'start_on', 'start_at',
  'html_notes', 'notes', 'permalink_url', 'assignee.gid', 'created_by.gid', 'parent.gid', 'num_subtasks', 'tags.name', 'tags.color',
  'memberships.project.gid', 'memberships.section.gid', 'memberships.section.name', 'dependencies.gid',
  'custom_fields.name', 'custom_fields.resource_subtype', 'custom_fields.type', 'custom_fields.is_formula_field', 'custom_fields.text_value',
  'custom_fields.number_value', 'custom_fields.enum_value.name', 'custom_fields.multi_enum_values.name', 'custom_fields.date_value', 'custom_fields.people_value.gid',
].join(',');

interface SubtaskParent {
  /** Project (copy) the subtasks belong to. */
  p: string;
  /** Parent task gid. */
  g: string;
  /** The section status an OPEN subtask inherits. */
  s: string;
}

/** Where the next call continues. Plain JSON (it lives in the job's checkpoint): the projects are resolved ONCE, on the structure page. */
interface AsanaCursor {
  v: 1;
  /** The sorted project gids of this import. */
  projects: string[];
  /** First section gid of each project ('' = none), parallel to `projects`: where a task without a section of its own goes. */
  first: string[];
  /** Sections could not be read (no scope): section names travel as tags. */
  fb: boolean;
  /** Index into `projects`; === projects.length means every project's tasks were read. */
  i: number;
  /** The offset token USED to fetch the current page (null = the first page): re-sending it re-fetches the same page. */
  off: string | null;
  /** Parents whose subtasks are still to be read, oldest first. Drained before the next task page. */
  subs: SubtaskParent[];
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  data?: { gid?: string; id?: number | string; name?: string; email?: string };
  error?: string;
  error_description?: string;
}

interface Accumulator {
  tasks: CanonicalTask[];
  deps: Map<string, ReturnType<typeof toDependencies>[number]>;
  tags: Map<string, CanonicalTag>;
  subs: SubtaskParent[];
}

/**
 * Asana (step 4.10, ADR-0039): OAuth 2 (PKCE, one-hour access tokens + a refresh token) and the import capability.
 *
 * What maps to what (diagrams 06 and 07): a PROJECT is one of our projects; its SECTIONS are its statuses (category judged by name,
 * shown as a guess) plus a synthetic "Completed"; the TEAM (organizations) is only a grouping in the picker; subtasks -> children; tags ->
 * tags; a task in several selected projects is DUPLICATED into each; custom fields -> project fields (best match), the enum field called
 * "Priority" -> task priority; dependencies -> BLOCKS; comment stories -> comments; Asana-hosted files -> files (the download address is
 * asked for right before the copy: it is short-lived). Milestones and approvals -> issue types.
 * NOT imported: history (Asana's system stories are prose, not field changes), portfolios, goals, forms, rules, time tracking, custom types.
 *
 * Written against Asana's public documentation; tested against SYNTHETIC responses. No live Asana workspace was called.
 */
@Injectable()
export class AsanaAdapter implements ImportCapableAdapter {
  readonly provider = IntegrationProvider.ASANA;
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>(['IMPORT']);
  readonly usesPkce = true;

  constructor(
    private readonly config: ConfigService,
    private readonly http: ProviderHttpClient,
    private readonly api: AsanaClient,
  ) {}

  // ------------------------------------------------------------------------------------------------ OAuth

  isConfigured(): boolean {
    return !!this.config.get('ASANA_CLIENT_ID') && !!this.config.get('ASANA_CLIENT_SECRET');
  }

  private get scopes(): string {
    const s = (this.config.get<string>('ASANA_SCOPES') ?? '').trim();
    return s || DEFAULT_SCOPES;
  }

  authorizeUrl(ctx: AuthorizeContext): string {
    const u = new URL(AUTHORIZE_URL);
    u.searchParams.set('client_id', this.config.get<string>('ASANA_CLIENT_ID')!);
    u.searchParams.set('redirect_uri', ctx.redirectUri);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('state', ctx.state);
    u.searchParams.set('scope', this.scopes);
    if (ctx.pkceChallenge) {
      u.searchParams.set('code_challenge_method', 'S256');
      u.searchParams.set('code_challenge', ctx.pkceChallenge);
    }
    return u.toString();
  }

  private async tokenCall(url: string, form: Record<string, string>): Promise<TokenResponse & { status: number }> {
    const body = new URLSearchParams({ ...form, client_id: this.config.get<string>('ASANA_CLIENT_ID')!, client_secret: this.config.get<string>('ASANA_CLIENT_SECRET')! });
    const res = await this.http.request({
      rateKey: 'oauth:ASANA',
      url,
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
    });
    let parsed: TokenResponse = {};
    try {
      parsed = res.json<TokenResponse>();
    } catch {
      /* the status decides */
    }
    return { ...parsed, status: res.status };
  }

  /** The token response carries no `scope`: what was asked for is what is recorded. */
  private toTokenSet(r: TokenResponse, previousRefresh?: string): TokenSet {
    return {
      accessToken: r.access_token!,
      // Asana does not rotate refresh tokens: a refresh answer has no new one and the stored one stays valid.
      refreshToken: r.refresh_token ?? previousRefresh,
      expiresAt: typeof r.expires_in === 'number' ? new Date(Date.now() + r.expires_in * 1000) : undefined,
      scopes: this.scopes.split(/\s+/).filter(Boolean),
      tokenType: r.token_type ?? 'bearer',
    };
  }

  /**
   * A connection is the PERSON's Asana account, not one workspace: the token covers every workspace the person is in (the consent
   * screen has no workspace picker), and the source tree shows them all. So nothing is refused here.
   */
  async exchangeCode(params: CallbackParams, ctx: ExchangeContext): Promise<{ tokens: TokenSet; account: ExternalAccount }> {
    if (!params.code) throw new Error('Asana callback without code');
    const form: Record<string, string> = { grant_type: 'authorization_code', code: params.code, redirect_uri: ctx.redirectUri };
    if (ctx.pkceVerifier) form.code_verifier = ctx.pkceVerifier;
    const r = await this.tokenCall(TOKEN_URL, form);
    if (r.status < 200 || r.status >= 300 || !r.access_token) throw new Error(`Asana token endpoint: HTTP ${r.status}${r.error ? ` ${r.error}` : ''}`);
    const gid = r.data?.gid ?? (r.data?.id !== undefined ? String(r.data.id) : '');
    if (!gid) throw new Error('Asana did not say whose account this is');
    return { tokens: this.toTokenSet(r), account: { id: String(gid), name: (r.data?.name ?? '').toString() || `Asana user ${gid}` } };
  }

  /** Not rotating, so no lock subtleties beyond the caller's per-connection lock. 400 / 401 = the grant is dead (revoked, secret reset): the person reconnects. */
  async refresh(tokens: TokenSet): Promise<TokenSet> {
    if (!tokens.refreshToken) throw new ProviderAuthRejectedError('This Asana connection has no refresh token; reconnect it');
    const r = await this.tokenCall(TOKEN_URL, { grant_type: 'refresh_token', refresh_token: tokens.refreshToken });
    if (r.status === 400 || r.status === 401 || r.status === 403) throw new ProviderAuthRejectedError(`Asana rejected the refresh token (${r.error ?? r.status})`);
    if (r.status < 200 || r.status >= 300 || !r.access_token) throw new ProviderHttpError(r.status, TOKEN_URL, r.error_description ?? r.error ?? '');
    return { ...this.toTokenSet(r, tokens.refreshToken), scopes: tokens.scopes.length ? tokens.scopes : this.toTokenSet(r).scopes };
  }

  /** Best effort: Asana revokes with the REFRESH token (an access token is rejected) and answers 200 even when it was already gone. */
  async revoke(tokens: TokenSet, _account: ExternalAccount): Promise<void> {
    if (!tokens.refreshToken) return;
    await this.tokenCall(REVOKE_URL, { token: tokens.refreshToken });
  }

  // ------------------------------------------------------------------------------------------------ import: discover / estimate

  async discover(ctx: ImportAdapterContext): Promise<SourceTree> {
    const c = this.call(ctx);
    const nodes: SourceTree['nodes'] = [];
    const { items: workspaces } = await this.api.all<AsWorkspace>(c, '/workspaces', { opt_fields: 'name' }, 200);
    let budget = MAX_DISCOVER;
    for (const w of workspaces) {
      nodes.push({ id: w.gid, type: 'workspace', name: (w.name ?? '').toString() || `Workspace ${w.gid}`, parentId: null, selectable: false });
      let projects: AsProject[];
      try {
        projects = (await this.api.all<AsProject>(c, `/workspaces/${enc(w.gid)}/projects`, { archived: false, opt_fields: 'name,team.gid,team.name' }, budget)).items;
      } catch (e) {
        if (isClientError(e)) continue; // a workspace this token cannot list (distribution settings): it simply has nothing to pick
        throw e;
      }
      budget -= projects.length;
      const teams = new Map<string, string>();
      for (const p of projects) if (p.team?.gid && !teams.has(p.team.gid)) teams.set(p.team.gid, (p.team.name ?? '').toString() || `Team ${p.team.gid}`);
      for (const [gid, name] of teams) nodes.push({ id: gid, type: 'team', name, parentId: w.gid, selectable: true });
      for (const p of projects) nodes.push({ id: p.gid, type: 'project', name: (p.name ?? '').toString() || `Project ${p.gid}`, parentId: p.team?.gid ?? w.gid, selectable: true });
      if (budget <= 0) break;
    }
    return { nodes };
  }

  async estimate(ctx: ImportAdapterContext, selection: ImportSelection, options: ImportOptions): Promise<ImportEstimate> {
    const c = this.call(ctx);
    const warnings: NonNullable<ImportEstimate['warnings']> = [];
    const ids = await this.resolveProjects(c, selection, warnings);
    const s = await this.structurePage(c, ids, warnings);
    const checked = validateBundle(s.page);
    if ('fatal' in checked) throw new Error(`Asana structure page rejected: ${checked.fatal.code} ${checked.fatal.message}`);

    const projects: ImportEstimate['projects'] = [];
    let total = 0;
    for (const p of s.projects) {
      const count = await this.api
        .get<{ num_tasks?: number }>(c, `/projects/${enc(p.gid)}/task_counts`, { opt_fields: 'num_tasks' })
        .then((r) => (typeof r.data?.num_tasks === 'number' ? r.data.num_tasks : 0))
        .catch((e: unknown) => {
          if (!isClientError(e)) throw e;
          warnings.push({ code: 'COUNT_UNAVAILABLE', message: `The number of tasks of ${p.name ?? p.gid} could not be read.` });
          return 0;
        });
      total += count;
      projects.push({ sourceId: p.gid, name: (p.name ?? '').toString() || `Project ${p.gid}`, tasks: count });
    }

    const inventory = buildInventory([checked.bundle]);
    const have = new Set(inventory.priorities.map(priorityKey));
    for (const name of s.priorities) if (!have.has(priorityKey(name))) (have.add(priorityKey(name)), inventory.priorities.push(name));

    if (s.projects.length > 1) {
      warnings.push({ code: 'MULTI_PROJECT_DUPLICATED', message: 'A task that is in several of the selected projects is imported once into each of them (they are separate copies).' });
    }
    if (s.sectionsUnavailable) {
      warnings.push({ code: 'SECTIONS_UNAVAILABLE', message: 'Asana did not allow reading the sections of some projects (the app needs "Full permissions"): those tasks arrive as To do / Completed, with the section name as a tag.' });
    }
    // Comments and files are not in the task list: one request per task each, at about `requestsPerMinute` a minute.
    const perTask = (options.comments ? 1 : 0) + (options.attachments ? 1 : 0);
    if (perTask > 0 && total > 0) {
      const minutes = Math.ceil((total * perTask) / this.api.requestsPerMinute);
      warnings.push({
        code: 'CONTENT_SLOW',
        message: `Comments and files are fetched one task at a time and Asana allows about ${this.api.requestsPerMinute} requests a minute per connection: reading them for ${total} tasks takes about ${minutes >= 120 ? `${Math.round(minutes / 60)} hours` : `${minutes} minutes`}.`,
      });
    }
    if (options.history) {
      warnings.push({ code: 'HISTORY_NOT_AVAILABLE', message: 'Asana records changes as text ("X moved this to Done"), not as field changes, so the activity history cannot be imported faithfully and is skipped.' });
    }
    return { projects, users: checked.bundle.users?.length ?? 0, warnings, inventory };
  }

  // ------------------------------------------------------------------------------------------------ import: fetchBundle

  async fetchBundle(input: FetchBundleInput): Promise<FetchBundleResult> {
    const c = this.call(input.ctx);
    if (input.cursor === null || input.cursor === undefined) {
      const ids = await this.resolveProjects(c, input.selection, []);
      const s = await this.structurePage(c, ids, []);
      const next: AsanaCursor | null = s.projects.length
        ? { v: 1, projects: s.projects.map((p) => p.gid), first: s.first, fb: s.sectionsUnavailable, i: 0, off: null, subs: [] }
        : null;
      return { bundle: s.page, next };
    }
    const cur = this.parseCursor(input.cursor);
    return cur.subs.length > 0 ? this.subtaskPage(c, cur, input.options) : this.taskPage(c, cur, input.options);
  }

  /**
   * Opens one Asana file as a stream. The ref is OURS (`asana-attachment:<gid>`, never an address); the real download address is asked
   * for NOW because Asana's are short-lived, then checked against the allow-list (an asana.com address gets the token, a signed storage
   * address does not) before a single byte is requested. Only files Asana itself stores can be fetched.
   */
  async fetchAttachment(input: FetchAttachmentInput): Promise<FetchedAttachment> {
    const gid = parseAttachmentRef(input.providerRef);
    if (!gid) throw new ProviderHttpError(400, 'asana:file', 'Not an Asana file reference; it was not fetched');
    const c = this.call(input.ctx);
    const meta = (await this.api.get<AsAttachment>(c, `/attachments/${enc(gid)}`, { opt_fields: 'host,resource_subtype,download_url' })).data;
    if (!meta || !isAsanaHosted(meta) || !meta.download_url) throw new ProviderHttpError(422, `asana:attachment:${gid}`, 'This file is not stored by Asana, so it cannot be copied');
    const target = downloadTarget(meta.download_url);
    if (!target) throw new ProviderHttpError(400, `asana:attachment:${gid}`, 'Asana pointed at an address that is not an Asana file host; it was not fetched');
    try {
      const res = await this.http.openStream({
        rateKey: `files:${input.ctx.connectionId}`,
        url: meta.download_url,
        headers: target === 'asana' ? { authorization: `Bearer ${input.ctx.accessToken}` } : {},
      });
      const raw = res.headers.get('content-length');
      const len = raw === null ? NaN : Number(raw);
      return {
        stream: res.body,
        ...(Number.isFinite(len) && len >= 0 ? { sizeBytes: len } : {}),
        ...(res.headers.get('content-type') ? { mimeType: res.headers.get('content-type') as string } : {}),
      };
    } catch (e) {
      if (e instanceof ProviderHttpError && e.status === 401 && target === 'asana') throw new ProviderAuthRejectedError('Asana rejected the access token (HTTP 401)');
      throw e;
    }
  }

  // ------------------------------------------------------------------------------------------------ internals

  private call(ctx: ImportAdapterContext): AsanaCallContext {
    return { connectionId: ctx.connectionId, accessToken: ctx.accessToken };
  }

  private parseCursor(raw: unknown): AsanaCursor {
    const c = raw as Partial<AsanaCursor> | null;
    const strings = (a: unknown): a is string[] => Array.isArray(a) && a.every((x) => typeof x === 'string');
    const subs = (a: unknown): a is SubtaskParent[] =>
      Array.isArray(a) && a.every((x) => !!x && typeof x === 'object' && typeof x.p === 'string' && typeof x.g === 'string' && typeof x.s === 'string');
    const ok =
      !!c && typeof c === 'object' && c.v === 1 && strings(c.projects) && strings(c.first) && c.projects.length === c.first.length &&
      typeof c.fb === 'boolean' && Number.isInteger(c.i) && c.i! >= 0 && c.i! <= c.projects.length &&
      (c.off === null || typeof c.off === 'string') && subs(c.subs);
    if (!ok) throw new Error('The saved Asana cursor is not valid; start the import again');
    return c as AsanaCursor;
  }

  /** Selected teams / projects -> the sorted, de-duplicated project gids. */
  private async resolveProjects(c: AsanaCallContext, selection: ImportSelection, warnings: NonNullable<ImportEstimate['warnings']>): Promise<string[]> {
    const ids = new Set<string>();
    for (const s of selection.sources) {
      if (s.type === 'project') ids.add(s.id);
      else if (s.type === 'team') {
        const r = await this.api.all<AsProject>(c, `/teams/${enc(s.id)}/projects`, { archived: false, opt_fields: 'name' }, MAX_DISCOVER);
        for (const p of r.items) ids.add(p.gid);
      } else throw new Error(`Asana can import teams and projects (got "${s.type}")`);
    }
    let sorted = [...ids].sort();
    if (sorted.length > MAX_PROJECTS) {
      warnings.push({ code: 'PROJECTS_CAPPED', message: `Only the first ${MAX_PROJECTS} projects of the selection are imported; select fewer teams or projects.` });
      sorted = sorted.slice(0, MAX_PROJECTS);
    }
    return sorted;
  }

  /** Page 0: the people of the involved workspaces, each project with its sections as statuses, the custom fields, the built-in issue types. */
  private async structurePage(c: AsanaCallContext, projectIds: string[], warnings: NonNullable<ImportEstimate['warnings']>) {
    const projects: AsProject[] = [];
    const bundleProjects = [];
    const first: string[] = [];
    const fields = new Map<string, CanonicalCustomField>();
    const skipped = new Map<string, number>();
    const priorities: string[] = [];
    const workspaces = new Set<string>();
    let sectionsUnavailable = false;

    for (const id of projectIds) {
      const p = (await this.api.get<AsProject>(c, `/projects/${enc(id)}`, { opt_fields: 'name,archived,notes,permalink_url,created_at,workspace.gid' })).data;
      if (!p?.gid) throw new ProviderHttpError(404, `asana:project:${id}`, 'A selected Asana project no longer exists');
      projects.push(p);
      if (p.workspace?.gid) workspaces.add(p.workspace.gid);

      let sections: AsSection[] = [];
      try {
        sections = (await this.api.all<AsSection>(c, `/projects/${enc(id)}/sections`, { opt_fields: 'name' }, MAX_SECTIONS)).items;
      } catch (e) {
        // `GET /projects/{gid}/sections` is not in Asana's scope table: an app with granular scopes may get a 403 here.
        if (e instanceof ProviderHttpError && e.status === 403) sectionsUnavailable = true;
        else throw e;
      }
      first.push(sections[0]?.gid ?? '');
      bundleProjects.push(toProject(p, sections));

      const settings = await this.api
        .all<AsCustomFieldSetting>(c, `/projects/${enc(id)}/custom_field_settings`, {
          opt_fields: 'custom_field.name,custom_field.resource_subtype,custom_field.type,custom_field.is_formula_field,custom_field.enum_options.name,custom_field.enum_options.enabled',
        }, MAX_FIELDS)
        .then((r) => r.items)
        .catch((e: unknown) => {
          if (isClientError(e)) return [] as AsCustomFieldSetting[];
          throw e;
        });
      for (const st of settings) {
        const f = st.custom_field;
        if (!f?.gid) continue;
        if (isPriorityField(f)) {
          for (const o of f.enum_options ?? []) if (o?.name && o.enabled !== false && !priorities.includes(o.name)) priorities.push(o.name);
          continue;
        }
        const mapped = toCustomField(f);
        if (mapped) {
          const have = fields.get(mapped.externalId);
          if (!have) fields.set(mapped.externalId, mapped);
          else if (mapped.options?.length) {
            const labels = new Set((have.options ?? []).map((o) => o.label));
            have.options = [...(have.options ?? []), ...mapped.options.filter((o) => !labels.has(o.label))];
          }
        } else if (!isSupportedField(f)) {
          const kind = (f.is_formula_field ? 'formula' : f.resource_subtype ?? f.type ?? 'unknown').toString();
          skipped.set(kind, (skipped.get(kind) ?? 0) + 1);
        }
      }
    }
    let customFields = [...fields.values()];
    if (customFields.length > MAX_PAGE_FIELDS) {
      warnings.push({ code: 'CUSTOM_FIELDS_CAPPED', message: `The selected projects use ${customFields.length} custom fields; only the first ${MAX_PAGE_FIELDS} are imported.` });
      customFields = customFields.slice(0, MAX_PAGE_FIELDS);
    }
    if (skipped.size) warnings.push({ code: 'CUSTOM_FIELDS_SKIPPED', message: `Some Asana custom fields have no equivalent and are not imported: ${[...skipped].map(([t, n]) => `${n} x ${t}`).join(', ')}.` });

    const users = new Map<string, AsUser>();
    for (const ws of workspaces) {
      const got = await this.api
        .all<AsUser>(c, `/workspaces/${enc(ws)}/users`, { opt_fields: 'name,email,photo.image_128x128' }, MAX_USERS)
        .then((r) => r.items)
        .catch((e: unknown) => {
          if (!isClientError(e)) throw e;
          warnings.push({ code: 'USERS_UNAVAILABLE', message: 'Asana did not allow reading the people of a workspace: assignees can only be matched by name.' });
          return [] as AsUser[];
        });
      for (const u of got) if (u?.gid && !users.has(u.gid)) users.set(u.gid, u);
    }
    if (users.size > MAX_USERS) warnings.push({ code: 'USERS_CAPPED', message: `Only the first ${MAX_USERS} Asana people are considered when matching people.` });

    const page: CanonicalBundle = {
      ...emptyPage(),
      source: { ...ASANA_SYSTEM },
      users: [...users.values()].slice(0, MAX_USERS).map(toUser),
      projects: bundleProjects,
      issueTypes: [{ externalId: 'milestone', name: 'Milestone' }, { externalId: 'approval', name: 'Approval' }],
    };
    if (customFields.length) page.customFields = customFields;
    return { page, projects, first, priorities, sectionsUnavailable };
  }

  private fallbackStatus(cur: AsanaCursor, projectId: string): string {
    const idx = cur.projects.indexOf(projectId);
    const sec = idx >= 0 ? cur.first[idx] : '';
    return sec ? sectionStatusId(projectId, sec) : todoStatusId(projectId);
  }

  private newAcc(subs: SubtaskParent[] = []): Accumulator {
    return { tasks: [], deps: new Map(), tags: new Map(), subs };
  }

  private finish(acc: Accumulator): CanonicalBundle {
    const page = emptyPage();
    if (acc.tasks.length) page.tasks = acc.tasks;
    if (acc.deps.size) page.dependencies = [...acc.deps.values()];
    if (acc.tags.size) page.tags = [...acc.tags.values()];
    return page;
  }

  /** One task (a COPY of it in `projectId`) with its comments and files; queues its subtasks. */
  private async emit(c: AsanaCallContext, t: AsanaTaskLike, cur: AsanaCursor, projectId: string, parent: { id: string; statusId: string } | undefined, options: ImportOptions, acc: Accumulator): Promise<void> {
    if (!t?.gid) return;
    const fallback = this.fallbackStatus(cur, projectId);
    const mapped = toTask(t, { projectId, fallbackStatusId: fallback, parent, sectionsAsTags: cur.fb });
    if (options.comments) {
      const comments = await this.commentsOf(c, t.gid);
      if (comments.length) mapped.comments = comments;
    }
    if (options.attachments) {
      const files = await this.filesOf(c, mapped.externalId, t.gid);
      if (files.length) mapped.attachments = files;
    }
    acc.tasks.push(mapped);
    for (const d of toDependencies(t, projectId)) if (acc.deps.size < MAX_PAGE_DEPS) acc.deps.set(d.externalId, d);
    for (const g of t.tags ?? []) {
      const name = (g?.name ?? '').toString();
      if (name && acc.tags.size < MAX_PAGE_TAGS && !acc.tags.has(name.toLowerCase())) acc.tags.set(name.toLowerCase(), g.color ? { name, color: String(g.color) } : { name });
    }
    if ((t.num_subtasks ?? 0) > 0) acc.subs.push({ p: projectId, g: t.gid, s: parent?.statusId ?? openStatusOf(t, projectId, fallback, cur.fb) });
  }

  private async taskPage(c: AsanaCallContext, cur: AsanaCursor, options: ImportOptions): Promise<FetchBundleResult> {
    const projectId = cur.projects[cur.i];
    const r = await this.api.get<AsTask[]>(c, `/projects/${enc(projectId)}/tasks`, { limit: PAGE_LIMIT, offset: cur.off ?? undefined, opt_fields: TASK_FIELDS });
    const tasks = Array.isArray(r.data) ? r.data : [];
    const acc = this.newAcc();
    for (const t of tasks) await this.emit(c, t, cur, projectId, undefined, options, acc);

    const offset = r.next_page?.offset ?? null;
    let next: AsanaCursor | null;
    if (offset && tasks.length > 0) next = { ...cur, off: offset, subs: acc.subs };
    else next = { ...cur, i: cur.i + 1, off: null, subs: acc.subs };
    if (next.i >= next.projects.length && next.subs.length === 0) next = null;
    return { bundle: this.finish(acc), next };
  }

  /** Reads the subtasks of queued parents (one parent at a time, up to the page budget); a subtask can itself have subtasks, queued at the end. */
  private async subtaskPage(c: AsanaCallContext, cur: AsanaCursor, options: ImportOptions): Promise<FetchBundleResult> {
    const queue = [...cur.subs];
    const acc = this.newAcc(queue);
    while (queue.length > 0 && acc.tasks.length < SUBTASK_PAGE_BUDGET) {
      const e = queue.shift()!;
      const list = await this.api
        .all<AsTask>(c, `/tasks/${enc(e.g)}/subtasks`, { opt_fields: TASK_FIELDS }, MAX_SUBTASKS)
        .then((x) => x.items)
        .catch((err: unknown) => {
          if (isClientError(err)) return [] as AsTask[]; // the parent was deleted or became unreadable meanwhile
          throw err;
        });
      for (const sub of list) await this.emit(c, sub, cur, e.p, { id: `${e.p}:${e.g}`, statusId: e.s }, options, acc);
    }
    let next: AsanaCursor | null = { ...cur, subs: acc.subs };
    if (next.i >= next.projects.length && next.subs.length === 0) next = null;
    return { bundle: this.finish(acc), next };
  }

  /** Comments only (a task's `stories` also hold system events). All pages, oldest first after normalising. A task that cannot be read has no comments. */
  private async commentsOf(c: AsanaCallContext, taskGid: string) {
    const stories = await this.api
      .all<AsStory>(c, `/tasks/${enc(taskGid)}/stories`, { opt_fields: 'type,resource_subtype,text,html_text,created_at,created_by.name' }, MAX_STORIES)
      .then((r) => r.items)
      .catch((e: unknown) => {
        if (isClientError(e)) return [] as AsStory[];
        throw e;
      });
    return toComments(stories);
  }

  private async filesOf(c: AsanaCallContext, copyId: string, taskGid: string) {
    const list = await this.api
      .all<AsAttachment>(c, '/attachments', { parent: taskGid, opt_fields: 'name,host,resource_subtype,size,created_at' }, 100)
      .then((r) => r.items)
      .catch((e: unknown) => {
        if (isClientError(e)) return [] as AsAttachment[];
        throw e;
      });
    return toAttachments(copyId, list);
  }
}

type AsanaTaskLike = AsTask;

/** A 4xx that is about THIS object (forbidden, gone), as opposed to the token (401, handled by the HTTP layer) or the budget (429). */
function isClientError(e: unknown): boolean {
  return e instanceof ProviderHttpError && e.status >= 400 && e.status < 500 && e.status !== 401 && e.status !== 429;
}

const enc = (id: string | number): string => encodeURIComponent(String(id));

// kept for the fixtures/specs and ADR: the base URL the client talks to
export { ASANA_API };
