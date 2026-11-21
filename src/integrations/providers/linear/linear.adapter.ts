import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IntegrationProvider } from '@prisma/client';
import { CanonicalBundle, validateBundle } from '../../../imports/canonical';
import { FetchAttachmentInput, FetchBundleInput, FetchBundleResult, FetchedAttachment, ImportAdapterContext, ImportCapableAdapter } from '../../../imports/import-adapter';
import { ImportEstimate, ImportOptions, ImportSelection, SourceTree } from '../../../imports/imports.types';
import { buildInventory } from '../../../imports/mapping/mapping.inventory';
import { priorityKey } from '../../../imports/mapping/mapping.tables';
import { ProviderHttpClient } from '../../core/provider-http.client';
import {
  AuthorizeContext,
  CallbackParams,
  Capability,
  ExchangeContext,
  ExternalAccount,
  ProviderAuthRejectedError,
  ProviderHttpError,
  TokenSet,
} from '../../core/integration.types';
import { LinearCallContext, LinearClient } from './linear.client';
import {
  CONTENT_PAGE_SIZE,
  ISSUE_PAGE_SIZE,
  NESTED_FIRST,
  Q_ISSUE_COMMENTS,
  Q_ISSUE_HISTORY,
  Q_ISSUE_LINKS,
  Q_ISSUE_LABELS,
  Q_ISSUE_RELATIONS,
  Q_LABELS,
  Q_ORGANIZATION,
  Q_TEAM,
  Q_TEAMS,
  Q_TEAM_CYCLES,
  Q_TEAM_ISSUE_IDS,
  Q_TEAM_PROJECTS,
  Q_TEAM_STATES,
  Q_USERS,
  teamIssuesQuery,
} from './linear.queries';
import {
  LINEAR_SYSTEM,
  emptyPage,
  isLinearFileUrl,
  projectField,
  projectOptionLabels,
  toDependencies,
  toIteration,
  toProject,
  toTag,
  toTask,
  toUser,
  MAX_PROJECT_OPTIONS,
} from './linear.normalize';
import {
  Connection,
  LinearComment,
  LinearCycle,
  LinearHistoryNode,
  LinearLinkAttachment,
  LinearIssue,
  LinearLabel,
  LinearOrganization,
  LinearProject,
  LinearRelation,
  LinearState,
  LinearTeam,
  LinearTeamLite,
  LinearUser,
} from './linear.types';

const AUTHORIZE_URL = 'https://linear.app/oauth/authorize';
const TOKEN_URL = 'https://api.linear.app/oauth/token';
const REVOKE_URL = 'https://api.linear.app/oauth/revoke';
/** `read` is all an importer needs: this adapter never writes to Linear. */
const SCOPES = ['read'];

/** Bounds on what ONE page / estimate holds. Linear workspaces are not bounded; these keep a page inside CANONICAL_LIMITS. */
const MAX_USERS = 2000;
const MAX_TAGS = 2000;
const MAX_CYCLES_PER_TEAM = 500;
/** The estimate counts issues by paging ids (250 per request): this many requests per team, then it says "at least". */
const MAX_COUNT_PAGES = 100;

/** Where the next call continues. Plain JSON: it is stored in the job's checkpoint. */
interface LinearCursor {
  v: 1;
  /** Index into the (sorted, de-duplicated) selected team ids. */
  team: number;
  /** Linear's endCursor for that team's issues; null = start of the team (which also carries the team's cycles). */
  after: string | null;
  /** Whether the "Linear project" field exists in this import (decided once, on the structure page). */
  pf: boolean;
  /** Issues per page, when Linear refused the default as too complex and the adapter halved it (step 4.6). */
  ps?: number;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string | string[];
  token_type?: string;
  error?: string;
  error_description?: string;
}

/**
 * Linear (step 4.5, ADR-0034): OAuth 2 (`read` scope) + the import capability.
 *
 * What maps to what: a Linear TEAM is one of our projects (its workflow states, its issue key and its cycles belong to the team);
 * a Linear PROJECT becomes a value of a "Linear project" select field; cycles -> iterations (CYCLE); labels -> tags; estimate ->
 * estimate; sub-issues -> parent; `blocks` relations -> BLOCKS dependencies. Step 4.6: comments -> comments (replies kept one
 * level), the issue history -> generic field diffs, files uploaded into a description / comment (uploads.linear.app) -> files
 * to copy, Linear's own link attachments -> a short list at the end of the description.
 *
 * Written against Linear's public documentation and tested against SYNTHETIC responses: no live Linear workspace was called.
 */
@Injectable()
export class LinearAdapter implements ImportCapableAdapter {
  readonly provider = IntegrationProvider.LINEAR;
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>(['IMPORT']);
  readonly usesPkce = false;

  constructor(
    private readonly config: ConfigService,
    private readonly http: ProviderHttpClient,
    private readonly gql: LinearClient,
  ) {}

  // ------------------------------------------------------------------------------------------------ OAuth

  isConfigured(): boolean {
    return !!this.config.get('LINEAR_CLIENT_ID') && !!this.config.get('LINEAR_CLIENT_SECRET');
  }

  authorizeUrl(ctx: AuthorizeContext): string {
    const u = new URL(AUTHORIZE_URL);
    u.searchParams.set('client_id', this.config.get<string>('LINEAR_CLIENT_ID')!);
    u.searchParams.set('redirect_uri', ctx.redirectUri);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', SCOPES.join(','));
    u.searchParams.set('state', ctx.state);
    // Linear shows a consent screen only when asked: without this a previously-authorised user is bounced straight back.
    u.searchParams.set('prompt', 'consent');
    return u.toString();
  }

  async exchangeCode(params: CallbackParams, ctx: ExchangeContext): Promise<{ tokens: TokenSet; account: ExternalAccount }> {
    if (!params.code) throw new Error('Linear callback without code');
    const r = await this.token({ grant_type: 'authorization_code', code: params.code, redirect_uri: ctx.redirectUri });
    const tokens = this.toTokens(r);
    const org = await this.gql.query<{ organization: LinearOrganization | null }>({ accessToken: tokens.accessToken }, Q_ORGANIZATION);
    if (!org.organization?.id) throw new Error('Linear response missing organization');
    return { tokens, account: { id: org.organization.id, name: org.organization.name } };
  }

  async refresh(tokens: TokenSet): Promise<TokenSet> {
    if (!tokens.refreshToken) throw new ProviderAuthRejectedError('No refresh token stored');
    const r = await this.token({ grant_type: 'refresh_token', refresh_token: tokens.refreshToken }, true);
    const next = this.toTokens(r);
    // A provider that does not rotate the refresh token leaves the old one valid.
    return { ...next, refreshToken: next.refreshToken ?? tokens.refreshToken };
  }

  async revoke(tokens: TokenSet): Promise<void> {
    await this.http.request({
      rateKey: 'oauth:LINEAR',
      url: REVOKE_URL,
      method: 'POST',
      headers: { authorization: `Bearer ${tokens.accessToken}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ access_token: tokens.accessToken }),
    });
  }

  private async token(form: Record<string, string>, isRefresh = false): Promise<TokenResponse> {
    const res = await this.http.request({
      rateKey: 'oauth:LINEAR',
      url: TOKEN_URL,
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.config.get<string>('LINEAR_CLIENT_ID')!,
        client_secret: this.config.get<string>('LINEAR_CLIENT_SECRET')!,
        ...form,
      }),
    });
    let body: TokenResponse = {};
    try {
      body = res.json<TokenResponse>();
    } catch {
      /* not JSON: handled below by status */
    }
    if (!res.ok) {
      const dead = ['invalid_grant', 'invalid_token', 'invalid_client', 'unauthorized_client'];
      if (isRefresh && (res.status === 401 || (res.status === 400 && dead.includes(body.error ?? '')))) {
        throw new ProviderAuthRejectedError(`Linear: ${body.error ?? res.status}`);
      }
      throw new Error(`Linear token endpoint: HTTP ${res.status}${body.error ? ` ${body.error}` : ''}`);
    }
    if (!body.access_token) throw new Error('Linear token response without access_token');
    return body;
  }

  private toTokens(r: TokenResponse): TokenSet {
    const scopes = Array.isArray(r.scope) ? r.scope : (r.scope ?? '').split(/[\s,]+/);
    return {
      accessToken: r.access_token!,
      refreshToken: r.refresh_token,
      // Old Linear tokens do not expire (no expires_in); newer ones last ~a day and come with a refresh token.
      expiresAt: typeof r.expires_in === 'number' && r.expires_in > 0 ? new Date(Date.now() + r.expires_in * 1000) : undefined,
      scopes: scopes.filter(Boolean),
      tokenType: r.token_type,
    };
  }

  // ------------------------------------------------------------------------------------------------ import: discover / estimate

  async discover(ctx: ImportAdapterContext): Promise<SourceTree> {
    const { nodes } = await this.gql.fetchAll<{ teams: Connection<LinearTeamLite> }, LinearTeamLite>(this.call(ctx), Q_TEAMS, {}, (r) => r.teams);
    return { nodes: nodes.map((t) => ({ id: t.id, type: 'team', name: `${t.name} (${t.key})`, parentId: null, selectable: true })) };
  }

  async estimate(ctx: ImportAdapterContext, selection: ImportSelection, options: ImportOptions): Promise<ImportEstimate> {
    const teamIds = this.teamIds(selection);
    const c = this.call(ctx);
    const warnings: NonNullable<ImportEstimate['warnings']> = [];

    const structure = await this.structurePage(c, teamIds, warnings);
    const checked = validateBundle(structure.page);
    if ('fatal' in checked) throw new Error(`Linear structure page rejected: ${checked.fatal.code} ${checked.fatal.message}`);

    const projects: ImportEstimate['projects'] = [];
    for (const team of structure.teams) {
      const { count, capped } = await this.countIssues(c, team.id);
      projects.push({ sourceId: team.id, name: team.name, tasks: count });
      if (capped) warnings.push({ code: 'COUNT_CAPPED', message: `${team.name} has more than ${count} issues; the real number is higher.` });
    }

    // Linear's priorities are a fixed list, so the Map step can offer them even before a single issue is read.
    const inventory = buildInventory([checked.bundle]);
    const have = new Set(inventory.priorities.map(priorityKey));
    for (const p of ['Urgent', 'High', 'Medium', 'Low']) if (!have.has(priorityKey(p))) inventory.priorities.push(p);

    if (options.comments || options.attachments || options.history) {
      warnings.push({
        code: 'CONTENT_COUNT_UNKNOWN',
        message:
          'Comments, activity history and files are read together with each issue, so their number (and the storage the files need) is only known while the import runs. Importing them makes it noticeably slower than issues alone.',
      });
    }
    return { projects, users: checked.bundle.users?.length ?? 0, warnings, inventory };
  }

  // ------------------------------------------------------------------------------------------------ import: fetchBundle

  async fetchBundle(input: FetchBundleInput): Promise<FetchBundleResult> {
    const teamIds = this.teamIds(input.selection);
    const c = this.call(input.ctx);

    if (input.cursor === null || input.cursor === undefined) {
      const structure = await this.structurePage(c, teamIds, []);
      const next: LinearCursor = { v: 1, team: 0, after: null, pf: structure.hasProjectField };
      return { bundle: structure.page, next };
    }
    const cursor = this.parseCursor(input.cursor, teamIds.length);
    return this.issuePage(c, teamIds, cursor, input.options);
  }

  /**
   * Step 4.6. Opens one Linear-hosted file as a stream. The ref is checked AGAIN here (it was produced from text a Linear user
   * wrote, and the checkpoint / item table is stored data): only https://uploads.linear.app/... is ever requested, and the
   * access token is sent only there. HTTP 401 means the token is dead (the job pauses); any other refusal is about this file.
   * Linear's file URLs need the Authorization header (documented for private uploads; unverified live, ADR-0035).
   */
  async fetchAttachment(input: FetchAttachmentInput): Promise<FetchedAttachment> {
    if (!isLinearFileUrl(input.providerRef)) throw new ProviderHttpError(400, 'linear:file', 'Not a Linear file address; it was not fetched');
    try {
      const res = await this.http.openStream({
        rateKey: `connection:${input.ctx.connectionId}`,
        url: input.providerRef,
        headers: { authorization: `Bearer ${input.ctx.accessToken}` },
      });
      const len = Number(res.headers.get('content-length'));
      return {
        stream: res.body,
        ...(Number.isFinite(len) && len >= 0 && res.headers.get('content-length') !== null ? { sizeBytes: len } : {}),
        ...(res.headers.get('content-type') ? { mimeType: res.headers.get('content-type') as string } : {}),
      };
    } catch (e) {
      if (e instanceof ProviderHttpError && e.status === 401) throw new ProviderAuthRejectedError('Linear rejected the access token (HTTP 401)');
      throw e;
    }
  }

  // ------------------------------------------------------------------------------------------------ internals

  private call(ctx: ImportAdapterContext): LinearCallContext {
    return { connectionId: ctx.connectionId, accessToken: ctx.accessToken };
  }

  /** Selected team ids: only teams are selectable; sorted so the page order (and so the cursor) does not depend on click order. */
  private teamIds(selection: ImportSelection): string[] {
    const ids = new Set<string>();
    for (const s of selection.sources) {
      if (s.type !== 'team') throw new Error(`Linear can only import teams (got "${s.type}")`);
      ids.add(s.id);
    }
    return [...ids].sort();
  }

  private parseCursor(raw: unknown, teams: number): LinearCursor {
    const c = raw as Partial<LinearCursor> | null;
    const ok =
      !!c && typeof c === 'object' && c.v === 1 && Number.isInteger(c.team) && c.team! >= 0 && c.team! < teams &&
      (c.after === null || typeof c.after === 'string') && typeof c.pf === 'boolean' &&
      (c.ps === undefined || (Number.isInteger(c.ps) && c.ps! >= 1 && c.ps! <= 50));
    if (!ok) throw new Error('The saved Linear cursor is not valid; start the import again');
    return c as LinearCursor;
  }

  /**
   * Page 0: organization users, labels, and for each selected team its project entry with the workflow states. Cycles are NOT
   * here (they ride with the team's first issue page, so no page can exceed the iteration ceiling).
   */
  private async structurePage(
    c: LinearCallContext,
    teamIds: string[],
    warnings: NonNullable<ImportEstimate['warnings']>,
  ): Promise<{ page: CanonicalBundle; teams: LinearTeam[]; hasProjectField: boolean }> {
    const { organization } = await this.gql.query<{ organization: LinearOrganization | null }>(c, Q_ORGANIZATION);
    if (!organization) throw new ProviderHttpError(404, 'linear:organization', 'The Linear organization is not visible to this token');

    const users = await this.gql.fetchAll<{ users: Connection<LinearUser> }, LinearUser>(c, Q_USERS, {}, (r) => r.users, MAX_USERS);
    if (users.truncated) warnings.push({ code: 'USERS_CAPPED', message: `Only the first ${MAX_USERS} Linear users are considered when matching people.` });
    const labels = await this.gql.fetchAll<{ issueLabels: Connection<LinearLabel> }, LinearLabel>(c, Q_LABELS, {}, (r) => r.issueLabels, MAX_TAGS);

    const teams: LinearTeam[] = [];
    const projects = [];
    const projectNames: string[] = [];
    for (const id of teamIds) {
      const { team } = await this.gql.query<{ team: LinearTeam | null }>(c, Q_TEAM, { id });
      if (!team) throw new ProviderHttpError(404, `linear:team:${id}`, 'A selected Linear team no longer exists');
      const states = await this.gql.fetchAll<{ team: { states: Connection<LinearState> } | null }, LinearState>(c, Q_TEAM_STATES, { id }, (r) => r.team?.states);
      const names = await this.gql.fetchAll<{ team: { projects: Connection<LinearProject> } | null }, LinearProject>(c, Q_TEAM_PROJECTS, { id }, (r) => r.team?.projects);
      projectNames.push(...names.nodes.map((p) => p.name));
      teams.push(team);
      projects.push(toProject(organization, team, states.nodes));
    }

    const field = projectField(projectNames);
    if (!field && projectOptionLabels(projectNames).length > MAX_PROJECT_OPTIONS) {
      warnings.push({ code: 'PROJECT_FIELD_SKIPPED', message: `The selected teams have more than ${MAX_PROJECT_OPTIONS} Linear projects; they are not carried over as a field.` });
    }

    const page: CanonicalBundle = {
      ...emptyPage(),
      source: { ...LINEAR_SYSTEM },
      users: users.nodes.map(toUser),
      tags: labels.nodes.map(toTag),
      projects,
    };
    if (field) page.customFields = [field];
    return { page, teams, hasProjectField: !!field };
  }

  private async issuePage(c: LinearCallContext, teamIds: string[], cur: LinearCursor, options: ImportOptions): Promise<FetchBundleResult> {
    const teamId = teamIds[cur.team];
    const page = emptyPage();
    const content = { comments: !!options.comments, history: !!options.history, attachments: !!options.attachments };
    const withContent = content.comments || content.history || content.attachments;

    // A team's first page also carries its cycles, so a task can never reference an iteration that arrives later.
    if (cur.after === null) {
      const cycles = await this.gql.fetchAll<{ team: { cycles: Connection<LinearCycle> } | null }, LinearCycle>(c, Q_TEAM_CYCLES, { id: teamId }, (r) => r.team?.cycles, MAX_CYCLES_PER_TEAM);
      if (cycles.nodes.length) page.iterations = cycles.nodes.map((cy) => toIteration(teamId, cy));
    }

    // Content makes an issue far more expensive for Linear's complexity limit: smaller pages, and when Linear still says "too
    // complex" the page is halved (down to one issue) and the smaller size is remembered in the cursor.
    let size = cur.ps ?? (withContent ? CONTENT_PAGE_SIZE : ISSUE_PAGE_SIZE);
    let r: { team: { issues: Connection<LinearIssue> } | null };
    for (let halvings = 0; ; halvings++) {
      try {
        r = await this.gql.query<{ team: { issues: Connection<LinearIssue> } | null }>(
          c,
          teamIssuesQuery({ first: size, comments: content.comments, history: content.history, links: content.attachments }),
          { id: teamId, after: cur.after },
        );
        break;
      } catch (e) {
        const tooComplex = e instanceof ProviderHttpError && e.status === 400 && /complex/i.test(e.bodySnippet);
        if (!tooComplex || size <= 1 || halvings >= 5) throw e;
        size = Math.max(1, Math.floor(size / 2));
      }
    }
    if (!r.team) throw new ProviderHttpError(404, `linear:team:${teamId}`, 'A selected Linear team no longer exists');
    const issues = r.team.issues.nodes ?? [];

    const extraLabels = new Map<string, string[]>();
    const extraRelations = new Map<string, LinearRelation[]>();
    const extraComments = new Map<string, LinearComment[]>();
    const extraHistory = new Map<string, LinearHistoryNode[]>();
    const extraLinks = new Map<string, LinearLinkAttachment[]>();
    for (const i of issues) {
      if (i.labels?.pageInfo?.hasNextPage) extraLabels.set(i.id, await this.restOfLabels(c, i));
      if (i.relations?.pageInfo?.hasNextPage) extraRelations.set(i.id, await this.restOfRelations(c, i));
      if (content.comments && i.comments?.pageInfo?.hasNextPage) extraComments.set(i.id, await this.restOf<LinearComment>(c, Q_ISSUE_COMMENTS, i.id, 'comments', i.comments.pageInfo.endCursor));
      if (content.history && i.history?.pageInfo?.hasNextPage) extraHistory.set(i.id, await this.restOf<LinearHistoryNode>(c, Q_ISSUE_HISTORY, i.id, 'history', i.history.pageInfo.endCursor));
      if (content.attachments && i.attachments?.pageInfo?.hasNextPage) extraLinks.set(i.id, await this.restOf<LinearLinkAttachment>(c, Q_ISSUE_LINKS, i.id, 'attachments', i.attachments.pageInfo.endCursor));
    }

    const cx = { teamId, withProjectField: cur.pf, selectedTeamIds: new Set(teamIds), extraLabels, extraRelations, content, extraComments, extraHistory, extraLinks };
    if (issues.length) page.tasks = issues.map((i) => toTask(i, cx));
    const deps = issues.flatMap((i) => toDependencies(i, cx));
    if (deps.length) page.dependencies = deps;

    const keep = size !== (withContent ? CONTENT_PAGE_SIZE : ISSUE_PAGE_SIZE) ? { ps: size } : {};
    const info = r.team.issues.pageInfo;
    let next: LinearCursor | null;
    if (info?.hasNextPage && info.endCursor) next = { v: 1, team: cur.team, after: info.endCursor, pf: cur.pf, ...keep };
    else if (cur.team + 1 < teamIds.length) next = { v: 1, team: cur.team + 1, after: null, pf: cur.pf, ...keep };
    else next = null;
    return { bundle: page, next };
  }

  /** The rest of a nested connection of ONE issue, continuing after the cursor the issue page ended on. */
  private async restOf<N>(c: LinearCallContext, query: string, issueId: string, field: 'comments' | 'history' | 'attachments', after: string | null | undefined): Promise<N[]> {
    const out: N[] = [];
    let cursor: string | null = after ?? null;
    for (let n = 0; n < 200; n++) {
      const r: { issue: Record<string, Connection<N>> | null } = await this.gql.query(c, query, { id: issueId, after: cursor });
      const conn = r.issue?.[field];
      if (!conn) break;
      out.push(...(conn.nodes ?? []));
      if (!conn.pageInfo?.hasNextPage || !conn.pageInfo.endCursor) break;
      cursor = conn.pageInfo.endCursor;
    }
    return out;
  }

  /** Labels beyond the first NESTED_FIRST of one issue (the rare issue with more). */
  private async restOfLabels(c: LinearCallContext, i: LinearIssue): Promise<string[]> {
    const { nodes } = await this.gql.fetchAll<{ issue: { labels: Connection<LinearLabel> } | null }, LinearLabel>(c, Q_ISSUE_LABELS, { id: i.id }, (r) => r.issue?.labels);
    return nodes.map((l) => l.name);
  }

  private async restOfRelations(c: LinearCallContext, i: LinearIssue): Promise<LinearRelation[]> {
    const { nodes } = await this.gql.fetchAll<{ issue: { relations: Connection<LinearRelation> } | null }, LinearRelation>(c, Q_ISSUE_RELATIONS, { id: i.id }, (r) => r.issue?.relations);
    return nodes;
  }

  private async countIssues(c: LinearCallContext, teamId: string): Promise<{ count: number; capped: boolean }> {
    let count = 0;
    let after: string | null = null;
    for (let n = 0; n < MAX_COUNT_PAGES; n++) {
      const r: { team: { issues: Connection<{ id: string }> } | null } = await this.gql.query(c, Q_TEAM_ISSUE_IDS, { id: teamId, after });
      if (!r.team) throw new ProviderHttpError(404, `linear:team:${teamId}`, 'A selected Linear team no longer exists');
      count += r.team.issues.nodes?.length ?? 0;
      const info = r.team.issues.pageInfo;
      if (!info?.hasNextPage || !info.endCursor) return { count, capped: false };
      after = info.endCursor;
    }
    return { count, capped: true };
  }
}

/** Exposed for tests. */
export const LINEAR_ADAPTER_LIMITS = { MAX_USERS, MAX_TAGS, MAX_CYCLES_PER_TEAM, MAX_COUNT_PAGES, NESTED_FIRST } as const;
